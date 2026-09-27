/**
 * 话题根卡工作状态：**纯状态机 + 渲染**（无 IO，可单测）。
 *
 * 一个飞书话题 = 一个 OpenCode 会话；话题根卡需要反映该会话当前在干什么。
 * 状态用两处表达（**默认不改标题**，避免侧栏话题名频繁抖动）：
 * - header 颜色：运行中 `blue` / 待审核 `orange` / 待回复 `grey` / 完成 `green` / 失败 `red` / 中断 `grey`；
 * - 正文页脚 markdown：`🧠 运行中 · 12:03` / `🟡 待审核：shell` / `⏳ 待回复（排队 2）` / `✅ 完成` / `🔴 失败` / `⏹ 已中断`。
 *
 * 优先级（高 → 低）：**待审核 > 运行中 > 待回复 > 失败/中断 > 完成**。
 * `待审核` 优先于 `运行中`：有未答复的权限请求时先引导用户去点审批。
 *
 * 本模块只负责「由输入推导档位」与「档位 → emoji/颜色/页脚文案」；
 * 事件流 → 输入状态的接线在 `TopicStatusMachine`，整卡渲染在 `src/feishu/session-cards.ts`。
 */
import type { CardTemplate } from "../feishu/cards.js";

/** 工作状态档位。 */
export type TopicStatusKind =
  | "review" // 待审核：存在未答复的权限请求
  | "running" // 运行中
  | "pending" // 待回复：inbox 有排队未投递消息
  | "failed" // 失败（最近终态）
  | "interrupted" // 中断（最近终态）
  | "done"; // 完成（空闲）

/** 展示用的状态视图（档位 + 少量上下文）。 */
export interface TopicStatusView {
  readonly kind: TopicStatusKind;
  /** 排队消息条数（`pending` 时用于页脚「排队 N」）。 */
  readonly queued?: number;
  /** 待审核的工具 action（`review` 时用于页脚「待审核：<action>」）。 */
  readonly reviewAction?: string;
}

/** 档位 → 展示元数据。 */
export interface TopicStatusMeta {
  readonly emoji: string;
  readonly color: CardTemplate;
  readonly label: string;
}

const STATUS_META: Record<TopicStatusKind, TopicStatusMeta> = {
  review: { emoji: "🟡", color: "orange", label: "待审核" },
  running: { emoji: "🧠", color: "blue", label: "运行中" },
  pending: { emoji: "⏳", color: "grey", label: "待回复" },
  failed: { emoji: "🔴", color: "red", label: "失败" },
  interrupted: { emoji: "⏹", color: "grey", label: "已中断" },
  done: { emoji: "✅", color: "green", label: "完成" },
};

export function topicStatusMeta(kind: TopicStatusKind): TopicStatusMeta {
  return STATUS_META[kind];
}

/** 状态机输入的**纯快照**（由 `TopicStatusMachine` 维护）。 */
export interface TopicStatusInput {
  readonly running: boolean;
  /** 未答复的权限请求数（> 0 ⇒ 待审核）。 */
  readonly permissionPending: number;
  /** 未投递的排队消息数（> 0 ⇒ 待回复）。 */
  readonly queued: number;
  /** 最近一次终态（`done` / `failed` / `interrupted`）；无则视为完成。 */
  readonly terminal?: "done" | "failed" | "interrupted";
  /** 最近一条待审核请求的 action。 */
  readonly reviewAction?: string;
}

/** 纯推导：优先级 待审核 > 运行中 > 待回复 > 失败/中断 > 完成。 */
export function computeTopicStatus(input: TopicStatusInput): TopicStatusView {
  if (input.permissionPending > 0) {
    return { kind: "review", ...(input.reviewAction ? { reviewAction: input.reviewAction } : {}) };
  }
  if (input.running) return { kind: "running" };
  if (input.queued > 0) return { kind: "pending", queued: input.queued };
  if (input.terminal === "failed") return { kind: "failed" };
  if (input.terminal === "interrupted") return { kind: "interrupted" };
  return { kind: "done" };
}

/** `HH:MM`（本地时区，页脚时间戳）。 */
export function formatClock(now: number): string {
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 正文页脚文案（纯渲染，`now` 用于运行中的时间戳，便于单测）。 */
export function topicStatusFooter(view: TopicStatusView, now: number): string {
  switch (view.kind) {
    case "review":
      return view.reviewAction ? `🟡 待审核：${view.reviewAction}` : "🟡 待审核";
    case "running":
      return `🧠 运行中 · ${formatClock(now)}`;
    case "pending":
      return `⏳ 待回复（排队 ${view.queued ?? 0}）`;
    case "failed":
      return "🔴 失败";
    case "interrupted":
      return "⏹ 已中断";
    case "done":
      return "✅ 完成";
  }
}

/**
 * 标题渲染：默认**原样返回**（标题不放状态）。
 * `statusInTitle=true` 时在标题前加状态 emoji 前缀（如 `🟡 我的项目`）。
 */
export function topicStatusTitle(title: string, view: TopicStatusView, statusInTitle: boolean): string {
  if (!statusInTitle) return title;
  return `${topicStatusMeta(view.kind).emoji} ${title}`;
}

/** 单会话输入状态（可变，仅状态机内部持有）。 */
interface SessionStatusInput {
  running: boolean;
  readonly permissions: Set<string>;
  reviewAction?: string;
  readonly queued: Set<string>;
  terminal?: "done" | "failed" | "interrupted";
}

function newSessionStatusInput(): SessionStatusInput {
  return { running: false, permissions: new Set(), queued: new Set() };
}

/** `reduce` 的结果：新视图 + 档位是否发生变化（只有变化才应 patch）。 */
export interface TopicStatusChange {
  readonly view: TopicStatusView;
  readonly changed: boolean;
}

const HANDLED_EVENT_TYPES = new Set([
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.status",
  "session.idle",
  "permission.asked",
  "permission.replied",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
]);

/** 事件 → 状态机输入的事件子集（其余事件返回 undefined，不改状态）。 */
export interface TopicStatusEvent {
  readonly type: string;
  readonly data: unknown;
}

/**
 * 事件驱动的**纯状态机**：维护每个会话的运行/待审核/排队/终态输入，推导档位。
 *
 * 只做内存状态与推导，**不触碰 storage / 网络**；`changed` 只在「档位」变化时为 true。
 */
export class TopicStatusMachine {
  private readonly sessions = new Map<string, SessionStatusInput>();
  private lastKind = new Map<string, TopicStatusKind>();
  private permissionSeq = 0;

  /** 当前档位视图（未跟踪过的会话返回 undefined）。 */
  view(sessionID: string): TopicStatusView | undefined {
    const input = this.sessions.get(sessionID);
    if (!input) return undefined;
    return this.computeView(input);
  }

  /** 消费一条事件；未识别/无会话 id 返回 undefined。 */
  reduce(sessionID: string, event: TopicStatusEvent): TopicStatusChange | undefined {
    if (!sessionID) return undefined;
    if (!HANDLED_EVENT_TYPES.has(event.type)) return undefined;
    const input = this.input(sessionID);
    const data = (event.data ?? {}) as Record<string, unknown>;

    switch (event.type) {
      case "session.execution.started":
        input.running = true;
        input.terminal = undefined;
        break;
      case "session.execution.succeeded":
        input.running = false;
        input.terminal = "done";
        break;
      case "session.execution.failed":
        input.running = false;
        input.terminal = "failed";
        break;
      case "session.execution.interrupted":
        input.running = false;
        input.terminal = "interrupted";
        break;
      case "session.status": {
        const statusType = (data.status as { type?: unknown } | undefined)?.type;
        if (statusType === "idle") {
          input.running = false;
          input.terminal = "done";
        } else if (statusType === "busy" || statusType === "retry") {
          input.running = true;
          input.terminal = undefined;
        } else {
          return undefined; // 未知 status：不改状态
        }
        break;
      }
      case "session.idle":
        input.running = false;
        input.terminal = "done";
        break;
      case "permission.asked": {
        const id = str(data.id) || `p${(this.permissionSeq += 1)}`;
        input.permissions.add(id);
        const action = str(data.action);
        if (action) input.reviewAction = action;
        break;
      }
      case "permission.replied": {
        const requestID = str(data.requestID);
        if (requestID) input.permissions.delete(requestID);
        break;
      }
      case "session.inbox.enqueued": {
        const inboxID = str(data.inboxID) || str((data.item as { id?: unknown } | undefined)?.id);
        if (inboxID) input.queued.add(inboxID);
        break;
      }
      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        const inboxID = str(data.inboxID);
        if (inboxID) input.queued.delete(inboxID);
        break;
      }
      default:
        return undefined;
    }

    return this.record(sessionID, input);
  }

  /** 运行卡终态等**非事件流**信号的显式入口（如 prompt 发送失败）。 */
  markTerminal(sessionID: string, kind: "done" | "failed" | "interrupted"): TopicStatusChange | undefined {
    if (!sessionID) return undefined;
    const input = this.input(sessionID);
    input.running = false;
    input.terminal = kind;
    return this.record(sessionID, input);
  }

  /** 清理某会话状态（卸载 / 测试用）。 */
  forget(sessionID: string): void {
    this.sessions.delete(sessionID);
    this.lastKind.delete(sessionID);
  }

  clear(): void {
    this.sessions.clear();
    this.lastKind.clear();
  }

  private input(sessionID: string): SessionStatusInput {
    let input = this.sessions.get(sessionID);
    if (!input) {
      input = newSessionStatusInput();
      this.sessions.set(sessionID, input);
    }
    return input;
  }

  private computeView(input: SessionStatusInput): TopicStatusView {
    return computeTopicStatus({
      running: input.running,
      permissionPending: input.permissions.size,
      queued: input.queued.size,
      ...(input.terminal ? { terminal: input.terminal } : {}),
      ...(input.reviewAction ? { reviewAction: input.reviewAction } : {}),
    });
  }

  private record(sessionID: string, input: SessionStatusInput): TopicStatusChange {
    const view = this.computeView(input);
    const changed = this.lastKind.get(sessionID) !== view.kind;
    this.lastKind.set(sessionID, view.kind);
    return { view, changed };
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
