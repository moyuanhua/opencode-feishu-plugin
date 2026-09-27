import { describe, expect, test } from "vitest";
import {
  decideEffect,
  decideEffectForSession,
  parseAllowSessionValue,
  parseApprovalValue,
  type GateConfig,
} from "../src/permission.js";

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

describe("decideEffectForSession 会话内放行（任务 A）", () => {
  test("allowActions 命中 → 不再降级为 ask，返回 allow", () => {
    const session = { gateMode: "gate" as const, askActions: ["shell", "bash", "edit"] };
    expect(decideEffectForSession("bash", cfg(), session, ["shell", "bash"]).effect).toBe("allow");
    expect(decideEffectForSession("bash", cfg(), session, ["bash"]).effect).toBe("allow");
    // 未命中的动作仍会 ask
    expect(decideEffectForSession("edit", cfg(), session, ["shell", "bash"]).effect).toBe("ask");
    // 仅放行 shell 时 bash 仍 ask（真实实现里两者一起放行，见 allowActionsForGrant）
    expect(decideEffectForSession("bash", cfg(), session, ["shell"]).effect).toBe("ask");
  });

  test("denyTools 优先于 allowActions（安全红线）", () => {
    const session = { gateMode: "gate" as const, askActions: ["bash"] };
    expect(decideEffectForSession("bash", cfg({ denyTools: ["bash"] }), session, ["bash"]).effect).toBe("deny");
  });

  test("无会话预设（全局 gate）时命中 allowActions 也不 ask", () => {
    expect(decideEffectForSession("bash", cfg(), undefined, ["bash"]).effect).toBe("allow");
    // 未命中仍走全局判定 → ask
    expect(decideEffectForSession("edit", cfg(), undefined, ["bash"]).effect).toBe("ask");
  });

  test("permissionGate=off 时不介入（allowActions 也不会强制 allow）", () => {
    expect(decideEffectForSession("bash", cfg({ permissionGate: "off" }), undefined, ["bash"])).toEqual({});
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

describe("parseAllowSessionValue", () => {
  test("合法 value", () => {
    expect(parseAllowSessionValue({ cmd: "allow_session", a: "bash", t: "tok" })).toEqual({
      action: "bash",
      token: "tok",
    });
  });

  test("缺 action / token / 非本按钮返回 undefined", () => {
    expect(parseAllowSessionValue({ cmd: "allow_session", t: "tok" })).toBeUndefined();
    expect(parseAllowSessionValue({ cmd: "allow_session", a: "bash" })).toBeUndefined();
    expect(parseAllowSessionValue({ cmd: "open", a: "bash", t: "tok" })).toBeUndefined();
    expect(parseAllowSessionValue({ t: "tok", d: "once" })).toBeUndefined();
    expect(parseAllowSessionValue(null)).toBeUndefined();
  });
});
