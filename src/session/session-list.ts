/**
 * `/sessions` 列表 + 分页 + 「进入话题」动作（纯重构：从 `session-commands.ts` 抽出）。
 *
 * 数据源优先 `ctx.session.list()`（经 `normalizeSessionList` 归一化），
 * 缺失/形状不识别时回退 `SessionMap.listSessions`。
 */
import { errorMessage } from "../logger.js";
import type { CardAction, IncomingMessage } from "../types.js";
import {
  buildSessionListCard,
  buildSessionMissingCard,
  buildSessionOpenedCard,
  type SessionCardValue,
  type SessionListRow,
} from "../feishu/session-cards.js";
import {
  fallbackEntries,
  normalizeSessionInfo,
  normalizeSessionList,
  type SessionListEntry,
} from "../feishu/session-list.js";
import { toast, type SessionPrimitives, type SessionListApi } from "./context.js";
import { sendSetupFormForChat } from "./setup-wizard.js";

/**
 * `/sessions`（别名 `/ls`）：列出 opencode **全部**会话（按最近更新倒序、分页 8 条）。
 * 数据源优先 `ctx.session.list()`；拿不到时回退 SessionMap 映射表。
 */
export async function cmdSessions(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  page = 0,
): Promise<void> {
  const entries = await loadSessionEntries(ctx, message.chatId);
  const active = await ctx.deps.sessionMap.getActive(message.chatId);
  const card = await buildListCard(ctx, message.chatId, entries, page, active?.sessionID);
  const res = await ctx.deps.sender.sendCard(message.chatId, card);
  if (!res.ok) {
    ctx.deps.log.warn("会话卡片发送失败", { chatId: message.chatId, error: res.error ?? "unknown" });
  }
}

/**
 * 加载全量会话列表：优先 `ctx.session.list()`（归一化），失败/形状不识别回退 SessionMap。
 * 关键诊断日志：`列出全部会话` / `会话列表回退到 SessionMap`。
 */
export async function loadSessionEntries(
  ctx: SessionPrimitives,
  chatId: string,
): Promise<SessionListEntry[]> {
  if (ctx.deps.listAllSessions) {
    try {
      const raw = await ctx.deps.listAllSessions();
      const normalized = normalizeSessionList(raw);
      if (normalized) {
        ctx.deps.log.info("列出全部会话", { count: normalized.length, source: "session.list" });
        return normalized;
      }
      ctx.deps.log.warn("session.list 返回形状无法识别，回退 SessionMap 列表", { chatId });
    } catch (err) {
      ctx.deps.log.warn("session.list 调用失败，回退 SessionMap 列表", {
        chatId,
        error: errorMessage(err),
      });
    }
  } else {
    ctx.deps.log.warn("运行时未暴露 session.list，回退 SessionMap 列表", { chatId });
  }
  const fallback = fallbackEntries(await ctx.deps.sessionMap.listSessions(chatId));
  ctx.deps.log.warn("会话列表回退到 SessionMap", { chatId, count: fallback.length });
  return fallback;
}

/** 把全量列表切成当前页并构建列表卡（含「已绑话题」标记）。 */
export async function buildListCard(
  ctx: SessionPrimitives,
  chatId: string,
  entries: readonly SessionListEntry[],
  page: number,
  activeID?: string,
): Promise<object> {
  const pageSize = ctx.sessionPageSize;
  const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const slice = entries.slice(safePage * pageSize, safePage * pageSize + pageSize);
  const rows: SessionListRow[] = [];
  for (let i = 0; i < slice.length; i += 1) {
    const entry = slice[i]!;
    const bound = Boolean(await ctx.deps.sessionMap.threadIdForSession(entry.sessionID));
    rows.push({
      index: safePage * pageSize + i + 1,
      sessionID: entry.sessionID,
      title: entry.title,
      updatedAt: entry.updatedAt,
      ...(entry.directory ? { directory: entry.directory } : {}),
      bound,
      ...(entry.sessionID === activeID ? { active: true } : {}),
    });
  }
  return buildSessionListCard({
    chatId,
    rows,
    page: safePage,
    pageCount,
    total: entries.length,
    now: ctx.now(),
  });
}

/**
 * 「进入话题」核心流程（卡片动作 / `/resume` 共用）：
 * `reply_in_thread` 对触发消息开新话题 → 发「✅ 已进入会话」卡 → 拿 thread_id 绑定
 * thread + root 映射。成功后该话题内消息即续上历史会话（opencode 上下文天然持久）。
 */
export async function enterSessionThread(
  ctx: SessionPrimitives,
  input: {
    readonly chatId: string;
    readonly sessionID: string;
    readonly anchorMessageId: string;
    readonly operatorOpenId: string;
    readonly info?: SessionListEntry;
    /** 失败时 patch 的卡片消息 id（列表卡）；`/resume` 不传则改用文本回复。 */
    readonly patchMessageId?: string;
    readonly source: "card" | "resume";
  },
): Promise<{ ok: boolean; threadId?: string; error?: string }> {
  const { chatId, sessionID, anchorMessageId, operatorOpenId } = input;
  if (!anchorMessageId || !chatId) {
    return { ok: false, error: "missing anchor/chat" };
  }
  const info = input.info;
  const card = buildSessionOpenedCard({
    title: info?.title ?? "",
    sessionID,
    ...(info?.directory ? { dir: info.directory } : {}),
    ...(info?.updatedAt ? { updatedAt: info.updatedAt } : {}),
    now: ctx.now(),
  });
  const res = await ctx.deps.sender.replyCard(anchorMessageId, card, { replyInThread: true });
  ctx.deps.log.info("进入会话并开话题", {
    sessionID,
    source: input.source,
    anchorMessageId,
    replyOk: res.ok,
    replyMessageId: res.messageId,
    replyThreadId: res.threadId,
    replyError: res.error,
  });
  if (!res.ok || !res.messageId) {
    const error = res.error ?? "unknown";
    ctx.deps.log.warn("进入话题失败", { sessionID, anchorMessageId, error });
    if (input.patchMessageId) {
      await ctx.deps.sender.patchCard(
        input.patchMessageId,
        buildSessionMissingCard(sessionID, error),
      );
    }
    return { ok: false, error };
  }

  // reply 响应可能不含 thread_id → 读回消息元数据兜底。
  const meta = res.threadId ? undefined : await ctx.deps.sender.getMessageMeta(res.messageId);
  const threadId = res.threadId ?? meta?.threadId;
  if (!threadId) {
    ctx.deps.log.warn("进入话题后未读到 thread_id，该会话暂无法自动路由", { messageId: res.messageId });
    return { ok: false, error: "未拿到话题 ID" };
  }

  await ctx.deps.sessionMap.bindThread(threadId, sessionID, chatId, operatorOpenId, anchorMessageId);
  await ctx.deps.sessionMap.bindRoot(res.messageId, sessionID);
  ctx.deps.log.info("已绑定话题与会话", { sessionID, threadId, rootId: res.messageId });
  return { ok: true, threadId };
}

/**
 * `{cmd:"open"}`：白名单（上层已校验）→ `ctx.session.get` 校验存在 →
 * 不存在 toast「会话不存在」并 patch 提示；存在则后台开话题并绑定。
 */
export async function handleOpenCardAction(
  ctx: SessionPrimitives,
  action: CardAction,
  value: Extract<SessionCardValue, { cmd: "open" }>,
): Promise<object> {
  if (!ctx.threadRouting) {
    return toast("error", "当前为回退模式，不支持话题路由");
  }
  const chatId = action.chatId || value.chatId;
  const hasApi = Boolean(ctx.deps.getSessionInfo);
  const info = hasApi ? normalizeSessionInfo(await ctx.deps.getSessionInfo!(value.sessionID)) : undefined;
  if (hasApi && !info) {
    ctx.deps.log.warn("进入话题失败：会话不存在", { sessionID: value.sessionID, chatId });
    void patchMissingCard(ctx, action.messageId, value.sessionID).catch((err) => {
      ctx.deps.log.warn("会话不存在提示卡 patch 失败", { error: errorMessage(err) });
    });
    return toast("error", "会话不存在");
  }
  const snapshot: SessionListEntry = info ?? { sessionID: value.sessionID, title: "", updatedAt: 0 };
  void enterSessionThread(ctx, {
    chatId,
    sessionID: value.sessionID,
    anchorMessageId: action.messageId,
    operatorOpenId: action.operatorOpenId,
    info: snapshot,
    patchMessageId: action.messageId,
    source: "card",
  }).catch((err) => {
    ctx.deps.log.warn("进入话题处理失败", { sessionID: value.sessionID, error: errorMessage(err) });
  });
  return toast("success", "正在进入话题…");
}

/** 会话不存在：把原列表卡 patch 成提示卡。 */
export async function patchMissingCard(
  ctx: SessionPrimitives,
  messageId: string,
  sessionID: string,
): Promise<void> {
  if (!messageId) return;
  await ctx.deps.sender.patchCard(messageId, buildSessionMissingCard(sessionID));
}

/**
 * 会话卡按钮（`use` / `new` / `list`；`open` 由 `handleOpenCardAction` 处理）。
 * - `new`：发送 `/form` 建会话表单卡（不再直接建会话）；
 * - `list`：按页码 patch 当前列表卡；
 * - `use`：旧卡片兼容，切换当前会话并刷新列表（含翻页位置）。
 */
export async function applySessionCardAction(
  ctx: SessionPrimitives,
  action: CardAction,
  value: SessionCardValue,
): Promise<void> {
  const chatId = action.chatId || value.chatId;
  if (!chatId) return;

  if (value.cmd === "new") {
    await sendSetupFormForChat(ctx, chatId, action.messageId, action.operatorOpenId);
    return;
  }
  if (value.cmd === "list") {
    if (action.messageId) await patchListCard(ctx, chatId, action.messageId, value.page);
    return;
  }
  if (value.cmd === "open") {
    // 理论上不会走到这（open 在 handleCardAction 提前处理）；防御式兜底。
    return;
  }

  const ok = await ctx.deps.sessionMap.setActive(chatId, value.sessionID);
  if (!ok) ctx.deps.log.debug("卡片切换会话失败：会话不存在", { sessionID: value.sessionID });
  if (action.messageId) await patchListCard(ctx, chatId, action.messageId);
}

export async function patchListCard(
  ctx: SessionPrimitives,
  chatId: string,
  messageId: string,
  page = 0,
): Promise<void> {
  const entries = await loadSessionEntries(ctx, chatId);
  const active = await ctx.deps.sessionMap.getActive(chatId);
  const card = await buildListCard(ctx, chatId, entries, page, active?.sessionID);
  const res = await ctx.deps.sender.patchCard(messageId, card);
  if (!res.ok) ctx.deps.log.warn("会话卡片更新失败", { error: res.error ?? "unknown" });
}

/** 会话列表 / 进入话题 API 装配（挂到 ctx 上供命令分发调用）。 */
export function createSessionListApi(ctx: SessionPrimitives): SessionListApi {
  return {
    cmdSessions: (message, page) => cmdSessions(ctx, message, page),
    loadSessionEntries: (chatId) => loadSessionEntries(ctx, chatId),
    buildListCard: (chatId, entries, page, activeID) => buildListCard(ctx, chatId, entries, page, activeID),
    enterSessionThread: (input) => enterSessionThread(ctx, input),
    handleOpenCardAction: (action, value) => handleOpenCardAction(ctx, action, value),
    patchMissingCard: (messageId, sessionID) => patchMissingCard(ctx, messageId, sessionID),
    applySessionCardAction: (action, value) => applySessionCardAction(ctx, action, value),
    patchListCard: (chatId, messageId, page) => patchListCard(ctx, chatId, messageId, page),
  };
}
