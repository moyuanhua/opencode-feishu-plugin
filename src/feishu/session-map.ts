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
import type {
  Logger,
  SessionLink,
  SessionRootCardBase,
  StorageLike,
  ThreadLink,
} from "../types.js";

export const CHAT_KEY_PREFIX = "feishu:v2:chat:";
export const SESSION_KEY_PREFIX = "feishu:v2:session:";
/** 新多会话 key 的后缀：`feishu:v2:chat:<chatId>:sessions`。 */
export const CHAT_SESSIONS_SUFFIX = ":sessions";
/** 话题 → 会话映射：`feishu:v2:thread:<threadId>`（P5）。 */
export const THREAD_KEY_PREFIX = "feishu:v2:thread:";
/** 话题根消息 → 会话映射：`feishu:v2:root:<rootId>`（P5，手动从卡片建话题）。 */
export const ROOT_KEY_PREFIX = "feishu:v2:root:";
/** 会话 → 最近话题 反向索引：`feishu:v2:session-thread:<sessionID>`（P7，列表标记「已绑话题」）。 */
export const SESSION_THREAD_KEY_PREFIX = "feishu:v2:session-thread:";

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

/** `addSession` 的可选行为。 */
export interface AddSessionOptions {
  /** 是否把新会话设为当前；默认 true。话题内新建会话时传 false，避免抢走主聊天流的当前会话。 */
  readonly setActive?: boolean;
}

export class SessionMap {
  private readonly sessionToChat = new Map<string, SessionLink>();
  /** chat → 当前会话 id（内存缓存，供同步读取）。 */
  private readonly chatToActive = new Map<string, string>();
  /** chat → 多会话记录（内存缓存，热路径/命令共用）。 */
  private readonly chatCache = new Map<string, ChatSessionsRecord>();
  /** threadId → 会话映射（内存缓存）。 */
  private readonly threadCache = new Map<string, ThreadLink>();
  /** rootId → sessionID（内存缓存）。 */
  private readonly rootCache = new Map<string, string>();
  /** sessionID → 最近绑定的话题 id（反向索引内存缓存，P7）。 */
  private readonly sessionToThread = new Map<string, string>();
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
    const stored = await this.safeGet(`${SESSION_KEY_PREFIX}${sessionID}`);
    const link = parseSessionLink(stored);
    if (!link) return undefined;
    this.remember(sessionID, link);
    return link;
  }

  /**
   * 更新会话元数据（P6：perm/gateMode/dir/model），保留 chatId/openId/replyMessageId。
   * 会话不存在返回 false。patch 中值为 `undefined` 表示删除该字段。
   */
  async setSessionMeta(sessionID: string, patch: Partial<Omit<SessionLink, "chatId" | "openId">>): Promise<boolean> {
    const existing = await this.resolveBySession(sessionID);
    if (!existing) return false;
    const next: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    const link = next as unknown as SessionLink;
    this.remember(sessionID, link);
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, serializeSession(link));
    return true;
  }

  /**
   * 绑定话题 → 会话（P5）。同时把 `replyMessageId`（锚点消息）写进 session 索引，
   * 让审批卡等**异步出站**也能用 reply 落在同一话题内。
   */
  async bindThread(
    threadId: string,
    sessionID: string,
    chatId: string,
    openId: string,
    anchorMessageId?: string,
  ): Promise<void> {
    if (!threadId || !sessionID) return;
    const link: ThreadLink = { sessionID, chatId, openId, ...(anchorMessageId ? { anchorMessageId } : {}) };
    this.threadCache.set(threadId, link);
    await this.safeSet(`${THREAD_KEY_PREFIX}${threadId}`, serializeThread(link));

    // 反向索引：session → 最近话题（列表卡标记「已绑话题」/「再开话题」用）。
    this.sessionToThread.set(sessionID, threadId);
    await this.safeSet(`${SESSION_THREAD_KEY_PREFIX}${sessionID}`, { threadId });

    // 保留已有的会话元数据（perm/gateMode/dir/model），只更新 chat/openId/锚点。
    const existing = this.sessionToChat.get(sessionID) ?? (await this.readSessionLink(sessionID));
    const sessionLink: SessionLink = {
      ...existing,
      chatId,
      openId,
      ...(anchorMessageId ? { replyMessageId: anchorMessageId } : {}),
    };
    this.remember(sessionID, sessionLink);
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, serializeSession(sessionLink));
  }

  /** 解析话题对应的会话；未命中返回 undefined（冷缓存回填）。 */
  async resolveByThread(threadId: string): Promise<ThreadLink | undefined> {
    if (!threadId) return undefined;
    const cached = this.threadCache.get(threadId);
    if (cached) return cached;
    const stored = await this.safeGet(`${THREAD_KEY_PREFIX}${threadId}`);
    const link = parseThreadLink(stored);
    if (link) this.threadCache.set(threadId, link);
    return link;
  }

  /**
   * 反向查询：该会话最近绑定的话题 id（P7）。
   * 用于列表卡标记「💬 已绑话题」与按钮文案「再开话题」。冷缓存回填。
   */
  async threadIdForSession(sessionID: string): Promise<string | undefined> {
    if (!sessionID) return undefined;
    const cached = this.sessionToThread.get(sessionID);
    if (cached) return cached;
    const stored = await this.safeGet(`${SESSION_THREAD_KEY_PREFIX}${sessionID}`);
    const threadId = isRecord(stored) ? str(stored.threadId) : "";
    if (!threadId) return undefined;
    this.sessionToThread.set(sessionID, threadId);
    return threadId;
  }

  /** 绑定话题根消息 → 会话（手动从卡片建话题时用根消息 id 反查）。 */
  async bindRoot(rootId: string, sessionID: string): Promise<void> {
    if (!rootId || !sessionID) return;
    this.rootCache.set(rootId, sessionID);
    await this.safeSet(`${ROOT_KEY_PREFIX}${rootId}`, { sessionID });
  }

  /** 解析话题根消息对应的会话。 */
  async resolveByRoot(rootId: string): Promise<{ sessionID: string } | undefined> {
    if (!rootId) return undefined;
    const cached = this.rootCache.get(rootId);
    if (cached) return { sessionID: cached };
    const stored = await this.safeGet(`${ROOT_KEY_PREFIX}${rootId}`);
    const sessionID = isRecord(stored) && typeof stored.sessionID === "string" ? stored.sessionID : "";
    if (!sessionID) return undefined;
    this.rootCache.set(rootId, sessionID);
    return { sessionID };
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

  /** 按 id 取会话条目（话题内 `/current` 等需要标题）。 */
  async getSession(chatId: string, sessionID: string): Promise<SessionEntry | undefined> {
    const record = await this.loadChat(chatId);
    const entry = record.sessions.find((s) => s.sessionID === sessionID);
    return entry ? { ...entry } : undefined;
  }

  /** 新增会话（已存在则更新标题/时间）并设为当前（可用 options.setActive=false 保留原当前）。 */
  async addSession(
    chatId: string,
    sessionID: string,
    title: string,
    openId: string,
    options: AddSessionOptions = {},
  ): Promise<void> {
    const record = await this.loadChat(chatId);
    const entry: SessionEntry = { sessionID, title, updatedAt: this.now() };
    const index = record.sessions.findIndex((s) => s.sessionID === sessionID);
    if (index >= 0) record.sessions[index] = entry;
    else record.sessions.push(entry);
    if (options.setActive === false) {
      // 话题内新建会话不应抢走主聊天流的当前会话；仅在原本没有当前时兜底。
      if (!record.active) record.active = sessionID;
    } else {
      record.active = sessionID;
    }
    // 保留已有的会话元数据（replyMessageId/perm/gateMode/dir/model），避免被冲掉。
    const existing = this.sessionToChat.get(sessionID) ?? (await this.readSessionLink(sessionID));
    const link: SessionLink = { ...existing, chatId, openId };
    this.remember(sessionID, link);
    await this.persist(chatId, record);
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, serializeSession(link));
  }

  /**
   * 为**外部来源**的会话（TUI/Web，无飞书映射）补一条会话索引（P7.5）。
   *
   * `/ls` 列出 opencode 全量会话后，用户「进入话题」的会话需要审批投递、
   * 跨 location 路由（`dir`）与失败通知的目标。已存在则只补缺失字段，
   * **不覆盖** perm/gateMode/model 等既有元数据。
   */
  async ensureSessionLink(
    sessionID: string,
    input: { readonly chatId: string; readonly openId: string; readonly directory?: string },
  ): Promise<void> {
    if (!sessionID || !input.chatId) return;
    const existing = await this.resolveBySession(sessionID);
    const link: SessionLink = {
      ...existing,
      chatId: input.chatId,
      openId: input.openId,
      ...(input.directory ? { dir: input.directory } : {}),
    };
    this.remember(sessionID, link);
    await this.safeSet(`${SESSION_KEY_PREFIX}${sessionID}`, serializeSession(link));
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

  /**
   * 写入 / 清除该会话的**话题根卡基础内容**（工作状态刷新用，见 `types.SessionRootCardBase`）。
   * 会话不存在返回 false（不凭空造卡）。
   */
  async setRootCard(sessionID: string, base: SessionRootCardBase | undefined): Promise<boolean> {
    return this.setSessionMeta(sessionID, { rootCard: base });
  }

  /** 读取该会话的话题根卡基础内容（无则 undefined，状态刷新将跳过）。 */
  async getRootCard(sessionID: string): Promise<SessionRootCardBase | undefined> {
    const link = await this.resolveBySession(sessionID);
    return link?.rootCard;
  }

  private remember(sessionID: string, link: SessionLink): void {
    this.sessionToChat.set(sessionID, link);
  }

  /** 只从 storage 读取会话索引（写入缓存并返回）。 */
  private async readSessionLink(sessionID: string): Promise<SessionLink | undefined> {
    const stored = await this.safeGet(`${SESSION_KEY_PREFIX}${sessionID}`);
    const link = parseSessionLink(stored);
    if (link) this.remember(sessionID, link);
    return link;
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

function serializeSession(link: SessionLink): {
  chatId: string;
  openId: string;
  replyMessageId?: string;
  perm?: SessionLink["perm"];
  gateMode?: SessionLink["gateMode"];
  dir?: string;
  model?: SessionLink["model"];
  allowActions?: readonly string[];
  rootCard?: SessionRootCardBase;
} {
  return {
    chatId: link.chatId,
    openId: link.openId,
    ...(link.replyMessageId ? { replyMessageId: link.replyMessageId } : {}),
    ...(link.perm ? { perm: link.perm } : {}),
    ...(link.gateMode ? { gateMode: link.gateMode } : {}),
    ...(link.dir ? { dir: link.dir } : {}),
    ...(link.model ? { model: link.model } : {}),
    ...(link.allowActions && link.allowActions.length > 0 ? { allowActions: [...link.allowActions] } : {}),
    ...(link.rootCard ? { rootCard: link.rootCard } : {}),
  };
}

/** 解析 session 索引；缺 chatId 视为非法。 */
function parseSessionLink(value: unknown): SessionLink | undefined {
  if (!isRecord(value)) return undefined;
  const chatId = str(value.chatId);
  if (!chatId) return undefined;
  const openId = str(value.openId);
  const replyMessageId = str(value.replyMessageId);
  const perm = isPreset(value.perm) ? value.perm : undefined;
  const gateMode = value.gateMode === "off" || value.gateMode === "gate" ? value.gateMode : undefined;
  const dir = str(value.dir);
  const model = parseModelRef(value.model);
  const allowActions = parseStringArray(value.allowActions);
  const rootCard = parseRootCard(value.rootCard);
  return {
    chatId,
    openId,
    ...(replyMessageId ? { replyMessageId } : {}),
    ...(perm ? { perm } : {}),
    ...(gateMode ? { gateMode } : {}),
    ...(dir ? { dir } : {}),
    ...(model ? { model } : {}),
    ...(allowActions.length > 0 ? { allowActions } : {}),
    ...(rootCard ? { rootCard } : {}),
  };
}

/** 解析 `SessionLink.rootCard`（话题根卡基础内容）；非法返回 undefined（状态刷新将跳过）。 */
function parseRootCard(value: unknown): SessionRootCardBase | undefined {
  if (!isRecord(value)) return undefined;
  const style = value.style === "created" || value.style === "resumed" ? value.style : undefined;
  const sessionID = str(value.sessionID);
  if (!style || !sessionID) return undefined;
  const title = str(value.title);
  const dir = str(value.dir);
  const model = str(value.model);
  const perm = str(value.perm);
  const summary = str(value.summary);
  const summaryLabel = str(value.summaryLabel);
  const compactError = str(value.compactError);
  const note = str(value.note);
  const updatedAt =
    typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : undefined;
  return {
    style,
    sessionID,
    title,
    ...(dir ? { dir } : {}),
    ...(model ? { model } : {}),
    ...(perm ? { perm } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(summary ? { summary } : {}),
    ...(summaryLabel ? { summaryLabel } : {}),
    ...(value.summaryPending === true ? { summaryPending: true } : {}),
    ...(value.compactPending === true ? { compactPending: true } : {}),
    ...(compactError ? { compactError } : {}),
    ...(value.compactButton === true ? { compactButton: true } : {}),
    ...(note ? { note } : {}),
    ...(value.openedTopic === true ? { openedTopic: true } : {}),
  };
}

/** 解析字符串数组（去空、去重）；非法返回 []。 */
function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function isPreset(value: unknown): value is NonNullable<SessionLink["perm"]> {
  return value === "readonly" || value === "edit" || value === "askHigh" || value === "trust";
}

function parseModelRef(value: unknown): NonNullable<SessionLink["model"]> | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = str(value.providerID);
  const id = str(value.id);
  if (!providerID || !id) return undefined;
  const name = str(value.name);
  return { providerID, id, ...(name ? { name } : {}) };
}

function serializeThread(link: ThreadLink): { sessionID: string; chatId: string; openId: string; anchorMessageId?: string } {
  return {
    sessionID: link.sessionID,
    chatId: link.chatId,
    openId: link.openId,
    ...(link.anchorMessageId ? { anchorMessageId: link.anchorMessageId } : {}),
  };
}

/** 解析 thread 映射；缺 sessionID 视为非法。 */
function parseThreadLink(value: unknown): ThreadLink | undefined {
  if (!isRecord(value)) return undefined;
  const sessionID = str(value.sessionID);
  if (!sessionID) return undefined;
  const chatId = str(value.chatId);
  const openId = str(value.openId);
  const anchorMessageId = str(value.anchorMessageId);
  return { sessionID, chatId, openId, ...(anchorMessageId ? { anchorMessageId } : {}) };
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
