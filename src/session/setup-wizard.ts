/**
 * 建会话向导 / 表单（纯重构：从 `session-commands.ts` 抽出）。
 *
 * 覆盖 `/new` `/form` `/dir` `/model` `/perm` `/cancel` 与表单提交，以及
 * 「表单提交 → 统一建会话 → 开话题」路径；同时保留历史分步卡的兼容回调
 * （`applySetupCardAction` / `confirmSetup`，仅当用户点击旧卡片时才会走到）。
 */
import { errorMessage } from "../logger.js";
import type {
  CardAction,
  IncomingMessage,
  ModelRef,
  PermissionPreset,
} from "../types.js";
import type { CommandScope } from "../feishu/routing.js";
import {
  defaultSessionTitle,
  threadForbiddenText,
} from "../feishu/commands.js";
import {
  matchModel,
  modelLabel,
  modelMatchErrorText,
} from "../feishu/models.js";
import {
  isPermissionPreset,
  presetGateMode,
  presetLabel,
  presetToRuleset,
} from "../feishu/perm-presets.js";
import { scanRootSubdirs } from "../feishu/root-scan.js";
import {
  buildSessionCreatedCard,
  buildSessionReadyCard,
} from "../feishu/session-cards.js";
import {
  buildConfirmCard,
  buildModelCard,
  buildPermCard,
  buildSetupDoneCard,
  buildSetupFormCard,
  parseSetupFormValues,
  resolveSetupFormDir,
  type SetupCardValue,
  type SetupFormDirEntry,
  type SetupFormValuesInput,
} from "../feishu/setup-cards.js";
import {
  currentModel,
  modelSwitchDoneCard,
  permUsageText,
  renderModelCard,
  setPermInThread,
  switchModelInThread,
} from "./model-perm.js";
import type {
  SessionPrimitives,
  SetupWizardApi,
  WizardStateLike,
} from "./context.js";

/**
 * `/new`：与 `/form` **完全等价**，直接发建会话表单卡（不再走目录→模型→权限→确认分步卡）。
 * 带标题时写入向导状态，表单提交后作为会话标题。
 */
export async function cmdNew(ctx: SessionPrimitives, message: IncomingMessage, args: string): Promise<void> {
  const title = args.trim() || undefined;
  if (!ctx.threadRouting) {
    // 回退模式（threadRouting=false）：没有话题，沿用 P3 旧行为直接建会话。
    const finalTitle = title ?? defaultSessionTitle(ctx.now());
    const created = await ctx.deps.createSession({
      title: finalTitle,
      chatId: message.chatId,
      openId: message.senderOpenId,
    });
    await ctx.reply(message, `✅ 已新建并切换到会话「${finalTitle}」\n\`${created.id}\``);
    return;
  }
  await openSetupForm(ctx, message, title);
}

/**
 * `/form [标题]`：直接打开发建会话表单卡。
 * 与 `/new [标题]` 走同一入口，二者完全等价。
 */
export async function cmdForm(ctx: SessionPrimitives, message: IncomingMessage, args: string): Promise<void> {
  await openSetupForm(ctx, message, args.trim() || undefined);
}

/**
 * `/new` / `/form` 共同入口：发（或复用）建会话表单卡。
 * 已有向导状态时保留 `/dir` `/model` `/perm` 预填的字段；带标题则更新标题。
 */
export async function openSetupForm(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  title?: string,
): Promise<void> {
  if (message.threadId) {
    await ctx.reply(message, threadForbiddenText("form"));
    return;
  }
  if (!ctx.threadRouting) {
    await ctx.reply(message, "当前为回退模式（`threadRouting=false`），不支持表单建会话，请用 `/new`。");
    return;
  }
  let state = await ctx.deps.wizard.get(message.chatId);
  if (!state) {
    state = await ctx.deps.wizard.start(message.chatId, title, message.messageId);
  } else if (title !== undefined) {
    state = { ...state, title };
    await ctx.deps.wizard.set(message.chatId, state);
  }
  const card = await renderFormCard(ctx, state);
  const res = await ctx.deps.sender.sendCard(message.chatId, card);
  if (!res.ok) ctx.deps.log.warn("表单卡发送失败", { chatId: message.chatId, error: res.error ?? "unknown" });
}

/**
 * `/dir <path>`：目录只作表单**预填**（不再是必经步骤）。
 * 目录容错：留空 = 允许根目录；不存在则自动创建（仍在 allowedRoots 之下）。
 */
export async function cmdDir(ctx: SessionPrimitives, message: IncomingMessage, args: string): Promise<void> {
  if (message.threadId) {
    await ctx.reply(message, threadForbiddenText("dir"));
    return;
  }
  const validation = ctx.deps.validateDir(args);
  if (!validation.ok) {
    await ctx.reply(message, validation.message);
    return;
  }
  if (!(await ctx.deps.wizard.get(message.chatId))) {
    await ctx.deps.wizard.start(message.chatId, undefined, message.messageId);
  }
  const state = await ctx.deps.wizard.apply(message.chatId, { type: "setDir", dir: validation.path });
  await ctx.deps.recent.addDir(validation.path);
  if (!state) {
    await ctx.reply(message, "向导状态已丢失，请重新发送 `/new` 开始。");
    return;
  }
  // 分步卡已下线：把目录作为表单预填项，直接回一张新的表单卡。
  await ctx.deps.sender.sendCard(message.chatId, await renderFormCard(ctx, state));
}

/** `/model [关键词]`：向导内选模型（仅预填表单）；话题内切换当前会话模型。 */
export async function cmdModel(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  args: string,
  scope: CommandScope,
): Promise<void> {
  if (scope === "thread") {
    await switchModelInThread(ctx, message, args);
    return;
  }

  if (!(await ctx.deps.wizard.get(message.chatId))) {
    await ctx.deps.wizard.start(message.chatId, undefined, message.messageId);
  }
  if (!args.trim()) {
    const state = await ctx.deps.wizard.get(message.chatId);
    await ctx.deps.sender.sendCard(message.chatId, await renderFormCard(ctx, state));
    return;
  }
  const models = await ctx.loadModels();
  const matched = matchModel(args, models);
  if (!matched.ok) {
    await ctx.reply(message, modelMatchErrorText(matched.reason, matched.candidates));
    return;
  }
  const next = await ctx.deps.wizard.apply(message.chatId, { type: "setModel", model: matched.model });
  await ctx.deps.recent.addModel(matched.model);
  if (!next) return;
  // 分步卡已下线：模型作为表单预填项。
  await ctx.deps.sender.sendCard(message.chatId, await renderFormCard(ctx, next));
}

/** `/perm [档位]`：向导内选权限（仅预填表单）；话题内修改当前会话权限。 */
export async function cmdPerm(
  ctx: SessionPrimitives,
  message: IncomingMessage,
  args: string,
  scope: CommandScope,
): Promise<void> {
  if (scope === "thread") {
    await setPermInThread(ctx, message, args);
    return;
  }
  const arg = args.trim();

  if (!(await ctx.deps.wizard.get(message.chatId))) {
    await ctx.deps.wizard.start(message.chatId, undefined, message.messageId);
  }
  if (!arg) {
    const state = await ctx.deps.wizard.get(message.chatId);
    await ctx.deps.sender.sendCard(message.chatId, await renderFormCard(ctx, state));
    return;
  }
  if (!isPermissionPreset(arg)) {
    await ctx.reply(message, permUsageText());
    return;
  }
  const next = await ctx.deps.wizard.apply(message.chatId, { type: "setPerm", perm: arg });
  if (!next) return;
  // 分步卡已下线：权限作为表单预填项。
  await ctx.deps.sender.sendCard(message.chatId, await renderFormCard(ctx, next));
}

/** `/cancel`：放弃向导。 */
export async function cmdCancel(ctx: SessionPrimitives, message: IncomingMessage): Promise<void> {
  if (message.threadId) {
    await ctx.reply(message, threadForbiddenText("cancel"));
    return;
  }
  await ctx.deps.wizard.cancel(message.chatId);
  await ctx.reply(message, "✖️ 已取消建会话表单。发送 `/new [标题]` 可重新开始。");
}

/** 列表卡「➕ 新建会话」→ 打开 `/form` 建会话表单卡（复用向导状态/标题）。 */
export async function sendSetupFormForChat(
  ctx: SessionPrimitives,
  chatId: string,
  anchorMessageId: string,
  openId: string,
): Promise<void> {
  if (!ctx.threadRouting) {
    // 回退模式：没有话题，沿用旧行为直接建会话。
    const title = defaultSessionTitle(ctx.now());
    await ctx.deps.createSession({ title, chatId, openId });
    await ctx.replyChat(chatId, `✅ 已新建会话「${title}」`);
    return;
  }
  let state = await ctx.deps.wizard.get(chatId);
  if (!state) state = await ctx.deps.wizard.start(chatId, undefined, anchorMessageId);
  const card = await renderFormCard(ctx, state);
  const res = await ctx.deps.sender.sendCard(chatId, card);
  if (!res.ok) ctx.deps.log.warn("表单卡发送失败", { chatId, error: res.error ?? "unknown" });
}

/**
 * 建会话向导 / 已存在会话操作卡的按钮回调。
 *
 * ⚠️ 仅为兼容**历史卡片**：`/new` 早已改为直接发表单卡，下面的「dir→model→perm→confirm」
 * 分步推进会走到那些旧卡片按钮；用户可能仍持有它们，所以这些分支**必须保留**。
 * 对应构建函数 `buildModelCard` / `buildPermCard` / `buildConfirmCard` 因此也保留（标注 @deprecated）。
 */
export async function applySetupCardAction(
  ctx: SessionPrimitives,
  action: CardAction,
  value: SetupCardValue,
): Promise<void> {
  const chatId = action.chatId;
  if (value.kind === "confirm") {
    await confirmSetup(ctx, chatId, action);
    return;
  }
  if (value.kind === "cancel") {
    await ctx.deps.wizard.cancel(chatId);
    await ctx.patchCard(action.messageId, buildSetupDoneCard("✖️ 已取消", ["建会话向导已取消。发送 `/new` 重新开始。"]));
    return;
  }
  if (value.kind === "form") {
    const state = (await ctx.deps.wizard.get(chatId)) ?? (await ctx.deps.wizard.start(chatId, undefined, action.messageId));
    await ctx.patchCard(action.messageId, await renderFormCard(ctx, state));
    return;
  }

  // 已存在会话的操作卡（话题内 `/model` `/perm`）
  if (value.kind !== "dir" && value.sid) {
    if (value.kind === "model") {
      try {
        const outcome = await ctx.deps.switchSessionModel(value.sid, value.model);
        await ctx.deps.recent.addModel(value.model);
        await ctx.patchCard(action.messageId, modelSwitchDoneCard(outcome, value.model));
      } catch (err) {
        ctx.deps.log.warn("卡片切换模型失败", { sessionID: value.sid, error: errorMessage(err) });
        await ctx.patchCard(
          action.messageId,
          buildSetupDoneCard("⚠️ 切换模型失败", [errorMessage(err)]),
        );
      }
      return;
    }
    if (value.kind === "perm") {
      await ctx.deps.applyPermissionPreset(value.sid, value.preset);
      await ctx.patchCard(
        action.messageId,
        buildSetupDoneCard("✅ 已更新权限", [`当前权限：${presetLabel(value.preset)}`]),
      );
      return;
    }
    if (value.kind === "more") {
      const current = await currentModel(ctx, value.sid);
      const models = await ctx.loadModels();
      const recent = await ctx.deps.recent.listModels();
      const card = buildModelCard({
        models,
        recent,
        ...(current ? { current } : {}),
        page: value.page,
        pageSize: ctx.modelPageSize,
        recentLimit: ctx.recentModelsLimit(),
        sid: value.sid,
      });
      await ctx.patchCard(action.messageId, card);
      return;
    }
    return;
  }

  // 建会话向导
  const state = await ctx.deps.wizard.get(chatId);
  if (!state) {
    await ctx.patchCard(action.messageId, buildSetupDoneCard("⚠️ 向导已失效", ["请重新发送 `/new` 开始。"]));
    return;
  }
  if (value.kind === "dir") {
    const next = await ctx.deps.wizard.apply(chatId, { type: "setDir", dir: value.dir });
    await ctx.deps.recent.addDir(value.dir);
    if (!next) return;
    await ctx.patchCard(action.messageId, await renderModelCard(ctx, next));
    return;
  }
  if (value.kind === "model") {
    const next = await ctx.deps.wizard.apply(chatId, { type: "setModel", model: value.model });
    await ctx.deps.recent.addModel(value.model);
    if (!next) return;
    await ctx.patchCard(action.messageId, buildPermCard({ ...(next.perm ? { current: next.perm } : {}) }));
    return;
  }
  if (value.kind === "perm") {
    const next = await ctx.deps.wizard.apply(chatId, { type: "setPerm", perm: value.preset });
    if (!next) return;
    await ctx.patchCard(action.messageId, buildConfirmCard(confirmInput(next)));
    return;
  }
  if (value.kind === "more") {
    const next = await ctx.deps.wizard.apply(chatId, { type: "setPage", page: value.page });
    if (!next) return;
    await ctx.patchCard(action.messageId, await renderModelCard(ctx, next, value.page));
  }
}

/**
 * 确认卡「✅ 创建」：读向导 → 走统一创建路径。
 *
 * @deprecated `/new` 已不再发确认卡；仅当用户点击**历史遗留**的确认卡时才会走到这里。
 * 新流程见 `applySetupFormSubmit`（表单提交）。
 */
export async function confirmSetup(ctx: SessionPrimitives, chatId: string, action: CardAction): Promise<void> {
  const state = await ctx.deps.wizard.get(chatId);
  if (!state || state.step !== "confirm" || !state.dir || !state.perm) {
    await ctx.patchCard(action.messageId, buildSetupDoneCard("⚠️ 向导状态不完整", ["请重新发送 `/new` 开始。"]));
    return;
  }
  // 立即消费向导，防止确认按钮被连点造成重复建会话。
  await ctx.deps.wizard.cancel(chatId);
  const title = state.title?.trim() || defaultSessionTitle(ctx.now());
  await createSessionFromSetup(ctx, chatId, action, {
    title,
    dir: state.dir,
    perm: state.perm,
    ...(state.model ? { model: state.model } : {}),
    ...(state.anchorMessageId ? { anchorMessageId: state.anchorMessageId } : {}),
  });
}

/**
 * 表单提交（P6.1）：与按钮向导**共用创建路径**。
 * 目录先用 `validateDir` 校验（失败 → 回带错误说明的表单卡并保留已填项，不建会话）。
 */
export async function applySetupFormSubmit(ctx: SessionPrimitives, action: CardAction): Promise<void> {
  const fv = action.formValue;
  const fvKeys = fv && typeof fv === "object" ? Object.keys(fv as Record<string, unknown>) : [];
  ctx.deps.log.info("表单提交进入处理", {
    chatId: action.chatId,
    messageId: action.messageId,
    formValueKeys: fvKeys,
    formValueType: Array.isArray(fv) ? "array" : typeof fv,
  });
  const values = parseSetupFormValues(action.formValue);
  if (!values) {
    ctx.deps.log.warn("表单数据缺失（parse 返回 undefined）", { formValueKeys: fvKeys });
    await ctx.patchCard(action.messageId, buildSetupDoneCard("⚠️ 表单数据缺失", ["请重新发送 `/form` 填写。"]));
    return;
  }
  const state = await ctx.deps.wizard.get(action.chatId);
  if (!state) {
    ctx.deps.log.warn("表单提交但向导状态不存在（可能已过期/已被消费）", {
      chatId: action.chatId,
      dirLen: values.dir.length,
      hasModel: Boolean(values.model),
      hasPerm: Boolean(values.perm),
    });
    // 与按钮确认一致：向导状态已消费/失效 → 视为过期提交，不再建会话（防重放/重复提交）。
    await ctx.patchCard(action.messageId, buildSetupDoneCard("⚠️ 表单已失效", ["请重新发送 `/form` 或 `/new` 打开表单。"]));
    return;
  }
  const title = state.title?.trim() || defaultSessionTitle(ctx.now());
  // 目录优先级：下拉选中 → 文本输入 → 允许根目录 allowedRoots[0]（纯函数，便于单测）。
  const requestedDir = resolveSetupFormDir(values, ctx.deps.allowedRoots ?? []);
  let preserved: SetupFormValuesInput = {
    dir: requestedDir,
    ...(values.model ? { model: values.model } : {}),
    ...(values.perm ? { perm: values.perm } : {}),
  };

  // 保留诊断日志：字段解析。
  ctx.deps.log.info("表单字段解析", {
    dirInput: values.dir,
    dirSelect: values.dirSelect,
    dir: requestedDir,
    model: values.model ? `${values.model.providerID}/${values.model.id}` : undefined,
    perm: values.perm,
    hasState: true,
  });
  const validation = ctx.deps.validateDir(requestedDir);
  if (!validation.ok) {
    // 目录留空/不存在都由 validateDir 处理：留空 → 允许根目录；不存在 → 自动创建。
    ctx.deps.log.warn("目录校验失败", { dir: requestedDir, reason: validation.message });
    await ctx.patchCard(
      action.messageId,
      await renderFormCard(ctx, state, { error: validation.message, values: preserved }),
    );
    return;
  }
  // 目录留空 → 用解析出的实际路径回写，便于后续展示/错误回显。
  preserved = { ...preserved, dir: validation.path };

  if (!values.perm) {
    ctx.deps.log.warn("权限档位缺失", { dir: validation.path });
    await ctx.patchCard(
      action.messageId,
      await renderFormCard(ctx, state, { error: "请选择权限档位。", values: { ...preserved, dir: validation.path } }),
    );
    return;
  }

  const model = values.model ? await resolveFormModel(ctx, values.model) : state?.model;
  ctx.deps.log.info("表单校验通过，开始建会话", {
    dir: validation.path,
    perm: values.perm,
    model: model ? `${model.providerID}/${model.id}` : undefined,
  });
  // 消费向导，防连点重复建会话。
  await ctx.deps.wizard.cancel(action.chatId);
  await createSessionFromSetup(ctx, action.chatId, action, {
    title,
    dir: validation.path,
    perm: values.perm,
    ...(model ? { model } : {}),
  });
}

/** 表单模型引用 → 尽量补全 name（列表不可用时保留原引用）。 */
async function resolveFormModel(ctx: SessionPrimitives, ref: ModelRef): Promise<ModelRef> {
  const models = await ctx.loadModels();
  const matched = matchModel(`${ref.providerID}/${ref.id}`, models);
  return matched.ok ? matched.model : ref;
}

/** 建会话统一创建路径（按钮确认 / 表单提交共用）。 */
async function createSessionFromSetup(
  ctx: SessionPrimitives,
  chatId: string,
  action: CardAction,
  opts: {
    readonly title: string;
    readonly dir: string;
    readonly perm: PermissionPreset;
    readonly model?: ModelRef;
    readonly anchorMessageId?: string;
  },
): Promise<void> {
  const { title, dir, perm, model } = opts;
  const permissions = presetToRuleset(perm);
  const gateMode = presetGateMode(perm);

  const created = await ctx.deps.createSession({
    title,
    chatId,
    openId: action.operatorOpenId,
    setActive: true,
    directory: dir,
    permissions,
    perm,
    gateMode,
    ...(model ? { model } : {}),
  });
  await ctx.deps.recent.addDir(dir);
  if (model) await ctx.deps.recent.addModel(model);

  const readyCard = buildSessionReadyCard({
    title,
    sessionID: created.id,
    dir,
    ...(model ? { model: modelLabel(model) } : {}),
    perm: presetLabel(perm),
  });

  // 话题锚点 = 用户提交的建会话表单卡这条消息本身：
  // 对它 `reply_in_thread` 发就绪卡，表单消息即成为话题根；不再发独立的锚点文本。
  const anchorId = action.messageId || opts.anchorMessageId || "";
  const res = await ctx.deps.sender.replyCard(anchorId, readyCard, { replyInThread: true });
  ctx.deps.log.info("创建会话并开话题", {
    sessionID: created.id,
    anchorMessageId: anchorId,
    anchorFromFormCard: Boolean(action.messageId),
    replyOk: res.ok,
    replyMessageId: res.messageId,
    replyThreadId: res.threadId,
    replyError: res.error,
  });
  if (!res.ok || !res.messageId) {
    ctx.deps.log.warn("一键开话题失败", { error: res.error ?? "unknown" });
    await ctx.patchCard(
      action.messageId,
      buildSessionCreatedCard({
        title,
        sessionID: created.id,
        dir,
        ...(model ? { model: modelLabel(model) } : {}),
        perm: presetLabel(perm),
        note: "⚠️ 自动开话题失败：请在 `/sessions` 的会话卡上手动「创建话题」，或在主聊天流用 `/use` 切换后继续。",
      }),
    );
    return;
  }

  // 表单消息即话题根。
  await ctx.deps.sessionMap.bindRoot(anchorId, created.id);
  const meta = res.threadId ? undefined : await ctx.deps.sender.getMessageMeta(res.messageId);
  const threadId = res.threadId ?? meta?.threadId;
  if (threadId) {
    await ctx.deps.sessionMap.bindThread(threadId, created.id, chatId, action.operatorOpenId, anchorId);
  } else {
    ctx.deps.log.warn("一键开话题后未读到 thread_id，该会话暂无法自动路由", { messageId: res.messageId });
  }

  // 把表单卡改写成成功卡：标题 `✅ 已创建 · <会话标题>`，作为话题显示名。
  await ctx.patchCard(
    action.messageId,
    buildSessionCreatedCard({
      title,
      sessionID: created.id,
      dir,
      ...(model ? { model: modelLabel(model) } : {}),
      perm: presetLabel(perm),
      ...(threadId ? {} : { note: "（未拿到话题 ID，若话题未出现请在会话卡上手动创建。）" }),
    }),
  );
}

/**
 * 渲染建会话表单卡（P6.1）：最近模型 + 常用模型 + 默认预选。
 * P6.2：目录/权限也从向导状态预填（`/dir` `/perm` 的能力，不再是必经步骤）。
 */
async function renderFormCard(
  ctx: SessionPrimitives,
  state: WizardStateLike | undefined,
  over?: { readonly error?: string; readonly values?: SetupFormValuesInput },
): Promise<object> {
  const models = await ctx.loadModels();
  const recent = await ctx.deps.recent.listModels();
  const rootSubdirs = await scanRoot(ctx, ctx.deps.allowedRoots?.[0]);
  const values: SetupFormValuesInput =
    over?.values ?? {
      ...(state?.dir ? { dir: state.dir } : {}),
      ...(state?.perm ? { perm: state.perm } : {}),
    };
  return buildSetupFormCard({
    models,
    recent,
    ...(state?.model ? { defaultModel: state.model } : {}),
    ...(rootSubdirs.length > 0 ? { rootSubdirs } : {}),
    ...(ctx.deps.allowedRoots ? { allowedRoots: ctx.deps.allowedRoots } : {}),
    ...(over?.error ? { error: over.error } : {}),
    values,
  });
}

/**
 * 扫描允许根目录的一级子目录（表单目录下拉选项来源）。
 * 任何失败静默降级为空列表（只保留「手动输入」与根目录两项），绝不抛异常。
 */
async function scanRoot(
  ctx: SessionPrimitives,
  root: string | undefined,
): Promise<readonly SetupFormDirEntry[]> {
  if (!root) return [];
  const scan = ctx.deps.scanRootSubdirs ?? scanRootSubdirs;
  try {
    return [...(await scan(root))];
  } catch (err) {
    ctx.deps.log.warn("根目录子目录扫描失败", { error: errorMessage(err) });
    return [];
  }
}

function confirmInput(state: WizardStateLike): {
  title?: string;
  dir?: string;
  model?: ModelRef;
  perm?: PermissionPreset;
} {
  return {
    ...(state.title ? { title: state.title } : {}),
    ...(state.dir ? { dir: state.dir } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.perm ? { perm: state.perm } : {}),
  };
}

/** 建会话向导 API 装配（挂到 ctx 上供命令分发调用）。 */
export function createSetupWizardApi(ctx: SessionPrimitives): SetupWizardApi {
  return {
    cmdNew: (message, args) => cmdNew(ctx, message, args),
    cmdForm: (message, args) => cmdForm(ctx, message, args),
    cmdDir: (message, args) => cmdDir(ctx, message, args),
    cmdModel: (message, args, scope) => cmdModel(ctx, message, args, scope),
    cmdPerm: (message, args, scope) => cmdPerm(ctx, message, args, scope),
    cmdCancel: (message) => cmdCancel(ctx, message),
    applySetupCardAction: (action, value) => applySetupCardAction(ctx, action, value),
    applySetupFormSubmit: (action) => applySetupFormSubmit(ctx, action),
    sendSetupFormForChat: (chatId, anchorMessageId, openId) =>
      sendSetupFormForChat(ctx, chatId, anchorMessageId, openId),
  };
}
