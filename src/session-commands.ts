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
import { buildSessionListCard, buildSessionCreatedCard, buildSessionReadyCard, parseSessionCardValue, type SessionCardValue } from "./feishu/session-cards.js";
import {
  buildConfirmCard,
  buildModelCard,
  buildPermCard,
  buildSetupDoneCard,
  buildSetupFormCard,
  isSetupFormAction,
  parseSetupCardValue,
  parseSetupFormValues,
  resolveSetupFormDir,
  type SetupFormValuesInput,
  type SetupCardValue,
  type SetupFormDirEntry,
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
import { scanRootSubdirs } from "./feishu/root-scan.js";

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
  /**
   * `/steer <文本>`：把文本以 `delivery:"steer"` 立即插入会话执行（打断当前步骤）。
   * 缺省时该命令提示不支持。
   */
  readonly steerPrompt?: (message: IncomingMessage, sessionID: string, text: string) => Promise<void>;
  /**
   * `/now`：把会话已排队的未投递消息改为 `steer`，返回提升条数。
   * 返回 -1 表示当前运行时未暴露 inbox（不支持）；缺省同。
   */
  readonly promoteQueued?: (sessionID: string) => Promise<number>;
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
  /** 扫描允许根目录的一级子目录（目录下拉选项来源，默认 `scanRootSubdirs`；测试可注入）。 */
  readonly scanRootSubdirs?: (root: string) => Promise<readonly SetupFormDirEntry[]>;
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
      case "steer":
        return this.cmdSteer(message, parsed.args, scope);
      case "now":
        return this.cmdNow(message, scope);
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
        return this.cmdForm(message, parsed.args);
      case "unknown":
        return this.reply(message, `未知命令 \`/${parsed.raw}\`\n\n${helpText(scope)}`);
      case "help":
      default:
        return this.reply(message, helpText(scope));
    }
  }

  // ── 建会话（主聊天流） ────────────────────────────────────────────────

  /**
   * `/new`：与 `/form` **完全等价**，直接发建会话表单卡（不再走目录→模型→权限→确认分步卡）。
   * 带标题时写入向导状态，表单提交后作为会话标题。
   */
  private async cmdNew(message: IncomingMessage, args: string): Promise<void> {
    const title = args.trim() || undefined;
    if (!this.threadRouting) {
      // 回退模式（threadRouting=false）：没有话题，沿用 P3 旧行为直接建会话。
      const finalTitle = title ?? defaultSessionTitle(this.now());
      const created = await this.deps.createSession({
        title: finalTitle,
        chatId: message.chatId,
        openId: message.senderOpenId,
      });
      await this.reply(message, `✅ 已新建并切换到会话「${finalTitle}」\n\`${created.id}\``);
      return;
    }
    await this.openSetupForm(message, title);
  }

  /**
   * `/form [标题]`：直接打开发建会话表单卡。
   * 与 `/new [标题]` 走同一入口，二者完全等价。
   */
  private async cmdForm(message: IncomingMessage, args: string): Promise<void> {
    await this.openSetupForm(message, args.trim() || undefined);
  }

  /**
   * `/new` / `/form` 共同入口：发（或复用）建会话表单卡。
   * 已有向导状态时保留 `/dir` `/model` `/perm` 预填的字段；带标题则更新标题。
   */
  private async openSetupForm(message: IncomingMessage, title?: string): Promise<void> {
    if (message.threadId) {
      await this.reply(message, threadForbiddenText("form"));
      return;
    }
    if (!this.threadRouting) {
      await this.reply(message, "当前为回退模式（`threadRouting=false`），不支持表单建会话，请用 `/new`。");
      return;
    }
    let state = await this.deps.wizard.get(message.chatId);
    if (!state) {
      state = await this.deps.wizard.start(message.chatId, title, message.messageId);
    } else if (title !== undefined) {
      state = { ...state, title };
      await this.deps.wizard.set(message.chatId, state);
    }
    const card = await this.renderFormCard(state);
    const res = await this.deps.sender.sendCard(message.chatId, card);
    if (!res.ok) this.deps.log.warn("表单卡发送失败", { chatId: message.chatId, error: res.error ?? "unknown" });
  }

  /**
   * `/dir <path>`：目录只作表单**预填**（不再是必经步骤）。
   * 目录容错：留空 = 允许根目录；不存在则自动创建（仍在 allowedRoots 之下）。
   */
  private async cmdDir(message: IncomingMessage, args: string): Promise<void> {
    if (message.threadId) {
      await this.reply(message, threadForbiddenText("dir"));
      return;
    }
    const validation = this.deps.validateDir(args);
    if (!validation.ok) {
      await this.reply(message, validation.message);
      return;
    }
    if (!(await this.deps.wizard.get(message.chatId))) {
      await this.deps.wizard.start(message.chatId, undefined, message.messageId);
    }
    const state = await this.deps.wizard.apply(message.chatId, { type: "setDir", dir: validation.path });
    await this.deps.recent.addDir(validation.path);
    if (!state) {
      await this.reply(message, "向导状态已丢失，请重新发送 `/new` 开始。");
      return;
    }
    // 分步卡已下线：把目录作为表单预填项，直接回一张新的表单卡。
    await this.deps.sender.sendCard(message.chatId, await this.renderFormCard(state));
  }

  /** `/model [关键词]`：向导内选模型（仅预填表单）；话题内切换当前会话模型。 */
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

    if (!(await this.deps.wizard.get(message.chatId))) {
      await this.deps.wizard.start(message.chatId, undefined, message.messageId);
    }
    if (!args.trim()) {
      const state = await this.deps.wizard.get(message.chatId);
      await this.deps.sender.sendCard(message.chatId, await this.renderFormCard(state));
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
    // 分步卡已下线：模型作为表单预填项。
    await this.deps.sender.sendCard(message.chatId, await this.renderFormCard(next));
  }

  /** `/perm [档位]`：向导内选权限（仅预填表单）；话题内修改当前会话权限。 */
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

    if (!(await this.deps.wizard.get(message.chatId))) {
      await this.deps.wizard.start(message.chatId, undefined, message.messageId);
    }
    if (!arg) {
      const state = await this.deps.wizard.get(message.chatId);
      await this.deps.sender.sendCard(message.chatId, await this.renderFormCard(state));
      return;
    }
    if (!isPermissionPreset(arg)) {
      await this.reply(message, permUsageText());
      return;
    }
    const next = await this.deps.wizard.apply(message.chatId, { type: "setPerm", perm: arg });
    if (!next) return;
    // 分步卡已下线：权限作为表单预填项。
    await this.deps.sender.sendCard(message.chatId, await this.renderFormCard(next));
  }

  /**
   * `/cd <path>`：话题内移动当前会话目录。
   * 目录容错：留空 = 回到允许根目录；不存在则自动创建（仍在 allowedRoots 之下）。
   */
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
    await this.reply(message, "✖️ 已取消建会话表单。发送 `/new [标题]` 可重新开始。");
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

  /** 解析命令作用域内的目标会话：话题内用 thread 映射，主聊天流用当前会话。 */
  private async scopeSessionID(message: IncomingMessage, scope: CommandScope): Promise<string | undefined> {
    if (scope === "thread") return this.threadSessionID(message);
    const active = await this.deps.sessionMap.getActive(message.chatId);
    return active?.sessionID;
  }

  /** `/now`：把已排队（未投递）的消息提升为 steer，立即插队执行。 */
  private async cmdNow(message: IncomingMessage, scope: CommandScope): Promise<void> {
    const sessionID = await this.scopeSessionID(message, scope);
    if (!sessionID) {
      await this.reply(message, "当前没有会话。");
      return;
    }
    if (!this.deps.promoteQueued) {
      await this.reply(message, "当前版本不支持插队（运行时未暴露 inbox）。");
      return;
    }
    const promoted = await this.deps.promoteQueued(sessionID);
    if (promoted < 0) {
      await this.reply(message, "当前版本不支持插队（运行时未暴露 inbox）。");
      return;
    }
    if (promoted === 0) {
      await this.reply(message, "没有排队中的消息（该会话当前空闲或无待投递项）。");
      return;
    }
    await this.reply(message, `⚡ 已把 ${promoted} 条排队消息改为立即插队执行。`);
  }

  /** `/steer <文本>`：立即插队发送一条消息（打断当前步骤插入执行）。 */
  private async cmdSteer(message: IncomingMessage, args: string, scope: CommandScope): Promise<void> {
    const sessionID = await this.scopeSessionID(message, scope);
    if (!sessionID) {
      await this.reply(message, "当前没有会话。");
      return;
    }
    const text = args.trim();
    if (!text) {
      await this.reply(message, "用法：`/steer <文本>`（立即插队发送）；把已排队消息插队请用 `/now`。");
      return;
    }
    if (!this.deps.steerPrompt) {
      await this.reply(message, "当前版本不支持插队。");
      return;
    }
    await this.deps.steerPrompt(message, sessionID, text);
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

  /**
   * 确认卡「✅ 创建」：读向导 → 走统一创建路径。
   *
   * @deprecated `/new` 已不再发确认卡；仅当用户点击**历史遗留**的确认卡时才会走到这里。
   * 新流程见 `applySetupFormSubmit`（表单提交）。
   */
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
    // 目录优先级：下拉选中 → 文本输入 → 允许根目录 allowedRoots[0]（纯函数，便于单测）。
    const requestedDir = resolveSetupFormDir(values, this.deps.allowedRoots ?? []);
    let preserved: SetupFormValuesInput = {
      dir: requestedDir,
      ...(values.model ? { model: values.model } : {}),
      ...(values.perm ? { perm: values.perm } : {}),
    };

    // 保留诊断日志：字段解析。
    this.deps.log.info("表单字段解析", {
      dirInput: values.dir,
      dirSelect: values.dirSelect,
      dir: requestedDir,
      model: values.model ? `${values.model.providerID}/${values.model.id}` : undefined,
      perm: values.perm,
      hasState: true,
    });
    const validation = this.deps.validateDir(requestedDir);
    if (!validation.ok) {
      // 目录留空/不存在都由 validateDir 处理：留空 → 允许根目录；不存在 → 自动创建。
      this.deps.log.warn("目录校验失败", { dir: requestedDir, reason: validation.message });
      await this.patchCard(
        action.messageId,
        await this.renderFormCard(state, { error: validation.message, values: preserved }),
      );
      return;
    }
    // 目录留空 → 用解析出的实际路径回写，便于后续展示/错误回显。
    preserved = { ...preserved, dir: validation.path };

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

    // 话题锚点 = 用户提交的建会话表单卡这条消息本身：
    // 对它 `reply_in_thread` 发就绪卡，表单消息即成为话题根；不再发独立的锚点文本。
    const anchorId = action.messageId || opts.anchorMessageId || "";
    const res = await this.deps.sender.replyCard(anchorId, readyCard, { replyInThread: true });
    this.deps.log.info("创建会话并开话题", {
      sessionID: created.id,
      anchorMessageId: anchorId,
      anchorFromFormCard: Boolean(action.messageId),
      replyOk: res.ok,
      replyMessageId: res.messageId,
      replyThreadId: res.threadId,
      replyError: res.error,
    });
    if (!res.ok || !res.messageId) {
      this.deps.log.warn("一键开话题失败", { error: res.error ?? "unknown" });
      await this.patchCard(
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
    await this.deps.sessionMap.bindRoot(anchorId, created.id);
    const meta = res.threadId ? undefined : await this.deps.sender.getMessageMeta(res.messageId);
    const threadId = res.threadId ?? meta?.threadId;
    if (threadId) {
      await this.deps.sessionMap.bindThread(threadId, created.id, chatId, action.operatorOpenId, anchorId);
    } else {
      this.deps.log.warn("一键开话题后未读到 thread_id，该会话暂无法自动路由", { messageId: res.messageId });
    }

    // 把表单卡改写成成功卡：标题 `✅ 已创建 · <会话标题>`，作为话题显示名。
    await this.patchCard(
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

  // ── 卡片渲染辅助 ──────────────────────────────────────────────────────

  // 说明：`/new` 已改为直接发建会话表单卡，以下分步卡的发送方法已不再使用（已移除）。
  // 分步卡的**构建函数**（buildDirCard/buildModelCard/buildPermCard/buildConfirmCard）与
  // 对应卡片回调分支仍保留，用于兼容旧卡片与单测（标注 @deprecated）。

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

  /**
   * 渲染建会话表单卡（P6.1）：最近模型 + 常用模型 + 默认预选。
   * P6.2：目录/权限也从向导状态预填（`/dir` `/perm` 的能力，不再是必经步骤）。
   */
  private async renderFormCard(
    state: WizardStateLike | undefined,
    over?: { readonly error?: string; readonly values?: SetupFormValuesInput },
  ): Promise<object> {
    const models = await this.loadModels();
    const recent = await this.deps.recent.listModels();
    const rootSubdirs = await this.scanRoot(this.deps.allowedRoots?.[0]);
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
      ...(this.deps.allowedRoots ? { allowedRoots: this.deps.allowedRoots } : {}),
      ...(over?.error ? { error: over.error } : {}),
      values,
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

  /**
   * 扫描允许根目录的一级子目录（表单目录下拉选项来源）。
   * 任何失败静默降级为空列表（只保留「手动输入」与根目录两项），绝不抛异常。
   */
  private async scanRoot(root: string | undefined): Promise<readonly SetupFormDirEntry[]> {
    if (!root) return [];
    const scan = this.deps.scanRootSubdirs ?? scanRootSubdirs;
    try {
      return [...(await scan(root))];
    } catch (err) {
      this.deps.log.warn("根目录子目录扫描失败", { error: errorMessage(err) });
      return [];
    }
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
