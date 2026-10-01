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
   *
   * `shouldSkip` 返回 true 的会话视为**合法等待**（如待答表单 / 未决审批）：
   * 既不返回、也不移出运行态（避免在等待期被误杀，也避免丢追踪导致后续排队判定失真）。
   */
  stale(maxIdleMs: number, now: number = Date.now(), shouldSkip?: (sessionID: string) => boolean): string[] {
    const out: string[] = [];
    for (const [sessionID, at] of this.running) {
      if (now - at < maxIdleMs) continue;
      if (shouldSkip?.(sessionID)) continue;
      this.running.delete(sessionID);
      out.push(sessionID);
    }
    return out;
  }

  clear(): void {
    this.running.clear();
  }
}

/**
 * 子会话 → 父会话映射（看门狗判活用）。
 *
 * 背景（issue #1）：`task` 子代理跑在**子会话**里，其事件只带子会话 ID；
 * 父会话（飞书绑定会话）在子会话整个运行期间收不到任何活动 → 超过
 * `staleExecutionMs` 会被看门狗误判为卡死并强杀（子代理工作一并作废）。
 *
 * 修复：从 `session.created` 的 `parentID` 维护链路，任意事件触达某个会话时，
 * 沿父链逐级刷新活动时间（`walk` + `ExecutionTracker.touch`）。
 */
export class SessionParentLinks {
  private readonly parents = new Map<string, string>();

  constructor(private readonly maxEntries = 2000) {}

  /** 登记/清理某会话的父链接（无 parentID = 顶级会话，清掉旧链接）。 */
  remember(sessionID: string, parentID: string | undefined): void {
    if (!sessionID) return;
    if (!parentID) {
      this.parents.delete(sessionID);
      return;
    }
    // 重新插入以刷新 LRU 顺序；超上限时淘汰最旧条目（防长期运行泄漏）。
    this.parents.delete(sessionID);
    this.parents.set(sessionID, parentID);
    while (this.parents.size > this.maxEntries) {
      const oldest = this.parents.keys().next().value;
      if (oldest === undefined) break;
      this.parents.delete(oldest);
    }
  }

  parentOf(sessionID: string): string | undefined {
    return this.parents.get(sessionID);
  }

  /** 沿父链逐级回调（含自身；防环 + 深度上限）。 */
  walk(sessionID: string, visit: (id: string) => void): void {
    let current: string | undefined = sessionID;
    const seen = new Set<string>();
    for (let depth = 0; current && depth < 16 && !seen.has(current); depth += 1) {
      seen.add(current);
      visit(current);
      current = this.parents.get(current);
    }
  }
}
