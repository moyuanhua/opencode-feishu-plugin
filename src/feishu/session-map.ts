/**
 * 飞书 chat ↔ opencode session 映射，持久化在 `ctx.storage`。
 *
 * 多会话模型（P2）：
 * - `feishu:v2:chat:<chatId>:sessions` → { sessions: Array<{sessionID,title,updatedAt}>, active? }
 * - `feishu:v2:chat:<chatId>`           → 旧版单值 { sessionID, openId }，**仅向后兼容读取**，
 *                                          读到即迁移到新结构（并删除旧 key）
 * - `feishu:v2:session:<sid>`           → { chatId, openId }（权限路由依赖，**保持不变**）
 *
 * 内存缓存用于 `permission.evaluate` 这种热路径同步判定是否存在可用投递目标。
 */
import { errorMessage } from "../logger.js";
import type { Logger, SessionLink, StorageLike } from "../types.js";

export const CHAT_KEY_PREFIX = "feishu:v2:chat:";
export const SESSION_KEY_PREFIX = "feishu:v2:session:";
/** 新多会话 key 的后缀：`feishu:v2:chat:<chatId>:sessions`。 */
export const CHAT_SESSIONS_SUFFIX = ":sessions";

/** 单个会话条目（持久化结构；openId 仍存在 session 索引里，避免重复）。 */
export interface SessionEntry {
  readonly sessionID: string;
  readonly title: string;
  readonly updatedAt: number;
}

/** 一个 chat 的多会话记录。 */
export interface ChatSessionsRecord {
  sessions: SessionEntry[];
  active?: string;
}

interface ChatRecord {
  readonly sessionID: string;
  readonly openId: string;
}

export interface SessionMapOptions {
  /** 时间源，便于单测。默认 Date.now。 */
  readonly now?: () => number;
}

export class SessionMap {
  private readonly sessionToChat = new Map<string, SessionLink>();
  /** chat → 当前会话 id（内存缓存，供同步读取）。 */
  private readonly chatToActive = new Map<string, string>();
  /** chat → 多会话记录（内存缓存，热路径/命令共用）。 */
  private readonly chatCache = new Map<string, ChatSessionsRecord>();
  private readonly now: () => number;

  constructor(
    private readonly storage: StorageLike,
    private readonly log: Logger,
    options: SessionMapOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** 同步判定：是否有已知飞书投递目标。热路径用。 */
  hasSession(sessionID: string): boolean {
    return this.sessionToChat.has(sessionID);
  }

  getLink(sessionID: string): SessionLink | undefined {
    return this.sessionToChat.get(sessionID);
  }

  /** 当前激活会话 id（仅内存缓存；冷启动请用 `getActive`）。 */
  getSessionIdForChat(chatId: string): string | undefined {
    return this.chatToActive.get(chatId);
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

  /** 解析 chat 的**当前**会话（向后兼容旧调用）。 */
  async resolveByChat(chatId: string): Promise<ChatRecord | undefined> {
    const active = await this.getActive(chatId);
    if (!active) return undefined;
    const link = await this.resolveBySession(active.sessionID);
    return { sessionID: active.sessionID, openId: link?.openId ?? "" };
  }

  /** 列出会话（保持插入顺序，稳定；`/use <序号>` 依赖此顺序）。 */
  async listSessions(chatId: string): Promise<SessionEntry[]> {
    const record = await this.loadChat(chatId);
    return record.sessions.map((s) => ({ ...s }));
  }

  /** 当前会话；无则 undefined。 */
  async getActive(chatId: string): Promise<SessionEntry | undefined> {
    const record = await this.loadChat(chatId);
    if (!record.active) return undefined;
    const entry = record.sessions.find((s) => s.sessionID === record.active);
    return entry ? { ...entry } : undefined;
  }

  /** 新增会话（已存在则更新标题/时间）并设为当前。 */
  async addSession(chatId: string, sessionID: string, title: string, openId: string): Promise<void> {
    const record = await this.loadChat(chatId);
    const entry: SessionEntry = { sessionID, title, updatedAt: this.now() };
    const index = record.sessions.findIndex((s) => s.sessionID === sessionID);
    if (index >= 0) record.sessions[index] = entry;
    else record.sessions.push(entry);
    record.active = sessionID;
    this.remember(sessionID, { chatId, openId });
    await this.persist(chatId, record);
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, { chatId, openId });
  }

  /** 切换当前会话；会话不属于该 chat 时返回 false。 */
  async setActive(chatId: string, sessionID: string): Promise<boolean> {
    const record = await this.loadChat(chatId);
    if (!record.sessions.some((s) => s.sessionID === sessionID)) return false;
    record.active = sessionID;
    await this.persist(chatId, record);
    if (!this.sessionToChat.has(sessionID)) await this.resolveBySession(sessionID);
    return true;
  }

  /** 移除会话；若移除的是当前会话，则回退到剩余列表最后一个。 */
  async removeSession(chatId: string, sessionID: string): Promise<boolean> {
    const record = await this.loadChat(chatId);
    const before = record.sessions.length;
    record.sessions = record.sessions.filter((s) => s.sessionID !== sessionID);
    if (record.sessions.length === before) return false;
    if (record.active === sessionID) {
      record.active = record.sessions[record.sessions.length - 1]?.sessionID;
    }
    this.sessionToChat.delete(sessionID);
    await this.persist(chatId, record);
    await this.safeRemove(`${SESSION_KEY_PREFIX}${sessionID}`);
    return true;
  }

  /** 重命名会话。 */
  async renameSession(chatId: string, sessionID: string, title: string): Promise<boolean> {
    const record = await this.loadChat(chatId);
    const index = record.sessions.findIndex((s) => s.sessionID === sessionID);
    if (index < 0) return false;
    record.sessions[index] = { sessionID, title, updatedAt: this.now() };
    await this.persist(chatId, record);
    return true;
  }

  /** 兼容旧 API：把会话（重新）绑定到 chat 并设为当前。 */
  async link(chatId: string, sessionID: string, openId: string): Promise<void> {
    await this.addSession(chatId, sessionID, "", openId);
  }

  private remember(sessionID: string, link: SessionLink): void {
    this.sessionToChat.set(sessionID, link);
  }

  private cacheChat(chatId: string, record: ChatSessionsRecord): void {
    this.chatCache.set(chatId, record);
    if (record.active) this.chatToActive.set(chatId, record.active);
    else this.chatToActive.delete(chatId);
  }

  private async persist(chatId: string, record: ChatSessionsRecord): Promise<void> {
    this.cacheChat(chatId, record);
    await this.safeSet(`${CHAT_KEY_PREFIX}${chatId}${CHAT_SESSIONS_SUFFIX}`, serialize(record));
  }

  /**
   * 读取 chat 多会话记录，必要时从旧单值 key 迁移。
   * 记录本身会缓存在内存，避免命令/热路径反复读 storage。
   */
  private async loadChat(chatId: string): Promise<ChatSessionsRecord> {
    const cached = this.chatCache.get(chatId);
    if (cached) return cached;

    const modern = await this.safeGet(`${CHAT_KEY_PREFIX}${chatId}${CHAT_SESSIONS_SUFFIX}`);
    const parsed = parseChatSessions(modern);
    if (parsed) {
      this.cacheChat(chatId, parsed);
      return parsed;
    }

    // 向后兼容：旧版 chat 单值记录 → 迁移成多会话结构。
    const legacy = await this.safeGet(`${CHAT_KEY_PREFIX}${chatId}`);
    const legacySessionID = isRecord(legacy) ? str(legacy.sessionID) : "";
    const legacyOpenId = isRecord(legacy) ? str(legacy.openId) : "";
    const migrated: ChatSessionsRecord = { sessions: [] };

    if (legacySessionID) {
      migrated.sessions.push({ sessionID: legacySessionID, title: "", updatedAt: this.now() });
      migrated.active = legacySessionID;
      this.remember(legacySessionID, { chatId, openId: legacyOpenId });
      // 补齐 session 索引，保证权限路由在重启后仍可用。
      await this.safeSet(`${SESSION_KEY_PREFIX}${legacySessionID}`, { chatId, openId: legacyOpenId });
      await this.safeSet(`${CHAT_KEY_PREFIX}${chatId}${CHAT_SESSIONS_SUFFIX}`, serialize(migrated));
      await this.safeRemove(`${CHAT_KEY_PREFIX}${chatId}`);
      this.log.info("已迁移 chat 单会话记录为多会话结构", { chatId, sessionID: legacySessionID });
    }

    this.cacheChat(chatId, migrated);
    return migrated;
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

  private async safeRemove(key: string): Promise<void> {
    try {
      await this.storage.remove(key);
    } catch (err) {
      this.log.warn("storage.remove 失败", { key, error: errorMessage(err) });
    }
  }
}

function serialize(record: ChatSessionsRecord): { sessions: SessionEntry[]; active?: string } {
  return { sessions: record.sessions, ...(record.active ? { active: record.active } : {}) };
}

/** 解析新结构；格式非法返回 undefined（调用方回退到旧结构）。 */
function parseChatSessions(value: unknown): ChatSessionsRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return undefined;
  const sessions: SessionEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value.sessions) {
    if (!isRecord(raw)) continue;
    const sessionID = str(raw.sessionID);
    if (!sessionID || seen.has(sessionID)) continue;
    seen.add(sessionID);
    const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
    sessions.push({ sessionID, title: str(raw.title), updatedAt });
  }
  const activeRaw = typeof value.active === "string" ? value.active : "";
  const active = activeRaw && seen.has(activeRaw) ? activeRaw : sessions[sessions.length - 1]?.sessionID;
  return { sessions, ...(active ? { active } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
