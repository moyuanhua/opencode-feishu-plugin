import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CardAction, IncomingMessage } from "../src/types.js";
import { deriveSignSecret } from "../src/config.js";
import { signAllowSession, signStop } from "../src/security/token.js";
import { FakeStorage } from "./helpers.js";

/**
 * index 级路由集成测试：只 mock 长连接与飞书 SDK，走真实 handleMessage 决策树。
 * 校验：主聊天流提示卡、话题内新建会话并绑定、话题命中复用会话、去重、强停按钮路由。
 */
const h = vi.hoisted(() => ({
  gatewayOptions: undefined as
    | {
        onMessage: (m: IncomingMessage) => void | Promise<void>;
        onCardAction: (a: CardAction) => object | void | Promise<object | void>;
      }
    | undefined,
  created: [] as unknown[],
  replied: [] as unknown[],
  patched: [] as unknown[],
  switchCalls: [] as Array<{ sessionID: string; model: { id: string; providerID: string } }>,
  switchImpl: undefined as
    | undefined
    | ((input: { sessionID: string; model: { id: string; providerID: string } }) => Promise<void>),
  evaluateHook: undefined as
    | undefined
    | ((event: { sessionID: string; action: string; effect?: string; message?: string }) => Promise<void>),
  sessionUpdates: [] as Array<{ sessionID: string; permissions: Array<{ action: string; resource: string; effect: string }> }>,
  contextRaw: undefined as unknown,
  messagesRaw: undefined as unknown as { data: unknown[] } | undefined,
  generateRaw: undefined as unknown,
  generateCalls: [] as Array<{ sessionID: string; prompt: string }>,
  compactCalls: [] as Array<{ sessionID: string }>,
  generateTextCalls: [] as string[],
  resourceGets: [] as unknown[],
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
        patch: async (payload: unknown) => {
          h.patched.push(payload);
          return { code: 0, data: {} };
        },
        get: async (payload: { path: { message_id: string } }) => ({
          code: 0,
          data: { items: [{ message_id: payload.path.message_id, thread_id: "omt_from_get" }] },
        }),
        delete: async () => ({ code: 0, data: {} }),
      },
      messageResource: {
        get: async (payload: unknown) => {
          h.resourceGets.push(payload);
          return {
            headers: { "content-type": "image/png" },
            writeFile: async (filePath: string) => {
              const { writeFile } = await import("node:fs/promises");
              await writeFile(filePath, "png-bytes");
            },
          };
        },
      },
    };
  },
  Domain: { Feishu: "feishu", Lark: "lark" },
}));

const storage = new FakeStorage();
const promptCalls: Array<{ sessionID: string; text: string; files?: Array<{ uri: string }> }> = [];
const interruptCalls: string[] = [];
/** 假的全量会话列表（`ctx.session.list` 数据源）。 */
let sessionListRaw: Array<{
  id: string;
  title: string;
  time: { updated: number };
  location: { directory: string };
  model?: { providerID: string; id: string };
}> = [];
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
    model: {
      list: async () => ({
        data: [
          { providerID: "opencode-go", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
          { providerID: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
        ],
      }),
    },
    session: {
      create: createSession,
      prompt: async (input: { sessionID: string; text: string; files?: Array<{ uri: string }> }) => {
        promptCalls.push({
          sessionID: input.sessionID,
          text: input.text,
          ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
        });
      },
      interrupt: async (input: { sessionID: string }) => {
        interruptCalls.push(input.sessionID);
        return undefined;
      },
      list: async () => ({ data: sessionListRaw }),
      get: async (input: { sessionID: string }) => {
        const found = sessionListRaw.find((s) => s.id === input.sessionID);
        if (!found) throw new Error("session not found");
        return found;
      },
      switchModel: async (input: { sessionID: string; model: { id: string; providerID: string } }) => {
        h.switchCalls.push(input);
        if (h.switchImpl) await h.switchImpl(input);
      },
      update: async (input: { sessionID: string; permissions: Array<{ action: string; resource: string; effect: string }> }) => {
        h.sessionUpdates.push(input);
      },
      context: async () => h.contextRaw,
      compact: async (input: { sessionID: string }) => {
        h.compactCalls.push(input);
        // 模拟压缩"完成"：随后的轮询能读到新的 completed 摘要。
        h.messagesRaw = { data: [{ type: "compaction", status: "completed", summary: "压缩后的摘要" }] };
        return { id: "msg_c", sessionID: input.sessionID, type: "compaction" };
      },
      generate: async (input: { sessionID: string; prompt: string }) => {
        h.generateCalls.push(input);
        return h.generateRaw;
      },
    },
    // 完整消息通道（恢复卡"复用摘要"必须走这里，而不是精简形状的 session.context）。
    message: {
      list: async (_input: { sessionID: string; limit?: number }) => h.messagesRaw,
    },
    // 快摘要走**无会话上下文**的临时生成（绝不用 session.generate）。
    generate: {
      text: async (input: { prompt: string }) => {
        h.generateTextCalls.push(input.prompt);
        return h.generateRaw as { text: string } | undefined;
      },
    },
    permission: {
      hook: async (name: string, cb: unknown) => {
        if (name === "evaluate") h.evaluateHook = cb as typeof h.evaluateHook;
        return { dispose: async () => undefined };
      },
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

async function click(rawValue: unknown, operatorOpenId = "ou_1"): Promise<object> {
  return (
    (await h.gatewayOptions!.onCardAction({
      rawValue,
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId,
    })) ?? {}
  );
}

describe("index 话题路由（集成）", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    process.env.OPENCODE_CONFIG_DIR = "/tmp/opencode/__feishu_v2_nonexistent__";
    storage.clear();
    h.created.length = 0;
    h.replied.length = 0;
    h.patched.length = 0;
    h.gatewayOptions = undefined;
    promptCalls.length = 0;
    interruptCalls.length = 0;
    sessionListRaw = [];
    h.switchCalls.length = 0;
    h.switchImpl = undefined;
    h.evaluateHook = undefined;
    h.sessionUpdates.length = 0;
    h.resourceGets.length = 0;
    h.contextRaw = undefined;
    h.messagesRaw = undefined;
    h.generateRaw = undefined;
    h.generateCalls.length = 0;
    h.compactCalls.length = 0;
    h.generateTextCalls.length = 0;
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

  test("运行卡强停按钮：白名单 → 验签 → 绑定 sessionID（伪造/陌生人拒绝）", async () => {
    cleanup = await setup();
    await deliver(msg("干活", { messageId: "om_t1", threadId: "omt_a", rootId: "omr_a" }));

    const secret = deriveSignSecret("secret_test");
    const token = signStop({ sessionID: "ses_0", ttlMs: 600_000 }, secret);

    // 合法点击：运行卡处于 active（思考中）→ success toast，并在后台中断服务端。
    const stopped = (await click({ cmd: "stop", sid: "ses_0", t: token })) as { toast: { type: string; content: string } };
    expect(stopped.toast).toEqual({ type: "success", content: "正在停止…" });
    await vi.waitFor(() => expect(interruptCalls).toContain("ses_0"));

    // 伪造 token → 拒绝。
    const forged = (await click({ cmd: "stop", sid: "ses_0", t: `${token}x` })) as { toast: { content: string } };
    expect(forged.toast.content).toContain("操作凭证无效");

    // 非白名单 operator → 连验签都不做，直接拒绝。
    const stranger = (await click({ cmd: "stop", sid: "ses_0", t: token }, "ou_intruder")) as { toast: { content: string } };
    expect(stranger.toast.content).toContain("无操作权限");

    // sessionID 不匹配（token 绑定别的会话）→ 拒绝。
    const mismatch = (await click({
      cmd: "stop",
      sid: "ses_0",
      t: signStop({ sessionID: "ses_other", ttlMs: 600_000 }, secret),
    })) as { toast: { content: string } };
    expect(mismatch.toast.content).toContain("session-mismatch");
  });

  test("进入历史会话：主聊天流发恢复卡 + 绑 root → 回复卡片（仅 root_id）路由并补写 thread", async () => {
    sessionListRaw = [
      { id: "ses_hist", title: "历史会话", time: { updated: 1_700_000_000_000 }, location: { directory: "/home/ubuntu/work/app" } },
    ];
    cleanup = await setup();
    // 先发一条消息绑定 owner 白名单。
    await deliver(msg("你好", { messageId: "om_boot" }));

    const res = (await click({ cmd: "open", s: "ses_hist", c: "oc_1" })) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    // 恢复卡走主聊天流 sendCard 当话题根；opener（摘要/引导卡）reply_in_thread 直接开话题。
    await vi.waitFor(() => expect(JSON.stringify(h.created.at(-1))).toContain("🔄 历史会话"));
    expect(h.replied).toHaveLength(1);
    expect((h.replied.at(-1) as { data: { reply_in_thread?: boolean } }).data.reply_in_thread).toBe(true);

    const rootSet = storage.setCalls.find((c) => c.key.startsWith("feishu:v2:root:"));
    expect(rootSet).toBeDefined();
    const cardId = rootSet!.key.replace("feishu:v2:root:", "");
    expect((storage.raw(`feishu:v2:root:${cardId}`) as { sessionID: string }).sessionID).toBe("ses_hist");
    // 自动开话题成功：thread 映射在恢复阶段就建立（reply 直接带回 thread_id）。
    expect((storage.raw("feishu:v2:thread:omt_new") as { sessionID: string }).sessionID).toBe("ses_hist");

    // 用户首次回复恢复卡：事件只带 root_id（无 thread_id）→ 仍路由到该会话，
    // 并读回消息元数据拿到 thread_id 后补写 thread 映射。
    await deliver(msg("继续吧", { messageId: "om_hist_1", rootId: cardId, parentId: cardId }));
    expect(promptCalls.at(-1)).toEqual({ sessionID: "ses_hist", text: "继续吧" });
    expect((storage.raw("feishu:v2:thread:omt_from_get") as { sessionID: string }).sessionID).toBe("ses_hist");
  });

  test("主聊天流普通文本回复未映射消息（root 未命中）→ 仍回管理台提示卡", async () => {
    cleanup = await setup();
    await deliver(msg("你好", { messageId: "om_boot0" }));
    const before = h.created.length;
    await deliver(msg("引用了一条无关消息", { messageId: "om_q1", rootId: "om_unmapped", parentId: "om_unmapped" }));
    expect(promptCalls).toHaveLength(0);
    expect(JSON.stringify(h.created.at(-1))).toContain("管理台");
    expect(h.created.length).toBe(before + 1);
  });

  test("/resume：对最近更新的会话直接发恢复卡并绑 root", async () => {
    sessionListRaw = [
      { id: "ses_r1", title: "最近的", time: { updated: 1_700_000_000_000 }, location: { directory: "/home/ubuntu/work/a" } },
      { id: "ses_r2", title: "较旧", time: { updated: 1_600_000_000_000 }, location: { directory: "/home/ubuntu/work/b" } },
    ];
    cleanup = await setup();
    await deliver(msg("你好", { messageId: "om_boot2" }));

    await deliver(msg("/resume", { messageId: "om_resume" }));
    await vi.waitFor(() => expect(JSON.stringify(h.created.at(-1))).toContain("🔄 最近的"));
    const rootSet = storage.setCalls.find((c) => c.key.startsWith("feishu:v2:root:"));
    expect(rootSet).toBeDefined();
    expect((storage.raw(rootSet!.key) as { sessionID: string }).sessionID).toBe("ses_r1");
  });

  test("图片消息：下载附件并作为 file:// 附件挂进 prompt", async () => {
    const { readFile, rm } = await import("node:fs/promises");
    cleanup = await setup({ attachmentsDir: "/tmp/feishu-att-it" });
    await rm("/tmp/feishu-att-it", { recursive: true, force: true });
    // 先在话题里创建会话（普通文本）。
    await deliver(msg("干活", { messageId: "om_img_boot", threadId: "omt_img", rootId: "omr_img" }));
    // 同一话题内发图片：应下载并作为附件挂进 prompt。
    await deliver(
      msg("[图片]", {
        messageId: "om_img1",
        messageType: "image",
        threadId: "omt_img",
        rootId: "omr_img",
        attachment: { kind: "image", fileKey: "img_v2_test" },
      }),
    );
    const last = promptCalls.at(-1)!;
    expect(last.text).toContain("[附件] 图片");
    expect(last.files).toHaveLength(1);
    expect(last.files![0]!.uri.startsWith("file://")).toBe(true);
    // 显式 attachmentsDir：精确目录 + messageId 前缀。
    const saved = last.files![0]!.uri.replace("file://", "");
    expect(saved).toBe("/tmp/feishu-att-it/om_img1-image.png");
    expect(await readFile(saved, "utf8")).toBe("png-bytes");
    expect(h.resourceGets).toHaveLength(1);
  });

  // ── 任务 B：/model 切换后读回校验（集成） ─────────────────────────────

  async function bindThreadSession(): Promise<void> {
    await deliver(msg("干活", { messageId: "om_sw1", threadId: "omt_sw", rootId: "omr_sw" }));
  }

  function readStoredModel(sessionID: string): string | undefined {
    const link = storage.raw(`feishu:v2:session:${sessionID}`) as { model?: { id?: string } } | undefined;
    return link?.model?.id;
  }

  test("话题内 /model 切换成功：SessionMap 记录与回执同步为读回值", async () => {
    cleanup = await setup();
    await bindThreadSession();
    sessionListRaw = [
      {
        id: "ses_0",
        title: "话题会话",
        time: { updated: 1 },
        location: { directory: "/home/ubuntu" },
        model: { providerID: "opencode-go", id: "glm-5.3-flash" },
      },
    ];
    await deliver(msg("/model glm", { messageId: "om_sw2", threadId: "omt_sw", rootId: "omr_sw" }));
    expect(h.switchCalls.at(-1)).toMatchObject({
      sessionID: "ses_0",
      model: { id: "glm-5.3-flash", providerID: "opencode-go" },
    });
    expect(readStoredModel("ses_0")).toBe("glm-5.3-flash");
    expect(JSON.stringify(h.replied.at(-1))).toContain("已切换模型");
  });

  test("话题内 /model 切换：读回与请求不一致时记录读回值且回执告警", async () => {
    cleanup = await setup();
    await bindThreadSession();
    // 请求 glm，但服务端读回 deepseek（模拟切换未生效 / 被覆盖）。
    sessionListRaw = [
      {
        id: "ses_0",
        title: "话题会话",
        time: { updated: 1 },
        location: { directory: "/home/ubuntu" },
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      },
    ];
    await deliver(msg("/model glm", { messageId: "om_sw2", threadId: "omt_sw", rootId: "omr_sw" }));
    expect(readStoredModel("ses_0")).toBe("deepseek-v4.1-flash"); // 记录读回的真实值
    const text = JSON.stringify(h.replied.at(-1));
    expect(text).toContain("可能未生效");
    expect(text).not.toContain("✅ 已切换模型");
  });

  test("话题内 /model 切换失败：回执错误、不写入、不误报成功", async () => {
    cleanup = await setup();
    await bindThreadSession();
    h.switchImpl = async () => {
      throw new Error("permission denied");
    };
    await deliver(msg("/model glm", { messageId: "om_sw2", threadId: "omt_sw", rootId: "omr_sw" }));
    expect(readStoredModel("ses_0")).toBeUndefined();
    const text = JSON.stringify(h.replied.at(-1));
    expect(text).toContain("切换模型失败");
    expect(text).not.toContain("已切换模型");
  });

  test("话题内 /model 读回失败：降级写入请求值并提示未校验", async () => {
    cleanup = await setup();
    await bindThreadSession();
    // sessionListRaw 为空 → ctx.session.get 抛错 → 读回失败。
    await deliver(msg("/model glm", { messageId: "om_sw2", threadId: "omt_sw", rootId: "omr_sw" }));
    expect(readStoredModel("ses_0")).toBe("glm-5.3-flash");
    expect(JSON.stringify(h.replied.at(-1))).toContain("未能读回");
  });

  // ── 任务 A：审批卡「本会话内允许该工具」（集成） ─────────────────────
  function seedPermSession(): void {
    storage.seed("feishu:v2:chat:oc_1:sessions", {
      sessions: [{ sessionID: "ses_perm", title: "权限会话", updatedAt: 1 }],
      active: "ses_perm",
    });
    storage.seed("feishu:v2:session:ses_perm", {
      chatId: "oc_1",
      openId: "ou_1",
      perm: "askHigh",
      gateMode: "gate",
    });
  }

  test("会话内允许：点击 → allowActions 写入 + ruleset 追加 + gate 命中不再 ask；其它会话不受影响", async () => {
    cleanup = await setup({ permissionGate: "gate" });
    seedPermSession();
    await deliver(msg("你好", { messageId: "om_bootA" })); // 绑定 owner 白名单
    const evaluate = h.evaluateHook!;

    const before = { sessionID: "ses_perm", action: "bash" } as { sessionID: string; action: string; effect?: string };
    await evaluate(before);
    expect(before.effect).toBe("ask");

    const secret = deriveSignSecret("secret_test");
    const token = signAllowSession(
      { requestID: "per_1", sessionID: "ses_perm", action: "bash", ttlMs: 600_000 },
      secret,
    );
    const res = (await click({ cmd: "allow_session", a: "bash", t: token })) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");

    await vi.waitFor(() => {
      const link = storage.raw("feishu:v2:session:ses_perm") as { allowActions?: string[] };
      expect(link.allowActions).toContain("bash");
      expect(link.allowActions).toContain("shell");
    });
    await vi.waitFor(() => {
      expect(h.sessionUpdates.length).toBeGreaterThan(0);
    });
    const update = h.sessionUpdates.at(-1)!;
    expect(update.sessionID).toBe("ses_perm");
    expect(update.permissions).toContainEqual({ action: "bash", resource: "*", effect: "allow" });
    expect(update.permissions).toContainEqual({ action: "shell", resource: "*", effect: "allow" });

    const after = { sessionID: "ses_perm", action: "bash" } as { sessionID: string; action: string; effect?: string };
    await evaluate(after);
    expect(after.effect).toBe("allow");

    // 同会话其它动作仍按会话预设 ask
    const otherAction = { sessionID: "ses_perm", action: "edit" } as { sessionID: string; action: string; effect?: string };
    await evaluate(otherAction);
    expect(otherAction.effect).toBe("ask");

    // 其它已映射会话不受影响（各自 gate 预设，无 allowActions）
    storage.seed("feishu:v2:session:ses_other", {
      chatId: "oc_1",
      openId: "ou_1",
      perm: "askHigh",
      gateMode: "gate",
    });
    const otherSession = { sessionID: "ses_other", action: "bash" } as { sessionID: string; action: string; effect?: string };
    await evaluate(otherSession);
    expect(otherSession.effect).toBe("ask");
  });

  test("会话内允许：伪造 token 被拒，不写入", async () => {
    cleanup = await setup({ permissionGate: "gate" });
    seedPermSession();
    await deliver(msg("你好", { messageId: "om_bootA2" }));
    const token = signAllowSession(
      { requestID: "per_1", sessionID: "ses_perm", action: "bash", ttlMs: 600_000 },
      deriveSignSecret("secret_test"),
    );
    const res = (await click({ cmd: "allow_session", a: "bash", t: `${token}x` })) as { toast: { content: string } };
    expect(res.toast.content).toContain("审批凭证无效");
    expect((storage.raw("feishu:v2:session:ses_perm") as { allowActions?: string[] }).allowActions).toBeUndefined();
  });

  // ── 任务 B：恢复卡标题 + 摘要（集成） ────────────────────────────────
  test("恢复卡：标题用会话主题；完整消息里的 compaction 摘要直接复用（不调用生成）", async () => {
    sessionListRaw = [
      { id: "ses_sum", title: "摘要会话", time: { updated: 1_700_000_000_000 }, location: { directory: "/home/ubuntu/work/app" } },
    ];
    // 完整消息通道：compaction 消息带 status:"completed" + summary。
    h.messagesRaw = { data: [{ type: "compaction", status: "completed", summary: "1. 已完成 X\n2. 下一步 Y" }] };
    // session.context 是精简形状（不含 summary）；即便有也不能用来复用。
    h.contextRaw = [{ type: "assistant", content: [{ type: "text", text: "不该被当成摘要" }] }];
    cleanup = await setup();
    await deliver(msg("你好", { messageId: "om_bootB" }));

    await click({ cmd: "open", s: "ses_sum", c: "oc_1" });
    // 恢复卡走主聊天流 create，标题 = 🔄 + 会话主题。
    await vi.waitFor(() => {
      expect(JSON.stringify(h.created.at(-1))).toContain("🔄 摘要会话");
    });
    // 机器人同时以 reply_in_thread 发了话题首条回复卡（opener）。
    expect(h.replied).toHaveLength(1);
    // 摘要在火后 patch 回同一张话题首条回复卡（复用 compaction 摘要，不产生生成调用）。
    await vi.waitFor(() => {
      expect(JSON.stringify(h.patched.at(-1))).toContain("1. 已完成 X");
    });
    expect(h.generateCalls).toHaveLength(0);
    expect(h.generateTextCalls).toHaveLength(0);

    const rootSet = storage.setCalls.find((c) => c.key.startsWith("feishu:v2:root:"));
    const cardId = rootSet!.key.replace("feishu:v2:root:", "");
    // 回复恢复卡：只带 root_id（无 thread_id）→ 路由到该会话并补写 thread。
    await deliver(msg("继续", { messageId: "om_sum_1", rootId: cardId, parentId: cardId }));
    expect(promptCalls.at(-1)).toEqual({ sessionID: "ses_sum", text: "继续" });
    expect((storage.raw("feishu:v2:thread:omt_from_get") as { sessionID: string }).sessionID).toBe("ses_sum");
  });

  test("恢复卡无原生摘要：走快摘要（无会话上下文的 generate.text），不调用 session.generate", async () => {
    sessionListRaw = [
      { id: "ses_fast", title: "快摘要会话", time: { updated: 1_700_000_000_000 }, location: { directory: "/home/ubuntu/work/app" } },
    ];
    h.messagesRaw = { data: [{ type: "user", text: "帮我改 bug" }, { type: "assistant", content: [{ type: "text", text: "好的" }] }] };
    h.generateRaw = { text: "快摘要结果" };
    cleanup = await setup();
    await deliver(msg("你好", { messageId: "om_bootFast" }));

    await click({ cmd: "open", s: "ses_fast", c: "oc_1" });
    await vi.waitFor(() => {
      expect(JSON.stringify(h.patched.at(-1))).toContain("快摘要结果");
    });
    // 关键：走临时生成（generate.text），**绝不**用会把整个会话喂进去的 session.generate。
    expect(h.generateTextCalls).toHaveLength(1);
    expect(h.generateTextCalls[0]).toContain("用户：帮我改 bug");
    expect(h.generateCalls).toHaveLength(0);
  });

  test("进入会话**绝不**隐式触发压缩（不调用 session.compact）", async () => {
    sessionListRaw = [
      { id: "ses_nc", title: "不压缩", time: { updated: 1_700_000_000_000 }, location: { directory: "/home/ubuntu/work/app" } },
    ];
    h.messagesRaw = { data: [{ type: "user", text: "hi" }] };
    cleanup = await setup();
    await deliver(msg("你好", { messageId: "om_bootNC" }));
    await click({ cmd: "open", s: "ses_nc", c: "oc_1" });
    await vi.waitFor(() => {
      expect(JSON.stringify(h.created.at(-1))).toContain("🔄 不压缩");
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.compactCalls).toHaveLength(0);
  });

  test("压缩按钮：点击 → 触发 session.compact；轮询到新摘要 → patch「已压缩 · 会话摘要」", async () => {
    sessionListRaw = [
      { id: "ses_cmp", title: "压缩会话", time: { updated: 1_700_000_000_000 }, location: { directory: "/home/ubuntu/work/app" } },
    ];
    h.messagesRaw = { data: [{ type: "user", text: "hi" }] };
    cleanup = await setup();
    await deliver(msg("你好", { messageId: "om_bootCmp" }));

    await click({ cmd: "open", s: "ses_cmp", c: "oc_1" });
    await vi.waitFor(() => {
      expect(JSON.stringify(h.created.at(-1))).toContain("🔄 压缩会话");
    });
    // 话题首条回复卡（opener）带压缩按钮（签名由插件生成）。
    const openerPayload = h.replied.at(-1);
    const cardJson = JSON.stringify((openerPayload as { data?: { content?: string } }).data?.content);
    expect(cardJson).toContain("🗜 压缩并总结");
    // 等快摘要 patch 完，拿到按钮 token。
    await vi.waitFor(() => {
      const patched = JSON.stringify(h.patched.at(-1));
      expect(patched).toContain("摘要");
    });
    // 压缩"完成"由 mock 的 session.compact 触发：之后消息里出现新的 completed 摘要。
    const token = extractCompactToken(openerPayload);
    expect(token).toBeTruthy();
    const res = (await click({ cmd: "compact", s: "ses_cmp", t: token })) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await vi.waitFor(() => expect(h.compactCalls).toHaveLength(1));
    await vi.waitFor(
      () => {
        expect(JSON.stringify(h.patched.at(-1))).toContain("已压缩 · 会话摘要");
      },
      { timeout: 6000 },
    );
  });

  test("压缩按钮：伪造 token 被拒，不调用 session.compact", async () => {
    sessionListRaw = [
      { id: "ses_bad", title: "坏token", time: { updated: 1_700_000_000_000 }, location: { directory: "/home/ubuntu/work/app" } },
    ];
    h.messagesRaw = { data: [{ type: "user", text: "hi" }] };
    cleanup = await setup();
    await deliver(msg("你好", { messageId: "om_bootBad" }));
    await click({ cmd: "open", s: "ses_bad", c: "oc_1" });
    await vi.waitFor(() => expect(JSON.stringify(h.created.at(-1))).toContain("🔄 坏token"));
    const token = extractCompactToken(h.replied.at(-1))!;
    const res = (await click({ cmd: "compact", s: "ses_bad", t: `${token}x` })) as { toast: { content: string } };
    expect(res.toast.content).toContain("操作凭证无效");
    expect(h.compactCalls).toHaveLength(0);
  });
});

/**
 * 从卡片消息 payload 里抠出压缩按钮的 token（集成测试用）。
 *
 * 卡片经 `sender.sendCard` 发出时是 `payload.content = JSON.stringify(card)`，
 * 所以 payload 序列化后引号被转义。这里递归所有字符串并重新解析，再匹配 value。
 */
function extractCompactToken(payload: unknown): string | undefined {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      texts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(payload);
  for (const text of texts) {
    const match = text.match(/"cmd":"compact","s":"[^"]+","t":"([^"]+)"/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
