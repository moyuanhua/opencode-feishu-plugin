import { describe, expect, test } from "vitest";
import { ReplayGuard, signApproval, signStop, STOP_PURPOSE, verifyApproval, verifyStop } from "../src/security/token.js";

const SECRET = "test-secret";
const NOW = 1_700_000_000_000;

function token(overrides: Partial<{ r: string; s: string; u: string; ttlMs: number; nonce: string }> = {}) {
  return signApproval(
    {
      r: overrides.r ?? "per_1",
      s: overrides.s ?? "ses_1",
      u: overrides.u ?? "ou_1",
      ttlMs: overrides.ttlMs ?? 60_000,
      now: NOW,
    },
    SECRET,
    overrides.nonce ? { nonce: overrides.nonce } : {},
  );
}

describe("signApproval / verifyApproval", () => {
  test("签名-校验往返成功", () => {
    const t = token();
    const res = verifyApproval(t, SECRET, { now: NOW + 1000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.r).toBe("per_1");
      expect(res.claims.s).toBe("ses_1");
      expect(res.claims.u).toBe("ou_1");
    }
  });

  test("篡改载荷导致签名失败", () => {
    const t = token();
    const [body, sig] = t.split(".");
    const forged = `${body}x.${sig}`;
    expect(verifyApproval(forged, SECRET, { now: NOW }).ok).toBe(false);
  });

  test("换 secret 失败", () => {
    expect(verifyApproval(token(), "other", { now: NOW }).ok).toBe(false);
  });

  test("过期失败", () => {
    const res = verifyApproval(token({ ttlMs: 1000 }), SECRET, { now: NOW + 5000 });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  test("绑定字段不匹配失败", () => {
    const t = token();
    expect(verifyApproval(t, SECRET, { now: NOW, expect: { u: "ou_other" } })).toEqual({
      ok: false,
      reason: "operator-mismatch",
    });
    expect(verifyApproval(t, SECRET, { now: NOW, expect: { r: "per_other" } }).ok).toBe(false);
    expect(verifyApproval(t, SECRET, { now: NOW, expect: { s: "ses_other" } }).ok).toBe(false);
  });

  test("畸形 token", () => {
    expect(verifyApproval("", SECRET).ok).toBe(false);
    expect(verifyApproval("nodot", SECRET).ok).toBe(false);
  });
});

describe("signStop / verifyStop", () => {
  const signStopToken = (sessionID = "ses_1", ttlMs = 60_000, nonce?: string) =>
    signStop({ sessionID, ttlMs, now: NOW }, SECRET, nonce ? { nonce } : {});

  test("往返成功且用途标签正确", () => {
    const res = verifyStop(signStopToken(), SECRET, { now: NOW + 1000, expectSessionID: "ses_1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.p).toBe(STOP_PURPOSE);
      expect(res.claims.s).toBe("ses_1");
    }
  });

  test("伪造 / 换 secret 拒绝", () => {
    const t = signStopToken();
    const [body, sig] = t.split(".");
    expect(verifyStop(`${body}x.${sig}`, SECRET, { now: NOW }).ok).toBe(false);
    expect(verifyStop(t, "other-secret", { now: NOW }).ok).toBe(false);
    expect(verifyStop("nodot", SECRET, { now: NOW })).toEqual({ ok: false, reason: "malformed-token" });
  });

  test("sessionID 不匹配拒绝", () => {
    const res = verifyStop(signStopToken("ses_1"), SECRET, { now: NOW, expectSessionID: "ses_other" });
    expect(res).toEqual({ ok: false, reason: "session-mismatch" });
  });

  test("过期拒绝", () => {
    const res = verifyStop(signStopToken("ses_1", 1000), SECRET, { now: NOW + 5000 });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  test("审批 token 不能当强停 token 用（用途标签隔离）", () => {
    const approval = token();
    expect(verifyStop(approval, SECRET, { now: NOW }).ok).toBe(false);
  });
});

describe("ReplayGuard", () => {
  test("nonce 只能消费一次", () => {
    let now = NOW;
    const guard = new ReplayGuard(60_000, () => now);
    expect(guard.consume("n1", 60_000)).toBe(true);
    expect(guard.consume("n1", 60_000)).toBe(false);
    expect(guard.consume("n2", 60_000)).toBe(true);
    now += 61_000;
    expect(guard.consume("n1", 60_000)).toBe(true);
  });
});
