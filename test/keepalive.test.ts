import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ensureGatewayWatchdog,
  resetFastReviveForTest,
  resetGatewayWatchdogForTest,
  scheduleFastRevive,
  touchLocationOverHttp,
} from "../src/session/keepalive.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("touchLocationOverHttp", () => {
  test("只发 GET /api/plugin（query+头双重绑定），不再创建/删除探针会话", async () => {
    const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method: init?.method ?? "GET",
        url,
        headers,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return jsonResponse({ data: [{ id: "plugin-1" }] });
    }) as unknown as typeof fetch;

    const ok = await touchLocationOverHttp("/home/ubuntu", {
      log,
      discover: async () => ({ url: "http://127.0.0.1:3000", password: "pw" }),
      fetchImpl,
    });

    expect(ok).toBe(true);
    // 唯一一次请求：/api/plugin + location 绑定（query 参数 + x-opencode-directory 头，实测均有效）
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:3000/api/plugin?location%5Bdirectory%5D=%2Fhome%2Fubuntu",
    );
    expect(calls[0]!.headers["x-opencode-directory"]).toBe(encodeURIComponent("/home/ubuntu"));
    expect(calls[0]!.headers.authorization).toContain("Basic ");
    // 回归保护：保活绝不能创建会话（旧实现会 POST /api/session 再 DELETE，导致桌面端
    // 抢读已删除的会话 → 「请求失败 / Session not found」弹窗）。
    expect(calls.some((c) => c.url.includes("/api/session"))).toBe(false);
  });

  test("位置探针失败 → false（不抛错，也不再有任何辅助通道）", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;

    const ok = await touchLocationOverHttp("/home/ubuntu", {
      log,
      discover: async () => ({ url: "http://127.0.0.1:3000" }),
      fetchImpl,
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.startsWith("GET")).toBe(true);
  });

  test("无 directory：不带 location 绑定（查询串/头均为空）", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return jsonResponse({ data: [] });
    }) as unknown as typeof fetch;

    const ok = await touchLocationOverHttp("", {
      log,
      discover: async () => ({ url: "http://127.0.0.1:3000" }),
      fetchImpl,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3000/api/plugin");
    expect(calls[0]!.headers["x-opencode-directory"]).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
  });

  test("请求失败 → false（不抛错）", async () => {
    const ok = await touchLocationOverHttp("/home/ubuntu", {
      log,
      discover: async () => ({ url: "http://127.0.0.1:3000" }),
      fetchImpl: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    });
    expect(ok).toBe(false);
  });

  test("未发现本机服务 → false（不抛错）", async () => {
    const ok = await touchLocationOverHttp("/home/ubuntu", { log, discover: async () => undefined });
    expect(ok).toBe(false);
  });
});

describe("ensureGatewayWatchdog（进程级）", () => {
  afterEach(() => {
    resetGatewayWatchdogForTest();
    vi.useRealTimers();
  });

  test("每进程只启一个定时器；重复登记返回 false 且不重复探测", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => true);
    const first = ensureGatewayWatchdog({ log, directory: "/gw", intervalMs: 1000, immediateDelayMs: 100, probe });
    const second = ensureGatewayWatchdog({ log, directory: "/gw", intervalMs: 1000, immediateDelayMs: 100, probe });
    expect(first).toBe(true);
    expect(second).toBe(false);
    await vi.advanceTimersByTimeAsync(1200);
    // 立即探测 + 1 个周期刻度，且只来自同一个定时器。
    expect(probe.mock.calls.length).toBeLessThanOrEqual(2);
    expect(probe).toHaveBeenCalledWith("/gw");
  });

  test("网关实例 authoritative → 更新目标目录", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => true);
    ensureGatewayWatchdog({ log, directory: "/gw-parent", intervalMs: 1000, immediateDelayMs: 0, probe });
    const started = ensureGatewayWatchdog({
      log,
      directory: "/gw-parent/exact",
      intervalMs: 1000,
      immediateDelayMs: 0,
      authoritative: true,
      probe,
    });
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1200);
    expect(probe).toHaveBeenCalledWith("/gw-parent/exact");
  });

  test("立即探测在短延迟后触发（服务重启后尽快唤起）", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => true);
    ensureGatewayWatchdog({ log, directory: "/gw", intervalMs: 60_000, immediateDelayMs: 50, probe });
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("热重载：重复登记刷新探测实现（不再持有旧实例闭包）", async () => {
    vi.useFakeTimers();
    const oldProbe = vi.fn(async () => true);
    ensureGatewayWatchdog({ log, directory: "/gw", intervalMs: 1000, immediateDelayMs: 0, probe: oldProbe });
    const newProbe = vi.fn(async () => true);
    ensureGatewayWatchdog({ log, directory: "/gw", intervalMs: 1000, immediateDelayMs: 0, probe: newProbe });
    await vi.advanceTimersByTimeAsync(1200);
    expect(newProbe).toHaveBeenCalled();
    expect(oldProbe).not.toHaveBeenCalled();
  });

  test("独立日志 sink：只创建一次、不被后续登记替换、定时器里持续写入", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const closes: number[] = [];
    let sinks = 0;
    const makeSink = (): { sink: (line: string) => void; close: () => void } => {
      sinks += 1;
      return { sink: (line) => lines.push(line), close: () => closes.push(1) };
    };
    const fetchImpl = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch;
    const started = ensureGatewayWatchdog({
      log,
      directory: "/gw",
      intervalMs: 1000,
      immediateDelayMs: 10,
      logFile: "/tmp/watchdog-test.log",
      logLevel: "debug",
      makeSink,
      touchDeps: { discover: async () => ({ url: "http://127.0.0.1:3000" }), fetchImpl },
    });
    expect(started).toBe(true);
    expect(sinks).toBe(1);

    // 重复登记（模拟热重载）：不重建 sink、不关闭、沿用注入依赖
    ensureGatewayWatchdog({
      log,
      directory: "/gw",
      intervalMs: 1000,
      logFile: "/tmp/watchdog-test.log",
      makeSink,
    });
    expect(sinks).toBe(1);
    expect(closes).toHaveLength(0);

    // 定时器触发：默认探针把「启动」与「心跳」写进独立 sink（实例 logger 不参与）
    await vi.advanceTimersByTimeAsync(1200);
    const joined = lines.join("\n");
    expect(joined).toContain("网关看门狗已启动");
    expect(joined).toContain("保活心跳已发送");

    // reset 才关闭独立 sink
    resetGatewayWatchdogForTest();
    expect(closes).toHaveLength(1);
  });

  test("探测失败不抛错", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => {
      throw new Error("boom");
    });
    ensureGatewayWatchdog({ log, directory: "/gw", intervalMs: 1000, immediateDelayMs: 10, probe });
    await vi.advanceTimersByTimeAsync(1200);
    expect(probe).toHaveBeenCalled();
  });
});

describe("ensureGatewayWatchdog 向后兼容", () => {
  afterEach(() => {
    resetGatewayWatchdogForTest();
    vi.useRealTimers();
  });

  test("旧版本遗留槽位（无 state）→ 清理重建，不抛错", async () => {
    vi.useFakeTimers();
    // 模拟 v0.2.1/0.2.2 遗留的槽位结构（只有 target/timer/initial）。
    const legacyTimer = setInterval(() => undefined, 1000);
    (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("opencode-feishu-v2/gateway-watchdog")] = {
      target: "/old",
      timer: legacyTimer,
    };
    const probe = vi.fn(async () => true);
    expect(() =>
      ensureGatewayWatchdog({ log, directory: "/gw", intervalMs: 1000, immediateDelayMs: 0, probe }),
    ).not.toThrow();
    await vi.advanceTimersByTimeAsync(1200);
    expect(probe).toHaveBeenCalledWith("/gw");
  });
});

describe("scheduleFastRevive（被驱逐后秒级复活）", () => {
  afterEach(() => {
    resetFastReviveForTest();
    vi.useRealTimers();
  });

  test("按延迟序列多次探测（默认 1s/5s/20s）", async () => {
    vi.useFakeTimers();
    const touch = vi.fn(async () => true);
    scheduleFastRevive({ log, directory: "/gw", touch });
    await vi.advanceTimersByTimeAsync(1200);
    expect(touch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(touch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    expect(touch).toHaveBeenCalledTimes(3);
    expect(touch).toHaveBeenCalledWith("/gw");
  });

  test("幂等：已有计划在跑时不重复安排", async () => {
    vi.useFakeTimers();
    const touch = vi.fn(async () => true);
    scheduleFastRevive({ log, directory: "/gw", touch });
    scheduleFastRevive({ log, directory: "/gw", touch });
    await vi.advanceTimersByTimeAsync(1200);
    expect(touch).toHaveBeenCalledTimes(1);
  });

  test("计划结束后可再次安排（下一轮驱逐）", async () => {
    vi.useFakeTimers();
    const touch = vi.fn(async () => true);
    scheduleFastRevive({ log, directory: "/gw", touch, delaysMs: [100] });
    await vi.advanceTimersByTimeAsync(6000); // 100ms 尝试 + 5s 清理
    const touch2 = vi.fn(async () => true);
    scheduleFastRevive({ log, directory: "/gw", touch: touch2, delaysMs: [100] });
    await vi.advanceTimersByTimeAsync(200);
    expect(touch2).toHaveBeenCalledTimes(1);
  });

  test("探测失败不抛错", async () => {
    vi.useFakeTimers();
    const touch = vi.fn(async () => {
      throw new Error("boom");
    });
    scheduleFastRevive({ log, directory: "/gw", touch, delaysMs: [50] });
    await vi.advanceTimersByTimeAsync(100);
    expect(touch).toHaveBeenCalled();
  });
});
