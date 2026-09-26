/**
 * 飞书会话命令编排：文本命令 + 会话卡片按钮回调。
 *
 * 设计对齐 `ApprovalManager`：
 * - 文本命令走 `handleText`（异步，扣在 `handleMessage` 最前面）；
 * - 卡片按钮 `handleCardAction` **同步返回 toast**（飞书要求 3 秒内响应），
 *   真正的 create/switch/patch-card 全部 fire-and-forget。
 *
 * P5（话题 = 会话）：
 * - 话题内只允许 `/current` `/stop` `/help`；`/new` `/sessions` `/use` 给提示去主聊天流。
 * - `/new` 一键进入：建会话后把「会话已就绪」卡 `reply_in_thread` 到用户消息，
 *   读回 thread_id 后 `bindThread`；卡片消息同时 `bindRoot` 支持手动建话题。
 * - 出站按 scope 选 reply（话题内）或 create（主聊天流）。
 */
import { errorMessage } from "./logger.js";
import type { CardAction, IncomingMessage, Logger } from "./types.js";
import type { FeishuSender } from "./feishu/sender.js";
import type { SessionMap } from "./feishu/session-map.js";
import { buildSessionListCard, buildSessionReadyCard, parseSessionCardValue, type SessionCardValue } from "./feishu/session-cards.js";
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

export interface SessionCommandsDeps {
  readonly log: Logger;
  readonly sessionMap: SessionMap;
  readonly sender: FeishuSender;
  readonly isAllowed: (openId: string) => boolean;
  /** 新建 opencode 会话，返回至少含 id 的对象。 */
  readonly createSession: (title: string) => Promise<{ id: string }>;
  /** 中断指定会话正在跑的任务。 */
  readonly interruptSession: (sessionID: string) => Promise<void>;
  /** 话题路由开关（P5）。false = 完全回到 P3 行为（`/new` 只回执文本）。 */
  readonly threadRouting?: boolean;
  readonly now?: () => number;
}

export class SessionCommands {
  private readonly now: () => number;
  private readonly threadRouting: boolean;

  constructor(private readonly deps: SessionCommandsDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.threadRouting = deps.threadRouting ?? true;
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
      case "unknown":
        return this.reply(
          message,
          `未知命令 \`/${parsed.raw}\`\n\n${helpText(scope)}`,
        );
      case "help":
      default:
        return this.reply(message, helpText(scope));
    }
  }

  /**
   * `/new`：建会话并设为当前。
   * 话题路由开启时，进一步把「会话已就绪」卡 reply_in_thread 到用户消息，实现一键进入。
   */
  private async cmdNew(message: IncomingMessage, args: string): Promise<void> {
    const title = args.trim() || defaultSessionTitle(this.now());
    const created = await this.deps.createSession(title);
    await this.deps.sessionMap.addSession(message.chatId, created.id, title, message.senderOpenId);

    if (!this.threadRouting) {
      await this.reply(message, `✅ 已新建并切换到会话「${title}」\n\`${created.id}\``);
      return;
    }

    const card = buildSessionReadyCard({ title, sessionID: created.id });
    const res = await this.deps.sender.replyCard(message.messageId, card, { replyInThread: true });
    if (!res.ok || !res.messageId) {
      this.deps.log.warn("一键开话题失败，回退文本回执", { error: res.error ?? "unknown" });
      await this.reply(
        message,
        `✅ 已新建并切换到会话「${title}」\n\`${created.id}\`\n（自动开话题失败，可稍后在 /sessions 卡片上手动创建话题）`,
      );
      return;
    }

    // 卡片消息 id 作为「手动建话题」的 root 锚点。
    await this.deps.sessionMap.bindRoot(res.messageId, created.id);

    // reply 响应可能直接给 thread_id；没有则读回消息兜底（实测更可靠）。
    const meta = res.threadId ? undefined : await this.deps.sender.getMessageMeta(res.messageId);
    const threadId = res.threadId ?? meta?.threadId;
    if (threadId) {
      const anchor = res.rootId ?? message.messageId;
      await this.deps.sessionMap.bindThread(threadId, created.id, message.chatId, message.senderOpenId, anchor);
    } else {
      this.deps.log.warn("一键开话题后未读到 thread_id，该会话暂无法自动路由", { messageId: res.messageId });
    }
  }

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
      const link = message.threadId ? await this.deps.sessionMap.resolveByThread(message.threadId) : undefined;
      if (!link) {
        await this.reply(message, "本话题尚未关联会话。请回到主聊天流用 `/new` 新建。");
        return;
      }
      const entry = await this.deps.sessionMap.getSession(message.chatId, link.sessionID);
      const title = entry?.title.trim() || "(未命名)";
      await this.reply(message, `本话题会话：「${title}」\n\`${link.sessionID}\``);
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
      const link = message.threadId ? await this.deps.sessionMap.resolveByThread(message.threadId) : undefined;
      if (!link) {
        await this.reply(message, "本话题尚未关联会话，无法中断。");
        return;
      }
      await this.deps.interruptSession(link.sessionID);
      const entry = await this.deps.sessionMap.getSession(message.chatId, link.sessionID);
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

    if (action.messageId) await this.patchListCard(chatId, action.messageId);
  }

  /** 卡片原位更新（只 patch 不新建，无需重绑 root）。 */
  private async patchListCard(chatId: string, messageId: string): Promise<void> {
    const sessions = await this.deps.sessionMap.listSessions(chatId);
    const active = await this.deps.sessionMap.getActive(chatId);
    const card = buildSessionListCard({ chatId, sessions, ...(active ? { activeID: active.sessionID } : {}) });
    const res = await this.deps.sender.patchCard(messageId, card);
    if (!res.ok) this.deps.log.warn("会话卡片更新失败", { error: res.error ?? "unknown" });
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

type ToastType = "success" | "error" | "warning" | "info";

function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}
