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
import { type AllowSessionClaims, type ReplayGuard, type VerifyResult } from "./security/token.js";
import {
  buildApprovalCard,
  buildApprovalFailedCard,
  buildResolvedCard,
  buildSessionAllowResolvedCard,
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

/** 会话级 gate（P6）：由 `session:<sid>` 上的权限预设推导。 */
export interface SessionGate {
  readonly gateMode: "off" | "gate";
  /** gate 模式下强制升级为 ask 的动作（如 shell/edit/external_directory）。 */
  readonly askActions?: readonly string[];
}

/**
 * 会话级权限策略（P6）。无会话预设时**回退**到全局 `decideEffect`。
 *
 * 有预设时：
 * - `off`：完全不介入（ruleset/原生判定生效）；
 * - `gate`：denyTools → deny；allowTools → allow；askActions → ask；其余**继承**（不改写），
 *   因此不会把只读类工具误伤成 ask（与全局 gate 的「其余一律 ask」不同）。
 *
 * 任务 A：`allowActions` 是审批卡「本会话内允许该工具」写入的会话级放行集合。
 * 命中时**优先于 askActions** 返回 allow（避免 session ruleset 被 gate 再次改成 ask），
 * 但 `denyTools`（安全红线）仍优先。`allowActions` 与会话预设相互独立，因此即便会话
 * 没有预设（gate 走全局判定），命中也会把「本会被 ask」的动作保持为 allow。
 *
 * 安全边界（`ask` 是否可投递）仍由调用方判定，本函数不做飞书映射检查。
 */
export function decideEffectForSession(
  action: string,
  config: GateConfig,
  session: SessionGate | undefined,
  allowActions?: readonly string[],
): EffectDecision {
  if (!session) {
    const base = decideEffect(action, config);
    // 仅拦截「本会被 ask」的动作；permissionGate=off/notify 时保持不介入。
    if (base.effect === "ask" && allowActions && allowActions.length > 0 && matchesAny(action, allowActions)) {
      return { effect: "allow" };
    }
    return base;
  }
  if (session.gateMode === "off") return {};
  if (matchesAny(action, config.denyTools)) {
    return { effect: "deny", message: `feishu policy: ${action} 已在 denyTools` };
  }
  if (matchesAny(action, config.allowTools)) {
    return { effect: "allow" };
  }
  if (allowActions && allowActions.length > 0 && matchesAny(action, allowActions)) {
    return { effect: "allow" };
  }
  if (session.askActions && matchesAny(action, session.askActions)) {
    return { effect: "ask", message: `opencode-feishu-v2: 会话预设需人工批准 ${action}` };
  }
  return {};
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

export interface AllowSessionActionValue {
  readonly action: string;
  readonly token: string;
}

/**
 * 解析「本会话内允许该工具」按钮 value：`{ cmd:"allow_session", a:<action>, t:<token> }`。
 * 非该按钮返回 undefined。
 */
export function parseAllowSessionValue(rawValue: unknown): AllowSessionActionValue | undefined {
  if (typeof rawValue !== "object" || rawValue === null) return undefined;
  const record = rawValue as Record<string, unknown>;
  if (record.cmd !== "allow_session") return undefined;
  const action = typeof record.a === "string" ? record.a : "";
  const token = typeof record.t === "string" ? record.t : "";
  if (!action || !token) return undefined;
  return { action, token };
}

export interface ReplyInput {
  readonly sessionID: string;
  readonly requestID: string;
  readonly reply: PermissionReply;
  readonly message?: string;
  /**
   * 该会话工作目录（`SessionLink.dir`）。opencode 的权限请求按 **location** 存储，
   * 而飞书网关只在一个 location 运行；跨 location 会话必须带上
   * `x-opencode-directory` 才能命中请求，否则报 `Permission request not found`。
   */
  readonly directory?: string;
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
  // ── 任务 A：「本会话内允许该工具」 ──────────────────────────────────
  /** 该按钮总开关（默认 true）。false = 审批卡不渲染该按钮。 */
  readonly sessionAllowButton?: boolean;
  /** 签发 allow_session token（缺省 = 不渲染该按钮）。 */
  readonly signAllowSession?: (input: {
    requestID: string;
    sessionID: string;
    action: string;
  }) => string;
  /** 校验 allow_session token（绑定 action）。 */
  readonly verifyAllowSession?: (
    token: string,
    expect?: { sessionID?: string; action?: string },
  ) => VerifyResult<AllowSessionClaims>;
  /** 会话内放行：持久化 `allowActions` + 追加会话级 ruleset。 */
  readonly allowSession?: (input: { sessionID: string; action: string }) => Promise<void>;
  /** 同步查询该会话是否已放行某 action（幂等 toast 用）。 */
  readonly hasSessionAllow?: (input: { sessionID: string; action: string }) => boolean;
}

interface TrackedCard {
  readonly messageId: string;
  readonly input: ApprovalCardInput;
  /** 审批回复需要按会话所在 location 路由（跨 location 会话）。 */
  readonly directory?: string;
  /** 卡片绑定人 openId（reply 失败重试时重签 token 用）。 */
  readonly openId: string;
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
    // 任务 A：会话粒度放行按钮。默认开启；未装配签名时不渲染（保持向后兼容）。
    const allowSessionToken =
      this.deps.sessionAllowButton !== false && this.deps.signAllowSession
        ? this.deps.signAllowSession({
            requestID,
            sessionID: request.sessionID,
            action: request.action,
          })
        : undefined;
    const input: ApprovalCardInput = {
      requestID,
      sessionID: request.sessionID,
      action: request.action,
      resources: request.resources ?? [],
      ...(request.message ? { message: request.message } : {}),
      canPersistAlways,
      token,
      ...(allowSessionToken ? { allowSessionToken } : {}),
      maxResourcesShown: this.deps.config.maxResourcesShown,
    };

    const result = link.replyMessageId
      ? await this.deps.sender.replyCard(link.replyMessageId, buildApprovalCard(input))
      : await this.deps.sender.sendCard(link.chatId, buildApprovalCard(input));
    if (!result.ok || !result.messageId) {
      this.deps.log.warn("审批卡发送失败", { requestID, error: result.error ?? "unknown" });
      return;
    }
    this.cards.set(requestID, {
      messageId: result.messageId,
      input,
      ...(link.dir ? { directory: link.dir } : {}),
      openId: link.openId,
      resolved: false,
    });
    this.deps.log.info("审批卡已发送", {
      requestID,
      action: request.action,
      canPersistAlways,
      hasDir: Boolean(link.dir),
    });
  }

  /** 处理 permission.replied：收敛卡片（撤回，失败降级结果卡；若尚未由点击更新）。 */
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
    // 任务 A：「本会话内允许该工具」按钮（独立校验路径）。
    const allowValue = parseAllowSessionValue(action.rawValue);
    if (allowValue) return this.handleAllowSession(action, allowValue);

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
    // 注意：此处**不报成功**——reply 可能失败（如命中非持有该请求的实例）；
    // 成功与否由卡片收敛体现（成功 → 撤回；失败 → 红色失败卡 + 重试）。
    void this.applyReply(claims.r, claims.s, parsed.decision, tracked, outcome, tracked?.directory);

    return toast("info", "已提交，正在处理…");
  }

  /** 该会话是否有未决审批（看门狗判活：等审批属合法等待，不应判 stale）。 */
  hasPendingFor(sessionID: string): boolean {
    for (const [, card] of this.cards.entries()) {
      if (!card.resolved && card.input.sessionID === sessionID) return true;
    }
    return false;
  }

  dispose(): void {
    this.seenRequests.clear();
    this.cards.clear();
  }

  /**
   * 任务 A：「✅ 本会话内允许该工具」。
   *
   * 校验顺序严格按：**白名单 → 验签 → sessionID 匹配 → nonce 消费**。
   * 命中后：后台持久化 `allowActions` + 追加会话级 ruleset，并对当前挂起的请求回 `once`
   * （否则本次请求仍会卡住），最后把审批卡 patch 成「✅ 已允许本会话内 <action>」（无按钮）。
   * 重复点击 / 已生效只回 toast，不报错。
   */
  private handleAllowSession(action: CardAction, value: AllowSessionActionValue): object {
    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的会话放行点击", {
        operator: action.operatorOpenId.slice(0, 8),
      });
      return toast("error", "无审批权限");
    }
    if (!this.deps.verifyAllowSession || !this.deps.allowSession) {
      return toast("error", "本会话内允许暂不可用");
    }

    const verified = this.deps.verifyAllowSession(value.token, { action: value.action });
    if (!verified.ok) {
      this.deps.log.warn("会话放行 token 校验失败", { reason: verified.reason });
      return toast("error", `审批凭证无效（${verified.reason}）`);
    }
    const claims = verified.claims;

    // sessionID 匹配：token 里的会话必须与当前跟踪到的卡片会话一致（防跨会话/跨卡重用）。
    const tracked = this.cards.get(claims.r);
    if (tracked && tracked.input.sessionID !== claims.s) {
      this.deps.log.warn("会话放行 sessionID 不匹配", {
        tokenSession: claims.s,
        cardSession: tracked.input.sessionID,
      });
      return toast("error", "会话不匹配");
    }

    const ttl = Math.max(1000, claims.e - this.now());
    if (!this.deps.replay.consume(claims.n, ttl)) {
      return toast("warning", "该操作已处理，请勿重复点击");
    }

    const already = this.deps.hasSessionAllow?.({ sessionID: claims.s, action: claims.a }) ?? false;
    void this.applyAllowSession(claims, tracked, action).catch((err) =>
      this.deps.log.error("会话放行处理失败", {
        sessionID: claims.s,
        action: claims.a,
        error: errorMessage(err),
      }),
    );
    return already
      ? toast("info", "该工具已在本会话内允许")
      : toast("info", "已提交，正在处理…");
  }

  private async applyAllowSession(
    claims: AllowSessionClaims,
    tracked: TrackedCard | undefined,
    action: CardAction,
  ): Promise<void> {
    // 1) 持久化会话级放行（allowActions + ruleset）。
    try {
      await this.deps.allowSession!({ sessionID: claims.s, action: claims.a });
    } catch (err) {
      this.deps.log.error("会话内放行写入失败", {
        sessionID: claims.s,
        action: claims.a,
        error: errorMessage(err),
      });
    }

    // 2) 答复当前挂起的请求（once），否则本次执行仍然卡住。
    const directory = tracked?.directory ?? (await this.deps.getLink(claims.s))?.dir;
    try {
      await this.deps.reply({
        sessionID: claims.s,
        requestID: claims.r,
        reply: "once",
        ...(directory ? { directory } : {}),
      });
    } catch (err) {
      // fail loud：reply 失败不静默——保留卡片并给「重试」，绝不误判成功/撤回。
      const message = errorMessage(err);
      const notFound = isRequestNotFound(err);
      this.deps.log.error("permission.reply 失败", {
        requestID: claims.r,
        sessionID: claims.s,
        action: claims.a,
        notFound,
        error: message,
      });
      if (tracked) {
        tracked.resolved = false; // 允许后续 permission.replied 正常收敛
        await this.patchAllowSessionFailed(tracked, claims.a, message, notFound);
      } else {
        await this.notifyFailure(claims.s, message, notFound);
      }
      return;
    }

    // 3) reply 成功 → 收尾（优先撤回，失败降级为专用结果卡）。
    const messageId = tracked?.messageId;
    if (!messageId || !tracked) return;
    tracked.resolved = true;
    const card = buildSessionAllowResolvedCard(tracked.input, {
      action: claims.a,
      operatorOpenId: action.operatorOpenId,
      at: this.now(),
    });
    await this.finishCard(messageId, card, { requestID: claims.r });
  }

  private async applyReply(
    requestID: string,
    sessionID: string,
    reply: PermissionReply,
    tracked: TrackedCard | undefined,
    outcome: ApprovalOutcome,
    directory: string | undefined,
  ): Promise<void> {
    try {
      await this.deps.reply({ sessionID, requestID, reply, ...(directory ? { directory } : {}) });
    } catch (err) {
      // fail loud：reply 失败不静默——保留卡片并给「重试」，避免「假成功」卡死会话。
      const message = errorMessage(err);
      const notFound = isRequestNotFound(err);
      this.deps.log.error("permission.reply 失败", {
        requestID,
        hasDir: Boolean(directory),
        notFound,
        error: message,
      });
      if (tracked) {
        if (!tracked.resolved) await this.patchReplyFailed(tracked, reply, message, notFound);
      } else {
        await this.notifyFailure(sessionID, message, notFound);
      }
      return;
    }
    if (tracked && !tracked.resolved) {
      await this.patchResolved(tracked, outcome, requestID);
    }
  }

  /**
   * reply 失败且本实例**未跟踪到该卡片**时（跨进程：回调落到非持有实例），
   * 发一条可见失败提示，避免「静默假成功」。
   */
  private async notifyFailure(sessionID: string, reason: string, notFound: boolean): Promise<void> {
    const link = await this.deps.getLink(sessionID);
    if (!link) return;
    const text = [
      "⚠️ 审批未生效：本次操作没有送达 OpenCode，会话可能仍在等待。",
      `原因：${reason}`,
      notFound
        ? "该请求可能已由另一个 opencode 实例处理、或已过期。请回到该会话重新触发审批。"
        : "请稍后回到该会话重试。",
    ].join("\n");
    const res = link.replyMessageId
      ? await this.deps.sender.replyText(link.replyMessageId, text)
      : await this.deps.sender.sendText(link.chatId, text);
    if (!res.ok) this.deps.log.warn("审批失败提示发送失败", { sessionID, error: res.error ?? "unknown" });
  }

  /** reply 失败 → 把审批卡 patch 成「未生效 + 重试」卡（重试携带重签 token）。 */
  private async patchReplyFailed(
    tracked: TrackedCard,
    reply: PermissionReply,
    reason: string,
    notFound: boolean,
  ): Promise<void> {
    const token = this.deps.sign({
      requestID: tracked.input.requestID,
      sessionID: tracked.input.sessionID,
      openId: tracked.openId,
    });
    const card = buildApprovalFailedCard(tracked.input, {
      reason,
      ...(notFound ? { notFound: true } : {}),
      retry: { label: "🔁 重试", value: { t: token, d: reply } },
    });
    const res = await this.deps.sender.patchCard(tracked.messageId, card);
    if (!res.ok) {
      this.deps.log.warn("审批失败卡更新失败", {
        requestID: tracked.input.requestID,
        error: res.error ?? "unknown",
      });
    }
  }

  /** 会话放行 reply 失败 → 同样的「未生效 + 重试」卡（重试携带重签的 allow_session token）。 */
  private async patchAllowSessionFailed(
    tracked: TrackedCard,
    action: string,
    reason: string,
    notFound: boolean,
  ): Promise<void> {
    const retryValue: Record<string, unknown> | undefined =
      this.deps.signAllowSession && this.deps.sessionAllowButton !== false
        ? {
            cmd: "allow_session",
            a: action,
            t: this.deps.signAllowSession({
              requestID: tracked.input.requestID,
              sessionID: tracked.input.sessionID,
              action,
            }),
          }
        : undefined;
    const card = buildApprovalFailedCard(tracked.input, {
      reason,
      ...(notFound ? { notFound: true } : {}),
      ...(retryValue ? { retry: { label: "🔁 重试「本会话内允许」", value: retryValue } } : {}),
    });
    const res = await this.deps.sender.patchCard(tracked.messageId, card);
    if (!res.ok) {
      this.deps.log.warn("会话放行失败卡更新失败", {
        requestID: tracked.input.requestID,
        error: res.error ?? "unknown",
      });
    }
  }

  private async patchResolved(tracked: TrackedCard, outcome: ApprovalOutcome, requestID: string): Promise<void> {
    tracked.resolved = true;
    await this.finishCard(tracked.messageId, buildResolvedCard(tracked.input, outcome), { requestID });
  }

  /**
   * 审批卡收敛：**优先撤回**（操作后不再残留卡片影响用户查看），撤回失败（超时限/无权限）
   * 才降级 patch 成结果卡，避免卡片永久停在待审批态。
   */
  private async finishCard(messageId: string, card: object, tag: { requestID: string }): Promise<void> {
    const res = await this.deps.sender.deleteMessage(messageId);
    if (res.ok) {
      this.deps.log.debug("审批卡已撤回", tag);
      return;
    }
    const patched = await this.deps.sender.patchCard(messageId, card);
    if (!patched.ok) this.deps.log.warn("审批结果卡片更新失败", { ...tag, error: patched.error ?? "unknown" });
  }
}

type ToastType = "success" | "error" | "warning" | "info";

/** 是否「请求不存在」类错误（命中非持有该请求的实例 / 已过期失效）。 */
function isRequestNotFound(err: unknown): boolean {
  return /not\s*found/i.test(errorMessage(err));
}

function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}
