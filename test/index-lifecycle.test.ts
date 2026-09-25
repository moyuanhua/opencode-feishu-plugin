import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  startGateway: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../src/feishu/gateway.js", () => ({ startGateway: h.startGateway }));
// 不加载真实 SDK，避免测试里出现 'client ready' 等无关日志/副作用。
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {},
  Domain: { Feishu: "feishu", Lark: "lark" },
}));

/** 每个用例重新加载 index，获得全新的模块级 setup 守卫。 */
async function loadPlugin() {
  vi.resetModules();
  const mod = await import("../src/index.js");
  return mod.default;
}

/** 假 ctx：长连接/事件订阅全部可控，不触碰任何网络或生产文件。 */
function makeCtx() {
  return {
    options: {
      appId: "cli_test",
      appSecret: "secret_test",
      permissionGate: "off",
      stream: false,
      logFile: false,
      logLevel: "error",
    },
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      remove: async () => undefined,
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
    },
    permission: {
      hook: async () => ({ dispose: async () => undefined }),
      reply: async () => undefined,
    },
  };
}

const gatewayStop = (call: number) =>
  (h.startGateway.mock.results[call]!.value as { stop: ReturnType<typeof vi.fn> }).stop;

describe("进程级 setup 幂等", () => {
  beforeEach(() => {
    h.startGateway.mockClear();
    // 避免读到生产 feishu.json / 写生产日志。
    process.env.OPENCODE_CONFIG_DIR = "/tmp/opencode/__feishu_v2_nonexistent__";
  });

  test("同进程连续两次 setup 只启动一次 gateway，且第二次 cleanup 是 no-op", async () => {
    const plugin = await loadPlugin();
    const ctx = makeCtx();

    const cleanup1 = (await plugin.setup(ctx as never)) as (() => Promise<void>) | undefined;
    const cleanup2 = (await plugin.setup(ctx as never)) as (() => Promise<void>) | undefined;

    expect(h.startGateway).toHaveBeenCalledTimes(1);
    expect(typeof cleanup1).toBe("function");
    expect(typeof cleanup2).toBe("function");

    // 第二次 cleanup 不能关掉第一份资源。
    await cleanup2!();
    expect(gatewayStop(0)).not.toHaveBeenCalled();

    // 第一次 cleanup 要能正常关闭。
    await cleanup1!();
    expect(gatewayStop(0)).toHaveBeenCalledTimes(1);
  });

  test("首次 cleanup 之后允许再次 setup（opencode reload 场景）", async () => {
    const plugin = await loadPlugin();
    const cleanup1 = (await plugin.setup(makeCtx() as never)) as () => Promise<void>;
    await cleanup1();

    const cleanup2 = (await plugin.setup(makeCtx() as never)) as () => Promise<void>;
    expect(h.startGateway).toHaveBeenCalledTimes(2);
    await cleanup2();
    expect(gatewayStop(1)).toHaveBeenCalledTimes(1);
  });

  test("cleanup 幂等：重复调用不重复关闭", async () => {
    const plugin = await loadPlugin();
    const cleanup = (await plugin.setup(makeCtx() as never)) as () => Promise<void>;
    await cleanup();
    await cleanup();
    expect(gatewayStop(0)).toHaveBeenCalledTimes(1);
  });
});
