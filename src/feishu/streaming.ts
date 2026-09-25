/**
 * 流式回复卡片：把 assistant 文本增量以「原地更新一张卡片」的方式回填到飞书。
 *
 * 策略：
 * - 懒开卡：首个增量到达才发消息，避免空卡垃圾消息；
 * - 节流 ≥ streamThrottleMs（默认 400ms），并用串行 promise 链保证 patch 顺序；
 * - `session.text.ended` 用完整文本定稿（强制 flush 最终内容）；`session.idle` 兜底并回收状态。
 */
import type { Logger, SessionLink } from "../types.js";
import { buildStreamingCard } from "./cards.js";
import type { FeishuSender } from "./sender.js";
import { createThrottler } from "../utils/throttle.js";

export interface StreamingDeps {
  readonly sender: FeishuSender;
  readonly log: Logger;
  readonly enabled: boolean;
  readonly throttleMs: number;
  /** 解析 sessionID → 飞书会话；返回 undefined 表示该会话不来自飞书，静默丢弃。 */
  readonly getLink: (sessionID: string) => Promise<SessionLink | undefined>;
}

export interface StreamingController {
  onStarted(sessionID: string, assistantMessageID?: string): void;
  onDelta(sessionID: string, delta: string): void;
  onEnded(sessionID: string, fullText: string): void;
  onIdle(sessionID: string): void;
  dispose(): void;
}

interface StreamState {
  buffer: string;
  messageId?: string;
  finalized: boolean;
  dropped: boolean;
  link?: SessionLink;
  chain: Promise<void>;
}

export function createStreamingController(deps: StreamingDeps): StreamingController {
  const states = new Map<string, StreamState>();
  const throttlers = new Map<string, ReturnType<typeof createThrottler>>();
  let disposed = false;
  const throttleMs = Math.max(400, deps.throttleMs);

  const newState = (): StreamState => ({
    buffer: "",
    finalized: false,
    dropped: false,
    chain: Promise.resolve(),
  });

  const getState = (sessionID: string): StreamState => {
    let state = states.get(sessionID);
    if (!state) {
      state = newState();
      states.set(sessionID, state);
    }
    return state;
  };

  const flush = async (sessionID: string, state: StreamState): Promise<void> => {
    const content = state.buffer;
    if (!content) return;
    if (!state.link) {
      state.link = await deps.getLink(sessionID);
      if (!state.link) {
        state.dropped = true;
        deps.log.debug("流式回复丢弃：会话无飞书映射", { sessionID });
        return;
      }
    }
    if (!state.messageId) {
      const res = await deps.sender.sendCard(state.link.chatId, buildStreamingCard(content));
      if (res.ok && res.messageId) state.messageId = res.messageId;
      else deps.log.warn("流式卡片首发失败", { sessionID, error: res.error ?? "unknown" });
      return;
    }
    const res = await deps.sender.patchCard(state.messageId, buildStreamingCard(content));
    if (!res.ok) deps.log.warn("流式卡片更新失败", { sessionID, error: res.error ?? "unknown" });
  };

  /** 串行入队一次 flush（永远使用当时最新的 buffer）。 */
  const enqueueFlush = (sessionID: string, state: StreamState): void => {
    state.chain = state.chain.then(async () => {
      if (state.dropped || disposed) return;
      await flush(sessionID, state);
    });
  };

  const getThrottler = (sessionID: string, state: StreamState) => {
    let t = throttlers.get(sessionID);
    if (!t) {
      t = createThrottler({
        intervalMs: throttleMs,
        onFire: () => enqueueFlush(sessionID, state),
      });
      throttlers.set(sessionID, t);
    }
    return t;
  };

  const cleanupState = (sessionID: string): void => {
    throttlers.get(sessionID)?.cancel();
    throttlers.delete(sessionID);
    states.delete(sessionID);
  };

  const finalize = (sessionID: string, state: StreamState): void => {
    if (state.finalized) return;
    state.finalized = true;
    throttlers.get(sessionID)?.cancel();
    // 定稿必须强制推送一次最终内容，不能被节流吞掉。
    enqueueFlush(sessionID, state);
    state.chain = state.chain.finally(() => cleanupState(sessionID));
  };

  return {
    onStarted(sessionID) {
      if (!deps.enabled || disposed) return;
      const existing = states.get(sessionID);
      if (existing && !existing.finalized) return;
      cleanupState(sessionID);
      states.set(sessionID, newState());
    },

    onDelta(sessionID, delta) {
      if (!deps.enabled || disposed || !delta) return;
      const state = getState(sessionID);
      if (state.finalized || state.dropped) return;
      state.buffer += delta;
      getThrottler(sessionID, state).schedule();
    },

    onEnded(sessionID, fullText) {
      if (!deps.enabled || disposed) return;
      const state = states.get(sessionID);
      if (!state || state.dropped) return;
      if (fullText) state.buffer = fullText;
      finalize(sessionID, state);
    },

    onIdle(sessionID) {
      if (!deps.enabled || disposed) return;
      const state = states.get(sessionID);
      if (!state || state.dropped) return;
      finalize(sessionID, state);
    },

    dispose() {
      disposed = true;
      for (const t of throttlers.values()) t.cancel();
      throttlers.clear();
      states.clear();
    },
  };
}
