import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  markExactGateway,
  releaseProcessGuard,
  resetExactGateway,
  trackGatewayLocationSeen,
  waitForExactGateway,
} from "../src/lifecycle.js";

/**
 * gatewayLocation 兜底告警（issue：配置匹配失败时静默禁用整个网关）。
 * 用假定时器验证「延迟聚合告警 + 命中不误报 + 进程内仅一次」。
 */
describe("trackGatewayLocationSeen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("全部未命中 → 延迟后 warn 一次，列出已见 location，并结算 onSettled", () => {
    const warn = vi.fn();
    const settle1 = vi.fn();
    const settle2 = vi.fn();
    trackGatewayLocationSeen({ here: "/a", expected: "/t1", matched: false, warn, onSettled: settle1 });
    trackGatewayLocationSeen({ here: "/b", expected: "/t1", matched: false, warn, onSettled: settle2 });

    expect(warn).not.toHaveBeenCalled();
    expect(settle1).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain("/t1");
    expect(message).toContain("/a");
    expect(message).toContain("/b");
    expect(settle1).toHaveBeenCalledTimes(1);
    expect(settle2).toHaveBeenCalledTimes(1);
  });

  test("有命中 → 不 warn，未命中实例的 onSettled 仍被结算", () => {
    const warn = vi.fn();
    const settleNoMatch = vi.fn();
    trackGatewayLocationSeen({ here: "/a", expected: "/t2", matched: false, warn, onSettled: settleNoMatch });
    trackGatewayLocationSeen({ here: "/t2/sub", expected: "/t2", matched: true, warn });

    vi.advanceTimersByTime(5000);

    expect(warn).not.toHaveBeenCalled();
    expect(settleNoMatch).toHaveBeenCalledTimes(1);
  });

  test("命中之后到达的未命中实例：不误报，且立即结算其 onSettled", () => {
    const warn = vi.fn();
    trackGatewayLocationSeen({ here: "/t3/src", expected: "/t3", matched: true, warn });

    const settleLate = vi.fn();
    trackGatewayLocationSeen({ here: "/elsewhere", expected: "/t3", matched: false, warn, onSettled: settleLate });
    vi.advanceTimersByTime(5000);

    expect(warn).not.toHaveBeenCalled();
    expect(settleLate).toHaveBeenCalledTimes(1);
  });

  test("告警后到达的未命中实例：不再重复告警", () => {
    const warn = vi.fn();
    trackGatewayLocationSeen({ here: "/a", expected: "/t4", matched: false, warn });
    vi.advanceTimersByTime(2000);
    expect(warn).toHaveBeenCalledTimes(1);

    const settleLater = vi.fn();
    trackGatewayLocationSeen({ here: "/b", expected: "/t4", matched: false, warn, onSettled: settleLater });
    vi.advanceTimersByTime(5000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(settleLater).toHaveBeenCalledTimes(1);
  });

  test("目标变化时重置：旧目标的未命中不会污染新目标", () => {
    const warnOld = vi.fn();
    trackGatewayLocationSeen({ here: "/a", expected: "/old-target", matched: false, warn: warnOld });
    const warnNew = vi.fn();
    trackGatewayLocationSeen({ here: "/b", expected: "/new-target", matched: false, warn: warnNew });

    vi.advanceTimersByTime(2000);

    expect(warnOld).not.toHaveBeenCalled();
    expect(warnNew).toHaveBeenCalledTimes(1);
    expect(warnNew.mock.calls[0]![0] as string).toContain("/new-target");
  });

  test("窗口内连续到达未命中：定时器重置，仅告警一次且包含全部已见", () => {
    const warn = vi.fn();
    trackGatewayLocationSeen({ here: "/a", expected: "/t5", matched: false, warn });
    vi.advanceTimersByTime(1000);
    trackGatewayLocationSeen({ here: "/b", expected: "/t5", matched: false, warn });
    vi.advanceTimersByTime(1000);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain("/a");
    expect(message).toContain("/b");
  });
});

describe("网关精确匹配选举（子目录仅兜底）", () => {
  afterEach(() => {
    resetExactGateway();
    vi.useRealTimers();
  });

  test("精确匹配就任 → 等待中的子目录候选立即让位", async () => {
    const pending = waitForExactGateway(5000);
    markExactGateway();
    expect(await pending).toBe(true);
  });

  test("宽限窗口内无精确匹配 → 子目录兜底", async () => {
    vi.useFakeTimers();
    const pending = waitForExactGateway(1000);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await pending).toBe(false);
  });

  test("精确匹配已就任 → 后续候选立即让位", async () => {
    markExactGateway();
    expect(await waitForExactGateway(1000)).toBe(true);
  });

  test("graceMs=0 → 不等待，直接兜底", async () => {
    expect(await waitForExactGateway(0)).toBe(false);
  });

  test("releaseProcessGuard 重置选举（网关停止后子目录可再接管）", async () => {
    vi.useFakeTimers();
    markExactGateway();
    releaseProcessGuard();
    const pending = waitForExactGateway(1000);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await pending).toBe(false);
  });
});
