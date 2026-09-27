import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { runWatchdogTick } from "../src/feishu/watchdog.js";

const log = createLogger({ level: "error", sink: () => undefined });

describe("runWatchdogTick", () => {
  test("陈旧执行与排队超时都会触发恢复（不再只是放开排队）", () => {
    const recover = vi.fn(async () => ({ ok: true }));
    const result = runWatchdogTick({
      log,
      staleExecutionMs: 5 * 60_000,
      staleExecutions: () => ["ses_stale"],
      staleQueued: () => ["ses_queued"],
      recover,
    });

    expect(result).toEqual({ executions: ["ses_stale"], queued: ["ses_queued"] });
    expect(recover).toHaveBeenCalledWith("ses_stale", "长时间无进展");
    expect(recover).toHaveBeenCalledWith("ses_queued", "排队超时");
    expect(recover).toHaveBeenCalledTimes(2);
  });

  test("无陈旧会话时不触发", () => {
    const recover = vi.fn(async () => ({ ok: true }));
    runWatchdogTick({
      log,
      staleExecutionMs: 60_000,
      staleExecutions: () => [],
      staleQueued: () => [],
      recover,
    });
    expect(recover).not.toHaveBeenCalled();
  });

  test("同一会话同时命中两类时只按「陈旧执行」处理一次", () => {
    const recover = vi.fn(async () => ({ ok: true }));
    const result = runWatchdogTick({
      log,
      staleExecutionMs: 60_000,
      staleExecutions: () => ["ses_both"],
      staleQueued: () => ["ses_both"],
      recover,
    });
    expect(result.queued).toEqual([]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith("ses_both", "长时间无进展");
  });

  test("recover 抛错不冒泡到 tick", async () => {
    const recover = vi.fn(async () => {
      throw new Error("nope");
    });
    expect(() =>
      runWatchdogTick({
        log,
        staleExecutionMs: 60_000,
        staleExecutions: () => ["ses_1"],
        staleQueued: () => [],
        recover,
      }),
    ).not.toThrow();
    // 让 catch 分支执行，确认不产生 unhandled rejection。
    await Promise.resolve();
  });
});
