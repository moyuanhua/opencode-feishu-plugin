/**
 * 飞书会话命令编排**门面**（facade）。
 *
 * 纯重构说明：本文件原先把「文本命令 + 会话/向导卡片回调」的全部实现揉在一起，
 * 现按职责拆到 `src/session/` 下四个模块，这里只保留对外接口与命令分发，行为不变：
 * - `src/session/session-list.ts`：`/sessions` 列表 + 分页 + 进入话题动作；
 * - `src/session/setup-wizard.ts`：`/new` `/form` `/dir` `/model` `/perm` `/cancel` + 表单提交；
 * - `src/session/session-ops.ts`：`/use` `/current` `/stop` `/cd` `/resume` `/now` `/steer`；
 * - `src/session/model-perm.ts`：模型切换与权限档位相关编排；
 * - `src/session/context.ts`：依赖契约 + 通用原语。
 *
 * 设计对齐 `ApprovalManager`：
 * - 文本命令走 `handleText`（异步，扣在 `handleMessage` 最前面）；
 * - 卡片按钮 `handleCardAction` **同步返回 toast**（飞书要求 3 秒内响应），
 *   真正的 create/switch/patch-card 全部 fire-and-forget。
 */
import { errorMessage } from "./logger.js";
import type { CardAction, IncomingMessage } from "./types.js";
import {
  helpText,
  isCommandAllowedInThread,
  parseCommand,
  threadForbiddenText,
  type ParsedCommand,
} from "./feishu/commands.js";
import type { CommandScope } from "./feishu/routing.js";
import { parseSessionCardValue } from "./feishu/session-cards.js";
import {
  isSetupFormAction,
  parseSetupCardValue,
  parseSetupFormValues,
  type SetupCardValue,
} from "./feishu/setup-cards.js";
import {
  createSessionContext,
  toast,
  type SessionCommandsDeps,
  type SessionContext,
  type SetupFormPrefill,
} from "./session/context.js";
import { createSessionListApi } from "./session/session-list.js";
import { createSetupWizardApi } from "./session/setup-wizard.js";
import { createSessionOpsApi } from "./session/session-ops.js";
import { createModelPermApi } from "./session/model-perm.js";

// 对外类型契约保持不变（原来就在本文件导出，改从 session 上下文再导出）。
export type { CreateSessionInput, SessionCommandsDeps } from "./session/context.js";

export class SessionCommands {
  private readonly ctx: SessionContext;

  constructor(deps: SessionCommandsDeps) {
    const ctx = createSessionContext(deps);
    Object.assign(
      ctx,
      createSessionListApi(ctx),
      createSetupWizardApi(ctx),
      createSessionOpsApi(ctx),
      createModelPermApi(ctx),
    );
    this.ctx = ctx;
  }

  /** AI 管理台：构建会话列表卡（不发送；调用方自行 patch / 发送）。 */
  async buildSessionListCard(chatId: string, page = 0): Promise<object> {
    const entries = await this.ctx.loadSessionEntries(chatId);
    const active = await this.ctx.deps.sessionMap.getActive(chatId);
    return this.ctx.buildListCard(chatId, entries, page, active?.sessionID);
  }

  /**
   * AI 管理台：构建 AI 预填的建会话表单卡（写入向导状态，**不发送**）。
   * 表单消息 id 即后续话题锚点；用户确认/修改后提交走既有表单流程。
   */
  async buildPrefilledSetupForm(
    chatId: string,
    anchorMessageId: string,
    prefill: SetupFormPrefill,
  ): Promise<object> {
    return this.ctx.buildPrefilledSetupForm(chatId, anchorMessageId, prefill);
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
        await this.ctx.reply(message, threadForbiddenText(parsed.raw));
        return true;
      }
      await this.dispatch(parsed, message, scope);
    } catch (err) {
      this.ctx.deps.log.warn("会话命令处理失败", { command: parsed.raw, error: errorMessage(err) });
      await this.ctx.reply(message, `⚠️ 命令执行失败：${errorMessage(err)}`);
    }
    return true;
  }

  /**
   * 卡片按钮点击：同步（或极快）返回飞书回调响应（toast），重活在后台完成。
   * 校验：仅白名单用户可操作。表单提交 / 会话卡 / 向导卡分别路由。
   *
   * `open`（进入/再开话题）需要先 `ctx.session.get` 校验会话存在，因此返回 Promise；
   * gateway 的 SDK 会 await 该 Promise 作为回调响应，仍应在 3s 内完成。
   */
  handleCardAction(action: CardAction): object | Promise<object> {
    const ctx = this.ctx;
    // P6.1：表单提交（`action.form_value` 存在，或 value 带 `{cmd:"setup.form"}`）。
    if (isSetupFormAction(action.rawValue) || parseSetupFormValues(action.formValue)) {
      if (!ctx.deps.isAllowed(action.operatorOpenId)) {
        ctx.deps.log.warn("拒绝非白名单用户的表单提交", { operator: action.operatorOpenId.slice(0, 8) });
        return toast("error", "无操作权限");
      }
      void ctx.applySetupFormSubmit(action).catch((err) => {
        ctx.deps.log.warn("表单提交处理失败", { error: errorMessage(err) });
      });
      return toast("success", "正在创建会话…");
    }

    const sessionValue = parseSessionCardValue(action.rawValue);
    const setupValue = sessionValue ? undefined : parseSetupCardValue(action.rawValue);
    if (!sessionValue && !setupValue) return toast("error", "无法识别的操作");
    if (!ctx.deps.isAllowed(action.operatorOpenId)) {
      ctx.deps.log.warn("拒绝非白名单用户的卡片点击", { operator: action.operatorOpenId.slice(0, 8) });
      return toast("error", "无操作权限");
    }

    if (sessionValue) {
      // 「进入话题」：先查会话存在（快），再 fire-and-forget 开话题。
      if (sessionValue.cmd === "open") {
        return ctx.handleOpenCardAction(action, sessionValue);
      }
      void ctx.applySessionCardAction(action, sessionValue).catch((err) => {
        ctx.deps.log.warn("会话卡片操作失败", { cmd: sessionValue.cmd, error: errorMessage(err) });
      });
      if (sessionValue.cmd === "new") return toast("success", "正在打开表单…");
      if (sessionValue.cmd === "list") return toast("info", "已翻页");
      return toast("success", "已切换");
    }

    const value = setupValue!;
    void ctx.applySetupCardAction(action, value).catch((err) => {
      ctx.deps.log.warn("向导卡片操作失败", { wizard: value.kind, error: errorMessage(err) });
    });
    return setupToast(value);
  }

  private async dispatch(
    parsed: ParsedCommand,
    message: IncomingMessage,
    scope: CommandScope,
  ): Promise<void> {
    switch (parsed.name) {
      case "new":
        return this.ctx.cmdNew(message, parsed.args);
      case "sessions":
        return this.ctx.cmdSessions(message);
      case "use":
        return this.ctx.cmdUse(message, parsed.args);
      case "resume":
        return this.ctx.cmdResume(message, parsed.args);
      case "current":
        return this.ctx.cmdCurrent(message, scope);
      case "stop":
        return this.ctx.cmdStop(message, scope);
      case "steer":
        return this.ctx.cmdSteer(message, parsed.args, scope);
      case "now":
        return this.ctx.cmdNow(message, scope);
      case "dir":
        return this.ctx.cmdDir(message, parsed.args);
      case "model":
        return this.ctx.cmdModel(message, parsed.args, scope);
      case "perm":
        return this.ctx.cmdPerm(message, parsed.args, scope);
      case "cd":
        return this.ctx.cmdCd(message, parsed.args);
      case "cancel":
        return this.ctx.cmdCancel(message);
      case "form":
        return this.ctx.cmdForm(message, parsed.args);
      case "unknown":
        return this.ctx.reply(message, `未知命令 \`/${parsed.raw}\`\n\n${helpText(scope)}`);
      case "help":
      default:
        return this.ctx.reply(message, helpText(scope));
    }
  }
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
