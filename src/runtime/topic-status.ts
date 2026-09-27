/**
 * 话题根卡**工作状态刷新**的运行时接线（IO 层，纯逻辑在 `src/session/topic-status.ts`）。
 *
 * 职责：
 * 1. 消费事件流（execution.* / session.status / permission.asked|replied / inbox.*），
 *    更新纯状态机；
 * 2. 仅当**状态档位变化**时刷新一次根卡（整卡 patch），且两次 patch 至少间隔 `throttleMs`；
 * 3. 用 `SessionMap` 持久化的 `rootCard` 基础内容 + 统一构建器重渲染，**不丢摘要/元信息**；
 * 4. 容错：无 rootCard / 无 replyMessageId（非飞书会话、旧会话）→ 跳过（debug）；
 *    patch 失败只 `warn`、不抛、不重试风暴；同一会话连续失败达阈值即停止刷新。
 *
 * 与运行卡（每条消息那张流式卡）完全独立：只更新会话**最近一次**根卡
 * （`SessionLink.replyMessageId`），不触碰运行卡。
 */
import { errorMessage } from "../logger.js";
import { createThrottler, type Throttler } from "../utils/throttle.js";
import { buildSessionRootCard } from "../feishu/session-cards.js";
import { TopicStatusMachine, type TopicStatusView } from "../session/topic-status.js";
import type { Logger, SessionRootCardBase } from "../types.js";

/** 同一会话连续 patch 失败达到该次数后，停止该会话后续刷新（避免重试风暴）。 */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface TopicStatusTarget {
  readonly base: SessionRootCardBase;
  /** 根卡消息 id（`SessionLink.replyMessageId`）。 */
  readonly messageId: string;
}

export interface TopicStatusControllerDeps {
  readonly log: Logger;
  /** 总开关（`topicStatus`）。false = 完全不刷新。 */
  readonly enabled: boolean;
  /** 标题是否加状态 emoji 前缀（`topicStatusInTitle`）。 */
  readonly statusInTitle: boolean;
  /** 两次 patch 最小间隔（`topicStatusThrottleMs`）。 */
  readonly throttleMs: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** 解析该会话根卡基础内容 + 消息 id；无则跳过（非飞书会话 / 旧会话）。 */
  readonly getRoot: (sessionID: string) => Promise<TopicStatusTarget | undefined>;
  /** 整卡 patch。失败只返回 ok=false，不抛。 */
  readonly patch: (messageId: string, card: object) => Promise<{ ok: boolean; error?: string }>;
  /** 状态刷新时重签的压缩按钮 token（缺省 = 不渲染压缩按钮）。 */
  readonly compactToken?: (sessionID: string) => string | undefined;
}

export interface TopicStatusController {
  /** 消费一条服务器事件（fire-and-forget；内部不抛）。 */
  onEvent(event: { type: string; data: unknown }): void;
  /** 运行卡终态等**非事件流**信号的显式入口（如 prompt 发送失败）。 */
  markTerminal(sessionID: string, kind: "done" | "failed" | "interrupted"): void;
  /** 当前档位视图（测试/诊断用）。 */
  statusOf(sessionID: string): TopicStatusView | undefined;
  dispose(): void;
}

export function createTopicStatusController(deps: TopicStatusControllerDeps): TopicStatusController {
  const log = deps.log;
  const now = deps.now ?? (() => Date.now());
  const throttleMs = Math.max(0, deps.throttleMs);
  const machine = new TopicStatusMachine();
  const throttlers = new Map<string, Throttler>();
  const failures = new Map<string, number>();
  /** 连续失败达阈值的会话：不再尝试刷新。 */
  const disabled = new Set<string>();
  let disposed = false;

  const run = async (sessionID: string): Promise<void> => {
    if (disposed || !deps.enabled || disabled.has(sessionID)) return;
    const view = machine.view(sessionID);
    if (!view) return;
    let target: TopicStatusTarget | undefined;
    try {
      target = await deps.getRoot(sessionID);
    } catch (err) {
      log.warn("话题状态：读取根卡基础内容失败", { sessionID, error: errorMessage(err) });
      return;
    }
    if (!target) {
      // 无 rootCard / replyMessageId：非飞书会话或旧会话，跳过（不凭空造卡）。
      log.debug("话题状态：无根卡基础内容，跳过刷新", { sessionID });
      return;
    }
    const card = buildSessionRootCard(target.base, view, {
      now: now(),
      statusInTitle: deps.statusInTitle,
      ...(deps.compactToken ? { compactToken: deps.compactToken(sessionID) } : {}),
    });
    let ok = false;
    let error: string | undefined;
    try {
      const res = await deps.patch(target.messageId, card);
      ok = res.ok;
      error = res.error;
    } catch (err) {
      error = errorMessage(err);
    }
    if (ok) {
      failures.delete(sessionID);
      return;
    }
    const count = (failures.get(sessionID) ?? 0) + 1;
    failures.set(sessionID, count);
    log.warn("话题状态根卡刷新失败", { sessionID, attempts: count, error: error ?? "unknown" });
    if (count >= MAX_CONSECUTIVE_FAILURES) {
      disabled.add(sessionID);
      log.warn("话题状态：连续刷新失败，停止该会话后续状态刷新", {
        sessionID,
        attempts: count,
      });
    }
  };

  const getThrottler = (sessionID: string): Throttler => {
    let throttler = throttlers.get(sessionID);
    if (!throttler) {
      throttler = createThrottler({
        intervalMs: throttleMs,
        now,
        ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
        ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
        onFire: () => {
          if (!disposed) void run(sessionID);
        },
      });
      throttlers.set(sessionID, throttler);
    }
    return throttler;
  };

  const schedule = (sessionID: string): void => {
    if (!deps.enabled || disposed || disabled.has(sessionID)) return;
    getThrottler(sessionID).schedule();
  };

  const sessionIDOf = (data: unknown): string => {
    const value = (data as { sessionID?: unknown } | undefined)?.sessionID;
    return typeof value === "string" ? value : "";
  };

  return {
    onEvent(event) {
      if (!deps.enabled) return;
      const sessionID = sessionIDOf(event.data);
      if (!sessionID) return;
      const change = machine.reduce(sessionID, event);
      if (!change?.changed) return;
      schedule(sessionID);
    },

    markTerminal(sessionID, kind) {
      if (!deps.enabled || !sessionID) return;
      const change = machine.markTerminal(sessionID, kind);
      if (!change?.changed) return;
      schedule(sessionID);
    },

    statusOf(sessionID) {
      return machine.view(sessionID);
    },

    dispose() {
      disposed = true;
      for (const throttler of throttlers.values()) throttler.cancel();
      throttlers.clear();
      machine.clear();
      failures.clear();
      disabled.clear();
    },
  };
}
