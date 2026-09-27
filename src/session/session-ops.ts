/**
 * 会话运维命令（纯重构：从 `session-commands.ts` 抽出）。
 *
 * `/use` `/current` `/stop` `/cd` `/resume` `/now` `/steer`。
 * （会话卡按钮动作 `applySessionCardAction` 与列表渲染同属列表域，放在 `session-list.ts`。）
 */
import type { IncomingMessage } from "../types.js";
import type { CommandScope } from "../feishu/routing.js";
import {
  matchSession,
  threadForbiddenText,
  useErrorText,
} from "../feishu/commands.js";
import { presetLabel } from "../feishu/perm-presets.js";
import { modelLabel } from "../feishu/models.js";
import type { SessionPrimitives, SessionOpsApi } from "./context.js";
import { currentModel } from "./model-perm.js";
import { enterSessionThread, loadSessionEntries } from "./session-list.js";

export async function cmdUse(ctx: SessionPrimitives, message: IncomingMessage, args: string): Promise<void> {
  const sessions = await ctx.deps.sessionMap.listSessions(message.chatId);
  if (sessions.length === 0) {
    await ctx.reply(message, "还没有会话。使用 /new 新建一个。");
    return;
  }
  const matched = matchSession(args, sessions);
  if (!matched.ok) {
    await ctx.reply(message, useErrorText(matched.reason));
    return;
  }
  const entry = matched.entry;
  const ok = await ctx.deps.sessionMap.setActive(message.chatId, entry.sessionID);
  if (!ok) {
    await ctx.reply(message, "切换失败：会话不存在，先用 /sessions 查看列表。");
    return;
  }
  await ctx.reply(message, `✅ 已切换到「${entry.title.trim() || "(未命名)"}」\n\`${entry.sessionID}\``);
}

export async function cmdCurrent(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  scope: CommandScope,
): Promise<void> {
  if (scope === "thread") {
    const sessionID = await ctx.threadSessionID(message);
    if (!sessionID) {
      await ctx.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
      return;
    }
    const entry = await ctx.deps.sessionMap.getSession(message.chatId, sessionID);
    const link = await ctx.deps.sessionMap.resolveBySession(sessionID);
    // 模型以读回的真实值为准；读回失败才降级到插件记录值。
    const model = (await currentModel(ctx, sessionID)) ?? link?.model;
    const lines = [
      `本话题会话：「${entry?.title.trim() || "(未命名)"}」`,
      `\`${sessionID}\``,
      ...(link?.dir ? [`目录：\`${link.dir}\``] : []),
      ...(model ? [`模型：${modelLabel(model)}`] : []),
      ...(link?.perm ? [`权限：${presetLabel(link.perm)}`] : []),
    ];
    await ctx.reply(message, lines.join("\n"));
    return;
  }

  const active = await ctx.deps.sessionMap.getActive(message.chatId);
  if (!active) {
    await ctx.reply(message, "当前没有会话。使用 /new 新建一个。");
    return;
  }
  const count = (await ctx.deps.sessionMap.listSessions(message.chatId)).length;
  await ctx.reply(
    message,
    `当前会话：「${active.title.trim() || "(未命名)"}」\n\`${active.sessionID}\`\n共 ${count} 个会话。`,
  );
}

export async function cmdStop(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  scope: CommandScope,
): Promise<void> {
  if (scope === "thread") {
    const sessionID = await ctx.threadSessionID(message);
    if (!sessionID) {
      await ctx.reply(message, "本话题尚未关联会话，无法中断。");
      return;
    }
    await ctx.deps.interruptSession(sessionID);
    const entry = await ctx.deps.sessionMap.getSession(message.chatId, sessionID);
    await ctx.reply(message, `⏹️ 已请求中断本话题会话：「${entry?.title.trim() || "(未命名)"}」`);
    return;
  }

  const active = await ctx.deps.sessionMap.getActive(message.chatId);
  if (!active) {
    await ctx.reply(message, "当前没有会话可中断。");
    return;
  }
  await ctx.deps.interruptSession(active.sessionID);
  await ctx.reply(message, `⏹️ 已请求中断当前会话：「${active.title.trim() || "(未命名)"}」`);
}

/**
 * `/cd <path>`：话题内移动当前会话目录。
 * 目录容错：留空 = 回到允许根目录；不存在则自动创建（仍在 allowedRoots 之下）。
 */
export async function cmdCd(ctx: SessionPrimitives, message: IncomingMessage, args: string): Promise<void> {
  if (!message.threadId) {
    await ctx.reply(message, "`/cd` 只能在话题内使用（用于移动该话题会话的工作目录）。");
    return;
  }
  const sessionID = await ctx.threadSessionID(message);
  if (!sessionID) {
    await ctx.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
    return;
  }
  const validation = ctx.deps.validateDir(args);
  if (!validation.ok) {
    await ctx.reply(message, validation.message);
    return;
  }
  await ctx.deps.moveSessionDir(sessionID, validation.path);
  await ctx.deps.recent.addDir(validation.path);
  await ctx.reply(message, `✅ 已切换本会话目录：\`${validation.path}\``);
}

/**
 * `/resume [序号]`：对「最近更新」的会话（或列表第 N 个）直接执行「进入话题」流程，
 * 跳过列表卡。序号越界/无会话时提示。序号与 `/sessions` 列表一致（最近更新倒序）。
 */
export async function cmdResume(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  args: string,
): Promise<void> {
  if (message.threadId) {
    await ctx.reply(message, threadForbiddenText("resume"));
    return;
  }
  if (!ctx.threadRouting) {
    await ctx.reply(message, "当前为回退模式（`threadRouting=false`），不支持续聊历史会话。");
    return;
  }
  const entries = await loadSessionEntries(ctx, message.chatId);
  if (entries.length === 0) {
    await ctx.reply(message, "没有可续聊的会话。用 `/new` 新建，或先在话题里发消息创建一个。");
    return;
  }
  const query = args.trim();
  let index = 0;
  if (query) {
    if (!/^\d+$/.test(query)) {
      await ctx.reply(message, "用法：`/resume [序号]`（序号见 `/sessions`；省略 = 最近更新的会话）。");
      return;
    }
    index = Number.parseInt(query, 10) - 1;
  }
  if (index < 0 || index >= entries.length) {
    await ctx.reply(
      message,
      `序号越界：当前共 ${entries.length} 个会话，有效范围 1–${entries.length}。`,
    );
    return;
  }
  const entry = entries[index]!;
  const result = await enterSessionThread(ctx, {
    chatId: message.chatId,
    sessionID: entry.sessionID,
    anchorMessageId: message.messageId,
    operatorOpenId: message.senderOpenId,
    info: entry,
    source: "resume",
  });
  if (!result.ok) {
    await ctx.reply(
      message,
      `⚠️ 进入话题失败：${result.error ?? "unknown"}。可发送 \`/sessions\` 手动进入。`,
    );
  }
}

/** `/now`：把已排队（未投递）的消息提升为 steer，立即插队执行。 */
export async function cmdNow(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  scope: CommandScope,
): Promise<void> {
  const sessionID = await ctx.scopeSessionID(message, scope);
  if (!sessionID) {
    await ctx.reply(message, "当前没有会话。");
    return;
  }
  if (!ctx.deps.promoteQueued) {
    await ctx.reply(message, "当前版本不支持插队（运行时未暴露 inbox）。");
    return;
  }
  const promoted = await ctx.deps.promoteQueued(sessionID);
  if (promoted < 0) {
    await ctx.reply(message, "当前版本不支持插队（运行时未暴露 inbox）。");
    return;
  }
  if (promoted === 0) {
    await ctx.reply(message, "没有排队中的消息（该会话当前空闲或无待投递项）。");
    return;
  }
  await ctx.reply(message, `⚡ 已把 ${promoted} 条排队消息改为立即插队执行。`);
}

/** `/steer <文本>`：立即插队发送一条消息（打断当前步骤插入执行）。 */
export async function cmdSteer(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  args: string,
  scope: CommandScope,
): Promise<void> {
  const sessionID = await ctx.scopeSessionID(message, scope);
  if (!sessionID) {
    await ctx.reply(message, "当前没有会话。");
    return;
  }
  const text = args.trim();
  if (!text) {
    await ctx.reply(message, "用法：`/steer <文本>`（立即插队发送）；把已排队消息插队请用 `/now`。");
    return;
  }
  if (!ctx.deps.steerPrompt) {
    await ctx.reply(message, "当前版本不支持插队。");
    return;
  }
  await ctx.deps.steerPrompt(message, sessionID, text);
}

/** 会话运维 API 装配（挂到 ctx 上供命令分发调用）。 */
export function createSessionOpsApi(ctx: SessionPrimitives): SessionOpsApi {
  return {
    cmdUse: (message, args) => cmdUse(ctx, message, args),
    cmdCurrent: (message, scope) => cmdCurrent(ctx, message, scope),
    cmdStop: (message, scope) => cmdStop(ctx, message, scope),
    cmdCd: (message, args) => cmdCd(ctx, message, args),
    cmdResume: (message, args) => cmdResume(ctx, message, args),
    cmdNow: (message, scope) => cmdNow(ctx, message, scope),
    cmdSteer: (message, args, scope) => cmdSteer(ctx, message, args, scope),
  };
}
