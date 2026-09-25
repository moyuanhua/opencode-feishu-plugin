/**
 * 原生排队决策与执行态跟踪（纯逻辑，可单测）。
 *
 * `POST /api/session/{id}/prompt` 原生支持 `delivery: "steer" | "queue"`：
 * - steer：立即投递（会打断/插入当前执行）；
 * - queue：排到当前执行之后。
 *
 * 是否排队只看「该 session 是否有正在跑的 execution」：
 * `session.execution.started` 置位，`session.execution.succeeded|failed` 清除。
 */

export type Delivery = "steer" | "queue";

/** 纯决策：正在跑 → queue；空闲 → steer。 */
export function decideDelivery(running: boolean): Delivery {
  return running ? "queue" : "steer";
}

export class ExecutionTracker {
  private readonly running = new Set<string>();

  markStarted(sessionID: string): void {
    if (sessionID) this.running.add(sessionID);
  }

  markEnded(sessionID: string): void {
    this.running.delete(sessionID);
  }

  isRunning(sessionID: string): boolean {
    return this.running.has(sessionID);
  }

  clear(): void {
    this.running.clear();
  }
}
