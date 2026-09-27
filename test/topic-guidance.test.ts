import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildTopicGuidance,
  injectTopicGuidance,
  TOPIC_GUIDANCE_MARKER,
} from "../src/feishu/topic-guidance.js";
import { createLogger } from "../src/logger.js";
import type { IncomingMessage, Logger } from "../src/types.js";
import { FakeStorage } from "./helpers.js";

const log: Logger = createLogger({ level: "error", sink: () => undefined });

// ── 纯逻辑 ──────────────────────────────────────────────────────────────

describe("buildTopicGuidance", () => {
  test("含标题、/new 提示，且明确不拒绝回答/不说教", () => {
    const text = buildTopicGuidance("修登录 bug");
    expect(text).toContain("修登录 bug");
    expect(text).toContain("/new");
    expect(text).toContain("不要因此拒绝回答");
    expect(text).toContain("不要长篇说教");
  });
});

describe("injectTopicGuidance", () => {
  function deps(over: Partial<Parameters<typeof injectTopicGuidance>[1]> = {}) {
    return {
      log,
      resolveSession: async () => ({ chatId: "oc_1" }),
      resolveTitle: async () => "主题 A",
      ...over,
    };
  }

  test("飞书会话：注入含标题的 system 说明 + 去重标记", async () => {
    const system: unknown[] = [];
    await injectTopicGuidance({ sessionID: "ses_1", system }, deps());
    expect(system).toHaveLength(1);
    const part = system[0] as { type: string; text: string; metadata: Record<string, unknown> };
    expect(part.type).toBe("text");
    expect(part.text).toContain("主题 A");
    expect(part.text).toContain("/new");
    expect(part.metadata[TOPIC_GUIDANCE_MARKER]).toBe(true);
  });

  test("非飞书会话（无映射）：绝不注入", async () => {
    const system: unknown[] = [];
    await injectTopicGuidance({ sessionID: "ses_local", system }, deps({ resolveSession: async () => undefined }));
    expect(system).toHaveLength(0);
  });

  test("无标题：跳过注入", async () => {
    const system: unknown[] = [];
    await injectTopicGuidance({ sessionID: "ses_1", system }, deps({ resolveTitle: async () => undefined }));
    expect(system).toHaveLength(0);
    await injectTopicGuidance({ sessionID: "ses_1", system }, deps({ resolveTitle: async () => "   " }));
    expect(system).toHaveLength(0);
  });

  test("同一请求已注入过：不重复注入", async () => {
    const system: unknown[] = [];
    await injectTopicGuidance({ sessionID: "ses_1", system }, deps());
    await injectTopicGuidance({ sessionID: "ses_1", system }, deps());
    expect(system).toHaveLength(1);
  });

  test("system 不是数组：安全跳过", async () => {
    await expect(injectTopicGuidance({ sessionID: "ses_1", system: undefined }, deps())).resolves.toBeUndefined();
    await expect(injectTopicGuidance({ sessionID: "ses_1", system: "nope" }, deps())).resolves.toBeUndefined();
  });

  test("依赖异常：只 warn，不抛出", async () => {
    const system: unknown[] = [];
    await expect(
      injectTopicGuidance(
        { sessionID: "ses_1", system },
        deps({
          resolveSession: async () => {
            throw new Error("boom");
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(system).toHaveLength(0);
  });
});

// ── index 集成：hook 注册与注入边界 ─────────────────────────────────────

const h = vi.hoisted(() => ({
  gatewayOptions: undefined as
    | {
        onMessage: (m: IncomingMessage) => void | Promise<void>;
      }
    | undefined,
  sessionHooks: [] as Array<{ name: string; cb: (input: unknown) => unknown }>,
}));

vi.mock("../src/feishu/gateway.js", () => ({
  startGateway: (options: unknown) => {
    h.gatewayOptions = options as typeof h.gatewayOptions;
    return { stop: () => undefined };
  },
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    im = {
      message: {
        create: async () => ({ code: 0, data: { message_id: "om_c" } }),
        reply: async () => ({ code: 0, data: { message_id: "om_r", thread_id: "omt_new" } }),
        patch: async () => ({ code: 0, data: {} }),
        get: async () => ({ code: 0, data: { items: [{ thread_id: "omt_new" }] } }),
        delete: async () => ({ code: 0, data: {} }),
      },
    };
  },
  Domain: { Feishu: "feishu", Lark: "lark" },
}));

const storage = new FakeStorage();
let failGet = false;

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    options: {
      appId: "cli_test",
      appSecret: "secret_test",
      permissionGate: "off",
      stream: false,
      logFile: false,
      logLevel: "error",
      ...overrides,
    },
    storage: {
      get: async (k: string) => {
        if (failGet) throw new Error("storage boom");
        return storage.get(k);
      },
      set: (k: string, v: unknown) => storage.set(k, v),
      remove: (k: string) => storage.remove(k),
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal }) => ({
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<{ type: string; data: unknown }>> =>
              new Promise((resolve) => {
                if (!signal || signal.aborted) {
                  resolve({ done: true, value: undefined });
                  return;
                }
                signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
              }),
          };
        },
      }),
    },
    session: {
      create: async (input: { title?: string }) => ({ id: "ses_new", title: input.title ?? "" }),
      prompt: async () => undefined,
      interrupt: async () => undefined,
      hook: async (name: string, cb: (input: unknown) => unknown) => {
        h.sessionHooks.push({ name, cb });
        return { dispose: async () => undefined };
      },
    },
    permission: {
      hook: async () => ({ dispose: async () => undefined }),
      reply: async () => undefined,
    },
  };
}

async function setup(options: Record<string, unknown> = {}): Promise<() => Promise<void>> {
  vi.resetModules();
  const mod = await import("../src/index.js");
  return (await mod.default.setup(makeCtx(options) as never)) as () => Promise<void>;
}

function contextHook(): ((input: unknown) => unknown) | undefined {
  return h.sessionHooks.find((x) => x.name === "context")?.cb;
}

function seedFeishuSession(sessionID: string, title: string | undefined): void {
  storage.seed(`feishu:v2:session:${sessionID}`, { chatId: "oc_1", openId: "ou_1" });
  if (title !== undefined) {
    storage.seed("feishu:v2:chat:oc_1:sessions", {
      sessions: [{ sessionID, title, updatedAt: 1 }],
      active: sessionID,
    });
  }
}

describe("index 主题软引导注册（集成）", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    process.env.OPENCODE_CONFIG_DIR = "/tmp/opencode/__feishu_v2_nonexistent__";
    storage.clear();
    failGet = false;
    h.gatewayOptions = undefined;
    h.sessionHooks.length = 0;
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  test("默认开启：注册 context hook，对飞书会话注入含标题的说明", async () => {
    seedFeishuSession("ses_x", "主题 X");
    cleanup = await setup();
    const hook = contextHook();
    expect(typeof hook).toBe("function");

    const system: unknown[] = [];
    await hook!({ sessionID: "ses_x", system });
    expect(system).toHaveLength(1);
    expect(JSON.stringify(system[0])).toContain("主题 X");
  });

  test("非飞书会话：不注入", async () => {
    cleanup = await setup();
    const hook = contextHook();
    const system: unknown[] = [];
    await hook!({ sessionID: "ses_local_tui", system });
    expect(system).toHaveLength(0);
  });

  test("无标题：跳过注入", async () => {
    seedFeishuSession("ses_notitle", undefined);
    cleanup = await setup();
    const hook = contextHook();
    const system: unknown[] = [];
    await hook!({ sessionID: "ses_notitle", system });
    expect(system).toHaveLength(0);
  });

  test("topicGuidance=false：不注册 context hook", async () => {
    cleanup = await setup({ topicGuidance: false });
    expect(contextHook()).toBeUndefined();
  });

  test("注入依赖异常：回调不抛出", async () => {
    seedFeishuSession("ses_x", "主题 X");
    cleanup = await setup();
    const hook = contextHook();
    failGet = true;
    const system: unknown[] = [];
    await expect(hook!({ sessionID: "ses_x", system })).resolves.toBeUndefined();
  });
});
