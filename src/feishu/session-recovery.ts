/**
 * 会话恢复例程：中断服务端执行 + 取消排队消息 + 清执行态 + 卡片收尾。
 *
 * 任务 A（卡片「强制停止」按钮）与任务 B（看门狗）**共用同一例程**，保证行为一致：
 * 看门狗不再只是「放开插件侧排队判定」，而是真正中断服务端会话。
 *
 * 注入 IO（ctx.session.interrupt / inbox / runs / sessionMap），保持可单测。
 */
import { errorMessage } from "../logger.js";
import type { Logger, SessionLink } from "../types.js";

export interface CancelQueuedResult {
  /** 成功取消的排队消息条数。 */
  readonly cancelled: number;
  /** 取消过程中的错误（best-effort，失败不阻断中断）。 */
  readonly error?: string;
}

export interface SessionRecoveryDeps {
  readonly log: Logger;
  readonly resolveLink: (sessionID: string) => Promise<SessionLink | undefined>;
  /** 中断服务端执行；`directory` 用于跨 location 路由（x-opencode-directory）。 */
  readonly interrupt: (sessionID: string, directory: string | undefined) => Promise<void>;
  /** 取消会话尚未投递的排队消息（best-effort，不抛异常，错误放 result.error）。 */
  readonly cancelQueued: (sessionID: string, directory: string | undefined) => Promise<CancelQueuedResult>;
  /** 清理插件侧执行态（executions.markEnded）。 */
  readonly markEnded: (sessionID: string) => void;
  /** 运行卡收尾（active + queued 卡片）。失败时 error 文案会注明。 */
  readonly finalizeCard: (sessionID: string, error: string) => void;
  /** 发送带「强制停止」按钮的提示卡；无飞书映射时自行 no-op。 */
  readonly notify: (sessionID: string, reason: string, ok: boolean) => Promise<void>;
}

export interface RecoveryResult {
  readonly ok: boolean;
  readonly cancelled: number;
  readonly error?: string;
}

export interface SessionRecovery {
  /** 仅中断 + 取消排队 + 收尾（按钮 / `/stop` 用）。 */
  interrupt(sessionID: string, reason: string): Promise<RecoveryResult>;
  /** interrupt + 提示卡（看门狗用）；无飞书映射的会话不自动中断，避免误伤本地 TUI。 */
  recover(sessionID: string, reason: string): Promise<RecoveryResult>;
}

export function createSessionRecovery(deps: SessionRecoveryDeps): SessionRecovery {
  const interrupt = async (sessionID: string, reason: string): Promise<RecoveryResult> => {
    const link = await deps.resolveLink(sessionID).catch(() => undefined);
    const directory = link?.dir;

    let interruptError: string | undefined;
    try {
      await deps.interrupt(sessionID, directory);
    } catch (err) {
      interruptError = errorMessage(err);
      deps.log.warn("中断服务端执行失败", {
        sessionID,
        hasDir: Boolean(directory),
        error: interruptError,
      });
    }

    let cancelled = 0;
    let cancelError: string | undefined;
    try {
      const res = await deps.cancelQueued(sessionID, directory);
      cancelled = res.cancelled;
      cancelError = res.error;
    } catch (err) {
      cancelError = errorMessage(err);
    }
    if (cancelError) deps.log.warn("取消排队消息失败", { sessionID, error: cancelError });

    // 无论中断是否成功，都清理插件侧执行态，避免该会话永远被判为 queue。
    deps.markEnded(sessionID);

    const problems: string[] = [];
    if (interruptError) problems.push(`中断失败：${interruptError}`);
    if (cancelError) problems.push(`取消排队失败：${cancelError}`);
    const text =
      problems.length === 0
        ? `已中断（${reason}）`
        : `⏹ 已请求中断（${reason}），但：${problems.join("；")}`;
    deps.finalizeCard(sessionID, text);

    return {
      ok: problems.length === 0,
      cancelled,
      ...(interruptError ? { error: interruptError } : {}),
    };
  };

  return {
    interrupt,

    async recover(sessionID, reason) {
      const link = await deps.resolveLink(sessionID).catch(() => undefined);
      if (!link) return { ok: false, cancelled: 0, error: "no-link" };
      const result = await interrupt(sessionID, reason);
      await deps.notify(sessionID, reason, result.ok).catch((err) => {
        deps.log.warn("卡死提示卡发送异常", { sessionID, error: errorMessage(err) });
      });
      return result;
    },
  };
}
