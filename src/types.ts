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
  /**
   * `action.form_value`（P6.1）：表单容器提交时携带，键 = 表单内组件的 `name`。
   * 仅表单提交回调存在；纯按钮回调没有该字段（向后兼容）。
   */
  readonly formValue?: Readonly<Record<string, unknown>>;
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

/** 权限预设四档（P6）。 */
export type PermissionPreset = "readonly" | "edit" | "askHigh" | "trust";

/** 会话级 gate 模式：off = 不介入（依赖 ruleset/原生）；gate = 对指定动作升级为 ask。 */
export type SessionGateMode = "off" | "gate";

/** 规则集条目（与 SessionCreateInput.permissions 对齐，最后匹配优先）。 */
export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "ask" | "deny";
}

/** 模型引用（providerID + id；name 仅用于展示）。 */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly name?: string;
}

/** 建会话向导步骤（P6）。 */
export type WizardStep = "dir" | "model" | "perm" | "confirm";

/**
 * 建会话向导状态，持久化在 `feishu:v2:setup:<chatId>`。
 * `anchorMessageId` 是触发 `/new` 的用户消息 id，确认时对它 `reply_in_thread` 开话题。
 */
export interface WizardState {
  readonly step: WizardStep;
  readonly dir?: string;
  readonly model?: ModelRef;
  readonly perm?: PermissionPreset;
  readonly title?: string;
  /** 模型卡片分页：0 = 最近/当前视图，>=1 = 全量分页。 */
  readonly page?: number;
  readonly anchorMessageId?: string;
}

/** 会话 ↔ 飞书会话映射，持久化在 ctx.storage。 */
export interface SessionLink {
  readonly chatId: string;
  /** 触发该会话的飞书用户 open_id（审批卡 token 绑定对象）。 */
  readonly openId: string;
  /**
   * 话题锚点消息 id（P5）。存在即表示该会话绑定在某个飞书话题内，
   * 异步出站（审批卡 / 失败提示）通过 `im.message.reply` 引用它，回复自然留在话题内。
   */
  readonly replyMessageId?: string;
  /** 会话创建时选择的权限预设（P6，用于展示与 gate 决策）。 */
  readonly perm?: PermissionPreset;
  /** 会话级 gate 模式（P6）。 */
  readonly gateMode?: SessionGateMode;
  /** 会话工作目录（P6，`/cd` 后更新）。 */
  readonly dir?: string;
  /** 当前模型（P6，`/model` 后更新；运行卡页脚展示）。 */
  readonly model?: ModelRef;
  /**
   * 会话内显式放行的工具 action（任务 A）。
   * 由审批卡「✅ 本会话内允许该工具」写入；`permission.evaluate` gate 命中即**不降级为 ask**。
   */
  readonly allowActions?: readonly string[];
}

/** 话题 / 话题根 → 会话映射（P5：话题 = 会话）。 */
export interface ThreadLink {
  readonly sessionID: string;
  readonly chatId: string;
  readonly openId: string;
  /** 话题根消息 id；回复它可留在话题内（审批卡等异步出站使用）。 */
  readonly anchorMessageId?: string;
}

/** `ctx.storage` 的最小子集，便于单测注入 fake。 */
export interface StorageLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}
