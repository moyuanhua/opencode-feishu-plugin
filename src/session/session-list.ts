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
import { modelLabel } from "../feishu/models.js";
import type { CardLimitReport } from "../feishu/card-limits.js";
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
 * 加载全量会话列表，三级数据源：
 * 1. `ctx.session.list()`（插件原生域；V2 运行时通常未暴露）；
 * 2. **本机 HTTP `GET /api/session`**（与 opencode 同机时可用，能拿到 TUI/Web 会话）；
 * 3. `SessionMap` 映射表（只含机器人自己登记过的会话）。
 * 关键诊断日志：`列出全部会话` / `会话列表回退到 SessionMap`。
 */
export async function loadSessionEntries(
  ctx: SessionPrimitives,
  chatId: string,
): Promise<SessionListEntry[]> {
  const viaApi = await loadViaSessionListApi(ctx, chatId);
  if (viaApi) return viaApi;

  const viaHttp = await loadViaHttp(ctx, chatId);
  if (viaHttp) return viaHttp;

  const fallback = fallbackEntries(await ctx.deps.sessionMap.listSessions(chatId));
  ctx.deps.log.warn("会话列表回退到 SessionMap", { chatId, count: fallback.length });
  return fallback;
}

/** 数据源 1：`ctx.session.list()`。形状不识别/缺失/异常返回 undefined。 */
async function loadViaSessionListApi(
  ctx: SessionPrimitives,
  chatId: string,
): Promise<SessionListEntry[] | undefined> {
  if (!ctx.deps.listAllSessions) {
    ctx.deps.log.warn("运行时未暴露 session.list，尝试 HTTP 兜底", { chatId });
    return undefined;
  }
  try {
    const raw = await ctx.deps.listAllSessions();
    const normalized = normalizeSessionList(raw);
    if (normalized) {
      ctx.deps.log.info("列出全部会话", { count: normalized.length, source: "session.list" });
      return normalized;
    }
    ctx.deps.log.warn("session.list 返回形状无法识别，尝试 HTTP 兜底", { chatId });
  } catch (err) {
    ctx.deps.log.warn("session.list 调用失败，尝试 HTTP 兜底", {
      chatId,
      error: errorMessage(err),
    });
  }
  return undefined;
}

/** 数据源 2：本机 HTTP `GET /api/session`（全量会话，含 TUI/Web 来源）。 */
async function loadViaHttp(
  ctx: SessionPrimitives,
  chatId: string,
): Promise<SessionListEntry[] | undefined> {
  if (!ctx.deps.listAllSessionsHttp) return undefined;
  try {
    const raw = await ctx.deps.listAllSessionsHttp();
    const normalized = normalizeSessionList(raw);
    if (normalized) {
      ctx.deps.log.info("列出全部会话", { count: normalized.length, source: "http" });
      return normalized;
    }
    ctx.deps.log.warn("HTTP 会话列表形状无法识别，回退 SessionMap 列表", { chatId });
  } catch (err) {
    ctx.deps.log.warn("HTTP 会话列表调用失败，回退 SessionMap 列表", {
      chatId,
      error: errorMessage(err),
    });
  }
  return undefined;
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
 * `reply_in_thread` 对触发消息开新话题 → 发「🔄 <会话标题>」恢复卡 → 拿 thread_id 绑定
 * thread + root 映射。成功后该话题内消息即续上历史会话（opencode 上下文天然持久）。
 *
 * 任务 B：标题 = 会话主题（话题显示名即会话主题）；正文带会话 ID/目录/模型/最近活动，
 * 并异步补一个**会话摘要**（优先复用已有 compaction 摘要，缺失才走**快摘要**）。
 * 卡片另带**用户主动**的「🗜 压缩并总结」按钮——**绝不隐式触发**压缩（它会修改会话历史）。
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
): Promise<{ ok: boolean; threadId?: string; messageId?: string; error?: string }> {
  const { chatId, sessionID, anchorMessageId, operatorOpenId } = input;
  if (!anchorMessageId || !chatId) {
    return { ok: false, error: "missing anchor/chat" };
  }
  const info = input.info;
  const link = await ctx.deps.sessionMap.resolveBySession(sessionID);
  const dir = info?.directory ?? link?.dir;
  // 外部来源会话（TUI/Web 无映射）→ 补一条索引：审批投递 / 跨 location 路由 /
  // 失败通知都需要它。已有映射（含用户建会话）保持不变。
  if (!link) {
    await ctx.deps.sessionMap.ensureSessionLink(sessionID, {
      chatId,
      openId: operatorOpenId,
      ...(dir ? { directory: dir } : {}),
    });
  }
  const showSummary = (ctx.deps.resumeSummary ?? true) && Boolean(ctx.deps.summarizeSession);
  const onLimit = (report: CardLimitReport): void => {
    ctx.deps.log.warn("会话恢复卡内容超限，已降级", { sessionID, ...report });
  };
  const cardInput = {
    title: info?.title ?? "",
    sessionID,
    ...(dir ? { dir } : {}),
    ...(link?.model ? { model: modelLabel(link.model) } : {}),
    ...(info?.updatedAt ? { updatedAt: info.updatedAt } : {}),
    now: ctx.now(),
    ...(ctx.deps.cardMaxTables !== undefined ? { maxTables: ctx.deps.cardMaxTables } : {}),
    onLimit,
    ...(showSummary ? { summaryPending: true } : {}),
    // 「🗜 压缩并总结」只在开关开启且运行时装配了签名时渲染。
    ...(showSummary && ctx.deps.signCompact
      ? { compactButton: { sessionID, token: ctx.deps.signCompact(sessionID) } }
      : {}),
  };
  const card = buildSessionOpenedCard(cardInput);
  // 恢复会话：在主聊天流发一张**普通消息卡**作为该会话的"恢复卡"。
  // 不预先开话题——用户**回复这张卡**时飞书会自动在该卡下形成话题（root_id = 卡片消息 id），
  // 我们靠 root→session 映射把消息路由到该会话（见 index.ts 的入站路由）。
  const res = await ctx.deps.sender.sendCard(chatId, card);
  ctx.deps.log.info("发送会话恢复卡", {
    sessionID,
    source: input.source,
    anchorMessageId,
    sendOk: res.ok,
    cardMessageId: res.messageId,
    sendError: res.error,
  });
  if (!res.ok || !res.messageId) {
    const error = res.error ?? "unknown";
    ctx.deps.log.warn("发送恢复卡失败", { sessionID, anchorMessageId, error });
    if (input.patchMessageId) {
      await ctx.deps.sender.patchCard(
        input.patchMessageId,
        buildSessionMissingCard(sessionID, error),
      );
    }
    return { ok: false, error };
  }

  // 只绑 root：thread_id 要等用户第一次回复后才存在（届时入站路由会用 root 兜底并补写 thread 映射）。
  await ctx.deps.sessionMap.bindRoot(res.messageId, sessionID);
  ctx.deps.log.info("resume card bound root to session", { sessionID, rootId: res.messageId });

  // 持久化根卡基础内容：工作状态刷新时据此重渲染（不丢摘要/元信息）。
  await ctx.deps.sessionMap.setRootCard(sessionID, {
    style: "resumed",
    sessionID,
    title: info?.title ?? "",
    ...(dir ? { dir } : {}),
    ...(link?.model ? { model: modelLabel(link.model) } : {}),
    ...(info?.updatedAt ? { updatedAt: info.updatedAt } : {}),
    ...(showSummary ? { summaryPending: true, compactButton: Boolean(cardInput.compactButton) } : {}),
  });

  // 任务 B：快摘要**火后执行**——先发卡（回调 3 秒内已回 toast），拿到结果再 patch 同一张卡。
  // 刻意**不**在此处触发压缩（压缩会修改会话历史，必须用户主动点按钮）。
  if (showSummary) {
    void patchResumeSummary(ctx, sessionID, dir, res.messageId, cardInput);
  }
  // thread_id 由用户首次回复后经 root 路由補写，这里只带卡片消息 id。
  return { ok: true, messageId: res.messageId };
}

/** 摘要来源标注：复用原生摘要 / 快摘要 / 已压缩。 */
const SUMMARY_LABEL: Record<string, string> = {
  reused: "会话摘要",
  generated: "摘要（快摘要）",
  compacted: "已压缩 · 会话摘要",
};

/**
 * 任务 B：异步获取**快摘要**并 patch 回恢复卡。失败/超时降级为「摘要生成失败，可直接发消息继续」。
 * 永不抛异常（只 log.warn），绝不影响已发出去的恢复卡与话题绑定。
 */
async function patchResumeSummary(
  ctx: SessionPrimitives,
  sessionID: string,
  dir: string | undefined,
  messageId: string,
  cardInput: Parameters<typeof buildSessionOpenedCard>[0],
): Promise<void> {
  try {
    const outcome = await ctx.deps.summarizeSession!({
      sessionID,
      ...(dir ? { directory: dir } : {}),
      timeoutMs: ctx.deps.resumeSummaryTimeoutMs ?? 15_000,
    });
    const summary = outcome.summary ?? "（摘要生成失败，可直接发消息继续）";
    const summaryLabel = SUMMARY_LABEL[outcome.source] ?? "摘要";
    // 把摘要写回根卡基础内容：后续工作状态刷新重渲染时摘要不丢。
    const base = await ctx.deps.sessionMap.getRootCard(sessionID);
    if (base) {
      await ctx.deps.sessionMap.setRootCard(sessionID, { ...base, summaryPending: false, summary, summaryLabel });
    }
    const res = await ctx.deps.sender.patchCard(
      messageId,
      buildSessionOpenedCard({
        ...cardInput,
        summaryPending: false,
        summary,
        summaryLabel,
      }),
    );
    if (!res.ok) ctx.deps.log.warn("恢复卡摘要更新失败", { sessionID, error: res.error ?? "unknown" });
    ctx.deps.log.info("恢复卡摘要已更新", { sessionID, source: outcome.source, hasSummary: Boolean(outcome.summary) });
  } catch (err) {
    ctx.deps.log.warn("恢复卡摘要生成异常", { sessionID, error: errorMessage(err) });
  }
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
  // 压缩按钮已由 card-action-router 独立校验路径（CompactController）处理；到达此处即防御式忽略。
  if (value.cmd === "compact") return;

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