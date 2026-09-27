import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import {
  quickGenerateWithSession,
  sessionRoutingHeaders,
  type QuickGenerateDeps,
} from "../src/session/quick-generate.js";

const log = createLogger({ level: "error", sink: () => undefined });

const service = { url: "http://127.0.0.1:3000", password: "pw" };

/** 极简 fetch 替身：记录调用并返回 JSON。 */
function fetchStub(payload: unknown, ok = true, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("sessionRoutingHeaders", () => {
  test("带会话头；有目录时附带 URL 编码的 x-opencode-directory", () => {
    expect(sessionRoutingHeaders("ses_1")).toEqual({ "x-opencode-session": "ses_1" });
    expect(sessionRoutingHeaders("ses_1", "/home/ubuntu/a b")).toEqual({
      "x-opencode-session": "ses_1",
      "x-opencode-directory": encodeURIComponent("/home/ubuntu/a b"),
    });
  });
});

describe("quickGenerateWithSession · A 通道（ctx.generate.text + 请求头）", () => {
  test("优先 A：把 x-opencode-session 作为请求头传入，且不触发 HTTP 兜底", async () => {
    const generateText = vi.fn(
      async (_prompt: string, requestOptions: { headers: Record<string, string> }) => {
        expect(requestOptions.headers["x-opencode-session"]).toBe("ses_1");
        return { text: "A 摘要" };
      },
    );
    const { impl, calls } = fetchStub({ text: "不应该走到这里" });
    const outcome = await quickGenerateWithSession(
      { log, generateText, discover: async () => service, fetchImpl: impl },
      { prompt: "总结", sessionID: "ses_1" },
    );
    expect(outcome).toEqual({ route: "generate", result: { text: "A 摘要" } });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

describe("quickGenerateWithSession · B 通道（本机 HTTP 兜底）", () => {
  test("A 不可用 → 走 HTTP，显式带 x-opencode-session 与 Basic 认证", async () => {
    const { impl, calls } = fetchStub({ text: "B 摘要" });
    const outcome = await quickGenerateWithSession(
      { log, discover: async () => service, fetchImpl: impl },
      { prompt: "总结这轮", sessionID: "ses_2", directory: "/home/ubuntu/work/app" },
    );
    expect(outcome).toEqual({ route: "http", result: { text: "B 摘要" } });

    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:3000/api/experimental/generate");
    expect(call.init!.method).toBe("POST");
    const headers = call.init!.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBe("ses_2");
    expect(headers["x-opencode-directory"]).toBe(encodeURIComponent("/home/ubuntu/work/app"));
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("opencode:pw", "utf8").toString("base64")}`,
    );
    expect(JSON.parse(call.init!.body as string)).toEqual({ prompt: "总结这轮" });
  });

  test("A 抛错（缺会话头被拒）→ 回退 B", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("Request is missing x-opencode-session");
    });
    const { impl } = fetchStub({ text: "回退成功" });
    const outcome = await quickGenerateWithSession(
      { log, generateText, discover: async () => service, fetchImpl: impl },
      { prompt: "p", sessionID: "ses_3" },
    );
    expect(outcome.route).toBe("http");
    expect(outcome.result).toEqual({ text: "回退成功" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("A 返回 undefined → 回退 B", async () => {
    const { impl } = fetchStub({ text: "ok" });
    const outcome = await quickGenerateWithSession(
      {
        log,
        generateText: async () => undefined,
        discover: async () => service,
        fetchImpl: impl,
      },
      { prompt: "p", sessionID: "ses_4" },
    );
    expect(outcome.route).toBe("http");
  });

  test("HTTP 非 2xx → 抛错（由上层收敛为降级文案）", async () => {
    const { impl } = fetchStub({}, false, 400);
    await expect(
      quickGenerateWithSession(
        { log, discover: async () => service, fetchImpl: impl },
        { prompt: "p", sessionID: "ses_5" },
      ),
    ).rejects.toThrow(/400/);
  });

  test("A/B 都不可用（无服务注册）→ 抛错", async () => {
    await expect(
      quickGenerateWithSession(
        { log, discover: async () => undefined },
        { prompt: "p", sessionID: "ses_6" },
      ),
    ).rejects.toThrow(/均不可用/);
  });
});

describe("quickGenerateWithSession · 不依赖会话级生成", () => {
  test("依赖里只有 generateText（一次性）；结构上不存在 session.generate", () => {
    const deps: QuickGenerateDeps = { log, generateText: async () => "x" };
    expect("generate" in deps).toBe(false);
    expect("session" in deps).toBe(false);
  });
});
