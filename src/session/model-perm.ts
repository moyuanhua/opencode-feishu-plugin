/**
 * 模型切换与权限档位编排（纯重构：从 `session-commands.ts` 抽出）。
 *
 * 职责：
 * - 话题内 `/model`：无参发模型操作卡，带参切换当前会话模型（含读回校验回执）；
 * - 话题内 `/perm`：无参发权限卡，带参应用权限预设；
 * - 已存在会话的模型/权限卡片渲染（`sid` 卡片）与读回模型。
 *
 * 只依赖 `SessionPrimitives`，不反向依赖其它会话子模块。
 */
import { errorMessage } from "../logger.js";
import type { IncomingMessage, ModelRef } from "../types.js";
import {
  matchModel,
  modelLabel,
  modelMatchErrorText,
} from "../feishu/models.js";
import {
  isPermissionPreset,
  PERMISSION_PRESETS,
  presetInfo,
  presetLabel,
} from "../feishu/perm-presets.js";
import {
  buildModelCard,
  buildPermCard,
  buildSetupDoneCard,
} from "../feishu/setup-cards.js";
import type {
  ModelPermApi,
  SessionPrimitives,
  WizardStateLike,
} from "./context.js";
import type { ModelSwitchOutcome } from "../feishu/models.js";

/**
 * 读回会话**真实**当前模型（优先 `ctx.session.get`），失败则降级到插件记录值。
 * 展示（运行卡页脚 / `/current` / 模型卡）一律以读回值为准，避免只显示我们记录的那份。
 */
export async function currentModel(
  ctx: SessionPrimitives,
  sessionID: string,
): Promise<ModelRef | undefined> {
  const link = await ctx.deps.sessionMap.resolveBySession(sessionID);
  if (ctx.deps.getSessionModel) {
    try {
      // 带目录头，保证跨 location 会话也能读回。
      const model = await ctx.deps.getSessionModel(sessionID, link?.dir);
      if (model) return model;
    } catch (err) {
      ctx.deps.log.warn("读回会话模型失败，回退记录值", { sessionID, error: errorMessage(err) });
    }
  }
  return link?.model;
}

/** 渲染建会话向导的模型选择卡（分步卡已下线，仅旧卡片回调分页沿用）。 */
export async function renderModelCard(
  ctx: SessionPrimitives,
  state: WizardStateLike,
  pageOverride?: number,
): Promise<object> {
  const models = await ctx.loadModels();
  const recent = await ctx.deps.recent.listModels();
  return buildModelCard({
    models,
    recent,
    ...(state.model ? { current: state.model } : {}),
    page: pageOverride ?? state.page ?? 0,
    pageSize: ctx.modelPageSize,
    recentLimit: ctx.recentModelsLimit(),
  });
}

/** 话题内 `/model`（无参）：发已存在会话的模型操作卡。 */
export async function sendModelCardToThread(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  sessionID: string,
  page: number,
): Promise<void> {
  const current = await currentModel(ctx, sessionID);
  const models = await ctx.loadModels();
  const recent = await ctx.deps.recent.listModels();
  const card = buildModelCard({
    models,
    recent,
    ...(current ? { current } : {}),
    page,
    pageSize: ctx.modelPageSize,
    recentLimit: ctx.recentModelsLimit(),
    sid: sessionID,
  });
  await ctx.deps.sender.replyCard(message.messageId, card);
}

/** 话题内 `/model [关键词]`：切换当前会话模型（含读回校验回执）。 */
export async function switchModelInThread(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  args: string,
): Promise<void> {
  const sessionID = await ctx.threadSessionID(message);
  if (!sessionID) {
    await ctx.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
    return;
  }
  if (!args.trim()) {
    await sendModelCardToThread(ctx, message, sessionID, 0);
    return;
  }
  const models = await ctx.loadModels();
  const matched = matchModel(args, models);
  if (!matched.ok) {
    await ctx.reply(message, modelMatchErrorText(matched.reason, matched.candidates));
    return;
  }
  try {
    const outcome = await ctx.deps.switchSessionModel(sessionID, matched.model);
    await ctx.deps.recent.addModel(matched.model);
    await ctx.reply(message, modelSwitchReply(outcome, matched.model));
  } catch (err) {
    // 切换失败（抛错/无权限/会话不存在）：明确回错误原因，绝不假装成功。
    ctx.deps.log.warn("切换会话模型失败", { sessionID, error: errorMessage(err) });
    await ctx.reply(message, `⚠️ 切换模型失败：${errorMessage(err)}`);
  }
}

/** 话题内 `/perm`（无参）：发已存在会话的权限操作卡。 */
export async function sendPermCardToThread(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  sessionID: string,
): Promise<void> {
  const link = await ctx.deps.sessionMap.resolveBySession(sessionID);
  const card = buildPermCard({ ...(link?.perm ? { current: link.perm } : {}), sid: sessionID });
  await ctx.deps.sender.replyCard(message.messageId, card);
}

/** 话题内 `/perm [档位]`：应用权限预设。 */
export async function setPermInThread(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  args: string,
): Promise<void> {
  const sessionID = await ctx.threadSessionID(message);
  if (!sessionID) {
    await ctx.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
    return;
  }
  const arg = args.trim();
  if (!arg) {
    await sendPermCardToThread(ctx, message, sessionID);
    return;
  }
  if (!isPermissionPreset(arg)) {
    await ctx.reply(message, permUsageText());
    return;
  }
  await ctx.deps.applyPermissionPreset(sessionID, arg);
  await ctx.reply(message, `✅ 已更新本会话权限：${presetLabel(arg)}`);
}

export function permUsageText(): string {
  const list = PERMISSION_PRESETS.map((p) => `\`${p.id}\`（${presetInfo(p.id).icon}${p.label}）`).join("、");
  return `未知权限档位。可用：${list}。\n例如：\`/perm edit\`。`;
}

/**
 * 模型切换回执文案（纯文本）。
 * - 读回不一致 → ⚠️ 明确告知「可能未生效」，绝不假装成功；
 * - 读回失败 → 说明「未能读回校验」；
 * - 成功 → ✅，并说明切换只影响后续回复（历史消息仍是旧模型属正常）。
 */
export function modelSwitchReply(outcome: ModelSwitchOutcome | undefined, requested: ModelRef): string {
  const effective = outcome?.effective ?? requested;
  const ref = `**${modelLabel(effective)}**\n\`${effective.providerID}/${effective.id}\``;
  if (outcome?.mismatch) {
    return [
      `⚠️ 模型可能未生效：请求 **${modelLabel(outcome.requested)}**，服务端实际为 ${ref}。`,
      "切换只影响**后续**回复；历史消息仍是旧模型，属正常。",
    ].join("\n");
  }
  if (outcome && !outcome.verified) {
    return `✅ 已请求切换模型：${ref}\n未能读回校验${outcome.warning ? `（${outcome.warning}）` : ""}；切换只影响**后续**回复。`;
  }
  return `✅ 已切换模型：${ref}\n切换只影响**后续**回复；该会话此前的历史消息仍显示旧模型，属正常。`;
}

/** 卡片版模型切换结果（与文本回执同语义）。 */
export function modelSwitchDoneCard(outcome: ModelSwitchOutcome | undefined, requested: ModelRef): object {
  const effective = outcome?.effective ?? requested;
  if (outcome?.mismatch) {
    return buildSetupDoneCard("⚠️ 模型可能未生效", [
      `请求：**${modelLabel(outcome.requested)}**`,
      `实际：**${modelLabel(effective)}**`,
      "切换只影响**后续**回复；历史消息仍是旧模型，属正常。",
    ]);
  }
  if (outcome && !outcome.verified) {
    return buildSetupDoneCard("✅ 已切换模型", [
      `当前模型：**${modelLabel(effective)}**`,
      "（未能读回校验；切换只影响**后续**回复。）",
    ]);
  }
  return buildSetupDoneCard("✅ 已切换模型", [
    `当前模型：**${modelLabel(effective)}**`,
    "（切换只影响**后续**回复；历史消息仍是旧模型，属正常。）",
  ]);
}

/** 模型/权限 API 装配（挂到 ctx 上供命令分发调用）。 */
export function createModelPermApi(ctx: SessionPrimitives): ModelPermApi {
  return {
    currentModel: (sessionID) => currentModel(ctx, sessionID),
    renderModelCard: (state, pageOverride) => renderModelCard(ctx, state, pageOverride),
    sendModelCardToThread: (message, sessionID, page) => sendModelCardToThread(ctx, message, sessionID, page),
    switchModelInThread: (message, args) => switchModelInThread(ctx, message, args),
    sendPermCardToThread: (message, sessionID) => sendPermCardToThread(ctx, message, sessionID),
    setPermInThread: (message, args) => setPermInThread(ctx, message, args),
  };
}
