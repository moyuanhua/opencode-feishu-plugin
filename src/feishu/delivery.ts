/**
 * 原生排队决策与执行态跟踪（纯逻辑，可单测）。
 *
 * `POST /api/session/{id}/prompt` 原生支持 `delivery: "steer" | "queue"`：
 * - steer：立即投递（会打断/插入当前执行）；
 * - queue：排到当前执行之后。
 *
 * 是否排队只看「该 session 是否有正在跑的 execution」。执行态的权威来源有两类：
 * - `session.execution.started|succeeded|failed|interrupted`（durable 事件）；
 * - `session.status`（busy/retry/idle 瞬时事件）。
 *
 * 另外记录每个 session 的「最近活动时间」，供看门狗清理卡死（事件丢失 / 交互工具挂起）
 * 的陈旧执行态，避免永远 queue（见 `stale`）。
 */

export type Delivery = "steer" | "queue";

/** 纯决策：正在跑 → queue；空闲 → steer。 */
export function decideDelivery(running: boolean): Delivery {
  return running ? "queue" : "steer";
}

export class ExecutionTracker {
  /** sessionID → 最近一次活动时间戳（ms）。 */
  private readonly running = new Map<string, number>();

  markStarted(sessionID: string, now: number = Date.now()): void {
    if (sessionID) this.running.set(sessionID, now);
  }

  /** 收到该 session 的任意事件时刷新活动时间，避免看门狗误杀长任务。 */
  touch(sessionID: string, now: number = Date.now()): void {
    if (sessionID && this.running.has(sessionID)) this.running.set(sessionID, now);
  }

  markEnded(sessionID: string): void {
    this.running.delete(sessionID);
  }

  isRunning(sessionID: string): boolean {
    return this.running.has(sessionID);
  }

  /**
   * 返回「正在跑但超过 maxIdleMs 无任何活动」的 sessionID，并将其从运行态移除。
   * 用于插件层看门狗：事件丢失或交互工具（question/permission）永久挂起时兜底放开排队。
   */
  stale(maxIdleMs: number, now: number = Date.now()): string[] {
    const out: string[] = [];
    for (const [sessionID, at] of this.running) {
      if (now - at >= maxIdleMs) {
        this.running.delete(sessionID);
        out.push(sessionID);
      }
    }
    return out;
  }

  clear(): void {
    this.running.clear();
  }
}
