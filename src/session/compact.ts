/**
 * 恢复卡「🗜 压缩并总结」：**用户主动触发**的原生压缩路径（三条路径的第 ③ 条）。
 *
 * 为什么必须显式：`session.compact` 会**修改会话历史**（把上下文替换成 compaction 摘要），
 * 因此绝不能在「进入会话」时自动执行——只在用户点按钮时触发。
 *
 * 流程：
 * 1. 点击时同步返回 toast（飞书 3 秒窗口），压缩 + 轮询在后台完成；
 * 2. 触发 `POST /api/session/{id}/compact`（`ctx.session.compact`）；
 * 3. 卡片进入「🗜 正在压缩会话…」态；
 * 4. 轮询（默认每 2s，上限 `timeoutMs`）读会话消息，直到出现**新的** `status:"completed"`
 *    的 compaction 摘要，取其 `summary` patch 到卡片；
 * 5. 失败/超时 patch 说明，不影响用户继续在该话题/卡片下干活。
 *
 * 安全边界与强停一致：白名单 → 验签 → 绑定 sessionID → 防重放（nonce 只消费一次）。
 * 纯逻辑 + 注入 IO，不 import 飞书 SDK / opencode API，便于单测。
 */
import { errorMessage } from "../logger.js";
import type { CardAction, Logger } from "../types.js";
import type { ReplayGuard, StopClaims, VerifyResult } from "../security/token.js";
import { extractLatestSummary } from "./resume-summary.js";

export const COMPACT_CMD = "compact" as const;

/** 按钮 value：`{ cmd: "compact", s: <sessionID>, t: <token> }`。 */
export type CompactActionValue = {
  readonly cmd: typeof COMPACT_CMD;
  readonly s: string;
  readonly t: string;
};

/** 解析按钮 value；非本类卡片返回 undefined。 */
export function parseCompactActionValue(raw: unknown): CompactActionValue | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.cmd !== COMPACT_CMD) return undefined;
  const s = typeof record.s === "string" ? record.s : "";
  const t = typeof record.t === "string" ? record.t : "";
  if (!s || !t) return undefined;
  return { cmd: COMPACT_CMD, s, t };
}

/** 构建按钮 value（token 由调用方签名）。 */
export function buildCompactValue(sessionID: string, token: string): CompactActionValue {
  return { cmd: COMPACT_CMD, s: sessionID, t: token };
}

export interface CompactPollResult {
  readonly summary?: string;
  readonly error?: string;
}

export interface CompactDeps {
  readonly log: Logger;
  readonly isAllowed: (openId: string) => boolean;
  /** 验签（复用 `verifyStop` 同族：绑定 sessionID + 用途标签 + TTL + nonce）。 */
  readonly verify: (token: string, expectSessionID: string) => VerifyResult<StopClaims>;
  readonly replay: ReplayGuard;
  /** 触发原生压缩 `session.compact`；抛错视为失败。 */
  readonly compact: (sessionID: string) => Promise<void>;
  /** 读会话消息（轮询用）；返回形状交给 `extractLatestSummary` 兼容。 */
  readonly readMessages: (sessionID: string) => Promise<unknown>;
  /** 点击后立刻把卡片改成「🗜 正在压缩会话…」（可选；失败只 log）。 */
  readonly patchPending?: (sessionID: string, messageId: string, token: string) => Promise<void>;
  /** 压缩完成 / 失败 / 超时时 patch 卡片（后台调用，失败只 log）。`messageId` = 触发点击的卡片消息 id。 */
  readonly patch: (sessionID: string, summary: string, kind: "completed" | "failed", messageId: string) => Promise<void>;
  /** 轮询间隔（默认 2000ms）。 */
  readonly pollIntervalMs?: number;
  /** 轮询总超时（默认 120000ms）。 */
  readonly timeoutMs?: number;
  /** 注入计时器，便于单测。 */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class CompactController {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: CompactDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * 处理卡片点击：同步返回 toast（3 秒窗口），压缩 + 轮询在后台完成。
   * 校验顺序：白名单 → 验签 → 绑定 sessionID → 防重放。
   */
  handleCardAction(action: CardAction): object {
    const parsed = parseCompactActionValue(action.rawValue);
    if (!parsed) return toast("error", "无法识别的操作");

    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的压缩点击", { operator: action.operatorOpenId.slice(0, 8) });
      return toast("error", "无操作权限");
    }

    const verified = this.deps.verify(parsed.t, parsed.s);
    if (!verified.ok) {
      this.deps.log.warn("压缩 token 校验失败", { reason: verified.reason, sessionID: parsed.s });
      return toast("error", `操作凭证无效（${verified.reason}）`);
    }

    const ttl = Math.max(1000, verified.claims.e - this.now());
    if (!this.deps.replay.consume(verified.claims.n, ttl)) {
      return toast("warning", "该操作已处理，请勿重复点击");
    }

    // 立刻 patch「正在压缩」态（best-effort），再后台压缩 + 轮询。
    const messageId = action.messageId;
    if (this.deps.patchPending && messageId) {
      void this.deps
        .patchPending(parsed.s, messageId, parsed.t)
        .catch((err) => this.deps.log.warn("压缩中卡片 patch 失败", { sessionID: parsed.s, error: errorMessage(err) }));
    }

    // 后台执行，绝不阻塞回调 3 秒窗口。
    void this.run(parsed.s, messageId).catch((err) =>
      this.deps.log.warn("压缩会话失败", { sessionID: parsed.s, error: errorMessage(err) }),
    );

    return toast("success", "🗜 正在压缩会话…");
  }

  /** 压缩 + 轮询到新摘要；失败/超时 patch 说明（best-effort）。 */
  async run(sessionID: string, messageId = ""): Promise<CompactPollResult> {
    const baseline = this.baselineSummary(await this.readQuiet(sessionID));

    try {
      await this.deps.compact(sessionID);
    } catch (err) {
      const error = errorMessage(err);
      this.deps.log.warn("触发会话压缩失败", { sessionID, error });
      await this.patchQuiet(sessionID, compactFailureText(error), "failed", messageId);
      return { error };
    }

    const result = await this.poll(sessionID, baseline);
    if (result.summary) {
      await this.patchQuiet(sessionID, `已压缩 · 会话摘要：\n\n${result.summary}`, "completed", messageId);
      return result;
    }
    await this.patchQuiet(sessionID, compactFailureText(result.error ?? "timeout"), "failed", messageId);
    return result;
  }

  /**
   * 轮询直到出现**新的** completed compaction 摘要。
   * `baseline` = 点击前的已有摘要，避免把旧摘要误当成新结果。
   */
  async poll(sessionID: string, baseline: string | undefined): Promise<CompactPollResult> {
    const interval = Math.max(50, this.deps.pollIntervalMs ?? 2000);
    const deadline = this.now() + Math.max(interval, this.deps.timeoutMs ?? 120_000);
    for (;;) {
      const summary = extractLatestSummary(await this.readQuiet(sessionID));
      if (summary && summary !== baseline) return { summary };
      if (this.now() >= deadline) return { error: "timeout" };
      await this.sleep(interval);
    }
  }

  /** 读一次当前已完成摘要（失败返回 undefined，不阻断）。 */
  private baselineSummary(raw: unknown): string | undefined {
    try {
      return extractLatestSummary(raw);
    } catch {
      return undefined;
    }
  }

  private async readQuiet(sessionID: string): Promise<unknown> {
    try {
      return await this.deps.readMessages(sessionID);
    } catch (err) {
      this.deps.log.debug("压缩轮询读取会话消息失败", { sessionID, error: errorMessage(err) });
      return undefined;
    }
  }

  private async patchQuiet(
    sessionID: string,
    text: string,
    kind: "completed" | "failed",
    messageId: string,
  ): Promise<void> {
    try {
      await this.deps.patch(sessionID, text, kind, messageId);
    } catch (err) {
      this.deps.log.warn("压缩结果 patch 失败", { sessionID, error: errorMessage(err) });
    }
  }
}

/** 压缩失败/超时的降级文案（用户仍可继续在该卡片/话题下干活）。 */
export function compactFailureText(error: string): string {
  const reason = error === "timeout" ? "超时（压缩仍在后台进行）" : `失败：${error}`;
  return `⚠️ 压缩会话${reason}。可继续在本话题/卡片下发消息；稍后如需摘要可再点一次「🗜 压缩并总结」。`;
}

type ToastType = "success" | "error" | "warning" | "info";

function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}
