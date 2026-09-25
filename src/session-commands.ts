/**
 * 飞书会话命令编排：文本命令 + 会话卡片按钮回调。
 *
 * 设计对齐 `ApprovalManager`：
 * - 文本命令走 `handleText`（异步，扣在 `handleMessage` 最前面）；
 * - 卡片按钮 `handleCardAction` **同步返回 toast**（飞书要求 3 秒内响应），
 *   真正的 create/switch/patch-card 全部 fire-and-forget。
 */
import { errorMessage } from "./logger.js";
import type { CardAction, IncomingMessage, Logger } from "./types.js";
import type { FeishuSender } from "./feishu/sender.js";
import type { SessionMap } from "./feishu/session-map.js";
import { buildSessionListCard, parseSessionCardValue, type SessionCardValue } from "./feishu/session-cards.js";
import { defaultSessionTitle, helpText, matchSession, parseCommand, useErrorText, type ParsedCommand } from "./feishu/commands.js";

export interface SessionCommandsDeps {
  readonly log: Logger;
  readonly sessionMap: SessionMap;
  readonly sender: FeishuSender;
  readonly isAllowed: (openId: string) => boolean;
  /** 新建 opencode 会话，返回至少含 id 的对象。 */
  readonly createSession: (title: string) => Promise<{ id: string }>;
  /** 中断指定会话正在跑的任务。 */
  readonly interruptSession: (sessionID: string) => Promise<void>;
  readonly now?: () => number;
}

export class SessionCommands {
  private readonly now: () => number;

  constructor(private readonly deps: SessionCommandsDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * 文本命令拦截。返回 true 表示已作为命令处理（调用方**不得**再发 prompt）。
   * 非命令返回 false。
   */
  async handleText(message: IncomingMessage): Promise<boolean> {
    const parsed = parseCommand(message.text);
    if (!parsed) return false;
    try {
      await this.dispatch(parsed, message);
    } catch (err) {
      this.deps.log.warn("会话命令处理失败", { command: parsed.raw, error: errorMessage(err) });
      await this.reply(message.chatId, `⚠️ 命令执行失败：${errorMessage(err)}`);
    }
    return true;
  }

  /**
   * 卡片按钮点击：同步返回飞书回调响应（toast），重活在后台完成。
   * 校验：仅白名单用户可操作。
   */
  handleCardAction(action: CardAction): object {
    const value = parseSessionCardValue(action.rawValue);
    if (!value) return toast("error", "无法识别的操作");
    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的会话卡片点击", { operator: action.operatorOpenId.slice(0, 8) });
      return toast("error", "无操作权限");
    }

    void this.applyCardAction(action, value).catch((err) => {
      this.deps.log.warn("会话卡片操作失败", { cmd: value.cmd, error: errorMessage(err) });
    });

    return value.cmd === "new" ? toast("success", "正在新建会话…") : toast("success", "已切换");
  }

  private async dispatch(parsed: ParsedCommand, message: IncomingMessage): Promise<void> {
    switch (parsed.name) {
      case "new":
        return this.cmdNew(message, parsed.args);
      case "sessions":
        return this.cmdSessions(message.chatId);
      case "use":
        return this.cmdUse(message, parsed.args);
      case "current":
        return this.cmdCurrent(message.chatId);
      case "stop":
        return this.cmdStop(message.chatId);
      case "unknown":
        return this.reply(message.chatId, `未知命令 \`/${parsed.raw}\`\n\n${helpText()}`);
      case "help":
      default:
        return this.reply(message.chatId, helpText());
    }
  }

  private async cmdNew(message: IncomingMessage, args: string): Promise<void> {
    const title = args.trim() || defaultSessionTitle(this.now());
    const created = await this.deps.createSession(title);
    await this.deps.sessionMap.addSession(message.chatId, created.id, title, message.senderOpenId);
    await this.reply(message.chatId, `✅ 已新建并切换到会话「${title}」\n\`${created.id}\``);
  }

  private async cmdSessions(chatId: string): Promise<void> {
    await this.sendListCard(chatId);
  }

  private async cmdUse(message: IncomingMessage, args: string): Promise<void> {
    const sessions = await this.deps.sessionMap.listSessions(message.chatId);
    if (sessions.length === 0) {
      await this.reply(message.chatId, "还没有会话。直接发消息即可自动创建，或使用 /new。");
      return;
    }
    const matched = matchSession(args, sessions);
    if (!matched.ok) {
      await this.reply(message.chatId, useErrorText(matched.reason));
      return;
    }
    const entry = matched.entry;
    const ok = await this.deps.sessionMap.setActive(message.chatId, entry.sessionID);
    if (!ok) {
      await this.reply(message.chatId, "切换失败：会话不存在，先用 /sessions 查看列表。");
      return;
    }
    await this.reply(message.chatId, `✅ 已切换到「${entry.title.trim() || "(未命名)"}」\n\`${entry.sessionID}\``);
  }

  private async cmdCurrent(chatId: string): Promise<void> {
    const active = await this.deps.sessionMap.getActive(chatId);
    if (!active) {
      await this.reply(chatId, "当前没有会话。发一条消息即可自动创建，或使用 /new。");
      return;
    }
    const count = (await this.deps.sessionMap.listSessions(chatId)).length;
    await this.reply(
      chatId,
      `当前会话：「${active.title.trim() || "(未命名)"}」\n\`${active.sessionID}\`\n共 ${count} 个会话。`,
    );
  }

  private async cmdStop(chatId: string): Promise<void> {
    const active = await this.deps.sessionMap.getActive(chatId);
    if (!active) {
      await this.reply(chatId, "当前没有会话可中断。");
      return;
    }
    await this.deps.interruptSession(active.sessionID);
    await this.reply(chatId, `⏹️ 已请求中断当前会话：「${active.title.trim() || "(未命名)"}」`);
  }

  private async applyCardAction(action: CardAction, value: SessionCardValue): Promise<void> {
    const chatId = action.chatId || value.chatId;
    if (!chatId) return;

    if (value.cmd === "new") {
      const title = defaultSessionTitle(this.now());
      const created = await this.deps.createSession(title);
      await this.deps.sessionMap.addSession(chatId, created.id, title, action.operatorOpenId);
    } else {
      const ok = await this.deps.sessionMap.setActive(chatId, value.sessionID);
      if (!ok) this.deps.log.debug("卡片切换会话失败：会话不存在", { sessionID: value.sessionID });
    }

    if (action.messageId) await this.sendListCard(chatId, action.messageId);
  }

  private async sendListCard(chatId: string, messageId?: string): Promise<void> {
    const sessions = await this.deps.sessionMap.listSessions(chatId);
    const active = await this.deps.sessionMap.getActive(chatId);
    const card = buildSessionListCard({ chatId, sessions, ...(active ? { activeID: active.sessionID } : {}) });
    if (messageId) {
      const res = await this.deps.sender.patchCard(messageId, card);
      if (!res.ok) this.deps.log.warn("会话卡片更新失败", { error: res.error ?? "unknown" });
      return;
    }
    const res = await this.deps.sender.sendCard(chatId, card);
    if (!res.ok) this.deps.log.warn("会话卡片发送失败", { chatId, error: res.error ?? "unknown" });
  }

  private async reply(chatId: string, text: string): Promise<void> {
    await this.deps.sender.sendText(chatId, text);
  }
}

type ToastType = "success" | "error" | "warning" | "info";

function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}
