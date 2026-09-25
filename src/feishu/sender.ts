/**
 * 飞书消息发送薄封装：只暴露 P0 用到的 3 个动作。
 *
 * 不打印任何 token/secret；失败只返回结构化错误。
 */
import type * as Lark from "@larksuiteoapi/node-sdk";
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";

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
        log.warn("发送卡片异常", { chatId, error: errorMessage(err) });
        return { ok: false, error: errorMessage(err) };
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
        log.warn("更新卡片异常", { messageId, error: errorMessage(err) });
        return { ok: false, error: errorMessage(err) };
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
        return { ok: false, error: errorMessage(err) };
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
