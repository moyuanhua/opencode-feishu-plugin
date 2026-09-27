import { describe, expect, test, vi } from "vitest";
import { createTopicStatusController } from "../src/runtime/topic-status.js";
import { createLogger } from "../src/logger.js";
import type { SessionRootCardBase } from "../src/types.js";

const log = createLogger({ level: "error", sink: () => undefined });
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const BASE: SessionRootCardBase = {
  style: "resumed",
  sessionID: "s1",
  title: "我的项目",
  summary: "1. 目标",
  summaryLabel: "会话摘要",
};

function deps(over: Partial<Parameters<typeof createTopicStatusController>[0]> = {}) {
  const patched: Array<{ messageId: string; card: object }> = [];
  const controller = createTopicStatusController({
    log,
    enabled: true,
    statusInTitle: false,
    throttleMs: 0,
    getRoot: async (sessionID) => (sessionID === "s1" ? { base: BASE, messageId: "om_1" } : undefined),
    patch: async (messageId, card) => {
      patched.push({ messageId, card });
      return { ok: true };
    },
    ...over,
  });
  return { controller, patched };
}

describe("createTopicStatusController", () => {
  test("档位变化才 patch：同状态重复事件不 patch", async () => {
    const { controller, patched } = deps();
    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(1);
    expect(patched[0]!.messageId).toBe("om_1");
    const text = JSON.stringify(patched[0]!.card);
    expect(text).toContain("🧠 运行中");
    expect(text).toContain("1. 目标"); // 摘要保留

    // 同档位重复事件（再次 started）→ 不再 patch
    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(1);

    // 档位变化 → patch
    controller.onEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(2);
    expect(JSON.stringify(patched[1]!.card)).toContain("✅ 完成");
  });

  test("无 rootCard / 无 replyMessageId（非飞书会话）→ 跳过，不 patch", async () => {
    const { controller, patched } = deps();
    controller.onEvent({ type: "session.execution.started", data: { sessionID: "ses-other" } });
    await flush();
    expect(patched).toHaveLength(0);
  });

  test("topicStatus=false 完全不刷新", async () => {
    const { controller, patched } = deps({ enabled: false });
    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(0);
    expect(controller.statusOf("s1")).toBeUndefined();
  });

  test("节流：最小间隔内不重复 patch，到点后补发", async () => {
    let t = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const { controller, patched } = deps({
      throttleMs: 1000,
      now: () => t,
      setTimer: ((fn: () => void, ms: number) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as Parameters<typeof createTopicStatusController>[0]["setTimer"],
      clearTimer: ((timer: unknown) => {
        const index = timers.indexOf(timer as { fn: () => void; ms: number });
        if (index >= 0) timers.splice(index, 1);
      }) as unknown as Parameters<typeof createTopicStatusController>[0]["clearTimer"],
    });

    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(1); // leading

    t = 100; // 间隔内
    controller.onEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(1); // trailing 尚未触发
    expect(timers).toHaveLength(1);

    // 触发 trailing
    timers[0]!.fn();
    await flush();
    expect(patched).toHaveLength(2);
    expect(JSON.stringify(patched[1]!.card)).toContain("✅ 完成");
  });

  test("patch 失败只 warn；连续失败达阈值后停止该会话刷新，不抛", async () => {
    const warn = vi.fn();
    const failingLog = { ...log, warn };
    const { controller, patched } = deps({
      log: failingLog as typeof log,
      patch: async (messageId, card) => {
        patched.push({ messageId, card });
        return { ok: false, error: "message deleted" };
      },
    });

    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } }); // 1
    await flush();
    controller.onEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } }); // 2
    await flush();
    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } }); // 3 → disable
    await flush();
    expect(patched).toHaveLength(3);
    expect(warn).toHaveBeenCalled();

    // 已降级：后续档位变化不再尝试
    controller.onEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(3);
  });

  test("markTerminal 显式失败态触发刷新", async () => {
    const { controller, patched } = deps();
    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } });
    await flush();
    controller.markTerminal("s1", "failed");
    await flush();
    expect(patched).toHaveLength(2);
    expect(JSON.stringify(patched[1]!.card)).toContain("🔴 失败");
  });

  test("dispose 后不再刷新", async () => {
    const { controller, patched } = deps();
    controller.dispose();
    controller.onEvent({ type: "session.execution.started", data: { sessionID: "s1" } });
    await flush();
    expect(patched).toHaveLength(0);
  });
});
