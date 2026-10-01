/**
 * 服务器事件分发（纯重构：从 `index.ts` 抽出）。
 *
 * 把 `ctx.event.subscribe` 的事件 switch（含 dedup/runs/executions 的接线）收敛为
 * 一个可单测的纯分发函数：`routeEvent(event, deps)`。所有副作用（发卡、状态机更新、
 * 失败通知）通过 `EventRouterDeps` 注入，本模块不持有任何全局状态。
 */
import { errorMessage } from "../logger.js";
import type {
  Logger,
  PermissionRepliedLike,
  PermissionRequestLike,
} from "../types.js";
import type { RunEvent } from "../feishu/run-state.js";

export interface EventRouterDeps {
  readonly log: Logger;
  /** 任意 session 事件都刷新活动时间（看门狗判活）。 */
  readonly touch: (sessionID: string) => void;
  readonly markStarted: (sessionID: string) => void;
  readonly markEnded: (sessionID: string) => void;
  readonly applyRun: (sessionID: string, event: RunEvent) => void;
  /** `permission.asked`：发卡是网络 IO，由 router fire-and-forget + warn。 */
  readonly onPermissionAsked: (data: PermissionRequestLike) => Promise<void>;
  readonly onPermissionReplied: (data: PermissionRepliedLike) => void;
  /** `form.created`：发卡是网络 IO，由 router fire-and-forget + warn。 */
  readonly onFormCreated: (data: unknown) => Promise<void>;
  readonly onFormReplied: (data: unknown) => void;
  readonly onFormCancelled: (data: unknown) => void;
  /** `session.execution.failed` 的失败通知（原 `notifyFailure`）。 */
  readonly notifyFailure: (sessionID: string, error: unknown) => Promise<void>;
  /**
   * `session.created`：登记 child→parent 链路（看门狗父链判活）。
   * 子会话（task 子代理）事件只带子会话 ID，父会话靠这条链路获取活动刷新。
   */
  readonly onSessionCreated?: (sessionID: string, parentID: string | undefined) => void;
  /**
   * 任意事件都下发给话题状态控制器（可选，缺省不影响既有行为）。
   * 话题根卡状态需要 permission / inbox / status 等**非 run 事件**，故在 switch 之前统一派发。
   */
  readonly onTopicStatus?: (event: { type: string; data: unknown }) => void;
}

export async function routeEvent(
  event: { type: string; data: unknown },
  deps: EventRouterDeps,
): Promise<void> {
  // 话题根卡工作状态：在 run/text 事件归一之前先下发（控制器自行过滤无关事件）。
  deps.onTopicStatus?.(event);

  // 任意 session 事件都刷新活动时间，避免看门狗误杀仍在产出的事件流。
  const touched = (event.data as { sessionID?: unknown } | undefined)?.sessionID;
  if (typeof touched === "string") deps.touch(touched);

  switch (event.type) {
    case "session.created": {
      // 事件体兼容两种形状：`{ sessionID | id, parentID | parentId }`（不同版本字段名不一）。
      const data = event.data as {
        sessionID?: unknown;
        id?: unknown;
        parentID?: unknown;
        parentId?: unknown;
      };
      const childId =
        typeof data.sessionID === "string" && data.sessionID
          ? data.sessionID
          : typeof data.id === "string" && data.id
            ? data.id
            : "";
      if (!childId) break;
      const parent =
        typeof data.parentID === "string" && data.parentID
          ? data.parentID
          : typeof data.parentId === "string" && data.parentId
            ? data.parentId
            : undefined;
      deps.onSessionCreated?.(childId, parent);
      break;
    }
    case "permission.asked":
      // 发卡是网络 IO，不能阻塞事件流（否则会拖慢后续 text.delta）。
      void deps
        .onPermissionAsked(event.data as PermissionRequestLike)
        .catch((err) => deps.log.warn("处理 permission.asked 失败", { error: errorMessage(err) }));
      break;
    case "permission.replied":
      deps.onPermissionReplied(event.data as PermissionRepliedLike);
      break;
    case "form.created":
      // 发卡是网络 IO，不能阻塞事件流（否则会拖慢后续 text.delta）。
      void deps
        .onFormCreated(event.data)
        .catch((err) => deps.log.warn("处理 form.created 失败", { error: errorMessage(err) }));
      break;
    case "form.replied":
      deps.onFormReplied(event.data);
      break;
    case "form.cancelled":
      deps.onFormCancelled(event.data);
      break;
    case "session.text.started": {
      const data = event.data as { sessionID: string; assistantMessageID?: string };
      deps.applyRun(data.sessionID, {
        type: "text.started",
        ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
      });
      break;
    }
    case "session.text.delta": {
      const data = event.data as { sessionID: string; delta: string; assistantMessageID?: string };
      deps.applyRun(data.sessionID, {
        type: "text.delta",
        delta: data.delta,
        ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
      });
      break;
    }
    case "session.text.ended": {
      const data = event.data as { sessionID: string; text?: string; assistantMessageID?: string };
      deps.applyRun(data.sessionID, {
        type: "text.ended",
        ...(data.text ? { text: data.text } : {}),
        ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
      });
      break;
    }
    case "session.tool.input.started": {
      const data = event.data as { sessionID: string; id: string; name: string; assistantMessageID?: string };
      deps.applyRun(data.sessionID, {
        type: "tool.input.started",
        id: data.id,
        name: data.name,
        ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
      });
      break;
    }
    case "session.tool.input.ended": {
      const data = event.data as { sessionID: string; id: string; input?: unknown };
      deps.applyRun(data.sessionID, { type: "tool.input.ended", id: data.id, input: data.input });
      break;
    }
    case "session.tool.success": {
      const data = event.data as { sessionID: string; id: string; content?: unknown };
      deps.applyRun(data.sessionID, {
        type: "tool.success",
        id: data.id,
        output: contentToText(data.content),
      });
      break;
    }
    case "session.tool.error": {
      const data = event.data as { sessionID: string; id: string; content?: unknown; error?: unknown };
      deps.applyRun(data.sessionID, {
        type: "tool.error",
        id: data.id,
        output: extractErrorText(data.error ?? data.content),
      });
      break;
    }
    case "session.execution.started": {
      const data = event.data as { sessionID: string };
      deps.log.debug("execution.started", { sessionID: data.sessionID });
      deps.markStarted(data.sessionID);
      deps.applyRun(data.sessionID, { type: "execution.started" });
      break;
    }
    case "session.execution.succeeded": {
      const data = event.data as { sessionID: string };
      deps.log.debug("execution.succeeded", { sessionID: data.sessionID });
      deps.markEnded(data.sessionID);
      deps.applyRun(data.sessionID, { type: "execution.succeeded" });
      break;
    }
    case "session.execution.failed": {
      const data = event.data as { sessionID: string; error: unknown };
      deps.log.debug("execution.failed", { sessionID: data.sessionID });
      deps.markEnded(data.sessionID);
      deps.applyRun(data.sessionID, { type: "execution.failed", error: extractErrorText(data.error) });
      void deps.notifyFailure(data.sessionID, data.error);
      break;
    }
    case "session.execution.interrupted": {
      // /stop、shutdown、被 steer 取代等都会走这里；漏处理会让执行态永远卡在 running，
      // 之后每条飞书消息都被判为 queue → 永久排队（历史 bug）。
      const data = event.data as { sessionID: string; reason?: string };
      deps.log.debug("execution.interrupted", { sessionID: data.sessionID, reason: data.reason });
      deps.markEnded(data.sessionID);
      deps.applyRun(data.sessionID, { type: "execution.failed", error: `已中断（${data.reason ?? "unknown"}）` });
      break;
    }
    case "session.status": {
      // 执行态权威信号（busy/retry/idle）。execution.* 事件可能丢失或错配，用状态事件兜底。
      const data = event.data as { sessionID: string; status?: { type?: string } };
      const statusType = data.status?.type;
      deps.log.debug("session.status", { sessionID: data.sessionID, status: statusType });
      if (statusType === "idle") {
        deps.markEnded(data.sessionID);
        deps.applyRun(data.sessionID, { type: "execution.succeeded" });
      } else if (statusType === "busy" || statusType === "retry") {
        deps.markStarted(data.sessionID);
      }
      break;
    }
    case "session.idle": {
      // 兜底收尾：某些路径可能没有 execution.succeeded，避免页脚悬挂。
      const data = event.data as { sessionID: string };
      deps.log.debug("session.idle", { sessionID: data.sessionID });
      deps.markEnded(data.sessionID);
      deps.applyRun(data.sessionID, { type: "execution.succeeded" });
      break;
    }
    default:
      break;
  }
}

export function extractErrorText(error: unknown): string {
  if (!error) return "unknown";
  if (typeof error === "string") return error.slice(0, 300);
  if (Array.isArray(error)) return contentToText(error).slice(0, 300) || "unknown";
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message.slice(0, 300);
    if (typeof record.type === "string") return record.type;
  }
  return "unknown";
}

/** 工具事件里的 `content` 可能是字符串 / 对象 / `[{type:"text",text}]` 数组。 */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
}
