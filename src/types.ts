/**
 * 共享类型定义。
 *
 * 这里刻意不 import `@opencode/plugin`，保证纯逻辑模块可以在单测里独立运行。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** 插件配置档位。 */
export type PermissionGate = "off" | "notify" | "gate" | "lockdown";

/** `ctx.options` 是 `Readonly<Record<string, any>>`，这里做一次收敛。 */
export type RawOptions = Readonly<Record<string, unknown>>;

/**
 * 飞书 `im.message.receive_v1` 归一化后的最小消息模型。
 * 只保留 P0 需要 p2p 文本链路字段。
 */
export interface IncomingMessage {
  readonly eventId: string;
  readonly messageId: string;
  readonly chatId: string;
  /** 飞书原始 chat_type，P0 只接受 `p2p`。 */
  readonly chatType: string;
  readonly messageType: string;
  /** 已抽取并清理 @占位符 的文本；非文本消息为占位描述。 */
  readonly text: string;
  readonly senderOpenId: string;
  readonly createTime?: string;
  /** 话题 ID（`omt_`）。单聊里通过「创建话题」产生；普通消息为 undefined。 */
  readonly threadId?: string;
  /** 回复链：root 是话题/回复树的根消息，parent 是直接父消息。 */
  readonly rootId?: string;
  readonly parentId?: string;
}

/** `card.action.trigger` 回调归一化后的模型。 */
export interface CardAction {
  /** `action.value` 原始值（对象或字符串）。 */
  readonly rawValue: unknown;
  /** 卡片的 open_message_id，用于回填/更新卡片。 */
  readonly messageId: string;
  readonly chatId: string;
  readonly operatorOpenId: string;
  /** 回调自带的卡片更新凭证，30 分钟有效（本插件改用 message.patch，不作为主路径）。 */
  readonly callbackToken?: string;
}

/** `permission.asked` 事件的 data 子集（与 @opencode/client 的 PermissionRequest 对齐）。 */
export interface PermissionRequestLike {
  readonly id: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly save?: readonly string[];
  readonly message?: string;
  readonly source?: {
    readonly type: "tool";
    readonly messageID: string;
    readonly id: string;
  };
}

/** `permission.replied` 事件的 data。 */
export interface PermissionRepliedLike {
  readonly sessionID: string;
  readonly requestID: string;
  readonly reply: "once" | "always" | "reject";
}

/** 会话 ↔ 飞书会话映射，持久化在 ctx.storage。 */
export interface SessionLink {
  readonly chatId: string;
  /** 触发该会话的飞书用户 open_id（审批卡 token 绑定对象）。 */
  readonly openId: string;
}

/** `ctx.storage` 的最小子集，便于单测注入 fake。 */
export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
