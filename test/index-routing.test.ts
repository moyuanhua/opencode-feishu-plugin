import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { IncomingMessage } from "../src/types.js";
import { FakeStorage } from "./helpers.js";

/**
 * index 级路由集成测试：只 mock 长连接与飞书 SDK，走真实 handleMessage 决策树。
 * 校验：主聊天流提示卡、话题内新建会话并绑定、话题命中复用会话、去重。
 */
const h = vi.hoisted(() => ({
  gatewayOptions: undefined as { onMessage: (m: IncomingMessage) => void | Promise<void> } | undefined,
  created: [] as unknown[],
  replied: [] as unknown[],
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
        create: async (payload: unknown) => {
          h.created.push(payload);
          return { code: 0, data: { message_id: `om_c${h.created.length}` } };
        },
        reply: async (payload: unknown) => {
          h.replied.push(payload);
          return { code: 0, data: { message_id: `om_r${h.replied.length}`, thread_id: "omt_new" } };
        },
        patch: async () => ({ code: 0, data: {} }),
        get: async (payload: { path: { message_id: string } }) => ({
          code: 0,
          data: { items: [{ message_id: payload.path.message_id, thread_id: "omt_from_get" }] },
        }),
        delete: async () => ({ code: 0, data: {} }),
      },
    };
  },
  Domain: { Feishu: "feishu", Lark: "lark" },
}));

const storage = new FakeStorage();
const promptCalls: Array<{ sessionID: string; text: string }> = [];
const createSession = vi.fn(async (_input: { title?: string }) => ({ id: `ses_${createSession.mock.calls.length - 1}` }));

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    options: {
      appId: "cli_test",
      appSecret: "secret_test",
      permissionGate: "off",
      stream: true,
      logFile: false,
      logLevel: "error",
      ...overrides,
    },
    storage: {
      get: (k: string) => storage.get(k),
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
      create: createSession,
      prompt: async (input: { sessionID: string; text: string }) => {
        promptCalls.push({ sessionID: input.sessionID, text: input.text });
      },
      interrupt: async () => undefined,
    },
    permission: {
      hook: async () => ({ dispose: async () => undefined }),
      reply: async () => undefined,
    },
  };
}

function msg(text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    eventId: "ev",
    messageId: `om_in_${h.created.length}_${h.replied.length}_${promptCalls.length}`,
    chatId: "oc_1",
    chatType: "p2p",
    messageType: "text",
    text,
    senderOpenId: "ou_1",
    ...extra,
  };
}

async function setup(options: Record<string, unknown> = {}): Promise<() => Promise<void>> {
  vi.resetModules();
  const mod = await import("../src/index.js");
  const plugin = mod.default;
  const cleanup = (await plugin.setup(makeCtx(options) as never)) as () => Promise<void>;
  return cleanup;
}

async function deliver(message: IncomingMessage): Promise<void> {
  await h.gatewayOptions!.onMessage(message);
}

describe("index 话题路由（集成）", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    process.env.OPENCODE_CONFIG_DIR = "/tmp/opencode/__feishu_v2_nonexistent__";
    storage.clear();
    h.created.length = 0;
    h.replied.length = 0;
    h.gatewayOptions = undefined;
    promptCalls.length = 0;
    createSession.mockClear();
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  test("主聊天流普通文本：回提示卡，不建会话、不 prompt", async () => {
    cleanup = await setup();
    await deliver(msg("你好"));
    expect(createSession).not.toHaveBeenCalled();
    expect(promptCalls).toHaveLength(0);
    expect(storage.raw("feishu:v2:chat:oc_1:sessions")).toBeUndefined();
    // 管理台提示卡通过 create 发送
    expect(h.created).toHaveLength(1);
    expect(JSON.stringify(h.created[0])).toContain("管理台");
  });

  test("话题内首条消息：新建会话 + bind thread/root + prompt", async () => {
    cleanup = await setup();
    const tid = "omt_a";
    await deliver(msg("帮我看看这个 bug", { messageId: "om_t1", threadId: tid, rootId: "omr_a", parentId: "omr_a" }));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]?.[0]?.title).toContain("话题: 帮我看看这个 bug");
    const link = storage.raw(`feishu:v2:thread:${tid}`) as { sessionID: string; anchorMessageId?: string };
    expect(link.sessionID).toBe("ses_0");
    expect(link.anchorMessageId).toBe("omr_a");
    expect((storage.raw("feishu:v2:root:omr_a") as { sessionID: string }).sessionID).toBe("ses_0");
    expect(promptCalls).toEqual([{ sessionID: "ses_0", text: "帮我看看这个 bug" }]);
    // 回执卡走 reply（落话题），而非主聊天流 create
    expect(h.replied).toHaveLength(1);
  });

  test("同一话题第二条消息：复用会话，不新建", async () => {
    cleanup = await setup();
    await deliver(msg("第一条", { messageId: "om_t1", threadId: "omt_a", rootId: "omr_a" }));
    await deliver(msg("第二条", { messageId: "om_t2", threadId: "omt_a", rootId: "omr_a" }));

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(promptCalls.map((p) => p.sessionID)).toEqual(["ses_0", "ses_0"]);
  });

  test("root 命中（手动从卡片建话题）：复用该会话并补写 thread", async () => {
    cleanup = await setup();
    // 先建一个会话并绑定 root（模拟会话卡锚点）。
    storage.seed("feishu:v2:chat:oc_1:sessions", { sessions: [{ sessionID: "ses_card", title: "卡片会话", updatedAt: 1 }], active: "ses_card" });
    storage.seed("feishu:v2:session:ses_card", { chatId: "oc_1", openId: "ou_1" });
    storage.seed("feishu:v2:root:om_card", { sessionID: "ses_card" });

    await deliver(msg("从卡片建的话题", { messageId: "om_t9", threadId: "omt_manual", rootId: "om_card" }));

    expect(createSession).not.toHaveBeenCalled();
    expect(promptCalls).toEqual([{ sessionID: "ses_card", text: "从卡片建的话题" }]);
    expect((storage.raw("feishu:v2:thread:omt_manual") as { sessionID: string }).sessionID).toBe("ses_card");
  });

  test("同一 messageId 重复投递被去重（不重复 prompt）", async () => {
    cleanup = await setup();
    const m = msg("重复消息", { messageId: "om_dup", threadId: "omt_a", rootId: "omr_a" });
    await deliver(m);
    await deliver({ ...m });
    expect(promptCalls).toHaveLength(1);
  });

  test("threadRouting=false 回退：即使带 threadId 也进当前会话，且主聊天流命令可用", async () => {
    cleanup = await setup({ threadRouting: false });
    await deliver(msg("主聊天流命令", { messageId: "om_f1" }));
    // 主聊天流普通文本进自动新建的当前会话
    expect(promptCalls).toHaveLength(1);
    expect(storage.raw("feishu:v2:thread:omt_any")).toBeUndefined();

    // 带 threadId 的 `/new` 在回退模式下应按主聊天流处理（不被话题矩阵拒绝）
    await deliver(msg("/new 回退新会话", { messageId: "om_f2", threadId: "omt_fallback", rootId: "omr_f" }));
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(storage.raw("feishu:v2:thread:omt_fallback")).toBeUndefined();
  });
});
