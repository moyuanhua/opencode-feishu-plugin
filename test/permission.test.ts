import { describe, expect, test } from "vitest";
import { decideEffect, parseApprovalValue, type GateConfig } from "../src/permission.js";

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
