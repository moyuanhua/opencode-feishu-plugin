/**
 * 飞书消息发送薄封装：只暴露 P0 用到的 3 个动作。
 *
 * 不打印任何 token/secret；失败只返回结构化错误。
 */
import type * as Lark from "@larksuiteoapi/node-sdk";
import { errorMessage } from "../logger.js";
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
  readonly error?: string;
}

export interface FeishuSender {
  sendCard(chatId: string, card: object): Promise<SendCardResult>;
  patchCard(messageId: string, card: object): Promise<{ ok: boolean; error?: string }>;
  sendText(chatId: string, text: string): Promise<SendCardResult>;
  deleteMessage(messageId: string): Promise<void>;
}

type LarkClient = InstanceType<typeof Lark.Client>;

export function createFeishuSender(client: LarkClient, log: Logger): FeishuSender {
  return {
    async sendCard(chatId, card) {
      if (!chatId) return { ok: false, error: "missing chatId" };
      try {
        const res = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(card),
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

    async patchCard(messageId, card) {
      if (!messageId) return { ok: false, error: "missing messageId" };
      try {
        const res = await client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) },
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
