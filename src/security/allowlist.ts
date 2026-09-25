/**
 * 单人白名单判定（纯函数）。
 *
 * SPEC：allowUsers 之外的用户静默忽略；空数组 = 仅应用 owner。
 * owner 的发现/持久化在 index.ts 的 OwnerPolicy 里完成，这里只做集合判定，
 * 保证「单人边界」的核心逻辑可被单测覆盖。
 */
import type { StorageLike } from "../types.js";

export const OWNER_STORAGE_KEY = "feishu:v2:owner";

export function isUserAllowed(openId: string | undefined, allowUsers: readonly string[]): boolean {
  if (!openId) return false;
  if (allowUsers.length === 0) return false;
  return allowUsers.includes(openId);
}

/** 匹配工具名：支持精确匹配与通配 `*`。 */
export function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => p === "*" || p === value || (p.endsWith("*") && value.startsWith(p.slice(0, -1))));
}

/**
 * owner 解析策略：
 * - allowUsers 非空 → 直接用白名单；
 * - allowUsers 为空 → 从 storage 读 owner；没有则把首个发消息的人绑定为 owner 并持久化。
 *
 * 安全性：飞书应用「可用范围=仅本人」保证只有 owner 能与机器人单聊，
 * 因此「首个发消息者」在平台层就是 owner。
 */
export class OwnerPolicy {
  private readonly allowed = new Set<string>();
  private owner?: string;
  private loaded: boolean;

  constructor(
    private readonly storage: StorageLike,
    private readonly allowUsers: readonly string[],
  ) {
    for (const id of allowUsers) this.allowed.add(id);
    this.loaded = allowUsers.length > 0;
  }

  /** 启动时调用；allowUsers 为空才需要读 storage。 */
  async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.safeGet(OWNER_STORAGE_KEY);
    if (typeof stored === "string" && stored.length > 0) {
      this.owner = stored;
      this.allowed.add(stored);
    }
    this.loaded = true;
  }

  isAllowed(openId: string | undefined): boolean {
    if (!openId) return false;
    return this.allowed.has(openId);
  }

  /**
   * 处理一条入站消息的发送者，必要时完成 owner 引导。
   * 返回是否允许继续处理。
   */
  async admit(senderOpenId: string | undefined): Promise<boolean> {
    if (!senderOpenId) return false;
    await this.load();
    if (this.allowed.has(senderOpenId)) return true;
    // allowUsers 为空且尚无 owner → 绑定。
    if (this.allowUsers.length === 0 && !this.owner) {
      this.owner = senderOpenId;
      this.allowed.add(senderOpenId);
      await this.safeSet(OWNER_STORAGE_KEY, senderOpenId);
      return true;
    }
    return false;
  }

  get ownerId(): string | undefined {
    return this.owner ?? (this.allowUsers.length === 1 ? this.allowUsers[0] : undefined);
  }

  private async safeGet(key: string): Promise<unknown> {
    try {
      return await this.storage.get(key);
    } catch {
      return undefined;
    }
  }

  private async safeSet(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.set(key, value);
    } catch {
      // 持久化失败不影响本次会话可用（内存已放行）。
    }
  }
}
