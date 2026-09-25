/**
 * 权限审批门（飞书卡片按钮闭环）。
 *
 * 接线（与 OPENCODE_PERMISSION_API.md 的实证一致）：
 *
 *   permission.evaluate hook ──白名单外置为 ask──▶ permission.asked (SSE)
 *        │                                              │
 *        │                                    发飞书审批卡（按钮带自签 token）
 *        ▼                                              ▼
 *   本会话无飞书映射则不改 effect                 card.action.trigger
 *   （避免把 TUI 会话卡死）                       │ 校验白名单 + token + 防重放
 *                                                 ▼
 *                              ctx.permission.reply({sessionID, requestID, reply})
 *
 * 三个按钮：允许一次(once) / 始终允许(always) / 拒绝(reject)。
 * - `always` 仅在请求带 save[] 时才会持久化（卡片文案已提示）；
 * - `reject` 会级联驳回同 session 其余挂起请求（卡片文案已警示）。
 */
import { errorMessage } from "./logger.js";
import type { Logger, PermissionRepliedLike, PermissionRequestLike, SessionLink } from "./types.js";
import { matchesAny } from "./security/allowlist.js";
import { type ReplayGuard, type VerifyResult } from "./security/token.js";
import {
  buildApprovalCard,
  buildResolvedCard,
  type ApprovalCardInput,
  type ApprovalOutcome,
} from "./feishu/cards.js";
import type { FeishuSender } from "./feishu/sender.js";
import type { CardAction } from "./types.js";
import { TtlMap } from "./utils/ttl-map.js";

export type PermissionEffect = "allow" | "ask" | "deny";
export type PermissionReply = "once" | "always" | "reject";

export interface GateConfig {
  readonly permissionGate: "off" | "notify" | "gate" | "lockdown";
  readonly allowTools: readonly string[];
  readonly denyTools: readonly string[];
  readonly approvalTtlMs: number;
  readonly maxResourcesShown: number;
}

export interface EffectDecision {
  /** undefined = 不改变原生判定。 */
  readonly effect?: PermissionEffect;
  readonly message?: string;
}

/**
 * 纯策略：根据 action 与配置决定 hook 是否改写 effect。
 * 注意：`ask` 是否可投递（会话有无飞书映射）由调用方判定，不在纯函数内。
 */
export function decideEffect(action: string, config: GateConfig): EffectDecision {
  if (config.permissionGate === "off" || config.permissionGate === "notify") {
    return {};
  }
  if (matchesAny(action, config.denyTools)) {
    return { effect: "deny", message: `feishu policy: ${action} 已在 denyTools` };
  }
  if (matchesAny(action, config.allowTools)) {
    return { effect: "allow" };
  }
  if (config.permissionGate === "lockdown") {
    return { effect: "deny", message: `feishu lockdown: ${action} 不在 allowTools` };
  }
  return { effect: "ask", message: `opencode-feishu-v2: 需要人工批准 ${action}` };
}

export interface ApprovalActionValue {
  readonly token: string;
  readonly decision: PermissionReply;
}

/** 解析按钮 value：`{ t: token, d: "once"|"always"|"reject" }`。 */
export function parseApprovalValue(rawValue: unknown): ApprovalActionValue | undefined {
  if (typeof rawValue !== "object" || rawValue === null) return undefined;
  const record = rawValue as Record<string, unknown>;
  const token = typeof record.t === "string" ? record.t : "";
  const d = record.d;
  if (!token) return undefined;
  if (d !== "once" && d !== "always" && d !== "reject") return undefined;
  return { token, decision: d };
}

export interface ReplyInput {
  readonly sessionID: string;
  readonly requestID: string;
  readonly reply: PermissionReply;
  readonly message?: string;
}

export interface ApprovalDeps {
  readonly config: GateConfig;
  readonly log: Logger;
  readonly sign: (input: { requestID: string; sessionID: string; openId: string }) => string;
  readonly verify: (token: string, expect?: { r?: string; s?: string; u?: string }) => VerifyResult;
  readonly replay: ReplayGuard;
  readonly sender: FeishuSender;
  readonly getLink: (sessionID: string) => Promise<SessionLink | undefined>;
  readonly isAllowed: (openId: string) => boolean;
  readonly reply: (input: ReplyInput) => Promise<void>;
  readonly now?: () => number;
}

interface TrackedCard {
  readonly messageId: string;
  readonly input: ApprovalCardInput;
  resolved: boolean;
}

export class ApprovalManager {
  private readonly seenRequests = new TtlMap<true>(60 * 60 * 1000);
  private readonly cards = new TtlMap<TrackedCard>(60 * 60 * 1000);
  private readonly now: () => number;

  constructor(private readonly deps: ApprovalDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 处理 permission.asked：发审批卡。 */
  async onAsked(request: PermissionRequestLike): Promise<void> {
    const requestID = request.id;
    if (!requestID || !this.seenRequests.setIfAbsent(requestID, true)) return;

    const link = await this.deps.getLink(request.sessionID);
    if (!link) {
      this.deps.log.debug("permission.asked 无飞书映射，跳过审批卡", {
        requestID,
        sessionID: request.sessionID,
      });
      return;
    }

    const canPersistAlways = Array.isArray(request.save) && request.save.length > 0;
    const token = this.deps.sign({
      requestID,
      sessionID: request.sessionID,
      openId: link.openId,
    });
    const input: ApprovalCardInput = {
      requestID,
      sessionID: request.sessionID,
      action: request.action,
      resources: request.resources ?? [],
      ...(request.message ? { message: request.message } : {}),
      canPersistAlways,
      token,
      maxResourcesShown: this.deps.config.maxResourcesShown,
    };

    const result = await this.deps.sender.sendCard(link.chatId, buildApprovalCard(input));
    if (!result.ok || !result.messageId) {
      this.deps.log.warn("审批卡发送失败", { requestID, error: result.error ?? "unknown" });
      return;
    }
    this.cards.set(requestID, { messageId: result.messageId, input, resolved: false });
    this.deps.log.info("审批卡已发送", { requestID, action: request.action, canPersistAlways });
  }

  /** 处理 permission.replied：把卡片收敛为结果态（若尚未由点击更新）。 */
  onReplied(event: PermissionRepliedLike): void {
    const tracked = this.cards.get(event.requestID);
    if (!tracked) return;
    if (!tracked.resolved) {
      const outcome: ApprovalOutcome = {
        reply: event.reply,
        operatorOpenId: "",
        at: this.now(),
      };
      void this.patchResolved(tracked, outcome, event.requestID);
    }
    this.cards.delete(event.requestID);
  }

  /**
   * 处理卡片按钮点击。同步返回飞书回调响应（toast），reply 在后台完成。
   * 校验顺序：白名单 → 签名 → 绑定字段 → 防重放。
   */
  handleCardAction(action: CardAction): object {
    const parsed = parseApprovalValue(action.rawValue);
    if (!parsed) {
      return toast("error", "无法识别的操作");
    }
    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的审批点击", {
        operator: action.operatorOpenId.slice(0, 8),
      });
      return toast("error", "无审批权限");
    }

    const verified = this.deps.verify(parsed.token, { u: action.operatorOpenId });
    if (!verified.ok) {
      this.deps.log.warn("审批 token 校验失败", { reason: verified.reason });
      return toast("error", `审批凭证无效（${verified.reason}）`);
    }
    const claims = verified.claims;

    const ttl = Math.max(1000, claims.e - this.now());
    if (!this.deps.replay.consume(claims.n, ttl)) {
      return toast("warning", "该操作已处理，请勿重复点击");
    }

    const tracked = this.cards.get(claims.r);
    const outcome: ApprovalOutcome = {
      reply: parsed.decision,
      operatorOpenId: action.operatorOpenId,
      at: this.now(),
    };

    // 后台回复 + 更新卡片，绝不阻塞回调 3 秒窗口。
    void this.applyReply(claims.r, claims.s, parsed.decision, tracked, outcome);

    return toast(
      parsed.decision === "reject" ? "warning" : "success",
      parsed.decision === "reject" ? "已拒绝" : "已允许",
    );
  }

  dispose(): void {
    this.seenRequests.clear();
    this.cards.clear();
  }

  private async applyReply(
    requestID: string,
    sessionID: string,
    reply: PermissionReply,
    tracked: TrackedCard | undefined,
    outcome: ApprovalOutcome,
  ): Promise<void> {
    try {
      await this.deps.reply({ sessionID, requestID, reply });
    } catch (err) {
      this.deps.log.error("permission.reply 失败", { requestID, error: errorMessage(err) });
      return;
    }
    if (tracked && !tracked.resolved) {
      await this.patchResolved(tracked, outcome, requestID);
    }
  }

  private async patchResolved(tracked: TrackedCard, outcome: ApprovalOutcome, requestID: string): Promise<void> {
    tracked.resolved = true;
    const res = await this.deps.sender.patchCard(tracked.messageId, buildResolvedCard(tracked.input, outcome));
    if (!res.ok) this.deps.log.warn("审批结果卡片更新失败", { requestID, error: res.error ?? "unknown" });
  }
}

type ToastType = "success" | "error" | "warning" | "info";

function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}
