import { describe, expect, test, vi } from "vitest";
import { listSessionsOverHttp } from "../src/session/session-list-http.js";
import { loadSessionEntries } from "../src/session/session-list.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("listSessionsOverHttp", () => {
  test("调 GET /api/session 并带 limit/order/parentID=null 与 Basic 认证", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/api/session?");
      expect(url).toContain("limit=200");
      expect(url).toContain("order=desc");
      expect(url).toContain("parentID=null");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^Basic /);
      return jsonResponse({ data: [{ id: "ses_1", title: "t", time: { updated: 1 } }], cursor: {} });
    });
    const raw = await listSessionsOverHttp(
      {},
      {
        log,
        discover: async () => ({ url: "http://127.0.0.1:3000", password: "pw" }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(raw).toEqual({ data: [{ id: "ses_1", title: "t", time: { updated: 1 } }], cursor: {} });
  });

  test("rootsOnly=false 时不带 parentID", async () => {
    let seen = "";
    await listSessionsOverHttp(
      { rootsOnly: false },
      {
        log,
        discover: async () => ({ url: "http://127.0.0.1:3000" }),
        fetchImpl: (async (url: string) => {
          seen = url;
          return jsonResponse({ data: [] });
        }) as unknown as typeof fetch,
      },
    );
    expect(seen).not.toContain("parentID");
  });

  test("未发现服务 → undefined", async () => {
    const raw = await listSessionsOverHttp({}, { log, discover: async () => undefined });
    expect(raw).toBeUndefined();
  });

  test("HTTP 失败 → undefined", async () => {
    const raw = await listSessionsOverHttp(
      {},
      { log, discover: async () => ({ url: "http://127.0.0.1:3000" }), fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch },
    );
    expect(raw).toBeUndefined();
  });
});

describe("loadSessionEntries 三级数据源", () => {
  const fallback = [{ sessionID: "ses_fallback", title: "机器人会话", updatedAt: 1 }];

  function makeCtx(over: {
    listAllSessions?: () => Promise<unknown>;
    listAllSessionsHttp?: () => Promise<unknown>;
  }) {
    return {
      deps: {
        log,
        sessionMap: { listSessions: async () => fallback },
        ...over,
      },
    } as never;
  }

  test("优先 ctx.session.list", async () => {
    const entries = await loadSessionEntries(
      makeCtx({
        listAllSessions: async () => ({ data: [{ id: "ses_api", title: "API", time: { updated: 10 } }] }),
        listAllSessionsHttp: async () => ({ data: [{ id: "ses_http", title: "HTTP", time: { updated: 20 } }] }),
      }),
      "oc_1",
    );
    expect(entries.map((e) => e.sessionID)).toEqual(["ses_api"]);
  });

  test("ctx.session.list 形状不可识别 → HTTP 兜底", async () => {
    const entries = await loadSessionEntries(
      makeCtx({
        listAllSessions: async () => "garbage" as unknown,
        listAllSessionsHttp: async () => ({
          data: [{ id: "ses_http", title: "本地会话", time: { updated: 20 }, location: { directory: "/home/ubuntu/work" } }],
        }),
      }),
      "oc_1",
    );
    expect(entries.map((e) => e.sessionID)).toEqual(["ses_http"]);
    expect(entries[0]!.directory).toBe("/home/ubuntu/work");
  });

  test("HTTP 也不可用 → SessionMap 回退", async () => {
    const entries = await loadSessionEntries(
      makeCtx({
        listAllSessions: async () => "garbage" as unknown,
        listAllSessionsHttp: async () => undefined,
      }),
      "oc_1",
    );
    expect(entries.map((e) => e.sessionID)).toEqual(["ses_fallback"]);
  });
});
