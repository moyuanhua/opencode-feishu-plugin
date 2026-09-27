/**
 * 卡片按钮的自签 token。
 *
 * 两类用途，共用同一套 HMAC-SHA256 机制：
 * - 审批卡：绑定 requestID + sessionID + operatorOpenId + 过期时间 + nonce（`signApproval`）；
 * - 运行卡「强制停止」：绑定 sessionID + 用途标签 + 过期时间 + nonce（`signStop`）。
 *
 * 为什么需要：飞书卡片按钮的 value 会被回传到 `card.action.trigger`，
 * 任何能点这张卡的人都能构造回调；必须证明「这个动作是本插件签发的」。
 *
 * 纯函数 + 注入时钟，便于单测。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TtlMap } from "../utils/ttl-map.js";

export interface ApprovalClaims {
  /** requestID（permission.asked 的 data.id）。 */
  readonly r: string;
  /** sessionID。 */
  readonly s: string;
  /** 被授权点击的 operator open_id。 */
  readonly u: string;
  /** 过期时间（ms epoch）。 */
  readonly e: number;
  /** 防重放 nonce。 */
  readonly n: string;
}

export type VerifyResult<T = ApprovalClaims> =
  | { readonly ok: true; readonly claims: T }
  | { readonly ok: false; readonly reason: string };

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(data: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(data).digest());
}

export interface SignOptions {
  /** 生成新 token 的 nonce；默认随机。 */
  readonly nonce?: string;
}

/** 验签并把 payload 解析为对象；不动任何业务字段。 */
function openSigned(
  token: string,
  secret: string,
): { readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly reason: string } {
  if (!token) return { ok: false, reason: "empty-token" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed-token" };
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = hmac(body, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { ok: false, reason: "bad-payload" };
    }
    return { ok: true, payload: payload as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
}

export function signApproval(
  input: Pick<ApprovalClaims, "r" | "s" | "u"> & { readonly ttlMs: number; readonly now?: number },
  secret: string,
  options: SignOptions = {},
): string {
  const now = input.now ?? Date.now();
  const claims: ApprovalClaims = {
    r: input.r,
    s: input.s,
    u: input.u,
    e: now + input.ttlMs,
    n: options.nonce ?? randomBytes(9).toString("hex"),
  };
  const body = b64url(JSON.stringify(claims));
  return `${body}.${hmac(body, secret)}`;
}

export interface VerifyOptions {
  readonly now?: number;
  /** 期望匹配的字段（可选），不匹配直接失败。 */
  readonly expect?: Partial<Pick<ApprovalClaims, "r" | "s" | "u">>;
}

export function verifyApproval(token: string, secret: string, options: VerifyOptions = {}): VerifyResult {
  const opened = openSigned(token, secret);
  if (!opened.ok) return opened;
  const claims = opened.payload as unknown as ApprovalClaims;

  if (
    typeof claims?.r !== "string" ||
    typeof claims?.s !== "string" ||
    typeof claims?.u !== "string" ||
    typeof claims?.e !== "number" ||
    typeof claims?.n !== "string"
  ) {
    return { ok: false, reason: "bad-claims" };
  }

  const now = options.now ?? Date.now();
  if (claims.e <= now) return { ok: false, reason: "expired" };

  const expect = options.expect;
  if (expect?.r && claims.r !== expect.r) return { ok: false, reason: "request-mismatch" };
  if (expect?.s && claims.s !== expect.s) return { ok: false, reason: "session-mismatch" };
  if (expect?.u && claims.u !== expect.u) return { ok: false, reason: "operator-mismatch" };

  return { ok: true, claims };
}

/** 「运行卡强制停止」token 的用途标签。 */
export const STOP_PURPOSE = "stop";

/**
 * 「强制停止」token 载荷：p=用途标签、s=sessionID、e=过期时间、n=nonce。
 *
 * 刻意**不绑定 operator**：授权由 allowUsers/owner 白名单在点击时校验（单聊场景下点击人即会话主人），
 * token 只负责证明「这个 sid 的停止动作由本插件签发、未过期、未重放」。
 */
export interface StopClaims {
  readonly p: typeof STOP_PURPOSE;
  readonly s: string;
  readonly e: number;
  readonly n: string;
}

export function signStop(
  input: { readonly sessionID: string; readonly ttlMs: number; readonly now?: number },
  secret: string,
  options: SignOptions = {},
): string {
  const now = input.now ?? Date.now();
  const claims: StopClaims = {
    p: STOP_PURPOSE,
    s: input.sessionID,
    e: now + input.ttlMs,
    n: options.nonce ?? randomBytes(9).toString("hex"),
  };
  const body = b64url(JSON.stringify(claims));
  return `${body}.${hmac(body, secret)}`;
}

export interface VerifyStopOptions {
  readonly now?: number;
  /** 期望匹配的 sessionID（必须与按钮 value 的 sid 一致）。 */
  readonly expectSessionID?: string;
}

export function verifyStop(token: string, secret: string, options: VerifyStopOptions = {}): VerifyResult<StopClaims> {
  const opened = openSigned(token, secret);
  if (!opened.ok) return opened;
  const claims = opened.payload as unknown as StopClaims;

  if (
    claims?.p !== STOP_PURPOSE ||
    typeof claims?.s !== "string" ||
    typeof claims?.e !== "number" ||
    typeof claims?.n !== "string"
  ) {
    return { ok: false, reason: "bad-claims" };
  }

  const now = options.now ?? Date.now();
  if (claims.e <= now) return { ok: false, reason: "expired" };
  if (options.expectSessionID && claims.s !== options.expectSessionID) {
    return { ok: false, reason: "session-mismatch" };
  }

  return { ok: true, claims };
}

/**
 * nonce 防重放：同一 token 只能成功消费一次。
 * 过期时间与 token TTL 对齐，避免内存无限增长。
 */
export class ReplayGuard {
  private readonly seen: TtlMap<true>;

  constructor(ttlMs: number, now: () => number = () => Date.now()) {
    this.seen = new TtlMap<true>(ttlMs, now);
  }

  /** 首次返回 true；重复返回 false。 */
  consume(nonce: string, ttlMs?: number): boolean {
    return this.seen.setIfAbsent(`n:${nonce}`, true, ttlMs);
  }

  clear(): void {
    this.seen.clear();
  }
}
