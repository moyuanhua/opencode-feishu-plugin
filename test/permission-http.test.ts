import { describe, expect, test } from "vitest";
import { replyPermissionOverHttp } from "../src/feishu/permission-http.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });

describe("replyPermissionOverHttp", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  test("POST 到 /api/session/../permission/../reply，带 Basic 认证与目录头（URL 编码）", async () => {
    calls.length = 0;
    await replyPermissionOverHttp(
      { sessionID: "ses_1", requestID: "per_1", reply: "once", directory: "/home/ubuntu/work" },
      { log, fetchImpl, discover: async () => ({ url: "http://127.0.0.1:3000", password: "pw" }) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3000/api/session/ses_1/permission/per_1/reply");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-opencode-directory"]).toBe(encodeURIComponent("/home/ubuntu/work"));
    expect(headers.authorization).toBe(`Basic ${Buffer.from("opencode:pw", "utf8").toString("base64")}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ reply: "once" });
  });

  test("无目录头 / 无口令时不带对应头", async () => {
    calls.length = 0;
    await replyPermissionOverHttp(
      { sessionID: "ses_1", requestID: "per_1", reply: "reject" },
      { log, fetchImpl, discover: async () => ({ url: "http://127.0.0.1:3000" }) },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-opencode-directory"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  test("未发现本机服务 → 抛错", async () => {
    await expect(
      replyPermissionOverHttp(
        { sessionID: "s", requestID: "p", reply: "once" },
        { log, fetchImpl, discover: async () => undefined },
      ),
    ).rejects.toThrow(/service\.json/);
  });

  test("非 2xx → 抛错并带状态码", async () => {
    const badFetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    await expect(
      replyPermissionOverHttp(
        { sessionID: "s", requestID: "p", reply: "once" },
        { log, fetchImpl: badFetch, discover: async () => ({ url: "http://127.0.0.1:3000" }) },
      ),
    ).rejects.toThrow(/404/);
  });
});
