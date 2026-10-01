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
import { errorMessage } from "../logger.js";
import { createThrottler } from "../utils/throttle.js";
import { initialRunState, reduce, type RunBlock, type RunEvent, type RunState } from "./run-state.js";
import { renderRunCard } from "./run-renderer.js";
import type { FeishuSender } from "./sender.js";
import type { Delivery } from "./delivery.js";

export interface RunControllerDeps {
  readonly sender: FeishuSender;
  readonly log: Logger;
  readonly enabled: boolean;
  readonly throttleMs: number;
  /**
   * 单卡最多保留的 markdown 表格数（默认 4，夹取 1–5）。
   * 飞书单卡表格超 5 会 400（code=230099），运行卡文本块是主要来源。
   */
  readonly cardMaxTables?: number;
  /**
   * 构建运行卡「强制停止」按钮 value（含当次签名 token）。
   * 每次 patch 都会调用 → 长任务 token 始终保持新鲜；缺省不渲染按钮。
   */
  readonly buildStopValue?: (sessionID: string) => Record<string, unknown> | undefined;
  /** 运行卡最多保留的工具块数（默认 12，见 run-renderer）。 */
  readonly runnerCardMaxTools?: number;
  /** 运行卡单个文本块字符上限（默认 2048）。 */
  readonly runnerCardTextMax?: number;
  /**
   * 最终答案阈值（P8.3）：一轮结束时，末尾文本 ≥ `minChars` 就**单独成卡/成文件**发送，
   * 运行卡内只留提示——避免长回答与工具噪声抢同一张卡。
   */
  readonly finalAnswer?: { readonly minChars: number };
  /** 发送「最终答案卡/文件」（由 index 注入；缺省 = 不拆分）。 */
  readonly sendFinalAnswer?: (input: {
    readonly sessionID: string;
    readonly chatId: string;
    readonly replyToMessageId?: string;
    readonly text: string;
  }) => Promise<void>;
}

export interface BeginRunInput {
  readonly sessionID: string;
  readonly chatId: string;
  readonly delivery: Delivery;
  /**
   * 有值时用 `im.message.reply` 引用该消息发回执卡（P5：消息在话题内 → 回复留在话题）。
   * 缺省则维持 `im.message.create`。
   */
  readonly replyToMessageId?: string;
  /** 当前会话模型展示名（P6：运行卡页脚显示）。 */
  readonly model?: string;
}

export interface BeginRunResult {
  readonly ok: boolean;
  readonly runID?: string;
  readonly messageId?: string;
}

export interface RunController {
  beginRun(input: BeginRunInput): Promise<BeginRunResult>;
  apply(sessionID: string, event: RunEvent): void;
  /** 记录/更新会话当前模型（P6），并同步到正在运行的卡片页脚。 */
  setModel(sessionID: string, model: string): void;
  hasActive(sessionID: string): boolean;
  /**
   * 返回「有排队卡但超过 maxIdleMs 仍无 execution.started」的会话。
   * 每个会话在超时窗口内只上报一次（收到 execution.started 后重置）。
   */
  staleQueued(maxIdleMs: number, now?: number, shouldSkip?: (sessionID: string) => boolean): string[];
  /** 把某会话所有排队卡收尾（看门狗中断时避免排队卡永久悬挂）。 */
  finalizeQueued(sessionID: string, error: string): void;
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
  /** 进入排队队列的时间（ms）；用于排队超时检测。 */
  readonly queuedAt: number;
  readonly replyToMessageId?: string;
}

interface SessionRuns {
  active?: Card;
  readonly queued: Card[];
  seq: number;
}

/** 取「最后一个工具块之后」的文本（即本轮最终回答），无工具时为全部文本。 */
function trailingText(blocks: readonly RunBlock[]): string {
  const parts: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    if (block.kind === "tool") {
      if (parts.length > 0) break;
      continue;
    }
    if (block.content.trim()) parts.unshift(block.content);
    else if (parts.length > 0) break;
  }
  return parts.join("\n\n").trim();
}

export function createRunController(deps: RunControllerDeps): RunController {
  const sessions = new Map<string, SessionRuns>();
  const throttlers = new Map<string, ReturnType<typeof createThrottler>>();
  /** sessionID → 当前模型展示名（P6）。 */
  const sessionModels = new Map<string, string>();
  /** 已就排队超时上报过的会话（收到 execution.started 后清除）。 */
  const notifiedQueued = new Set<string>();
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

  /** 渲染一张卡片（每次重签强停 token）；表格/组件超限时按 sessionID 记 warn。 */
  const renderCard = (sessionID: string, state: RunState): object =>
    renderRunCard(state, deps.buildStopValue?.(sessionID), {
      maxTables: deps.cardMaxTables,
      maxTools: deps.runnerCardMaxTools,
      textMax: deps.runnerCardTextMax,
      onLimit: (report) => {
        deps.log.warn("运行卡内容超限，已降级", {
          sessionID,
          tables: report.tables,
          degradedTables: report.degradedTables,
          elements: report.elements,
          droppedElements: report.droppedElements,
        });
      },
    });

  const patch = async (card: Card): Promise<void> => {
    if (disposed) return;
    const res = await deps.sender.patchCard(card.messageId, renderCard(card.sessionID, card.state));
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
      let state = reduce(initialRunState(), input.delivery === "queue" ? { type: "queued" } : { type: "execution.started" });
      const model = input.model ?? sessionModels.get(input.sessionID);
      if (model) state = reduce(state, { type: "model.set", model });
      if (model) sessionModels.set(input.sessionID, model);

      const res = input.replyToMessageId
        ? await deps.sender.replyCard(input.replyToMessageId, renderCard(input.sessionID, state))
        : await deps.sender.sendCard(input.chatId, renderCard(input.sessionID, state));
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
        queuedAt: Date.now(),
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
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
        notifiedQueued.delete(sessionID);
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

      if (event.type === "execution.succeeded") {
        // 长回答：单独发「最终答案卡/文件」，卡内收缩为提示，避免两者抢同一张卡。
        const text = trailingText(card.state.blocks);
        const long =
          deps.sendFinalAnswer !== undefined &&
          deps.finalAnswer !== undefined &&
          text.length >= deps.finalAnswer.minChars;
        if (long) {
          card.state = reduce(reduce(card.state, { type: "final.separated" }), event);
          finalize(card);
          runs.active = undefined;
          void deps
            .sendFinalAnswer!({
              sessionID,
              chatId: card.chatId,
              ...(card.replyToMessageId ? { replyToMessageId: card.replyToMessageId } : {}),
              text,
            })
            .catch((err) => {
              deps.log.warn("最终答案发送失败", { sessionID, error: errorMessage(err) });
            });
          return;
        }
        update(card, event, true);
        finalize(card);
        runs.active = undefined;
        return;
      }

      if (event.type === "execution.failed") {
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

    staleQueued(maxIdleMs, now = Date.now(), shouldSkip?: (sessionID: string) => boolean): string[] {
      const out: string[] = [];
      for (const [sessionID, runs] of sessions) {
        if (runs.active) continue;
        const first = runs.queued[0];
        if (!first || now - first.queuedAt < maxIdleMs) continue;
        // 合法等待（待答表单 / 未决审批）：不标记、不通知，等用户处理后再判。
        if (shouldSkip?.(sessionID)) continue;
        if (notifiedQueued.has(sessionID)) continue;
        notifiedQueued.add(sessionID);
        out.push(sessionID);
      }
      return out;
    },

    finalizeQueued(sessionID, error): void {
      const runs = sessions.get(sessionID);
      if (!runs || runs.queued.length === 0) return;
      for (const card of runs.queued) {
        if (card.finalized) continue;
        update(card, { type: "execution.failed", error }, true);
        finalize(card);
      }
      runs.queued.length = 0;
    },

    setModel(sessionID, model): void {
      if (disposed || !model) return;
      sessionModels.set(sessionID, model);
      const runs = sessions.get(sessionID);
      if (runs?.active) update(runs.active, { type: "model.set", model }, false);
    },

    dispose(): void {
      disposed = true;
      sessionModels.clear();
      notifiedQueued.clear();
      for (const throttler of throttlers.values()) throttler.cancel();
      throttlers.clear();
      for (const runs of sessions.values()) {
        if (runs.active) runs.active.chain = runs.active.chain.catch(() => undefined);
      }
      sessions.clear();
    },
  };
}
