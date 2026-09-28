import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ensureGatewayWatchdog,
  resetGatewayWatchdogForTest,
  startKeepalive,
  touchLocationOverHttp,
} from "../src/session/keepalive.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("touchLocationOverHttp", () => {
  test("双通道：会话级 GET（LayerMap）+ 探针会话（LocationActivity）", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.includes("/api/session?") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ data: [{ id: "ses_existing" }], cursor: {} });
      }
      if (init?.method === "POST") return jsonResponse({ data: { id: "ses_probe" } });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({ data: { id: "ses_existing" } });
    }) as unknown as typeof fetch;

    const ok = await touchLocationOverHttp("/home/ubuntu", {
      log,
      discover: async () => ({ url: "http://127.0.0.1:3000", password: "pw" }),
      fetchImpl,
    });

    expect(ok).toBe(true);
    // ① 列出该 location 的会话（带 directory 过滤）
    expect(calls[0]!.url).toContain("/api/session?");
    expect(calls[0]!.url).toContain("directory=%2Fhome%2Fubuntu");
    // ② 会话级 GET（LayerMap.get → 续期/重建）
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.url).toContain("/api/session/ses_existing");
    // ③ 探针创建（session.created 事件）
    expect(calls[2]!.method).toBe("POST");
    expect(calls[2]!.url).toBe("http://127.0.0.1:3000/api/session");
    expect(calls[2]!.body).toMatchObject({ location: { directory: "/home/ubuntu" } });
    // ④ 探针也走一次会话级 GET（location 重建触发点），再删除
    expect(calls[3]!.method).toBe("GET");
    expect(calls[3]!.url).toContain("/api/session/ses_probe");
    expect(calls[4]!.method).toBe("DELETE");
    expect(calls[4]!.url).toContain("/api/session/ses_probe");
  });

  test("无可选会话时仍走探针事件通道", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/api/session?") && init?.method !== "POST") return jsonResponse({ data: [] });
      if (init?.method === "POST") return jsonResponse({ data: { id: "ses_probe" } });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const ok = await touchLocationOverHttp("/home/ubuntu", {
      log,
      discover: async () => ({ url: "http://127.0.0.1:3000" }),
      fetchImpl,
    });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.startsWith("POST"))).toBe(true);
  });

  test("全部请求失败 → false（不抛错）", async () => {
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

describe("startKeepalive", () => {
  test("按间隔触发 touch，停止后不再触发", async () => {
    vi.useFakeTimers();
    try {
      const touch = vi.fn(async () => true);
      const stop = startKeepalive({
        log,
        directory: "/home/ubuntu",
        intervalMs: 1000,
        touch,
      });
      await vi.advanceTimersByTimeAsync(3500);
      expect(touch.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(touch).toHaveBeenCalledWith("/home/ubuntu");
      stop();
      const callsAfterStop = touch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(touch.mock.calls.length).toBe(callsAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  test("touch 抛错不影响后续心跳", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const touch = vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return true;
      });
      const stop = startKeepalive({ log, directory: "/home/ubuntu", intervalMs: 1000, touch });
      await vi.advanceTimersByTimeAsync(2500);
      expect(n).toBeGreaterThanOrEqual(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
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
