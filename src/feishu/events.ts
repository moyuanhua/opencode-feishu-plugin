/**
 * 飞书事件 → 归一化模型（纯函数，无 IO）。
 *
 * 覆盖两类长连接载荷：
 * - `im.message.receive_v1`
 * - `card.action.trigger`
 *
 * 兼容 SDK/服务端两种字段路径（context.* 与顶层），避免版本差异导致丢事件。
 */
import type { CardAction, IncomingMessage } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** 去掉文本里的 @占位符（飞书文本消息用 @_user_N 表示 @）。 */
export function stripMentionPlaceholders(text: string): string {
  return text.replace(/@_user_\d+\s*/g, "").trim();
}

/**
 * 抽取飞书消息内容为纯文本。
 * - `text`：解析 JSON 的 text 字段；
 * - `post`：拼接富文本段落；
 * - 其他类型：返回占位描述（仍会把消息交给 opencode，让用户知道收到了什么）。
 */
export function extractMessageText(messageType: string, rawContent: string): string {
  switch (messageType) {
    case "text":
      return stripMentionPlaceholders(parseJsonField(rawContent, "text"));
    case "post":
      return extractPostText(rawContent);
    case "image":
      return "[图片]";
    case "file":
      return "[文件]";
    case "audio":
      return "[语音消息]";
    case "media":
      return "[视频消息]";
    case "sticker":
      return "[表情包]";
    case "interactive":
      return "[卡片消息]";
    case "share_chat":
      return "[群分享]";
    case "share_user":
      return "[用户名片]";
    case "merge_forward":
      return "[合并转发消息]";
    default:
      return `[不支持的消息类型: ${messageType}]`;
  }
}

function parseJsonField(raw: string, field: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return str(parsed[field]);
  } catch {
    return "";
  }
}

function extractPostText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as {
      title?: string;
      content?: Array<Array<{ tag?: string; text?: string; href?: string }>>;
    };
    const lines: string[] = [];
    if (parsed.title) lines.push(parsed.title);
    for (const paragraph of parsed.content ?? []) {
      if (!Array.isArray(paragraph)) continue;
      const segments: string[] = [];
      for (const el of paragraph) {
        if (!el) continue;
        if ((el.tag === "text" || el.tag === "at") && el.text) segments.push(el.text);
        else if (el.tag === "a" && el.text) segments.push(el.href ? `${el.text}(${el.href})` : el.text);
        else if (el.tag === "img") segments.push("[图片]");
      }
      if (segments.length) lines.push(segments.join(""));
    }
    return lines.join("\n").trim();
  } catch {
    return "";
  }
}

/**
 * 解析 `im.message.receive_v1` 载荷。
 * 返回 undefined 表示字段缺失（无法处理）；调用方负责静默丢弃。
 */
export function parseIncomingMessage(data: unknown): IncomingMessage | undefined {
  if (!isRecord(data)) return undefined;
  const message = data.message;
  if (!isRecord(message)) return undefined;

  const chatId = str(message.chat_id);
  const messageId = str(message.message_id);
  if (!chatId || !messageId) return undefined;

  const messageType = str(message.message_type) || "text";
  const rawContent = str(message.content);
  if (!rawContent) return undefined;

  const sender = data.sender;
  const senderOpenId = isRecord(sender) && isRecord(sender.sender_id) ? str(sender.sender_id.open_id) : "";

  return {
    eventId: str(data.event_id),
    messageId,
    chatId,
    chatType: str(message.chat_type) || "p2p",
    messageType,
    text: extractMessageText(messageType, rawContent),
    senderOpenId,
    ...(str(message.create_time) ? { createTime: str(message.create_time) } : {}),
  };
}

/**
 * 解析 `card.action.trigger` 载荷。
 * `action.value` 可能是对象（新版）或 JSON 字符串（旧版）。
 */
export function parseCardAction(data: unknown): CardAction | undefined {
  if (!isRecord(data)) return undefined;
  const context = isRecord(data.context) ? data.context : {};
  const action = isRecord(data.action) ? data.action : {};
  const operator = isRecord(data.operator) ? data.operator : {};

  const messageId = str(context.open_message_id) || str(data.open_message_id);
  const chatId = str(context.open_chat_id) || str(data.open_chat_id);
  const operatorOpenId = str(operator.open_id);
  if (!operatorOpenId) return undefined;

  let rawValue: unknown = action.value;
  if (typeof rawValue === "string") {
    try {
      rawValue = JSON.parse(rawValue);
    } catch {
      // 保持字符串原样，交由上层判定失败。
    }
  }

  const callbackToken = str(data.token);
  return {
    rawValue,
    messageId,
    chatId,
    operatorOpenId,
    ...(callbackToken ? { callbackToken } : {}),
  };
}

/** 判断是否 p2p（单聊）。 */
export function isP2PChat(chatType: string | undefined): boolean {
  return chatType === "p2p";
}
