import { describe, expect, test, vi } from "vitest";
import { routeCardAction, type CardActionRouterDeps } from "../src/runtime/card-action-router.js";
import { createLogger } from "../src/logger.js";
import type { CardAction } from "../src/types.js";

const log = createLogger({ level: "error", sink: () => undefined });

function action(rawValue: unknown, formValue?: Readonly<Record<string, unknown>>): CardAction {
  return {
    rawValue,
    ...(formValue ? { formValue } : {}),
    messageId: "om_1",
    chatId: "oc_1",
    operatorOpenId: "ou_1",
  };
}

function makeDeps(over: Partial<CardActionRouterDeps> = {}): CardActionRouterDeps {
  return {
    log,
    handleForm: vi.fn(() => undefined),
    handleStop: vi.fn(() => ({ toast: { type: "success", content: "stop" } })),
    handleCommands: vi.fn(() => ({ toast: { type: "success", content: "cmd" } })),
    handleApprovals: vi.fn(() => ({ toast: { type: "success", content: "appr" } })),
    ...over,
  };
}

describe("routeCardAction", () => {
  test("表单中继命中时优先返回，不再分流", () => {
    const deps = makeDeps({ handleForm: vi.fn(() => ({ toast: { type: "info", content: "form" } })) });
    const res = routeCardAction(action({ f: "x", k: "y" }), deps);
    expect(res).toEqual({ toast: { type: "info", content: "form" } });
    expect(deps.handleStop).not.toHaveBeenCalled();
    expect(deps.handleCommands).not.toHaveBeenCalled();
    expect(deps.handleApprovals).not.toHaveBeenCalled();
  });

  test("强停按钮走独立路径", () => {
    const deps = makeDeps();
    routeCardAction(action({ cmd: "stop", sid: "s1", t: "tok" }), deps);
    expect(deps.handleStop).toHaveBeenCalledTimes(1);
    expect(deps.handleCommands).not.toHaveBeenCalled();
    expect(deps.handleApprovals).not.toHaveBeenCalled();
  });

  test("会话卡 value 路由到 commands", () => {
    const deps = makeDeps();
    routeCardAction(action({ cmd: "use", s: "s1", c: "c1" }), deps);
    expect(deps.handleCommands).toHaveBeenCalledTimes(1);
    expect(deps.handleApprovals).not.toHaveBeenCalled();
  });

  test("向导卡 value 路由到 commands", () => {
    const deps = makeDeps();
    routeCardAction(action({ wizard: "perm", v: "edit" }), deps);
    expect(deps.handleCommands).toHaveBeenCalledTimes(1);
  });

  test("表单提交（有 form_value / setup.form）路由到 commands", () => {
    const byFormValue = makeDeps();
    routeCardAction(action(undefined, { perm: "edit" }), byFormValue);
    expect(byFormValue.handleCommands).toHaveBeenCalledTimes(1);

    const byCmd = makeDeps();
    routeCardAction(action({ cmd: "setup.form" }), byCmd);
    expect(byCmd.handleCommands).toHaveBeenCalledTimes(1);
  });

  test("审批卡 value（无 cmd/wizard/f/k）路由到 approvals", () => {
    const deps = makeDeps();
    routeCardAction(action({ t: "approve", d: "once" }), deps);
    expect(deps.handleApprovals).toHaveBeenCalledTimes(1);
    expect(deps.handleCommands).not.toHaveBeenCalled();
  });
});
