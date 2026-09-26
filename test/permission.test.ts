import { describe, expect, test } from "vitest";
import { decideEffect, decideEffectForSession, parseApprovalValue, type GateConfig } from "../src/permission.js";

const cfg = (over: Partial<GateConfig> = {}): GateConfig => ({
  permissionGate: "gate",
  allowTools: ["read", "glob", "grep", "webfetch"],
  denyTools: [],
  approvalTtlMs: 60_000,
  maxResourcesShown: 8,
  ...over,
});

describe("decideEffect", () => {
  test("off / notify 不改写 effect", () => {
    expect(decideEffect("bash", cfg({ permissionGate: "off" }))).toEqual({});
    expect(decideEffect("bash", cfg({ permissionGate: "notify" }))).toEqual({});
  });

  test("gate：白名单放行，其余 ask", () => {
    expect(decideEffect("read", cfg())).toEqual({ effect: "allow" });
    const ask = decideEffect("bash", cfg());
    expect(ask.effect).toBe("ask");
    expect(ask.message).toContain("bash");
  });

  test("denyTools 优先于 allowTools", () => {
    const out = decideEffect("bash", cfg({ allowTools: ["bash"], denyTools: ["bash"] }));
    expect(out.effect).toBe("deny");
  });

  test("lockdown：白名单外一律 deny", () => {
    expect(decideEffect("bash", cfg({ permissionGate: "lockdown" })).effect).toBe("deny");
    expect(decideEffect("read", cfg({ permissionGate: "lockdown" })).effect).toBe("allow");
  });

  test("支持通配 *", () => {
    expect(decideEffect("anything", cfg({ allowTools: ["*"] })).effect).toBe("allow");
    expect(decideEffect("bashx", cfg({ denyTools: ["bash*"] })).effect).toBe("deny");
  });
});

describe("decideEffectForSession（P6 会话预设）", () => {
  test("无会话预设 → 回退全局 decideEffect", () => {
    expect(decideEffectForSession("bash", cfg(), undefined)).toEqual(decideEffect("bash", cfg()));
    expect(decideEffectForSession("read", cfg(), undefined)).toEqual({ effect: "allow" });
  });

  test("gateMode=off → 完全不介入（即使全局 gate）", () => {
    expect(decideEffectForSession("bash", cfg(), { gateMode: "off" })).toEqual({});
    expect(decideEffectForSession("edit", cfg(), { gateMode: "off" })).toEqual({});
  });

  test("gateMode=gate → 仅对 askActions 升级为 ask，其余继承", () => {
    const session = { gateMode: "gate" as const, askActions: ["shell", "bash", "edit", "external_directory"] };
    expect(decideEffectForSession("bash", cfg(), session).effect).toBe("ask");
    expect(decideEffectForSession("edit", cfg(), session).effect).toBe("ask");
    expect(decideEffectForSession("external_directory", cfg(), session).effect).toBe("ask");
    // 白名单仍放行
    expect(decideEffectForSession("read", cfg(), session).effect).toBe("allow");
    // 其余继承（不改写），不像全局 gate 那样一律 ask
    expect(decideEffectForSession("task", cfg(), session)).toEqual({});
  });

  test("denyTools 仍优先于会话 ask", () => {
    const session = { gateMode: "gate" as const, askActions: ["bash"] };
    expect(decideEffectForSession("bash", cfg({ denyTools: ["bash"] }), session).effect).toBe("deny");
  });
});

describe("parseApprovalValue", () => {
  test("合法 value", () => {
    expect(parseApprovalValue({ t: "tok", d: "once" })).toEqual({ token: "tok", decision: "once" });
  });

  test("非法 decision / 缺 token / 非对象", () => {
    expect(parseApprovalValue({ t: "tok", d: "maybe" })).toBeUndefined();
    expect(parseApprovalValue({ d: "once" })).toBeUndefined();
    expect(parseApprovalValue("string")).toBeUndefined();
    expect(parseApprovalValue(null)).toBeUndefined();
  });
});
