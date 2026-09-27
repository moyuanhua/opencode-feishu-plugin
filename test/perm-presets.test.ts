import { describe, expect, test } from "vitest";
import {
  PERMISSION_PRESETS,
  allowActionsForGrant,
  appendAllowRules,
  isPermissionPreset,
  presetAskActions,
  presetGateMode,
  presetInfo,
  presetLabel,
  presetToRuleset,
} from "../src/feishu/perm-presets.js";

describe("权限预设 → ruleset / gateMode", () => {
  test("readonly：禁 edit/write/shell，gate off，无 ask", () => {
    const rules = presetToRuleset("readonly");
    for (const action of ["edit", "write", "shell", "bash"]) {
      expect(rules).toContainEqual({ action, resource: "*", effect: "deny" });
    }
    expect(presetGateMode("readonly")).toBe("off");
    expect(presetAskActions("readonly")).toEqual([]);
  });

  test("edit：allow edit，shell→ask，gate gate", () => {
    const rules = presetToRuleset("edit");
    expect(rules).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    expect(rules).toContainEqual({ action: "shell", resource: "*", effect: "ask" });
    expect(rules).toContainEqual({ action: "bash", resource: "*", effect: "ask" });
    expect(presetGateMode("edit")).toBe("gate");
    expect(presetAskActions("edit")).toEqual(expect.arrayContaining(["shell", "bash"]));
  });

  test("askHigh：ruleset 为空（继承），gate gate 且 ask shell/edit/external_directory", () => {
    expect(presetToRuleset("askHigh")).toEqual([]);
    expect(presetGateMode("askHigh")).toBe("gate");
    expect(presetAskActions("askHigh")).toEqual(
      expect.arrayContaining(["shell", "edit", "external_directory"]),
    );
  });

  test("trust：allow all，gate off", () => {
    expect(presetToRuleset("trust")).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    expect(presetGateMode("trust")).toBe("off");
    expect(presetAskActions("trust")).toEqual([]);
  });
});

describe("任务 A：会话内放行规则", () => {
  test("allowActionsForGrant：shell/bash 一起放行，其它动作只放行自身", () => {
    expect(allowActionsForGrant("bash").sort()).toEqual(["bash", "shell"]);
    expect(allowActionsForGrant("shell").sort()).toEqual(["bash", "shell"]);
    expect(allowActionsForGrant("edit")).toEqual(["edit"]);
  });

  test("appendAllowRules：覆盖旧 ask，去重旧 allow", () => {
    const base = presetToRuleset("edit"); // allow edit + shell/bash ask
    const out = appendAllowRules(base, allowActionsForGrant("bash"));
    // shell/bash 的最后一条规则变为 allow
    expect(out).toContainEqual({ action: "bash", resource: "*", effect: "allow" });
    expect(out).toContainEqual({ action: "shell", resource: "*", effect: "allow" });
    expect(out).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    // 幂等：重复追加不再累积
    const again = appendAllowRules(out, allowActionsForGrant("bash"));
    expect(again.filter((r) => r.action === "bash" && r.effect === "allow")).toHaveLength(1);
    expect(again).toHaveLength(out.length);
  });

  test("appendAllowRules：空基底也能追加", () => {
    expect(appendAllowRules([], ["edit"])).toEqual([{ action: "edit", resource: "*", effect: "allow" }]);
  });
});

describe("预设元信息", () => {
  test("四档齐全且 isPermissionPreset 校验", () => {
    expect(PERMISSION_PRESETS.map((p) => p.id)).toEqual(["readonly", "edit", "askHigh", "trust"]);
    expect(isPermissionPreset("edit")).toBe(true);
    expect(isPermissionPreset("bogus")).toBe(false);
    expect(isPermissionPreset(1)).toBe(false);
  });

  test("presetLabel / presetInfo 带图标与说明", () => {
    expect(presetLabel("edit")).toBe("✏️ 可编辑");
    expect(presetInfo("trust").description.length).toBeGreaterThan(0);
  });
});
