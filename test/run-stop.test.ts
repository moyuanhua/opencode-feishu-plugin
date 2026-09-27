import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { ReplayGuard, signStop, verifyStop } from "../src/security/token.js";
import type { CardAction } from "../src/types.js";
import { buildStopValue, parseStopActionValue, StopController } from "../src/feishu/run-stop.js";

const SECRET = "test-secret";
const log = createLogger({ level: "error", sink: () => undefined });

function tokenFor(sessionID: string, ttlMs = 60_000, now = Date.now()): string {
  return signStop({ sessionID, ttlMs, now }, SECRET);
}

interface SetupOptions {
  readonly allowed?: boolean;
  readonly running?: boolean;
  readonly now?: number;
}

function setup(opts: SetupOptions = {}) {
  const interrupt = vi.fn(async () => ({ ok: true }));
  const controller = new StopController({
    log,
    isAllowed: () => opts.allowed ?? true,
    verify: (token, sessionID) => verifyStop(token, SECRET, { expectSessionID: sessionID, ...(opts.now ? { now: opts.now } : {}) }),
    replay: new ReplayGuard(60_000),
    sign: (sessionID) => tokenFor(sessionID),
    isRunning: () => opts.running ?? true,
    interrupt,
  });
  return { controller, interrupt };
}

function action(value: unknown, operatorOpenId = "ou_1"): CardAction {
  return { rawValue: value, messageId: "om_card", chatId: "oc_1", operatorOpenId };
}

describe("parseStopActionValue / buildStopValue", () => {
  test("合法 value 解析", () => {
    expect(parseStopActionValue({ cmd: "stop", sid: "ses_1", t: "tok" })).toEqual({
      cmd: "stop",
      sid: "ses_1",
      t: "tok",
    });
  });

  test("非本类 / 缺字段返回 undefined", () => {
    expect(parseStopActionValue({ cmd: "use", s: "x" })).toBeUndefined();
    expect(parseStopActionValue({ cmd: "stop", sid: "", t: "tok" })).toBeUndefined();
    expect(parseStopActionValue({ cmd: "stop", sid: "ses_1", t: "" })).toBeUndefined();
    expect(parseStopActionValue("stop")).toBeUndefined();
    expect(parseStopActionValue(null)).toBeUndefined();
  });

  test("buildStopValue 带上 token", () => {
    expect(buildStopValue("ses_1", "tok")).toEqual({ cmd: "stop", sid: "ses_1", t: "tok" });
  });
});

describe("StopController.handleCardAction", () => {
  test("合法点击：白名单 + 验签通过 → 后台中断 + success toast", async () => {
    const { controller, interrupt } = setup();
    const res = controller.handleCardAction(action({ cmd: "stop", sid: "ses_1", t: tokenFor("ses_1") })) as {
      toast: { type: string; content: string };
    };
    expect(res.toast.type).toBe("success");
    expect(res.toast.content).toContain("正在停止");
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
    expect(interrupt).toHaveBeenCalledWith("ses_1", "强制停止");
  });

  test("伪造 token 拒绝，不触发中断", () => {
    const { controller, interrupt } = setup();
    const res = controller.handleCardAction(
      action({ cmd: "stop", sid: "ses_1", t: `${tokenFor("ses_1")}x` }),
    ) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
    expect(res.toast.content).toContain("操作凭证无效");
    expect(interrupt).not.toHaveBeenCalled();
  });

  test("非白名单 operator 拒绝（即使 token 合法）", () => {
    const { controller, interrupt } = setup({ allowed: false });
    const res = controller.handleCardAction(
      action({ cmd: "stop", sid: "ses_1", t: tokenFor("ses_1") }, "ou_evil"),
    ) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
    expect(res.toast.content).toContain("无操作权限");
    expect(interrupt).not.toHaveBeenCalled();
  });

  test("sessionID 不匹配拒绝", () => {
    const { controller, interrupt } = setup();
    const res = controller.handleCardAction(
      action({ cmd: "stop", sid: "ses_1", t: tokenFor("ses_other") }),
    ) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
    expect(res.toast.content).toContain("session-mismatch");
    expect(interrupt).not.toHaveBeenCalled();
  });

  test("重复点击只回 toast，不重复中断", async () => {
    const { controller, interrupt } = setup();
    const value = { cmd: "stop", sid: "ses_1", t: tokenFor("ses_1") };
    const first = controller.handleCardAction(action(value)) as { toast: { type: string } };
    const second = controller.handleCardAction(action(value)) as { toast: { type: string; content: string } };
    expect(first.toast.type).toBe("success");
    expect(second.toast.type).toBe("warning");
    expect(second.toast.content).toContain("已处理");
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1));
  });

  test("任务已结束：只回 info toast，不中断", () => {
    const { controller, interrupt } = setup({ running: false });
    const res = controller.handleCardAction(
      action({ cmd: "stop", sid: "ses_1", t: tokenFor("ses_1") }),
    ) as { toast: { type: string; content: string } };
    expect(res.toast).toEqual({ type: "info", content: "该任务已结束" });
    expect(interrupt).not.toHaveBeenCalled();
  });

  test("token 过期但任务已结束：同样只回「已结束」", () => {
    const now = 1_700_000_000_000;
    const { controller } = setup({ running: false, now: now + 10 * 60_000 });
    const res = controller.handleCardAction(
      action({ cmd: "stop", sid: "ses_1", t: tokenFor("ses_1", 1000, now) }),
    ) as { toast: { type: string; content: string } };
    expect(res.toast).toEqual({ type: "info", content: "该任务已结束" });
  });

  test("无法识别的 value", () => {
    const { controller } = setup();
    const res = controller.handleCardAction(action({ cmd: "nope" })) as { toast: { type: string } };
    expect(res.toast.type).toBe("error");
  });
});
