import { describe, expect, test } from "vitest";
import { decideDelivery, ExecutionTracker } from "../src/feishu/delivery.js";

describe("decideDelivery", () => {
  test("空闲 → steer；运行中 → queue", () => {
    expect(decideDelivery(false)).toBe("steer");
    expect(decideDelivery(true)).toBe("queue");
  });
});

describe("ExecutionTracker", () => {
  test("started 置位、succeeded/failed 清除", () => {
    const tracker = new ExecutionTracker();
    expect(tracker.isRunning("ses_1")).toBe(false);
    tracker.markStarted("ses_1");
    expect(tracker.isRunning("ses_1")).toBe(true);
    tracker.markEnded("ses_1");
    expect(tracker.isRunning("ses_1")).toBe(false);
  });

  test("多会话互不干扰", () => {
    const tracker = new ExecutionTracker();
    tracker.markStarted("ses_1");
    expect(tracker.isRunning("ses_1")).toBe(true);
    expect(tracker.isRunning("ses_2")).toBe(false);
    tracker.markStarted("ses_2");
    tracker.markEnded("ses_1");
    expect(tracker.isRunning("ses_1")).toBe(false);
    expect(tracker.isRunning("ses_2")).toBe(true);
  });

  test("touch 刷新活动时间，未运行的会话不会被 touch 置位", () => {
    const tracker = new ExecutionTracker();
    tracker.touch("ses_1");
    expect(tracker.isRunning("ses_1")).toBe(false);
    tracker.markStarted("ses_1", 1000);
    tracker.touch("ses_1", 2000);
    // 活动时间被刷新到 2000：阈值 1500 在 t=3000 时差 1000 < 1500，不判陈旧
    expect(tracker.stale(1500, 3000)).toEqual([]);
  });

  test("stale：超过阈值无活动的执行被清理并返回", () => {
    const tracker = new ExecutionTracker();
    tracker.markStarted("ses_1", 1000);
    tracker.markStarted("ses_2", 2500);
    const stale = tracker.stale(1000, 3000);
    expect(stale).toEqual(["ses_1"]);
    expect(tracker.isRunning("ses_1")).toBe(false);
    expect(tracker.isRunning("ses_2")).toBe(true);
  });
});
