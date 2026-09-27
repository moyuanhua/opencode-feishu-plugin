/**
 * 看门狗（编排，注入时钟与 IO，可单测）。
 *
 * 与旧版「只放开插件侧排队判定」不同：现在对两类卡死**真正中断服务端会话**，
 * 复用 `createSessionRecovery` 的同一中断例程：
 * - 陈旧执行（长时间无任何事件）→ `staleExecutions()`；
 * - 排队超时（排队超过阈值仍无 `execution.started`）→ `staleQueued()`。
 *
 * 阈值 `staleExecutionMs` 来自 config（默认 5 分钟，夹取 1–60 分钟）。
 */
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";

export interface WatchdogDeps {
  readonly log: Logger;
  readonly staleExecutionMs: number;
  /** 返回「正在跑但超过阈值无活动」的会话（调用方通常传 ExecutionTracker.stale）。 */
  readonly staleExecutions: () => string[];
  /** 返回「排队超时且无 execution.started」的会话（RunController.staleQueued）。 */
  readonly staleQueued: () => string[];
  /** 会话恢复例程：中断 + 取消排队 + 收尾 + 提示卡。 */
  readonly recover: (sessionID: string, reason: string) => Promise<unknown>;
}

export interface WatchdogTickResult {
  readonly executions: string[];
  readonly queued: string[];
}

/** 执行一次扫描；返回本次实际触发恢复的会话（便于单测/观测）。 */
export function runWatchdogTick(deps: WatchdogDeps): WatchdogTickResult {
  const executions = deps.staleExecutions();
  for (const sessionID of executions) {
    deps.log.warn("执行态疑似卡死，主动中断并收尾", { sessionID, idleMs: deps.staleExecutionMs });
    void deps.recover(sessionID, "长时间无进展").catch((err) => {
      deps.log.warn("卡死恢复失败", { sessionID, error: errorMessage(err) });
    });
  }

  // 同一会话若已按「陈旧执行」处理，就不再重复走「排队超时」，避免发两张提示卡。
  const handled = new Set(executions);
  const queued = deps.staleQueued().filter((sessionID) => !handled.has(sessionID));
  for (const sessionID of queued) {
    deps.log.warn("会话排队超时，主动中断并取消排队", { sessionID, idleMs: deps.staleExecutionMs });
    void deps.recover(sessionID, "排队超时").catch((err) => {
      deps.log.warn("排队超时恢复失败", { sessionID, error: errorMessage(err) });
    });
  }

  return { executions, queued };
}

/** 启动周期扫描；返回停止函数。定时器 unref，不拖住进程退出。 */
export function startWatchdog(deps: WatchdogDeps, intervalMs = 60_000): () => void {
  const timer = setInterval(() => runWatchdogTick(deps), intervalMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
