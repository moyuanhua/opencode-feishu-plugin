import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import {
  quickGenerateWithSession,
  sessionRoutingHeaders,
  TEMP_SESSION_TITLE,
  type QuickGenerateDeps,
} from "../src/session/quick-generate.js";

const log = createLogger({ level: "error", sink: () => undefined });

const service = { url: "http://127.0.0.1:3000", password: "pw" };
const authHeader = `Basic ${Buffer.from("opencode:pw", "utf8").toString("base64")}`;

interface ScriptedResult {
  readonly ok?: boolean;
  readonly status?: number;
  readonly payload?: unknown;
  readonly text?: string;
}

/** 按 URL/方法脚本化响应的 fetch 替身：记录调用、返回预置结果。 */
function scriptedFetch(route: (url: string, init: RequestInit | undefined) => ScriptedResult) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = route(u, init);
    const status = r.status ?? 200;
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => r.payload,
      text: async () => r.text ?? "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** C 通道标准成功脚本：建会话 → 会话内生成 → 删除。 */
function sessionScript(text: string) {
  return scriptedFetch((url, init) => {
    if (init?.method === "POST" && url.endsWith("/api/session")) {
      return { payload: { data: { id: "ses_temp1" } } };
    }
    if (init?.method === "POST" && url.endsWith("/ses_temp1/generate")) {
      return { payload: { data: { text } } };
    }
    if (init?.method === "DELETE" && url.endsWith("/ses_temp1")) {
      return { status: 204 };
    }
    return { status: 500, text: `unexpected: ${init?.method} ${url}` };
  });
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

describe("quickGenerateWithSession · C 通道（临时会话）", () => {
  test("首选：建会话（显式模型/位置）→ 会话内生成 → 删除，全程带认证与目录头", async () => {
    const { impl, calls } = sessionScript("识别结果");
    const outcome = await quickGenerateWithSession(
      { log, sessionChannel: "on", discover: async () => service, fetchImpl: impl },
      {
        prompt: "分类",
        sessionID: "ses_main",
        directory: "/home/ubuntu/work",
        model: { providerID: "zhipu", id: "glm-5.2" },
      },
    );
    expect(outcome).toEqual({ route: "session", result: { data: { text: "识别结果" } } });
    expect(calls).toHaveLength(3);

    const [create, generate, remove] = calls;
    expect(create!.url).toBe("http://127.0.0.1:3000/api/session");
    expect(create!.init!.method).toBe("POST");
    expect(JSON.parse(create!.init!.body as string)).toEqual({
      title: TEMP_SESSION_TITLE,
      model: { providerID: "zhipu", id: "glm-5.2" },
      location: { directory: "/home/ubuntu/work" },
    });
    const createHeaders = create!.init!.headers as Record<string, string>;
    expect(createHeaders.authorization).toBe(authHeader);
    expect(createHeaders["x-opencode-directory"]).toBe(encodeURIComponent("/home/ubuntu/work"));

    expect(generate!.url).toBe("http://127.0.0.1:3000/api/session/ses_temp1/generate");
    expect(generate!.init!.method).toBe("POST");
    expect(JSON.parse(generate!.init!.body as string)).toEqual({ prompt: "分类" });

    expect(remove!.url).toBe("http://127.0.0.1:3000/api/session/ses_temp1");
    expect(remove!.init!.method).toBe("DELETE");
  });

  test("生成失败也会删除临时会话，并回退 A 通道", async () => {
    const { impl, calls } = scriptedFetch((url, init) => {
      if (init?.method === "POST" && url.endsWith("/api/session")) {
        return { payload: { data: { id: "ses_temp2" } } };
      }
      if (init?.method === "POST" && url.endsWith("/ses_temp2/generate")) {
        return { status: 500, text: "boom" };
      }
      if (init?.method === "DELETE" && url.endsWith("/ses_temp2")) {
        return { status: 204 };
      }
      return { status: 500, text: "unexpected" };
    });
    const generateText = vi.fn(async () => ({ text: "A 结果" }));
    const outcome = await quickGenerateWithSession(
      { log, sessionChannel: "on", generateText, discover: async () => service, fetchImpl: impl },
      { prompt: "p", sessionID: "ses_main" },
    );
    expect(outcome.route).toBe("generate");
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.init?.method === "DELETE")).toBe(true);
  });

  test("创建失败 → 不产生删除调用，直接回退", async () => {
    const { impl, calls } = scriptedFetch(() => ({ status: 500, text: "no" }));
    const generateText = vi.fn(async () => "ok");
    const outcome = await quickGenerateWithSession(
      { log, sessionChannel: "on", generateText, discover: async () => service, fetchImpl: impl },
      { prompt: "p", sessionID: "ses_main" },
    );
    expect(outcome.route).toBe("generate");
    expect(calls.every((c) => c.init?.method !== "DELETE")).toBe(true);
  });

  test('sessionChannel: "auto" 在测试环境自动关闭（不产生真实调用）', async () => {
    const { impl, calls } = scriptedFetch(() => ({ status: 500 }));
    const generateText = vi.fn(async () => "A 结果");
    const outcome = await quickGenerateWithSession(
      { log, generateText, discover: async () => service, fetchImpl: impl },
      { prompt: "p", sessionID: "ses_main" },
    );
    expect(outcome.route).toBe("generate");
    expect(calls).toHaveLength(0);
  });
});

describe("quickGenerateWithSession · A 通道（ctx.generate.text + 请求头）", () => {
  test("C 关闭时优先 A：把 x-opencode-session 作为请求头传入，且不触发 HTTP 兜底", async () => {
    const generateText = vi.fn(
      async (_prompt: string, requestOptions: { headers: Record<string, string> }) => {
        expect(requestOptions.headers["x-opencode-session"]).toBe("ses_1");
        return { text: "A 摘要" };
      },
    );
    const { impl, calls } = scriptedFetch(() => ({ payload: { text: "不应该走到这里" } }));
    const outcome = await quickGenerateWithSession(
      { log, sessionChannel: "off", generateText, discover: async () => service, fetchImpl: impl },
      { prompt: "总结", sessionID: "ses_1" },
    );
    expect(outcome).toEqual({ route: "generate", result: { text: "A 摘要" } });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  test("显式模型透传到 A 通道第三个参数", async () => {
    const generateText = vi.fn(
      async (
        _prompt: string,
        _requestOptions: { headers: Record<string, string> },
        model?: { providerID: string; id: string },
      ) => {
        expect(model).toEqual({ providerID: "zhipu", id: "glm-5.2" });
        return { text: "ok" };
      },
    );
    const outcome = await quickGenerateWithSession(
      { log, sessionChannel: "off", generateText },
      { prompt: "p", sessionID: "ses_m", model: { providerID: "zhipu", id: "glm-5.2" } },
    );
    expect(outcome.route).toBe("generate");
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

describe("quickGenerateWithSession · B 通道（本机 HTTP 兜底）", () => {
  test("A 不可用 → 走 HTTP，显式带 x-opencode-session 与 Basic 认证", async () => {
    const { impl, calls } = scriptedFetch(() => ({ payload: { text: "B 摘要" } }));
    const outcome = await quickGenerateWithSession(
      { log, sessionChannel: "off", discover: async () => service, fetchImpl: impl },
      {
        prompt: "总结这轮",
        sessionID: "ses_2",
        directory: "/home/ubuntu/work/app",
        model: { providerID: "zhipu", id: "glm-5.2" },
      },
    );
    expect(outcome).toEqual({ route: "http", result: { text: "B 摘要" } });

    const call = calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:3000/api/experimental/generate");
    expect(call.init!.method).toBe("POST");
    const headers = call.init!.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBe("ses_2");
    expect(headers["x-opencode-directory"]).toBe(encodeURIComponent("/home/ubuntu/work/app"));
    expect(headers.authorization).toBe(authHeader);
    expect(JSON.parse(call.init!.body as string)).toEqual({
      prompt: "总结这轮",
      model: { providerID: "zhipu", id: "glm-5.2" },
    });
  });

  test("A 抛错（缺会话头被拒）→ 回退 B", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("Request is missing x-opencode-session");
    });
    const { impl } = scriptedFetch(() => ({ payload: { text: "回退成功" } }));
    const outcome = await quickGenerateWithSession(
      { log, sessionChannel: "off", generateText, discover: async () => service, fetchImpl: impl },
      { prompt: "p", sessionID: "ses_3" },
    );
    expect(outcome.route).toBe("http");
    expect(outcome.result).toEqual({ text: "回退成功" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("A 返回 undefined → 回退 B", async () => {
    const { impl } = scriptedFetch(() => ({ payload: { text: "ok" } }));
    const outcome = await quickGenerateWithSession(
      {
        log,
        sessionChannel: "off",
        generateText: async () => undefined,
        discover: async () => service,
        fetchImpl: impl,
      },
      { prompt: "p", sessionID: "ses_4" },
    );
    expect(outcome.route).toBe("http");
  });

  test("HTTP 非 2xx → 抛错（由上层收敛为降级文案）", async () => {
    const { impl } = scriptedFetch(() => ({ status: 400, text: "bad" }));
    await expect(
      quickGenerateWithSession(
        { log, sessionChannel: "off", discover: async () => service, fetchImpl: impl },
        { prompt: "p", sessionID: "ses_5" },
      ),
    ).rejects.toThrow(/400/);
  });

  test("A/B 都不可用（无服务注册）→ 抛错", async () => {
    await expect(
      quickGenerateWithSession(
        { log, sessionChannel: "off", discover: async () => undefined },
        { prompt: "p", sessionID: "ses_6" },
      ),
    ).rejects.toThrow(/均不可用/);
  });
});

describe("quickGenerateWithSession · 测试环境真实网络防护", () => {
  test("未注入 discover/fetchImpl：本机 HTTP 通道被禁用（绝不真实联网）", async () => {
    const generateText = vi.fn(async () => undefined);
    await expect(
      quickGenerateWithSession({ log, generateText }, { prompt: "p", sessionID: "ses_guard" }),
    ).rejects.toThrow(/禁用/);
  });
});

describe("quickGenerateWithSession · 通道依赖结构", () => {
  test("依赖里没有会话域（C 通道走本机 HTTP 临时会话，不喂当前会话）", () => {
    const deps: QuickGenerateDeps = { log, generateText: async () => "x" };
    expect("generate" in deps).toBe(false);
    expect("session" in deps).toBe(false);
  });
});
