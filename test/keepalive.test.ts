import { describe, expect, test, vi } from "vitest";
import { startKeepalive, touchLocationOverHttp } from "../src/session/keepalive.js";
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
    // ④ 立即删除探针
    expect(calls[3]!.method).toBe("DELETE");
    expect(calls[3]!.url).toContain("/api/session/ses_probe");
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
