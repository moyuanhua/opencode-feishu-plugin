/**
 * 审批卡按钮的自签 token：绑定 requestID + sessionID + operatorOpenId + 过期时间 + 防重放 nonce。
 *
 * 为什么需要：飞书卡片按钮的 value 会被回传到 `card.action.trigger`，
 * 任何能点这张卡的人都能构造回调；必须证明「这个 requestID 是本插件为这个用户签发的」。
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

export type VerifyResult =
  | { readonly ok: true; readonly claims: ApprovalClaims }
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

  let claims: ApprovalClaims;
  try {
    claims = JSON.parse(fromB64url(body).toString("utf8")) as ApprovalClaims;
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
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
