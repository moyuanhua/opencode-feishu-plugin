/**
 * 飞书会话命令编排：文本命令 + 会话/向导卡片回调。
 *
 * 设计对齐 `ApprovalManager`：
 * - 文本命令走 `handleText`（异步，扣在 `handleMessage` 最前面）；
 * - 卡片按钮 `handleCardAction` **同步返回 toast**（飞书要求 3 秒内响应），
 *   真正的 create/switch/patch-card 全部 fire-and-forget。
 *
 * P5（话题 = 会话）+ P6（建会话向导 / 权限预设）：
 * - 主聊天流 `/new` 起**向导**：目录 → 模型 → 权限 → 确认 → 建会话并自动开话题；
 * - 话题内可用 `/current` `/stop` `/help` `/model` `/perm` `/cd`；其余命令提示去主聊天流；
 * - `/model` `/perm` 在向导内推进状态，在话题内直接改当前会话；
 * - 出站按 scope 选 reply（话题内）或 create（主聊天流）。
 */
import { errorMessage } from "./logger.js";
import type {
  CardAction,
  IncomingMessage,
  Logger,
  ModelRef,
  PermissionPreset,
  PermissionRule,
  SessionGateMode,
} from "./types.js";
import type { FeishuSender } from "./feishu/sender.js";
import type { SessionMap } from "./feishu/session-map.js";
import { buildSessionListCard, buildSessionReadyCard, parseSessionCardValue, type SessionCardValue } from "./feishu/session-cards.js";
import {
  buildConfirmCard,
  buildDirCard,
  buildModelCard,
  buildPermCard,
  buildSetupDoneCard,
  buildSetupFormCard,
  isSetupFormAction,
  parseSetupCardValue,
  parseSetupFormValues,
  type SetupFormValuesInput,
  type SetupCardValue,
} from "./feishu/setup-cards.js";
import {
  defaultSessionTitle,
  helpText,
  isCommandAllowedInThread,
  matchSession,
  parseCommand,
  threadForbiddenText,
  useErrorText,
  type ParsedCommand,
} from "./feishu/commands.js";
import type { CommandScope } from "./feishu/routing.js";
import type { DirValidation } from "./feishu/dirs.js";
import {
  PERMISSION_PRESETS,
  isPermissionPreset,
  presetAskActions,
  presetGateMode,
  presetInfo,
  presetLabel,
  presetToRuleset,
} from "./feishu/perm-presets.js";
import { matchModel, modelLabel, modelMatchErrorText, type ModelEntry } from "./feishu/models.js";
import type { WizardStore } from "./feishu/wizard.js";
import type { RecentStore } from "./feishu/recent.js";

/** 建会话输入（P6）：标题 + 归属 + 目录/模型/权限。 */
export interface CreateSessionInput {
  readonly title: string;
  readonly chatId: string;
  readonly openId: string;
  /** 是否设为该 chat 的当前会话（话题内新建传 false）。 */
  readonly setActive?: boolean;
  readonly model?: ModelRef;
  readonly directory?: string;
  readonly permissions?: readonly PermissionRule[];
  readonly perm?: PermissionPreset;
  readonly gateMode?: SessionGateMode;
}

export interface SessionCommandsDeps {
  readonly log: Logger;
  readonly sessionMap: SessionMap;
  readonly sender: FeishuSender;
  readonly isAllowed: (openId: string) => boolean;
  /** 新建 opencode 会话并写入映射/元数据，返回至少含 id 的对象。 */
  readonly createSession: (input: CreateSessionInput) => Promise<{ id: string }>;
  /** 中断指定会话正在跑的任务。 */
  readonly interruptSession: (sessionID: string) => Promise<void>;
  /** 话题路由开关（P5）。false = 完全回到 P3 行为（`/new` 只回执文本）。 */
  readonly threadRouting?: boolean;
  readonly now?: () => number;
  /** 建会话向导状态（P6）。 */
  readonly wizard: WizardStore;
  /** 最近使用目录/模型（P6）。 */
  readonly recent: RecentStore;
  /** 列出可用模型（P6，已归一化）。 */
  readonly listModels: () => Promise<readonly ModelEntry[]>;
  /** 切换已存在会话的模型（含记录 + 运行卡页脚）。 */
  readonly switchSessionModel: (sessionID: string, model: ModelRef) => Promise<void>;
  /** 应用权限预设（含 ruleset + gateMode 记录）。 */
  readonly applyPermissionPreset: (sessionID: string, preset: PermissionPreset) => Promise<void>;
  /** 移动会话工作目录（move + 记录）。 */
  readonly moveSessionDir: (sessionID: string, dir: string) => Promise<void>;
  /** 目录校验（与 config.allowedRoots 绑定）。 */
  readonly validateDir: (path: string) => DirValidation;
  readonly allowedRoots?: readonly string[];
  /** 模型卡片每页数量（默认 8）。 */
  readonly modelPageSize?: number;
  /** 模型卡片「最近」列表长度（默认 5，与 config.recentModelsLimit 一致）。 */
  readonly recentModelsLimit?: number;
}

export class SessionCommands {
  private readonly now: () => number;
  private readonly threadRouting: boolean;
  private readonly modelPageSize: number;

  constructor(private readonly deps: SessionCommandsDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.threadRouting = deps.threadRouting ?? true;
    this.modelPageSize = deps.modelPageSize ?? 8;
  }

  /**
   * 文本命令拦截。返回 true 表示已作为命令处理（调用方**不得**再发 prompt）。
   * 非命令返回 false。
   */
  async handleText(message: IncomingMessage): Promise<boolean> {
    const parsed = parseCommand(message.text);
    if (!parsed) return false;
    const scope: CommandScope = message.threadId ? "thread" : "main";
    try {
      if (scope === "thread" && !isCommandAllowedInThread(parsed.name)) {
        await this.reply(message, threadForbiddenText(parsed.raw));
        return true;
      }
      await this.dispatch(parsed, message, scope);
    } catch (err) {
      this.deps.log.warn("会话命令处理失败", { command: parsed.raw, error: errorMessage(err) });
      await this.reply(message, `⚠️ 命令执行失败：${errorMessage(err)}`);
    }
    return true;
  }

  /**
   * 卡片按钮点击：同步返回飞书回调响应（toast），重活在后台完成。
   * 校验：仅白名单用户可操作。表单提交 / 会话卡 / 向导卡分别路由。
   */
  handleCardAction(action: CardAction): object {
    // P6.1：表单提交（`action.form_value` 存在，或 value 带 `{cmd:"setup.form"}`）。
    if (isSetupFormAction(action.rawValue) || parseSetupFormValues(action.formValue)) {
      if (!this.deps.isAllowed(action.operatorOpenId)) {
        this.deps.log.warn("拒绝非白名单用户的表单提交", { operator: action.operatorOpenId.slice(0, 8) });
        return toast("error", "无操作权限");
      }
      void this.applySetupFormSubmit(action).catch((err) => {
        this.deps.log.warn("表单提交处理失败", { error: errorMessage(err) });
      });
      return toast("success", "正在创建会话…");
    }

    const sessionValue = parseSessionCardValue(action.rawValue);
    const setupValue = sessionValue ? undefined : parseSetupCardValue(action.rawValue);
    if (!sessionValue && !setupValue) return toast("error", "无法识别的操作");
    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的卡片点击", { operator: action.operatorOpenId.slice(0, 8) });
      return toast("error", "无操作权限");
    }

    if (sessionValue) {
      void this.applySessionCardAction(action, sessionValue).catch((err) => {
        this.deps.log.warn("会话卡片操作失败", { cmd: sessionValue.cmd, error: errorMessage(err) });
      });
      return sessionValue.cmd === "new" ? toast("success", "正在新建会话…") : toast("success", "已切换");
    }

    const value = setupValue!;
    void this.applySetupCardAction(action, value).catch((err) => {
      this.deps.log.warn("向导卡片操作失败", { wizard: value.kind, error: errorMessage(err) });
    });
    return setupToast(value);
  }

  private async dispatch(parsed: ParsedCommand, message: IncomingMessage, scope: CommandScope): Promise<void> {
    switch (parsed.name) {
      case "new":
        return this.cmdNew(message, parsed.args);
      case "sessions":
        return this.cmdSessions(message);
      case "use":
        return this.cmdUse(message, parsed.args);
      case "current":
        return this.cmdCurrent(message, scope);
      case "stop":
        return this.cmdStop(message, scope);
      case "dir":
        return this.cmdDir(message, parsed.args);
      case "model":
        return this.cmdModel(message, parsed.args, scope);
      case "perm":
        return this.cmdPerm(message, parsed.args, scope);
      case "cd":
        return this.cmdCd(message, parsed.args);
      case "cancel":
        return this.cmdCancel(message);
      case "form":
        return this.cmdForm(message);
      case "unknown":
        return this.reply(message, `未知命令 \`/${parsed.raw}\`\n\n${helpText(scope)}`);
      case "help":
      default:
        return this.reply(message, helpText(scope));
    }
  }

  // ── 建会话向导（主聊天流） ────────────────────────────────────────────

  /** `/new`：threadRouting=false 时沿用旧行为；否则起向导并发送目录选择卡。 */
  private async cmdNew(message: IncomingMessage, args: string): Promise<void> {
    const title = args.trim() || undefined;
    if (!this.threadRouting) {
      const finalTitle = title ?? defaultSessionTitle(this.now());
      const created = await this.deps.createSession({
        title: finalTitle,
        chatId: message.chatId,
        openId: message.senderOpenId,
      });
      await this.reply(message, `✅ 已新建并切换到会话「${finalTitle}」\n\`${created.id}\``);
      return;
    }
    const state = await this.deps.wizard.start(message.chatId, title, message.messageId);
    await this.sendDirCard(message.chatId);
  }

  /** `/dir <path>`：设置目录 → 进模型步。 */
  private async cmdDir(message: IncomingMessage, args: string): Promise<void> {
    if (message.threadId) {
      await this.reply(message, threadForbiddenText("dir"));
      return;
    }
    if (!(await this.deps.wizard.get(message.chatId))) {
      await this.deps.wizard.start(message.chatId, undefined, message.messageId);
    }
    const validation = this.deps.validateDir(args);
    if (!validation.ok) {
      await this.reply(message, validation.message);
      return;
    }
    const state = await this.deps.wizard.apply(message.chatId, { type: "setDir", dir: validation.path });
    await this.deps.recent.addDir(validation.path);
    if (!state) {
      await this.reply(message, "向导状态已丢失，请重新发送 `/new` 开始。");
      return;
    }
    await this.sendModelCard(message.chatId, state);
  }

  /** `/model [关键词]`：向导内选模型；话题内切换当前会话模型。 */
  private async cmdModel(message: IncomingMessage, args: string, scope: CommandScope): Promise<void> {
    if (scope === "thread") {
      const sessionID = await this.threadSessionID(message);
      if (!sessionID) {
        await this.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
        return;
      }
      if (!args.trim()) {
        await this.sendModelCardToThread(message, sessionID, 0);
        return;
      }
      const models = await this.loadModels();
      const matched = matchModel(args, models);
      if (!matched.ok) {
        await this.reply(message, modelMatchErrorText(matched.reason, matched.candidates));
        return;
      }
      await this.deps.switchSessionModel(sessionID, matched.model);
      await this.deps.recent.addModel(matched.model);
      await this.reply(message, `✅ 已切换模型：**${modelLabel(matched.model)}**\n\`${matched.model.providerID}/${matched.model.id}\``);
      return;
    }

    const state = await this.deps.wizard.get(message.chatId);
    if (!state) {
      await this.reply(message, "请先发送 `/new [标题]` 开始建会话向导并选择目录。");
      return;
    }
    if (!args.trim()) {
      await this.sendModelCard(message.chatId, state);
      return;
    }
    if (!state.dir) {
      await this.reply(message, "请先发送 `/dir <绝对路径>` 选择工作目录。");
      return;
    }
    const models = await this.loadModels();
    const matched = matchModel(args, models);
    if (!matched.ok) {
      await this.reply(message, modelMatchErrorText(matched.reason, matched.candidates));
      return;
    }
    const next = await this.deps.wizard.apply(message.chatId, { type: "setModel", model: matched.model });
    await this.deps.recent.addModel(matched.model);
    if (!next) return;
    await this.sendPermCard(message.chatId, next);
  }

  /** `/perm [档位]`：向导内选权限；话题内修改当前会话权限。 */
  private async cmdPerm(message: IncomingMessage, args: string, scope: CommandScope): Promise<void> {
    const arg = args.trim();
    if (scope === "thread") {
      const sessionID = await this.threadSessionID(message);
      if (!sessionID) {
        await this.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
        return;
      }
      if (!arg) {
        await this.sendPermCardToThread(message, sessionID);
        return;
      }
      if (!isPermissionPreset(arg)) {
        await this.reply(message, permUsageText());
        return;
      }
      await this.deps.applyPermissionPreset(sessionID, arg);
      await this.reply(message, `✅ 已更新本会话权限：${presetLabel(arg)}`);
      return;
    }

    const state = await this.deps.wizard.get(message.chatId);
    if (!state) {
      await this.reply(message, "请先发送 `/new [标题]` 开始建会话向导。");
      return;
    }
    if (!arg) {
      await this.sendPermCard(message.chatId, state);
      return;
    }
    if (!isPermissionPreset(arg)) {
      await this.reply(message, permUsageText());
      return;
    }
    if (!state.dir) {
      await this.reply(message, "请先发送 `/dir <绝对路径>` 选择工作目录。");
      return;
    }
    const next = await this.deps.wizard.apply(message.chatId, { type: "setPerm", perm: arg });
    if (!next) return;
    await this.sendConfirmCard(message.chatId, next);
  }

  /** `/cd <path>`：话题内移动当前会话目录。 */
  private async cmdCd(message: IncomingMessage, args: string): Promise<void> {
    if (!message.threadId) {
      await this.reply(message, "`/cd` 只能在话题内使用（用于移动该话题会话的工作目录）。");
      return;
    }
    const sessionID = await this.threadSessionID(message);
    if (!sessionID) {
      await this.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
      return;
    }
    const validation = this.deps.validateDir(args);
    if (!validation.ok) {
      await this.reply(message, validation.message);
      return;
    }
    await this.deps.moveSessionDir(sessionID, validation.path);
    await this.deps.recent.addDir(validation.path);
    await this.reply(message, `✅ 已切换本会话目录：\`${validation.path}\``);
  }

  /** `/cancel`：放弃向导。 */
  private async cmdCancel(message: IncomingMessage): Promise<void> {
    if (message.threadId) {
      await this.reply(message, threadForbiddenText("cancel"));
      return;
    }
    await this.deps.wizard.cancel(message.chatId);
    await this.reply(message, "✖️ 已取消建会话向导。发送 `/new [标题]` 可重新开始。");
  }

  /** `/form`：主聊天流直接打开建会话表单卡（P6.1）。 */
  private async cmdForm(message: IncomingMessage): Promise<void> {
    if (message.threadId) {
      await this.reply(message, threadForbiddenText("form"));
      return;
    }
    if (!this.threadRouting) {
      await this.reply(message, "当前为回退模式（`threadRouting=false`），不支持表单建会话，请用 `/new`。");
      return;
    }
    let state = await this.deps.wizard.get(message.chatId);
    if (!state) state = await this.deps.wizard.start(message.chatId, undefined, message.messageId);
    const card = await this.renderFormCard(state);
    const res = await this.deps.sender.sendCard(message.chatId, card);
    if (!res.ok) this.deps.log.warn("表单卡发送失败", { chatId: message.chatId, error: res.error ?? "unknown" });
  }

  // ── 既有会话管理 ──────────────────────────────────────────────────────

  private async cmdSessions(message: IncomingMessage): Promise<void> {
    const sessions = await this.deps.sessionMap.listSessions(message.chatId);
    const active = await this.deps.sessionMap.getActive(message.chatId);
    const card = buildSessionListCard({
      chatId: message.chatId,
      sessions,
      ...(active ? { activeID: active.sessionID } : {}),
    });
    const res = await this.deps.sender.sendCard(message.chatId, card);
    if (!res.ok) {
      this.deps.log.warn("会话卡片发送失败", { chatId: message.chatId, error: res.error ?? "unknown" });
      return;
    }
    // 用户从这张卡手动「创建话题」时，root = 卡片消息 id → 锚定到当前会话。
    if (res.messageId && active) {
      await this.deps.sessionMap.bindRoot(res.messageId, active.sessionID);
    }
  }

  private async cmdUse(message: IncomingMessage, args: string): Promise<void> {
    const sessions = await this.deps.sessionMap.listSessions(message.chatId);
    if (sessions.length === 0) {
      await this.reply(message, "还没有会话。使用 /new 新建一个。");
      return;
    }
    const matched = matchSession(args, sessions);
    if (!matched.ok) {
      await this.reply(message, useErrorText(matched.reason));
      return;
    }
    const entry = matched.entry;
    const ok = await this.deps.sessionMap.setActive(message.chatId, entry.sessionID);
    if (!ok) {
      await this.reply(message, "切换失败：会话不存在，先用 /sessions 查看列表。");
      return;
    }
    await this.reply(message, `✅ 已切换到「${entry.title.trim() || "(未命名)"}」\n\`${entry.sessionID}\``);
  }

  private async cmdCurrent(message: IncomingMessage, scope: CommandScope): Promise<void> {
    if (scope === "thread") {
      const sessionID = await this.threadSessionID(message);
      if (!sessionID) {
        await this.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
        return;
      }
      const entry = await this.deps.sessionMap.getSession(message.chatId, sessionID);
      const link = await this.deps.sessionMap.resolveBySession(sessionID);
      const lines = [
        `本话题会话：「${entry?.title.trim() || "(未命名)"}」`,
        `\`${sessionID}\``,
        ...(link?.dir ? [`目录：\`${link.dir}\``] : []),
        ...(link?.model ? [`模型：${modelLabel(link.model)}`] : []),
        ...(link?.perm ? [`权限：${presetLabel(link.perm)}`] : []),
      ];
      await this.reply(message, lines.join("\n"));
      return;
    }

    const active = await this.deps.sessionMap.getActive(message.chatId);
    if (!active) {
      await this.reply(message, "当前没有会话。使用 /new 新建一个。");
      return;
    }
    const count = (await this.deps.sessionMap.listSessions(message.chatId)).length;
    await this.reply(
      message,
      `当前会话：「${active.title.trim() || "(未命名)"}」\n\`${active.sessionID}\`\n共 ${count} 个会话。`,
    );
  }

  private async cmdStop(message: IncomingMessage, scope: CommandScope): Promise<void> {
    if (scope === "thread") {
      const sessionID = await this.threadSessionID(message);
      if (!sessionID) {
        await this.reply(message, "本话题尚未关联会话，无法中断。");
        return;
      }
      await this.deps.interruptSession(sessionID);
      const entry = await this.deps.sessionMap.getSession(message.chatId, sessionID);
      await this.reply(message, `⏹️ 已请求中断本话题会话：「${entry?.title.trim() || "(未命名)"}」`);
      return;
    }

    const active = await this.deps.sessionMap.getActive(message.chatId);
    if (!active) {
      await this.reply(message, "当前没有会话可中断。");
      return;
    }
    await this.deps.interruptSession(active.sessionID);
    await this.reply(message, `⏹️ 已请求中断当前会话：「${active.title.trim() || "(未命名)"}」`);
  }

  // ── 会话列表卡片（旧） ────────────────────────────────────────────────

  private async applySessionCardAction(action: CardAction, value: SessionCardValue): Promise<void> {
    const chatId = action.chatId || value.chatId;
    if (!chatId) return;

    if (value.cmd === "new") {
      const title = defaultSessionTitle(this.now());
      await this.deps.createSession({
        title,
        chatId,
        openId: action.operatorOpenId,
      });
    } else {
      const ok = await this.deps.sessionMap.setActive(chatId, value.sessionID);
      if (!ok) this.deps.log.debug("卡片切换会话失败：会话不存在", { sessionID: value.sessionID });
    }

    if (action.messageId) await this.patchListCard(chatId, action.messageId);
  }

  private async patchListCard(chatId: string, messageId: string): Promise<void> {
    const sessions = await this.deps.sessionMap.listSessions(chatId);
    const active = await this.deps.sessionMap.getActive(chatId);
    const card = buildSessionListCard({ chatId, sessions, ...(active ? { activeID: active.sessionID } : {}) });
    const res = await this.deps.sender.patchCard(messageId, card);
    if (!res.ok) this.deps.log.warn("会话卡片更新失败", { error: res.error ?? "unknown" });
  }

  // ── 向导 / 会话操作卡片 ───────────────────────────────────────────────

  private async applySetupCardAction(action: CardAction, value: SetupCardValue): Promise<void> {
    const chatId = action.chatId;
    if (value.kind === "confirm") {
      await this.confirmSetup(chatId, action);
      return;
    }
    if (value.kind === "cancel") {
      await this.deps.wizard.cancel(chatId);
      await this.patchCard(action.messageId, buildSetupDoneCard("✖️ 已取消", ["建会话向导已取消。发送 `/new` 重新开始。"]));
      return;
    }
    if (value.kind === "form") {
      const state = (await this.deps.wizard.get(chatId)) ?? (await this.deps.wizard.start(chatId, undefined, action.messageId));
      await this.patchCard(action.messageId, await this.renderFormCard(state));
      return;
    }

    // 已存在会话的操作卡（话题内 `/model` `/perm`）
    if (value.kind !== "dir" && value.sid) {
      if (value.kind === "model") {
        await this.deps.switchSessionModel(value.sid, value.model);
        await this.deps.recent.addModel(value.model);
        await this.patchCard(
          action.messageId,
          buildSetupDoneCard("✅ 已切换模型", [`当前模型：**${modelLabel(value.model)}**`]),
        );
        return;
      }
      if (value.kind === "perm") {
        await this.deps.applyPermissionPreset(value.sid, value.preset);
        await this.patchCard(
          action.messageId,
          buildSetupDoneCard("✅ 已更新权限", [`当前权限：${presetLabel(value.preset)}`]),
        );
        return;
      }
      if (value.kind === "more") {
        const link = await this.deps.sessionMap.resolveBySession(value.sid);
        const models = await this.loadModels();
        const recent = await this.deps.recent.listModels();
        const card = buildModelCard({
          models,
          recent,
          ...(link?.model ? { current: link.model } : {}),
          page: value.page,
          pageSize: this.modelPageSize,
          recentLimit: this.recentModelsLimit(),
          sid: value.sid,
        });
        await this.patchCard(action.messageId, card);
        return;
      }
      return;
    }

    // 建会话向导
    const state = await this.deps.wizard.get(chatId);
    if (!state) {
      await this.patchCard(action.messageId, buildSetupDoneCard("⚠️ 向导已失效", ["请重新发送 `/new` 开始。"]));
      return;
    }
    if (value.kind === "dir") {
      const next = await this.deps.wizard.apply(chatId, { type: "setDir", dir: value.dir });
      await this.deps.recent.addDir(value.dir);
      if (!next) return;
      await this.patchCard(action.messageId, await this.renderModelCard(next));
      return;
    }
    if (value.kind === "model") {
      const next = await this.deps.wizard.apply(chatId, { type: "setModel", model: value.model });
      await this.deps.recent.addModel(value.model);
      if (!next) return;
      await this.patchCard(action.messageId, buildPermCard({ ...(next.perm ? { current: next.perm } : {}) }));
      return;
    }
    if (value.kind === "perm") {
      const next = await this.deps.wizard.apply(chatId, { type: "setPerm", perm: value.preset });
      if (!next) return;
      await this.patchCard(action.messageId, buildConfirmCard(confirmInput(next)));
      return;
    }
    if (value.kind === "more") {
      const next = await this.deps.wizard.apply(chatId, { type: "setPage", page: value.page });
      if (!next) return;
      await this.patchCard(action.messageId, await this.renderModelCard(next, value.page));
    }
  }

  /** 确认卡「✅ 创建」：读向导 → 走统一创建路径。 */
  private async confirmSetup(chatId: string, action: CardAction): Promise<void> {
    const state = await this.deps.wizard.get(chatId);
    if (!state || state.step !== "confirm" || !state.dir || !state.perm) {
      await this.patchCard(action.messageId, buildSetupDoneCard("⚠️ 向导状态不完整", ["请重新发送 `/new` 开始。"]));
      return;
    }
    // 立即消费向导，防止确认按钮被连点造成重复建会话。
    await this.deps.wizard.cancel(chatId);
    const title = state.title?.trim() || defaultSessionTitle(this.now());
    await this.createSessionFromSetup(chatId, action, {
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
  private async applySetupFormSubmit(action: CardAction): Promise<void> {
    const fv = action.formValue;
    const fvKeys = fv && typeof fv === "object" ? Object.keys(fv as Record<string, unknown>) : [];
    this.deps.log.info("表单提交进入处理", {
      chatId: action.chatId,
      messageId: action.messageId,
      formValueKeys: fvKeys,
      formValueType: Array.isArray(fv) ? "array" : typeof fv,
    });
    const values = parseSetupFormValues(action.formValue);
    if (!values) {
      this.deps.log.warn("表单数据缺失（parse 返回 undefined）", { formValueKeys: fvKeys });
      await this.patchCard(action.messageId, buildSetupDoneCard("⚠️ 表单数据缺失", ["请重新发送 `/form` 填写。"]));
      return;
    }
    const state = await this.deps.wizard.get(action.chatId);
    if (!state) {
      this.deps.log.warn("表单提交但向导状态不存在（可能已过期/已被消费）", {
        chatId: action.chatId,
        dirLen: values.dir.length,
        hasModel: Boolean(values.model),
        hasPerm: Boolean(values.perm),
      });
      // 与按钮确认一致：向导状态已消费/失效 → 视为过期提交，不再建会话（防重放/重复提交）。
      await this.patchCard(action.messageId, buildSetupDoneCard("⚠️ 表单已失效", ["请重新发送 `/form` 或 `/new` 打开表单。"]));
      return;
    }
    const title = state.title?.trim() || defaultSessionTitle(this.now());
    const preserved: SetupFormValuesInput = {
      dir: values.dir,
      ...(values.model ? { model: values.model } : {}),
      ...(values.perm ? { perm: values.perm } : {}),
    };

    this.deps.log.info("表单字段解析", {
      dir: values.dir,
      model: values.model ? `${values.model.providerID}/${values.model.id}` : undefined,
      perm: values.perm,
      hasState: true,
    });
    const validation = this.deps.validateDir(values.dir);
    if (!validation.ok) {
      this.deps.log.warn("目录校验失败", { dir: values.dir, reason: validation.message });
      await this.patchCard(
        action.messageId,
        await this.renderFormCard(state, { error: validation.message, values: preserved }),
      );
      return;
    }

    if (!values.perm) {
      this.deps.log.warn("权限档位缺失", { dir: validation.path });
      await this.patchCard(
        action.messageId,
        await this.renderFormCard(state, { error: "请选择权限档位。", values: { ...preserved, dir: validation.path } }),
      );
      return;
    }

    const model = values.model ? await this.resolveFormModel(values.model) : state?.model;
    this.deps.log.info("表单校验通过，开始建会话", {
      dir: validation.path,
      perm: values.perm,
      model: model ? `${model.providerID}/${model.id}` : undefined,
    });
    // 消费向导，防连点重复建会话。
    await this.deps.wizard.cancel(action.chatId);
    await this.createSessionFromSetup(action.chatId, action, {
      title,
      dir: validation.path,
      perm: values.perm,
      ...(model ? { model } : {}),
      ...(state?.anchorMessageId ? { anchorMessageId: state.anchorMessageId } : {}),
    });
  }

  /** 表单模型引用 → 尽量补全 name（列表不可用时保留原引用）。 */
  private async resolveFormModel(ref: ModelRef): Promise<ModelRef> {
    const models = await this.loadModels();
    const matched = matchModel(`${ref.providerID}/${ref.id}`, models);
    return matched.ok ? matched.model : ref;
  }

  /** 建会话统一创建路径（按钮确认 / 表单提交共用）。 */
  private async createSessionFromSetup(
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

    const created = await this.deps.createSession({
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
    await this.deps.recent.addDir(dir);
    if (model) await this.deps.recent.addModel(model);

    const readyCard = buildSessionReadyCard({
      title,
      sessionID: created.id,
      dir,
      ...(model ? { model: modelLabel(model) } : {}),
      perm: presetLabel(perm),
    });

    // 用一条**独立**消息作为话题锚点：
    // 不复用会被 patchCard 改写的卡片（否则同一张卡既是话题根又被改写，视觉上会重复）。
    const anchorText = await this.deps.sender.sendText(chatId, `🗂 已为「${title}」创建会话，话题已开好 👇`);
    const anchorId = anchorText.messageId ?? opts.anchorMessageId ?? action.messageId;
    const res = await this.deps.sender.replyCard(anchorId, readyCard, { replyInThread: true });
    this.deps.log.info("创建会话并开话题", {
      sessionID: created.id,
      anchorMessageId: anchorId,
      anchorFromText: Boolean(anchorText.messageId),
      replyOk: res.ok,
      replyMessageId: res.messageId,
      replyThreadId: res.threadId,
      replyError: res.error,
    });
    if (!res.ok || !res.messageId) {
      this.deps.log.warn("一键开话题失败", { error: res.error ?? "unknown" });
      await this.patchCard(
        action.messageId,
        buildSetupDoneCard("✅ 会话已创建", [
          `「${title}」\`${created.id}\``,
          "",
          "⚠️ 自动开话题失败：请在 `/sessions` 的会话卡上手动「创建话题」，或在主聊天流用 `/use` 切换后继续。",
        ]),
      );
      return;
    }

    await this.deps.sessionMap.bindRoot(res.messageId, created.id);
    const meta = res.threadId ? undefined : await this.deps.sender.getMessageMeta(res.messageId);
    const threadId = res.threadId ?? meta?.threadId;
    if (threadId) {
      await this.deps.sessionMap.bindThread(threadId, created.id, chatId, action.operatorOpenId, anchorId);
    } else {
      this.deps.log.warn("一键开话题后未读到 thread_id，该会话暂无法自动路由", { messageId: res.messageId });
    }

    await this.patchCard(
      action.messageId,
      buildSetupDoneCard(
        "✅ 会话已创建",
        [
          `会话「${title}」已就绪（\`${created.id}\`）`,
          ...(threadId ? ["", "已开好话题 👆 点进话题后直接发消息即可。"] : ["", "（未拿到话题 ID，若话题未出现请在会话卡上手动创建）"]),
        ],
        "green",
      ),
    );
  }

  // ── 卡片渲染辅助 ──────────────────────────────────────────────────────

  private async sendDirCard(chatId: string): Promise<void> {
    const card = buildDirCard({
      recent: await this.deps.recent.listDirs(),
      ...(this.deps.allowedRoots ? { allowedRoots: this.deps.allowedRoots } : {}),
    });
    await this.deps.sender.sendCard(chatId, card);
  }

  private async sendModelCard(chatId: string, state: WizardStateLike): Promise<void> {
    const card = await this.renderModelCard(state);
    await this.deps.sender.sendCard(chatId, card);
  }

  private async renderModelCard(state: WizardStateLike, pageOverride?: number): Promise<object> {
    const models = await this.loadModels();
    const recent = await this.deps.recent.listModels();
    return buildModelCard({
      models,
      recent,
      ...(state.model ? { current: state.model } : {}),
      page: pageOverride ?? state.page ?? 0,
      pageSize: this.modelPageSize,
      recentLimit: this.recentModelsLimit(),
    });
  }

  private async sendPermCard(chatId: string, state: WizardStateLike): Promise<void> {
    await this.deps.sender.sendCard(chatId, buildPermCard({ ...(state.perm ? { current: state.perm } : {}) }));
  }

  private async sendConfirmCard(chatId: string, state: WizardStateLike): Promise<void> {
    await this.deps.sender.sendCard(chatId, buildConfirmCard(confirmInput(state)));
  }

  /** 渲染建会话表单卡（P6.1）：最近模型 + 常用模型 + 默认预选，供 `patch`/`send` 复用。 */
  private async renderFormCard(
    state: WizardStateLike | undefined,
    over?: { readonly error?: string; readonly values?: SetupFormValuesInput },
  ): Promise<object> {
    const models = await this.loadModels();
    const recent = await this.deps.recent.listModels();
    return buildSetupFormCard({
      models,
      recent,
      ...(state?.model ? { defaultModel: state.model } : {}),
      ...(this.deps.allowedRoots ? { allowedRoots: this.deps.allowedRoots } : {}),
      ...(over?.error ? { error: over.error } : {}),
      ...(over?.values ? { values: over.values } : {}),
    });
  }

  private async sendModelCardToThread(message: IncomingMessage, sessionID: string, page: number): Promise<void> {
    const link = await this.deps.sessionMap.resolveBySession(sessionID);
    const models = await this.loadModels();
    const recent = await this.deps.recent.listModels();
    const card = buildModelCard({
      models,
      recent,
      ...(link?.model ? { current: link.model } : {}),
      page,
      pageSize: this.modelPageSize,
      recentLimit: this.recentModelsLimit(),
      sid: sessionID,
    });
    await this.deps.sender.replyCard(message.messageId, card);
  }

  private async sendPermCardToThread(message: IncomingMessage, sessionID: string): Promise<void> {
    const link = await this.deps.sessionMap.resolveBySession(sessionID);
    const card = buildPermCard({ ...(link?.perm ? { current: link.perm } : {}), sid: sessionID });
    await this.deps.sender.replyCard(message.messageId, card);
  }

  private async patchCard(messageId: string, card: object): Promise<void> {
    if (!messageId) return;
    const res = await this.deps.sender.patchCard(messageId, card);
    if (!res.ok) this.deps.log.warn("向导卡片更新失败", { error: res.error ?? "unknown" });
  }

  private async loadModels(): Promise<ModelEntry[]> {
    try {
      return [...(await this.deps.listModels())];
    } catch (err) {
      this.deps.log.warn("模型列表获取失败", { error: errorMessage(err) });
      return [];
    }
  }

  private recentModelsLimit(): number {
    return this.deps.recentModelsLimit ?? 5;
  }

  private async threadSessionID(message: IncomingMessage): Promise<string | undefined> {
    if (!message.threadId) return undefined;
    const link = await this.deps.sessionMap.resolveByThread(message.threadId);
    return link?.sessionID;
  }

  /** 文本回执：话题内引用触发消息（留在话题），主聊天流直接发送。 */
  private async reply(message: IncomingMessage, text: string): Promise<void> {
    if (message.threadId) {
      await this.deps.sender.replyText(message.messageId, text);
      return;
    }
    await this.deps.sender.sendText(message.chatId, text);
  }
}

/** 向导状态（结构化子集，避免与持久化类型强耦合）。 */
interface WizardStateLike {
  readonly step?: string;
  readonly dir?: string;
  readonly model?: ModelRef;
  readonly perm?: PermissionPreset;
  readonly title?: string;
  readonly page?: number;
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

function permUsageText(): string {
  const list = PERMISSION_PRESETS.map((p) => `\`${p.id}\`（${presetInfo(p.id).icon}${p.label}）`).join("、");
  return `未知权限档位。可用：${list}。\n例如：\`/perm edit\`。`;
}

function setupToast(value: SetupCardValue): object {
  switch (value.kind) {
    case "dir":
      return toast("success", "已选择目录");
    case "model":
      return toast("success", "已选择模型");
    case "perm":
      return toast("success", "已选择权限");
    case "more":
      return toast("info", "已翻页");
    case "confirm":
      return toast("success", "正在创建会话…");
    case "form":
      return toast("info", "已打开表单");
    case "cancel":
    default:
      return toast("info", "已取消");
  }
}

type ToastType = "success" | "error" | "warning" | "info";

function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}
