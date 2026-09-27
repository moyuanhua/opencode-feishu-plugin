/**
 * 飞书消息发送薄封装：只暴露 P0 用到的 3 个动作。
 *
 * 不打印任何 token/secret；失败只返回结构化错误。
 */
import type * as Lark from "@larksuiteoapi/node-sdk";
import { errorMessage } from "../logger.js";
import { enforceCardLimits } from "./card-limits.js";
import type { Logger } from "../types.js";

/**
 * 提取飞书 SDK 错误里的真实诊断信息。
 *
 * axios 抛错时 `err.message` 只有 "Request failed with status code 400"，
 * 真正的 `code` / `msg`（如 230099 卡片内容非法）在 `err.response.data` 里。
 * 只提取结构与错误码，**绝不回显请求内容**（可能含 secret）。
 */
export function describeLarkError(err: unknown): string {
  const base = errorMessage(err);
  const data = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const parts: string[] = [];
    if (d.code !== undefined) parts.push(`code=${String(d.code)}`);
    if (typeof d.msg === "string") parts.push(`msg=${d.msg}`);
    const error = d.error as Record<string, unknown> | undefined;
    if (error && typeof error.message === "string") parts.push(`detail=${error.message}`);
    if (parts.length > 0) return `${base} [${parts.join(" ")}]`;
  }
  if (typeof data === "string" && data.length > 0) return `${base} [${data.slice(0, 300)}]`;
  return base;
}

export interface SendCardResult {
  readonly ok: boolean;
  readonly messageId?: string;
  /** `im.message.reply` 直接带回的 thread_id（P5）；回复响应可能不含，调用方再 getMessageThread 兜底。 */
  readonly threadId?: string;
  readonly rootId?: string;
  readonly error?: string;
}

/** `im.message.reply` 可选参数。 */
export interface ReplyOptions {
  /** true = 对该消息开启新话题（`reply_in_thread`）；缺省 false = 普通引用回复。 */
  readonly replyInThread?: boolean;
}

/** 消息归属信息（读回 `im.message.get`）。 */
export interface MessageMeta {
  readonly threadId?: string;
  readonly rootId?: string;
  readonly parentId?: string;
}

export interface FeishuSender {
  sendCard(chatId: string, card: object): Promise<SendCardResult>;
  /**
   * 引用回复一张卡片（P5）：消息在话题内时用它，回复自然留在同一话题。
   * `opts.replyInThread` 为 true 时开启新话题（`/new` 一键进入）。
   */
  replyCard(messageId: string, card: object, opts?: ReplyOptions): Promise<SendCardResult>;
  patchCard(messageId: string, card: object): Promise<{ ok: boolean; error?: string }>;
  sendText(chatId: string, text: string): Promise<SendCardResult>;
  /** 引用回复文本（话题内的命令回执 / 失败提示）。 */
  replyText(messageId: string, text: string, opts?: ReplyOptions): Promise<SendCardResult>;
  /** 读回消息的 thread/root/parent（reply 响应未直接给 thread_id 时的可靠兜底）。 */
  getMessageMeta(messageId: string): Promise<MessageMeta | undefined>;
  deleteMessage(messageId: string): Promise<void>;
}

type LarkClient = InstanceType<typeof Lark.Client>;

export interface SenderOptions {
  /** 单卡最多保留的 markdown 表格数（默认 4，夹取 1–5）。 */
  readonly cardMaxTables?: number;
}

export function createFeishuSender(client: LarkClient, log: Logger, options: SenderOptions = {}): FeishuSender {
  /**
   * 发送/更新前的**最后一道内容守卫**：无论哪张卡片、哪个构建器，表格数都收敛到上限内，
   * 组件数也 ≤200——避免任何遗漏的路径把飞书 400（`code=230099`）发出去。
   * 构建器已守卫过的卡片再次处理是幂等的（降级后的表格已变成代码块）。
   */
  const guard = (card: object, tag: string): object => {
    const { card: guarded, report } = enforceCardLimits(card, { maxTables: options.cardMaxTables });
    if (report.degradedTables > 0 || report.droppedElements > 0) {
      log.warn("卡片内容超限，已降级（发送层兜底）", {
        where: tag,
        tables: report.tables,
        degradedTables: report.degradedTables,
        elements: report.elements,
        droppedElements: report.droppedElements,
      });
    }
    return guarded;
  };

  return {
    async sendCard(chatId, card) {
      if (!chatId) return { ok: false, error: "missing chatId" };
      try {
        const res = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(guard(card, "create")),
          },
        });
        if (res?.code && res.code !== 0) {
          log.warn("发送卡片失败", { chatId, code: res.code, msg: res.msg });
          return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        }
        const messageId = res?.data?.message_id ?? "";
        return messageId ? { ok: true, messageId } : { ok: false, error: "missing message_id" };
      } catch (err) {
        log.warn("发送卡片异常", { chatId, error: describeLarkError(err) });
        return { ok: false, error: describeLarkError(err) };
      }
    },

    async replyCard(messageId, card, opts) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "interactive",
            content: JSON.stringify(guard(card, "reply")),
            ...(opts?.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        if (res?.code && res.code !== 0) {
          log.warn("回复卡片失败", { messageId, code: res.code, msg: res.msg });
          return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        }
        const newMessageId = res?.data?.message_id ?? "";
        if (!newMessageId) return { ok: false, error: "missing message_id" };
        return {
          ok: true,
          messageId: newMessageId,
          ...(res?.data?.thread_id ? { threadId: res.data.thread_id } : {}),
          ...(res?.data?.root_id ? { rootId: res.data.root_id } : {}),
        };
      } catch (err) {
        log.warn("回复卡片异常", { messageId, error: describeLarkError(err) });
        return { ok: false, error: describeLarkError(err) };
      }
    },

    async patchCard(messageId, card) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(guard(card, "patch")) },
        });
        if (res?.code && res.code !== 0) {
          log.warn("更新卡片失败", { messageId, code: res.code, msg: res.msg });
          return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        }
        return { ok: true };
      } catch (err) {
        log.warn("更新卡片异常", { messageId, error: describeLarkError(err) });
        return { ok: false, error: describeLarkError(err) };
      }
    },

    async sendText(chatId, text) {
      if (!chatId) return { ok: false, error: "missing chatId" };
      try {
        const res = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text }),
          },
        });
        if (res?.code && res.code !== 0) {
          return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        }
        const messageId = res?.data?.message_id ?? "";
        return messageId ? { ok: true, messageId } : { ok: true };
      } catch (err) {
        return { ok: false, error: describeLarkError(err) };
      }
    },

    async replyText(messageId, text, opts) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: "text",
            content: JSON.stringify({ text }),
            ...(opts?.replyInThread ? { reply_in_thread: true } : {}),
          },
        });
        if (res?.code && res.code !== 0) {
          return { ok: false, error: `code=${res.code} msg=${res.msg ?? ""}` };
        }
        const newMessageId = res?.data?.message_id ?? "";
        return {
          ok: true,
          ...(newMessageId ? { messageId: newMessageId } : {}),
          ...(res?.data?.thread_id ? { threadId: res.data.thread_id } : {}),
        };
      } catch (err) {
        return { ok: false, error: describeLarkError(err) };
      }
    },

    async getMessageMeta(messageId) {
      if (!messageId) return undefined;
      try {
        const res = await client.im.message.get({ path: { message_id: messageId } });
        if (res?.code && res.code !== 0) {
          log.warn("读取消息失败", { messageId, code: res.code, msg: res.msg });
          return undefined;
        }
        const item = res?.data?.items?.[0];
        if (!item) return undefined;
        return {
          ...(item.thread_id ? { threadId: item.thread_id } : {}),
          ...(item.root_id ? { rootId: item.root_id } : {}),
          ...(item.parent_id ? { parentId: item.parent_id } : {}),
        };
      } catch (err) {
        log.warn("读取消息异常", { messageId, error: describeLarkError(err) });
        return undefined;
      }
    },

    async deleteMessage(messageId) {
      if (!messageId) return;
      try {
        await client.im.message.delete({ path: { message_id: messageId } });
      } catch {
        // 尽力清理，失败无妨。
      }
    },
  };
}
