/**
 * 飞书 chat ↔ opencode session 映射，持久化在 `ctx.storage`。
 *
 * 双向索引：
 * - `feishu:v2:chat:<chatId>`    → { sessionID, openId }
 * - `feishu:v2:session:<sid>`    → { chatId, openId }
 *
 * 内存缓存用于 `permission.evaluate` 这种热路径同步判定是否存在可用投递目标。
 */
import { errorMessage } from "../logger.js";
import type { Logger, SessionLink, StorageLike } from "../types.js";

export const CHAT_KEY_PREFIX = "feishu:v2:chat:";
export const SESSION_KEY_PREFIX = "feishu:v2:session:";

interface ChatRecord {
  readonly sessionID: string;
  readonly openId: string;
}

export class SessionMap {
  private readonly sessionToChat = new Map<string, SessionLink>();
  private readonly chatToSession = new Map<string, string>();

  constructor(
    private readonly storage: StorageLike,
    private readonly log: Logger,
  ) {}

  /** 同步判定：是否有已知飞书投递目标。热路径用。 */
  hasSession(sessionID: string): boolean {
    return this.sessionToChat.has(sessionID);
  }

  getLink(sessionID: string): SessionLink | undefined {
    return this.sessionToChat.get(sessionID);
  }

  getSessionIdForChat(chatId: string): string | undefined {
    return this.chatToSession.get(chatId);
  }

  /** 冷启动/缓存未命中时从 storage 回填。 */
  async resolveBySession(sessionID: string): Promise<SessionLink | undefined> {
    const cached = this.sessionToChat.get(sessionID);
    if (cached) return cached;
    const stored = (await this.safeGet(`${SESSION_KEY_PREFIX}${sessionID}`)) as
      | { chatId?: unknown; openId?: unknown }
      | undefined;
    const chatId = typeof stored?.chatId === "string" ? stored.chatId : "";
    const openId = typeof stored?.openId === "string" ? stored.openId : "";
    if (!chatId) return undefined;
    const link: SessionLink = { chatId, openId };
    this.remember(sessionID, link);
    return link;
  }

  async resolveByChat(chatId: string): Promise<ChatRecord | undefined> {
    const cachedSid = this.chatToSession.get(chatId);
    if (cachedSid) {
      const link = this.sessionToChat.get(cachedSid);
      if (link) return { sessionID: cachedSid, openId: link.openId };
      return { sessionID: cachedSid, openId: "" };
    }
    const stored = (await this.safeGet(`${CHAT_KEY_PREFIX}${chatId}`)) as
      | { sessionID?: unknown; openId?: unknown }
      | undefined;
    const sessionID = typeof stored?.sessionID === "string" ? stored.sessionID : "";
    if (!sessionID) return undefined;
    const openId = typeof stored?.openId === "string" ? stored.openId : "";
    const link: SessionLink = { chatId, openId };
    this.remember(sessionID, link);
    return { sessionID, openId };
  }

  async link(chatId: string, sessionID: string, openId: string): Promise<void> {
    const link: SessionLink = { chatId, openId };
    this.remember(sessionID, link);
    await this.safeSet(`${CHAT_KEY_PREFIX}${chatId}`, { sessionID, openId });
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, { chatId, openId });
  }

  private remember(sessionID: string, link: SessionLink): void {
    this.sessionToChat.set(sessionID, link);
    this.chatToSession.set(link.chatId, sessionID);
  }

  private async safeGet(key: string): Promise<unknown> {
    try {
      return await this.storage.get(key);
    } catch (err) {
      this.log.warn("storage.get 失败", { key, error: errorMessage(err) });
      return undefined;
    }
  }

  private async safeSet(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.set(key, value);
    } catch (err) {
      this.log.warn("storage.set 失败", { key, error: errorMessage(err) });
    }
  }
}
