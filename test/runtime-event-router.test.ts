import { describe, expect, test, vi } from "vitest";
import { routeEvent, extractErrorText, contentToText, type EventRouterDeps } from "../src/runtime/event-router.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });

function makeDeps(over: Partial<EventRouterDeps> = {}): EventRouterDeps {
  return {
    log,
    touch: vi.fn(),
    markStarted: vi.fn(),
    markEnded: vi.fn(),
    applyRun: vi.fn(),
    onPermissionAsked: vi.fn(async () => undefined),
    onPermissionReplied: vi.fn(),
    onFormCreated: vi.fn(async () => undefined),
    onFormReplied: vi.fn(),
    onFormCancelled: vi.fn(),
    notifyFailure: vi.fn(async () => undefined),
    ...over,
  };
}

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe("routeEvent", () => {
  test("session.text.delta：刷新活动时间 + 应用 run 事件", async () => {
    const deps = makeDeps();
    await routeEvent({ type: "session.text.delta", data: { sessionID: "s1", delta: "hi" } }, deps);
    expect(deps.touch).toHaveBeenCalledWith("s1");
    expect(deps.applyRun).toHaveBeenCalledWith("s1", { type: "text.delta", delta: "hi" });
  });

  test("session.execution.failed：markEnded + 失败 run 事件 + 失败通知", async () => {
    const deps = makeDeps();
    await routeEvent(
      { type: "session.execution.failed", data: { sessionID: "s1", error: { message: "boom" } } },
      deps,
    );
    expect(deps.markEnded).toHaveBeenCalledWith("s1");
    expect(deps.applyRun).toHaveBeenCalledWith("s1", { type: "execution.failed", error: "boom" });
    expect(deps.notifyFailure).toHaveBeenCalledWith("s1", { message: "boom" });
  });

  test("session.execution.interrupted：markEnded + 收尾为中断失败态", async () => {
    const deps = makeDeps();
    await routeEvent(
      { type: "session.execution.interrupted", data: { sessionID: "s1", reason: "/stop" } },
      deps,
    );
    expect(deps.markEnded).toHaveBeenCalledWith("s1");
    expect(deps.applyRun).toHaveBeenCalledWith("s1", {
      type: "execution.failed",
      error: "已中断（/stop）",
    });
  });

  test("session.status：busy 起执行态 / idle 收尾", async () => {
    const busy = makeDeps();
    await routeEvent({ type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } }, busy);
    expect(busy.markStarted).toHaveBeenCalledWith("s1");
    expect(busy.applyRun).not.toHaveBeenCalled();

    const idle = makeDeps();
    await routeEvent({ type: "session.status", data: { sessionID: "s1", status: { type: "idle" } } }, idle);
    expect(idle.markEnded).toHaveBeenCalledWith("s1");
    expect(idle.applyRun).toHaveBeenCalledWith("s1", { type: "execution.succeeded" });
  });

  test("permission.asked / form.created fire-and-forget（不阻塞事件流）", async () => {
    const deps = makeDeps();
    await routeEvent({ type: "permission.asked", data: { id: "p1", sessionID: "s1" } }, deps);
    await routeEvent({ type: "form.created", data: { sessionID: "s1" } }, deps);
    await flush();
    expect(deps.onPermissionAsked).toHaveBeenCalledTimes(1);
    expect(deps.onFormCreated).toHaveBeenCalledTimes(1);
  });

  test("未知事件：只刷新活动时间，不派发", async () => {
    const deps = makeDeps();
    await routeEvent({ type: "no.such.event", data: { sessionID: "s1" } }, deps);
    expect(deps.touch).toHaveBeenCalledWith("s1");
    expect(deps.applyRun).not.toHaveBeenCalled();
    expect(deps.markStarted).not.toHaveBeenCalled();
    expect(deps.markEnded).not.toHaveBeenCalled();
  });

  test("onTopicStatus：任意事件都先下发话题状态控制器（含被 switch 忽略的事件）", async () => {
    const onTopicStatus = vi.fn();
    const deps = makeDeps({ onTopicStatus });
    await routeEvent({ type: "session.inbox.enqueued", data: { sessionID: "s1", inboxID: "i1" } }, deps);
    await routeEvent({ type: "no.such.event", data: { sessionID: "s1" } }, deps);
    expect(onTopicStatus).toHaveBeenCalledTimes(2);
    expect(onTopicStatus).toHaveBeenNthCalledWith(1, {
      type: "session.inbox.enqueued",
      data: { sessionID: "s1", inboxID: "i1" },
    });
  });
});

describe("extractErrorText / contentToText", () => {
  test("兼容字符串 / 对象 / 文本数组", () => {
    expect(extractErrorText("x")).toBe("x");
    expect(extractErrorText({ message: "bad" })).toBe("bad");
    expect(extractErrorText([{ type: "text", text: "a" }, { text: "b" }])).toBe("a\nb");
    expect(extractErrorText(undefined)).toBe("unknown");
    expect(contentToText([{ type: "text", text: "a" }, "b", ""])).toBe("a\nb");
  });
});
