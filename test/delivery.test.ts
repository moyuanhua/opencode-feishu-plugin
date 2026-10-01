import { describe, expect, test } from "vitest";
import { decideDelivery, ExecutionTracker, SessionParentLinks } from "../src/feishu/delivery.js";

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

  test("stale：shouldSkip 的会话视为合法等待——不返回、不移除追踪（issue #1）", () => {
    const tracker = new ExecutionTracker();
    tracker.markStarted("ses_form", 1000);
    tracker.markStarted("ses_dead", 1000);
    const stale = tracker.stale(1000, 3000, (id) => id === "ses_form");
    expect(stale).toEqual(["ses_dead"]);
    // 待答表单的会话保留在运行态（后续排队判定仍为 queue）
    expect(tracker.isRunning("ses_form")).toBe(true);
    expect(tracker.isRunning("ses_dead")).toBe(false);
  });
});

describe("SessionParentLinks（子会话→父会话链路）", () => {
  test("walk 沿父链逐级回调（含自身，防环）", () => {
    const links = new SessionParentLinks();
    links.remember("child", "parent");
    links.remember("parent", "root");
    const seen: string[] = [];
    links.walk("child", (id) => seen.push(id));
    expect(seen).toEqual(["child", "parent", "root"]);
  });

  test("无父链接/重复对（环）不会死循环", () => {
    const links = new SessionParentLinks();
    expect(links.parentOf("x")).toBeUndefined();
    const seen: string[] = [];
    links.walk("x", (id) => seen.push(id));
    expect(seen).toEqual(["x"]);
    // 人为制造环：a→b→a
    links.remember("a", "b");
    links.remember("b", "a");
    const loop: string[] = [];
    links.walk("a", (id) => loop.push(id));
    expect(loop).toEqual(["a", "b"]);
  });

  test("remember(id, undefined) 清理旧链接；超上限淘汰最旧", () => {
    const links = new SessionParentLinks(2);
    links.remember("c1", "p");
    links.remember("c2", "p");
    links.remember("c3", "p");
    // 上限 2：最旧的 c1 被淘汰
    expect(links.parentOf("c1")).toBeUndefined();
    expect(links.parentOf("c3")).toBe("p");
    links.remember("c3", undefined);
    expect(links.parentOf("c3")).toBeUndefined();
  });
});
