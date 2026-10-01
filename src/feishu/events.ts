/**
 * 飞书事件 → 归一化模型（纯函数，无 IO）。
 *
 * 覆盖两类长连接载荷：
 * - `im.message.receive_v1`
 * - `card.action.trigger`
 *
 * 兼容 SDK/服务端两种字段路径（context.* 与顶层），避免版本差异导致丢事件。
 */
import type { BotMenuClick, CardAction, IncomingAttachment, IncomingMessage } from "../types.js";

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
 * 解析图片/文件消息的资源信息（`image_key` / `file_key`）。
 * 仅 image / file 两类；其余类型返回 undefined（保持占位文本行为）。
 */
export function parseIncomingAttachment(
  messageType: string,
  rawContent: string,
): IncomingAttachment | undefined {
  if (messageType !== "image" && messageType !== "file") return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!isRecordLike(parsed)) return undefined;
  if (messageType === "image") {
    const imageKey = str(parsed.image_key);
    return imageKey ? { kind: "image", fileKey: imageKey } : undefined;
  }
  const fileKey = str(parsed.file_key);
  if (!fileKey) return undefined;
  const fileName = str(parsed.file_name);
  return { kind: "file", fileKey, ...(fileName ? { fileName } : {}) };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  const attachment = parseIncomingAttachment(messageType, rawContent);
  return {
    eventId: str(data.event_id),
    messageId,
    chatId,
    chatType: str(message.chat_type) || "p2p",
    messageType,
    text: extractMessageText(messageType, rawContent),
    ...(attachment ? { attachment } : {}),
    senderOpenId,
    ...(str(message.create_time) ? { createTime: str(message.create_time) } : {}),
    ...(str(message.thread_id) ? { threadId: str(message.thread_id) } : {}),
    ...(str(message.root_id) ? { rootId: str(message.root_id) } : {}),
    ...(str(message.parent_id) ? { parentId: str(message.parent_id) } : {}),
  };
}

/**
 * 解析 `application.bot.menu_v6`（机器人自定义菜单事件）载荷：
 * `{ header: { event_id }, event: { operator: { operator_id: { open_id } }, event_key } }`。
 * 字段缺失（无操作人 / 无 event_key）返回 undefined。
 */
export function parseBotMenuEvent(data: unknown): BotMenuClick | undefined {
  if (!isRecord(data)) return undefined;
  const header = isRecord(data.header) ? data.header : {};
  const event = isRecord(data.event) ? data.event : {};
  const operator = isRecord(event.operator) ? event.operator : {};
  const operatorId = isRecord(operator.operator_id) ? operator.operator_id : {};
  const operatorOpenId = str(operatorId.open_id);
  const eventKey = str(event.event_key);
  if (!operatorOpenId || !eventKey) return undefined;
  return { eventId: str(header.event_id), eventKey, operatorOpenId };
}

/**
 * 解析 `card.action.trigger` 载荷。
 * `action.value` 可能是对象（新版）或 JSON 字符串（旧版）；
 * 表单提交时还会带 `action.form_value`（键 = 组件 name），一并读取（P6.1）。
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

  const formValue = isRecord(action.form_value) ? action.form_value : undefined;

  const callbackToken = str(data.token);
  return {
    rawValue,
    ...(formValue ? { formValue } : {}),
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

/**
 * `card.action.trigger` 载荷诊断信息（P5.2）：**只记录键名与布尔**，
 * 绝不记录 token / value / open_id 的值。
 *
 * 目的：确认回调事件里是否真的带 `thread_id`（P5 存疑项）。
 */
export interface CardActionDiagnostics {
  readonly topKeys: readonly string[];
  readonly contextKeys: readonly string[];
  readonly actionKeys: readonly string[];
  readonly operatorKeys: readonly string[];
  readonly hasThreadId: boolean;
  readonly hasRootId: boolean;
  readonly hasOpenMessageId: boolean;
  readonly hasOpenChatId: boolean;
  readonly hasOperator: boolean;
  readonly hasToken: boolean;
}

function keysOf(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).slice(0, 30) : [];
}

export function describeCardActionEvent(data: unknown): CardActionDiagnostics {
  const top = isRecord(data) ? data : {};
  const context = isRecord(top.context) ? top.context : {};
  const action = isRecord(top.action) ? top.action : {};
  const operator = isRecord(top.operator) ? top.operator : {};
  const threadId = context.thread_id ?? top.thread_id;
  const rootId = context.root_id ?? top.root_id;
  const openMessageId = context.open_message_id ?? top.open_message_id;
  const openChatId = context.open_chat_id ?? top.open_chat_id;
  return {
    topKeys: keysOf(top),
    contextKeys: keysOf(context),
    actionKeys: keysOf(action),
    operatorKeys: keysOf(operator),
    hasThreadId: typeof threadId === "string" && threadId.length > 0,
    hasRootId: typeof rootId === "string" && rootId.length > 0,
    hasOpenMessageId: typeof openMessageId === "string" && openMessageId.length > 0,
    hasOpenChatId: typeof openChatId === "string" && openChatId.length > 0,
    hasOperator: Object.keys(operator).length > 0,
    hasToken: typeof top.token === "string" && top.token.length > 0,
  };
}
