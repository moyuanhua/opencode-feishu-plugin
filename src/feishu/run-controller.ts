/**
 * 运行卡片控制器：把「一条入站消息 = 一张卡片」的生命周期串起来。
 *
 * 职责：
 * 1. `beginRun`：**先**发回执卡（思考中 / 已排队），把卡片登记到对应 session；
 * 2. `apply`：消费归一化事件，驱动纯 reducer，并按 ≥`throttleMs` 节流 patch 卡片；
 * 3. 终态（execution.succeeded|failed）强制 flush 并清理节流器。
 *
 * 排队模型：每个 session 至多一张「正在运行」的卡片 + 一个 FIFO 的「已排队」卡片列表。
 * - 运行中收到新消息 → 新卡片进 queued；
 * - `execution.started` 到来：若有 queued 则晋升队首为 active（页脚 思考中）；
 * - 终态到来：finalize active 并清空 active，等待下一次 `execution.started`。
 */
import type { Logger } from "../types.js";
import { createThrottler } from "../utils/throttle.js";
import { initialRunState, reduce, type RunEvent, type RunState } from "./run-state.js";
import { renderRunCard } from "./run-renderer.js";
import type { FeishuSender } from "./sender.js";
import type { Delivery } from "./delivery.js";

export interface RunControllerDeps {
  readonly sender: FeishuSender;
  readonly log: Logger;
  readonly enabled: boolean;
  readonly throttleMs: number;
}

export interface BeginRunInput {
  readonly sessionID: string;
  readonly chatId: string;
  readonly delivery: Delivery;
}

export interface BeginRunResult {
  readonly ok: boolean;
  readonly runID?: string;
  readonly messageId?: string;
}

export interface RunController {
  beginRun(input: BeginRunInput): Promise<BeginRunResult>;
  apply(sessionID: string, event: RunEvent): void;
  hasActive(sessionID: string): boolean;
  dispose(): void;
}

interface Card {
  readonly runID: string;
  readonly sessionID: string;
  readonly chatId: string;
  readonly messageId: string;
  state: RunState;
  chain: Promise<void>;
  finalized: boolean;
}

interface SessionRuns {
  active?: Card;
  readonly queued: Card[];
  seq: number;
}

export function createRunController(deps: RunControllerDeps): RunController {
  const sessions = new Map<string, SessionRuns>();
  const throttlers = new Map<string, ReturnType<typeof createThrottler>>();
  const throttleMs = Math.max(400, deps.throttleMs);
  let disposed = false;

  const sessionRuns = (sessionID: string): SessionRuns => {
    let runs = sessions.get(sessionID);
    if (!runs) {
      runs = { queued: [], seq: 0 };
      sessions.set(sessionID, runs);
    }
    return runs;
  };

  const patch = async (card: Card): Promise<void> => {
    if (disposed) return;
    const res = await deps.sender.patchCard(card.messageId, renderRunCard(card.state));
    if (!res.ok) {
      deps.log.warn("运行卡片更新失败", {
        sessionID: card.sessionID,
        error: res.error ?? "unknown",
      });
    }
  };

  const enqueue = (card: Card): void => {
    card.chain = card.chain.then(() => patch(card));
  };

  const getThrottler = (card: Card): ReturnType<typeof createThrottler> => {
    let throttler = throttlers.get(card.runID);
    if (!throttler) {
      throttler = createThrottler({
        intervalMs: throttleMs,
        onFire: () => {
          if (!card.finalized && !disposed) enqueue(card);
        },
      });
      throttlers.set(card.runID, throttler);
    }
    return throttler;
  };

  const schedule = (card: Card): void => {
    getThrottler(card).schedule();
  };

  const finalize = (card: Card): void => {
    if (card.finalized) return;
    card.finalized = true;
    throttlers.get(card.runID)?.cancel();
    throttlers.delete(card.runID);
    // 终态必须强制推送，不能被节流吞掉。
    enqueue(card);
  };

  const update = (card: Card, event: RunEvent, force: boolean): void => {
    card.state = reduce(card.state, event);
    if (force) {
      throttlers.get(card.runID)?.cancel();
      enqueue(card);
    } else {
      schedule(card);
    }
  };

  return {
    async beginRun(input): Promise<BeginRunResult> {
      if (!deps.enabled || disposed) return { ok: false };
      const runs = sessionRuns(input.sessionID);
      const runID = `${input.sessionID}:${runs.seq++}`;
      const state = reduce(initialRunState(), input.delivery === "queue" ? { type: "queued" } : { type: "execution.started" });

      const res = await deps.sender.sendCard(input.chatId, renderRunCard(state));
      if (!res.ok || !res.messageId) {
        deps.log.warn("回执卡片发送失败", { sessionID: input.sessionID, error: res.error ?? "unknown" });
        return { ok: false };
      }

      const card: Card = {
        runID,
        sessionID: input.sessionID,
        chatId: input.chatId,
        messageId: res.messageId,
        state,
        chain: Promise.resolve(),
        finalized: false,
      };

      if (input.delivery === "queue") {
        runs.queued.push(card);
      } else {
        // 理论上 steer 时没有 active；若竞态出现，先把旧卡片收尾避免悬挂页脚。
        if (runs.active) finalize(runs.active);
        runs.active = card;
      }
      deps.log.debug("回执卡片已发送", { sessionID: input.sessionID, delivery: input.delivery, runID });
      return { ok: true, runID, messageId: res.messageId };
    },

    apply(sessionID, event): void {
      if (disposed) return;
      const runs = sessions.get(sessionID);
      if (!runs) return;

      if (event.type === "execution.started") {
        if (runs.active) {
          update(runs.active, event, true);
          return;
        }
        const next = runs.queued.shift();
        if (next) {
          runs.active = next;
          update(next, event, true);
        }
        return;
      }

      const card = runs.active;
      if (!card) return;

      if (event.type === "execution.succeeded" || event.type === "execution.failed") {
        update(card, event, true);
        finalize(card);
        runs.active = undefined;
        return;
      }

      update(card, event, false);
    },

    hasActive(sessionID): boolean {
      return sessions.get(sessionID)?.active !== undefined;
    },

    dispose(): void {
      disposed = true;
      for (const throttler of throttlers.values()) throttler.cancel();
      throttlers.clear();
      for (const runs of sessions.values()) {
        if (runs.active) runs.active.chain = runs.active.chain.catch(() => undefined);
      }
      sessions.clear();
    },
  };
}
