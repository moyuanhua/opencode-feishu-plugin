/**
 * 按 `messageId` 去重。
 *
 * 背景：插件会被实例化两次（独立 VM context，进程内单例无效），飞书可能把同一条
 * 消息投递给两个长连接（或客户端重试），因此必须用**跨实例共享的 ctx.storage**去重，
 * 同时保留同实例内存快路径（避免每条消息都读一次 storage）。
 *
 * key：`feishu:v2:msg:<messageId>`，值 `{ at: <ms> }`，TTL 默认 10 分钟。
 *
 * ⚠️ 已知限制：`get-then-set` **非原子**。极端并发（两个实例几乎同时处理同一条消息）
 * 下可能双处理——storage 没有 CAS/原子 setIfAbsent。内存快路径只能挡住同实例。
 * 若要彻底消除，需要在 storage 层提供原子操作，本插件不自行造锁。
 */
import { errorMessage } from "../logger.js";
import type { Logger, StorageLike } from "../types.js";
import { TtlMap } from "../utils/ttl-map.js";

export const MESSAGE_KEY_PREFIX = "feishu:v2:msg:";
export const DEFAULT_DEDUP_TTL_MS = 10 * 60 * 1000;

export interface MessageDedupOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class MessageDedup {
  private readonly memory: TtlMap<number>;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: StorageLike,
    private readonly log: Logger,
    options: MessageDedupOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_DEDUP_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.memory = new TtlMap<number>(this.ttlMs, this.now);
  }

  static key(messageId: string): string {
    return `${MESSAGE_KEY_PREFIX}${messageId}`;
  }

  /**
   * 尝试认领一条消息。返回 `true` = 首次见到（应处理）；`false` = 重复（应丢弃）。
   * 空 messageId 不参与去重（返回 true，不阻塞）。
   */
  async claim(messageId: string): Promise<boolean> {
    if (!messageId) return true;
    if (this.memory.has(messageId)) return false;

    const stored = await this.safeGet(MessageDedup.key(messageId));
    const seenAt = readTimestamp(stored);
    if (seenAt !== undefined && this.now() - seenAt < this.ttlMs) {
      this.memory.set(messageId, seenAt);
      return false;
    }

    const at = this.now();
    this.memory.set(messageId, at);
    await this.safeSet(MessageDedup.key(messageId), { at });
    return true;
  }

  private async safeGet(key: string): Promise<unknown> {
    try {
      return await this.storage.get(key);
    } catch (err) {
      this.log.warn("去重 storage.get 失败", { key, error: errorMessage(err) });
      return undefined;
    }
  }

  private async safeSet(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.set(key, value);
    } catch (err) {
      this.log.warn("去重 storage.set 失败", { key, error: errorMessage(err) });
    }
  }
}

function readTimestamp(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const at = (value as { at?: unknown }).at;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}
