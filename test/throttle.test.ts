import { describe, expect, test } from "vitest";
import { createThrottler } from "../src/utils/throttle.js";

/** 可手动控制时钟与定时器的节流器测试床。 */
function harness(intervalMs: number) {
  let now = 0;
  let scheduled: (() => void) | undefined;
  let fires = 0;
  const throttler = createThrottler({
    intervalMs,
    onFire: () => {
      fires += 1;
    },
    now: () => now,
    setTimer: (fn) => {
      scheduled = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      scheduled = undefined;
    },
  });
  return {
    throttler,
    advance: (ms: number) => {
      now += ms;
    },
    runTimer: () => {
      const fn = scheduled;
      scheduled = undefined;
      fn?.();
    },
    get fires() {
      return fires;
    },
    get hasTimer() {
      return scheduled !== undefined;
    },
  };
}

describe("createThrottler", () => {
  test("首次调用立即触发", () => {
    const h = harness(400);
    expect(h.throttler.schedule()).toBe(true);
    expect(h.fires).toBe(1);
  });

  test("间隔内合并为一次尾触发", () => {
    const h = harness(400);
    h.throttler.schedule();
    h.advance(100);
    expect(h.throttler.schedule()).toBe(false);
    expect(h.throttler.schedule()).toBe(false);
    expect(h.fires).toBe(1);
    expect(h.hasTimer).toBe(true);

    h.advance(300);
    h.runTimer();
    expect(h.fires).toBe(2);
  });

  test("超过间隔后再次立即触发", () => {
    const h = harness(400);
    h.throttler.schedule();
    h.advance(500);
    expect(h.throttler.schedule()).toBe(true);
    expect(h.fires).toBe(2);
  });

  test("flush 立即执行挂起调用；cancel 丢弃", () => {
    const h = harness(400);
    h.throttler.schedule();
    h.advance(50);
    h.throttler.schedule();
    h.throttler.flush();
    expect(h.fires).toBe(2);
    expect(h.throttler.pending).toBe(false);

    h.advance(50);
    h.throttler.schedule();
    h.throttler.cancel();
    h.runTimer();
    expect(h.fires).toBe(2);
  });
});
