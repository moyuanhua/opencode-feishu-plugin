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
});
