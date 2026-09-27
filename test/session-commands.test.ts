import { describe, expect, test, vi } from "vitest";
import { SessionMap } from "../src/feishu/session-map.js";
import { SessionCommands, type CreateSessionInput } from "../src/session-commands.js";
import { WizardStore, WIZARD_KEY_PREFIX } from "../src/feishu/wizard.js";
import { RecentStore, RECENT_DIRS_KEY, RECENT_MODELS_KEY } from "../src/feishu/recent.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";
import type { DirValidation } from "../src/feishu/dirs.js";
import { createLogger } from "../src/logger.js";
import type { CardAction, IncomingMessage, ModelRef, PermissionPreset } from "../src/types.js";
import type { ModelEntry, ModelSwitchOutcome } from "../src/feishu/models.js";
import type {
  SessionSummaryOutcome,
  SummarizeSessionInput,
} from "../src/session/resume-summary.js";
import { FakeStorage } from "./helpers.js";

const log = createLogger({ level: "error", sink: () => undefined });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

const MODELS: ModelEntry[] = [
  { providerID: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { providerID: "openai", id: "gpt-5", name: "GPT-5" },
  { providerID: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
];

class FakeSender implements FeishuSender {
  readonly cards: Array<{ chatId: string; card: object }> = [];
  readonly patched: Array<{ messageId: string; card: object }> = [];
  readonly texts: string[] = [];
  readonly replies: Array<{ messageId: string; text: string; replyInThread?: boolean }> = [];
  readonly repliedCards: Array<{ messageId: string; card: object; replyInThread?: boolean }> = [];
  threadIdFor: (messageId: string) => string | undefined = () => undefined;
  failReply = false;
  /** 发送恢复卡（sendCard）失败开关（不改生产代码，仅测试用）。 */
  failSendCard = false;
  /** getMessageMeta 调用次数（校验恢复卡阶段不再读回元数据）。 */
  metaCalls = 0;

  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    this.cards.push({ chatId, card });
    if (this.failSendCard) return { ok: false, error: "boom" };
    return { ok: true, messageId: `om_card_${this.cards.length}` };
  }
  async replyCard(messageId: string, card: object, opts?: { replyInThread?: boolean }): Promise<SendCardResult> {
    this.repliedCards.push({ messageId, card, ...(opts?.replyInThread ? { replyInThread: true } : {}) });
    if (this.failReply) return { ok: false, error: "boom" };
    return { ok: true, messageId: "om_ready" };
  }
  async patchCard(messageId: string, card: object): Promise<{ ok: boolean; error?: string }> {
    this.patched.push({ messageId, card });
    return { ok: true };
  }
  async sendText(chatId: string, text: string): Promise<SendCardResult> {
    this.texts.push(text);
    return { ok: true, messageId: "om_text" };
  }
  async replyText(messageId: string, text: string, opts?: { replyInThread?: boolean }): Promise<SendCardResult> {
    this.replies.push({ messageId, text, ...(opts?.replyInThread ? { replyInThread: true } : {}) });
    return { ok: true, messageId: "om_reply" };
  }
  async getMessageMeta(messageId: string): Promise<{ threadId?: string } | undefined> {
    this.metaCalls += 1;
    const threadId = this.threadIdFor(messageId);
    return threadId ? { threadId } : undefined;
  }
  async deleteMessage(): Promise<void> {}
}

function message(text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    eventId: "ev_1",
    messageId: "om_in",
    chatId: "oc_1",
    chatType: "p2p",
    messageType: "text",
    text,
    senderOpenId: "ou_1",
    ...extra,
  };
}

const threadMsg = (text: string, extra: Partial<IncomingMessage> = {}) =>
  message(text, { messageId: "om_t", threadId: "omt_1", rootId: "om_root", parentId: "om_root", ...extra });

/**
 * 假目录校验（模拟 dirs.ts 的目录容错规则）：
 * - 留空 → 允许根目录 `/home/ubuntu`；
 * - `/home/ubuntu` 或其下（含不存在，视为自动创建）→ 允许；
 * - 其它 → 越界拒绝。
 */
function fakeValidate(path: string): DirValidation {
  const p = path.trim() || "/home/ubuntu";
  if (p === "/home/ubuntu" || p.startsWith("/home/ubuntu/")) {
    return { ok: true, path: p };
  }
  return { ok: false, reason: "outside_allowed", message: `目录不在允许范围内：${path}` };
}

function setup(
  over: {
    allowed?: boolean;
    threadRouting?: boolean;
    promoted?: number;
    allSessions?: () => Promise<unknown>;
    getSession?: (sessionID: string) => Promise<unknown>;
    sessionPageSize?: number;
    /** 覆盖模型切换实现（返回 ModelSwitchOutcome | undefined）。 */
    switchImpl?: (sessionID: string, model: ModelRef) => Promise<ModelSwitchOutcome | undefined>;
    /** true = 切换抛错（模拟无权限/会话不存在）。 */
    switchThrows?: boolean;
    /** 覆盖读回模型（`getSessionModel`）。 */
    sessionModel?: (sessionID: string) => Promise<ModelRef | undefined>;
    /** 任务 B：恢复卡摘要获取实现。 */
    summarizeSession?: (input: SummarizeSessionInput) => Promise<SessionSummaryOutcome>;
    /** 任务 B：是否启用摘要（默认 false，不影响既有用例）。 */
    resumeSummary?: boolean;
    resumeSummaryTimeoutMs?: number;
  } = {},
) {
  const storage = new FakeStorage();
  const sessionMap = new SessionMap(storage, log, { now: () => 1000 });
  const sender = new FakeSender();
  const wizard = new WizardStore(storage, log);
  const recent = new RecentStore(storage, log, { dirs: 5, models: 5 });
  let seq = 0;
  const createSession = vi.fn(async (input: CreateSessionInput) => {
    const id = `ses_new_${++seq}`;
    // 模拟 index 的 createSessionInternal：建会话后写入映射（含 setActive 语义）。
    await sessionMap.addSession(input.chatId, id, input.title, input.openId, { setActive: input.setActive ?? true });
    return { id };
  });
  const interruptSession = vi.fn(async (_sessionID: string) => undefined);
  const switchSessionModel = over.switchThrows
    ? vi.fn(async (_sessionID: string, _model: ModelRef): Promise<ModelSwitchOutcome | undefined> => {
        throw new Error("permission denied");
      })
    : over.switchImpl
      ? vi.fn(over.switchImpl)
      : vi.fn(async (_sessionID: string, _model: ModelRef): Promise<ModelSwitchOutcome | undefined> => undefined);
  const applyPermissionPreset = vi.fn(async (_sessionID: string, _preset: PermissionPreset) => undefined);
  const moveSessionDir = vi.fn(async (_sessionID: string, _dir: string) => undefined);
  const steerPrompt = vi.fn(async (_message: IncomingMessage, _sessionID: string, _text: string) => undefined);
  const promoteQueued = vi.fn(async (_sessionID: string) => over.promoted ?? 0);
  // 表单目录下拉来源：注入固定的一级子目录，避免测试触碰真实文件系统。
  const scanRootSubdirs = vi.fn(async (root: string) => [
    { path: `${root}/my-app`, isRepo: true },
    { path: `${root}/other`, isRepo: false },
  ]);
  const commands = new SessionCommands({
    log,
    sessionMap,
    sender,
    wizard,
    recent,
    isAllowed: () => over.allowed ?? true,
    createSession,
    interruptSession,
    listModels: async () => MODELS,
    switchSessionModel,
    ...(over.sessionModel ? { getSessionModel: over.sessionModel } : {}),
    applyPermissionPreset,
    moveSessionDir,
    steerPrompt,
    promoteQueued,
    validateDir: fakeValidate,
    allowedRoots: ["/home/ubuntu"],
    scanRootSubdirs,
    threadRouting: over.threadRouting ?? true,
    now: () => 1000,
    ...(over.allSessions ? { listAllSessions: over.allSessions } : {}),
    ...(over.getSession ? { getSessionInfo: over.getSession } : {}),
    ...(over.sessionPageSize ? { sessionPageSize: over.sessionPageSize } : {}),
    ...(over.summarizeSession ? { summarizeSession: over.summarizeSession } : {}),
    ...(over.resumeSummary !== undefined ? { resumeSummary: over.resumeSummary } : {}),
    ...(over.resumeSummaryTimeoutMs !== undefined ? { resumeSummaryTimeoutMs: over.resumeSummaryTimeoutMs } : {}),
  });
  return {
    commands,
    sessionMap,
    sender,
    wizard,
    recent,
    createSession,
    interruptSession,
    switchSessionModel,
    applyPermissionPreset,
    moveSessionDir,
    steerPrompt,
    promoteQueued,
    scanRootSubdirs,
    storage,
  };
}

describe("SessionCommands.handleText（主聊天流）", () => {
  test("非命令返回 false 且无副作用", async () => {
    const { commands, sender, createSession } = setup();
    expect(await commands.handleText(message("你好"))).toBe(false);
    expect(sender.texts).toHaveLength(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  test("/new 直接发建会话表单卡（与 /form 等价）、不建会话、标题写入向导", async () => {
    const { commands, sender, createSession, wizard } = setup();
    expect(await commands.handleText(message("/new 我的标题"))).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(sender.cards).toHaveLength(1);
    const roots = (sender.cards[0]!.card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    expect(roots[0]!.tag).toBe("form");
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("setup_submit");
    const state = await wizard.get("oc_1");
    expect(state?.title).toBe("我的标题");
    expect(state?.anchorMessageId).toBe("om_in");
  });

  test("/new 与 /form 等价：都直接发表单卡，且 /new <标题> 预填标题", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/new 标题A"));
    const newCard = JSON.stringify(sender.cards.at(-1)!.card);
    await commands.handleText(message("/form"));
    const formCard = JSON.stringify(sender.cards.at(-1)!.card);
    expect(newCard).toContain("setup_form");
    expect(formCard).toContain("setup_form");
    // /form 复用已有向导状态 → 标题仍保留
    expect((await wizard.get("oc_1"))?.title).toBe("标题A");
    // /new 后再 /new <新标题> 覆盖标题
    await commands.handleText(message("/new 标题B"));
    expect((await wizard.get("oc_1"))?.title).toBe("标题B");
  });

  test("/dir 合法：写最近目录 + 目录作为表单预填（不再进分步模型卡）", async () => {
    const { commands, sender, wizard, recent } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /home/ubuntu/work/my-app"));
    const state = await wizard.get("oc_1");
    expect(state?.dir).toBe("/home/ubuntu/work/my-app");
    expect(await recent.listDirs()).toEqual(["/home/ubuntu/work/my-app"]);
    const roots = (sender.cards.at(-1)!.card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    expect(roots[0]!.tag).toBe("form");
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain("/home/ubuntu/work/my-app");
  });

  test("/dir 非法：回复错误且不改步骤", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /etc"));
    expect(sender.texts.join("\n")).toContain("不在允许范围内");
    // 校验失败不应写入目录
    expect((await wizard.get("oc_1"))?.dir).toBeUndefined();
  });

  test("/dir 留空 → 使用允许根目录（不报错，作为表单预填）", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir"));
    const state = await wizard.get("oc_1");
    expect(state?.dir).toBe("/home/ubuntu");
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain("/home/ubuntu");
  });

  test("/dir 不存在 → 目录容错：允许（视为自动创建）并预填", async () => {
    const { commands, wizard, sender } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /home/ubuntu/work/brand-new"));
    expect((await wizard.get("oc_1"))?.dir).toBe("/home/ubuntu/work/brand-new");
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain("/home/ubuntu/work/brand-new");
  });

  test("/model 唯一命中：写入向导并发表单卡预填模型", async () => {
    const { commands, sender, wizard, recent } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /home/ubuntu/work/app"));
    await commands.handleText(message("/model claude"));
    const state = await wizard.get("oc_1");
    expect(state?.model?.id).toBe("claude-sonnet-4");
    expect((await recent.listModels())[0]?.id).toBe("claude-sonnet-4");
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain("claude-sonnet-4");
  });

  test("/model 歧义：列出候选且不改步骤", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /home/ubuntu/work/app"));
    await commands.handleText(message("/model gpt"));
    expect(sender.texts.join("\n")).toContain("匹配到多个模型");
    expect((await wizard.get("oc_1"))?.step).toBe("model");
  });

  test("/model 无匹配", async () => {
    const { commands, sender } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /home/ubuntu/work/app"));
    await commands.handleText(message("/model zzz"));
    expect(sender.texts.join("\n")).toContain("没有匹配的模型");
  });

  test("/perm <档位>：写入向导并发表单卡预填权限", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/new 标题"));
    await commands.handleText(message("/dir /home/ubuntu/work/app"));
    await commands.handleText(message("/model claude"));
    await commands.handleText(message("/perm edit"));
    const state = await wizard.get("oc_1");
    expect(state?.perm).toBe("edit");
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain('"initial_option":"edit"');
  });

  test("/perm 非法档位提示可用档位", async () => {
    const { commands, sender } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/perm bogus"));
    expect(sender.texts.join("\n")).toContain("未知权限档位");
  });

  test("/cancel 清空向导", async () => {
    const { commands, sender, wizard, storage } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/cancel"));
    expect(await wizard.get("oc_1")).toBeUndefined();
    expect(storage.raw(`${WIZARD_KEY_PREFIX}oc_1`)).toBeUndefined();
    expect(sender.texts.join("\n")).toContain("已取消");
  });

  test("/model 在向导缺失时自动起向导并发表单卡（不再报错）", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/model claude"));
    expect((await wizard.get("oc_1"))?.model?.id).toBe("claude-sonnet-4");
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain("setup_form");
  });

  test("/sessions 发送会话卡片（无 list 源时回退 SessionMap）", async () => {
    const { commands, sessionMap, sender } = setup();
    await sessionMap.addSession("oc_1", "ses_1", "一", "ou_1");
    await commands.handleText(message("/ls"));
    expect(sender.cards).toHaveLength(1);
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("ses_1");
  });

  test("/use 2 切换当前会话", async () => {
    const { commands, sessionMap, sender } = setup();
    await sessionMap.addSession("oc_1", "ses_1", "一", "ou_1");
    await sessionMap.addSession("oc_1", "ses_2", "二", "ou_1");
    await commands.handleText(message("/use 2"));
    expect((await sessionMap.getActive("oc_1"))?.sessionID).toBe("ses_2");
    expect(sender.texts.join("\n")).toContain("二");
  });

  test("/current 展示当前会话", async () => {
    const { commands, sessionMap, sender } = setup();
    await sessionMap.addSession("oc_1", "ses_1", "当前标题", "ou_1");
    await commands.handleText(message("/current"));
    expect(sender.texts.join("\n")).toContain("当前标题");
  });

  test("/stop 调用 interrupt", async () => {
    const { commands, sessionMap, interruptSession } = setup();
    await sessionMap.addSession("oc_1", "ses_1", "一", "ou_1");
    await commands.handleText(message("/stop"));
    expect(interruptSession).toHaveBeenCalledWith("ses_1");
  });

  test("/cd 在主聊天流给出话题内使用提示", async () => {
    const { commands, sender } = setup();
    await commands.handleText(message("/cd /home/ubuntu/work/x"));
    expect(sender.texts.join("\n")).toContain("只能在话题内使用");
  });

  test("threadRouting=false：/new 沿用旧行为（直接建会话 + 文本回执）", async () => {
    const { commands, sender, createSession, sessionMap } = setup({ threadRouting: false });
    await commands.handleText(message("/new 旧行为"));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].title).toBe("旧行为");
    expect(sender.repliedCards).toHaveLength(0);
    expect(await sessionMap.getActive("oc_1")).toBeDefined();
  });

  test("未知命令回帮助提示", async () => {
    const { commands, sender, createSession } = setup();
    expect(await commands.handleText(message("/frobnicate"))).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(sender.texts.join("\n")).toContain("/sessions");
  });
});

describe("SessionCommands 话题内命令矩阵（P5.2 白名单）", () => {
  test("话题内 /new /sessions /use /dir /cancel 被拒 → 提示去主聊天流，且无副作用", async () => {
    const { commands, sender, createSession, sessionMap } = setup();
    await commands.handleText(threadMsg("/new 标题"));
    await commands.handleText(threadMsg("/sessions"));
    await commands.handleText(threadMsg("/use 1"));
    await commands.handleText(threadMsg("/dir /home/ubuntu/work/x"));
    await commands.handleText(threadMsg("/cancel"));
    expect(createSession).not.toHaveBeenCalled();
    expect(sender.cards).toHaveLength(0);
    expect(sender.replies).toHaveLength(5);
    expect(sender.replies.every((r) => r.messageId === "om_t")).toBe(true);
    expect(sender.replies[0]!.text).toContain("主聊天流");
    expect(await sessionMap.listSessions("oc_1")).toEqual([]);
  });

  test("话题内 /help 列出 model/perm/cd 且不含被禁命令", async () => {
    const { commands, sender } = setup();
    await commands.handleText(threadMsg("/help"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("/current");
    expect(text).toContain("/model");
    expect(text).toContain("/perm");
    expect(text).toContain("/cd");
    expect(text).not.toContain("`/new [标题]`");
    expect(text).not.toContain("`/dir <绝对路径>`");
  });

  test("话题内 /model <关键词> 切换本话题会话模型", async () => {
    const { commands, sender, sessionMap, switchSessionModel, recent } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/model claude"));
    expect(switchSessionModel).toHaveBeenCalledWith("ses_t", expect.objectContaining({ id: "claude-sonnet-4" }));
    expect((await recent.listModels())[0]?.id).toBe("claude-sonnet-4");
    expect(sender.replies.at(-1)!.text).toContain("已切换模型");
  });

  test("话题内 /model 切换成功：回执以读回的真实值为准", async () => {
    const { commands, sender, sessionMap } = setup({
      switchImpl: async (_sid, model) => ({
        requested: model,
        // 读回值故意不带 name，验证回执用的是读回值而非请求值。
        effective: { providerID: "anthropic", id: "claude-sonnet-4" },
        verified: true,
      }),
    });
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/model claude"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("已切换模型");
    expect(text).toContain("anthropic/claude-sonnet-4");
    expect(text).toContain("后续");
  });

  test("话题内 /model 读回不一致：明确告知可能未生效，不假装成功", async () => {
    const { commands, sender, sessionMap } = setup({
      switchImpl: async (_sid, model) => ({
        requested: model,
        effective: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
        verified: true,
        mismatch: true,
        warning: "请求不一致",
      }),
    });
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/model claude"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("可能未生效");
    expect(text).not.toContain("✅ 已切换模型");
    expect(text).toContain("deepseek-v4.1-flash");
  });

  test("话题内 /model 读回失败：降级为请求值并说明未校验", async () => {
    const { commands, sender, sessionMap } = setup({
      switchImpl: async (_sid, model) => ({
        requested: model,
        effective: model,
        verified: false,
        warning: "切换后未能读回校验模型",
      }),
    });
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/model claude"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("未能读回");
    expect(text).toContain("Claude Sonnet 4");
  });

  test("话题内 /model 切换抛错：回执错误原因，不误报成功", async () => {
    const { commands, sender, sessionMap } = setup({ switchThrows: true });
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/model claude"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("切换模型失败");
    expect(text).toContain("permission denied");
    expect(text).not.toContain("已切换模型");
  });

  test("话题内 /current：模型显示读回真实值（优先于记录值）", async () => {
    const { commands, sender, sessionMap } = setup({
      sessionModel: async () => ({ providerID: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }),
    });
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.setSessionMeta("ses_t", {
      model: { providerID: "opencode-go", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/current"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("DeepSeek V4.1 Flash");
    expect(text).not.toContain("GLM 5.3 Flash");
  });

  test("话题内 /current：读回失败时降级显示记录值", async () => {
    const { commands, sender, sessionMap } = setup({
      sessionModel: async () => {
        throw new Error("read-back boom");
      },
    });
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.setSessionMeta("ses_t", {
      model: { providerID: "opencode-go", id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/current"));
    expect(sender.replies.at(-1)!.text).toContain("GLM 5.3 Flash");
  });

  test("话题内 /model 无参：发带 sid 的模型卡（reply 落话题）", async () => {
    const { commands, sender, sessionMap } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/model"));
    expect(sender.repliedCards.at(-1)!.messageId).toBe("om_t");
    expect(JSON.stringify(sender.repliedCards.at(-1)!.card)).toContain("选择模型");
  });

  test("话题内 /perm edit 修改本会话权限", async () => {
    const { commands, sender, sessionMap, applyPermissionPreset } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/perm edit"));
    expect(applyPermissionPreset).toHaveBeenCalledWith("ses_t", "edit");
    expect(sender.replies.at(-1)!.text).toContain("已更新本会话权限");
  });

  test("话题内 /cd 合法目录：调用 moveSessionDir + 写最近目录", async () => {
    const { commands, sender, sessionMap, moveSessionDir, recent } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/cd /home/ubuntu/work/next"));
    expect(moveSessionDir).toHaveBeenCalledWith("ses_t", "/home/ubuntu/work/next");
    expect(await recent.listDirs()).toEqual(["/home/ubuntu/work/next"]);
    expect(sender.replies.at(-1)!.text).toContain("已切换本会话目录");
  });

  test("话题内 /cd 非法目录：报错且不 move", async () => {
    const { commands, sender, sessionMap, moveSessionDir } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/cd /etc"));
    expect(moveSessionDir).not.toHaveBeenCalled();
    expect(sender.replies.at(-1)!.text).toContain("不在允许范围内");
  });

  test("话题内 /cd 留空 → 回到允许根目录", async () => {
    const { commands, sessionMap, moveSessionDir, recent } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/cd"));
    expect(moveSessionDir).toHaveBeenCalledWith("ses_t", "/home/ubuntu");
    expect(await recent.listDirs()).toContain("/home/ubuntu");
  });

  test("话题内 /cd 不存在 → 目录容错：允许（视为自动创建）", async () => {
    const { commands, sessionMap, moveSessionDir } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/cd /home/ubuntu/work/created-now"));
    expect(moveSessionDir).toHaveBeenCalledWith("ses_t", "/home/ubuntu/work/created-now");
  });

  test("话题内 /stop 中断本话题会话；/current 展示 dir/model/perm", async () => {
    const { commands, sender, sessionMap, interruptSession } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "话题会话", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await sessionMap.setSessionMeta("ses_t", { dir: "/home/ubuntu/work/x", perm: "edit", model: MODELS[0]! });
    await commands.handleText(threadMsg("/current"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("话题会话");
    expect(text).toContain("/home/ubuntu/work/x");
    expect(text).toContain("Claude Sonnet 4");
    expect(text).toContain("可编辑");

    await commands.handleText(threadMsg("/stop"));
    expect(interruptSession).toHaveBeenCalledWith("ses_t");
  });

  test("话题内未关联会话时 /model /perm /cd 给提示", async () => {
    const { commands, sender } = setup();
    await commands.handleText(threadMsg("/model claude"));
    await commands.handleText(threadMsg("/perm edit"));
    await commands.handleText(threadMsg("/cd /home/ubuntu/work/x"));
    expect(sender.replies.every((r) => r.text.includes("尚未关联会话"))).toBe(true);
  });
});

describe("SessionCommands 向导卡片回调", () => {
  test("（deprecated）确认卡创建：createSession 带 dir/model/permissions/perm/gateMode + reply_in_thread + 绑定", async () => {
    const { commands, sender, wizard, createSession, sessionMap } = setup();
    sender.threadIdFor = (id) => (id === "om_ready" ? "omt_new" : undefined);
    await commands.handleText(message("/new 我的项目"));
    await commands.handleText(message("/dir /home/ubuntu/work/app"));
    await commands.handleText(message("/model claude"));
    await commands.handleText(message("/perm edit"));

    const res = commands.handleCardAction({
      rawValue: { wizard: "confirm" },
      messageId: "om_confirm",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await flush();

    expect(createSession).toHaveBeenCalledTimes(1);
    const input = createSession.mock.calls[0]![0];
    expect(input.directory).toBe("/home/ubuntu/work/app");
    expect(input.model?.id).toBe("claude-sonnet-4");
    expect(input.perm).toBe("edit");
    expect(input.gateMode).toBe("gate");
    expect(input.permissions).toEqual(
      expect.arrayContaining([{ action: "edit", resource: "*", effect: "allow" }]),
    );
    // 话题锚点 = 触发消息本身（不再发独立锚点文本）
    expect(sender.texts).toHaveLength(0);
    expect(sender.repliedCards).toHaveLength(1);
    expect(sender.repliedCards[0]!.messageId).toBe("om_confirm");
    expect(sender.repliedCards[0]!.replyInThread).toBe(true);
    const ready = JSON.stringify(sender.repliedCards[0]!.card);
    expect(ready).toContain("我的项目");
    expect(ready).toContain("Claude Sonnet 4");
    expect((await sessionMap.resolveByThread("omt_new"))?.sessionID).toBe("ses_new_1");
    expect((await sessionMap.resolveByRoot("om_confirm"))?.sessionID).toBe("ses_new_1");
    // 触发卡被改写为「已创建」成功卡
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("✅ 已创建 · 我的项目");
    // 向导清空
    expect(await wizard.get("oc_1")).toBeUndefined();
  });

  test("目录按钮推进到模型步（patch 同一卡片）", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/new"));
    const res = commands.handleCardAction({
      rawValue: { wizard: "dir", d: "/home/ubuntu/work/picked" },
      messageId: "om_setup",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await flush();
    expect((await wizard.get("oc_1"))?.step).toBe("model");
    expect(sender.patched.at(-1)!.messageId).toBe("om_setup");
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("选择模型");
  });

  test("取消按钮清空向导并 patch 结果卡", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/new"));
    commands.handleCardAction({
      rawValue: { wizard: "cancel" },
      messageId: "om_setup",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(await wizard.get("oc_1")).toBeUndefined();
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("已取消");
  });

  test("会话内权限按钮（带 sid）：直接改该会话并 patch", async () => {
    const { commands, sender, applyPermissionPreset } = setup();
    commands.handleCardAction({
      rawValue: { wizard: "perm", v: "trust", sid: "ses_t" },
      messageId: "om_perm",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(applyPermissionPreset).toHaveBeenCalledWith("ses_t", "trust");
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("已更新权限");
  });

  test("会话内模型按钮（带 sid）：切换模型并 patch", async () => {
    const { commands, sender, switchSessionModel } = setup();
    commands.handleCardAction({
      rawValue: { wizard: "model", p: "openai", m: "gpt-5", n: "GPT-5", sid: "ses_t" },
      messageId: "om_model",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(switchSessionModel).toHaveBeenCalledWith("ses_t", expect.objectContaining({ id: "gpt-5" }));
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("已切换模型");
  });

  test("会话内模型按钮：读回不一致 → patch 提示未生效（不显示成功）", async () => {
    const { commands, sender } = setup({
      switchImpl: async (_sid, model) => ({
        requested: model,
        effective: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
        verified: true,
        mismatch: true,
      }),
    });
    commands.handleCardAction({
      rawValue: { wizard: "model", p: "openai", m: "gpt-5", n: "GPT-5", sid: "ses_t" },
      messageId: "om_model",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    const card = JSON.stringify(sender.patched.at(-1)!.card);
    expect(card).toContain("可能未生效");
    expect(card).not.toContain("✅ 已切换模型");
  });

  test("会话内模型按钮：切换抛错 → patch 错误原因", async () => {
    const { commands, sender } = setup({ switchThrows: true });
    commands.handleCardAction({
      rawValue: { wizard: "model", p: "openai", m: "gpt-5", sid: "ses_t" },
      messageId: "om_model",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    const card = JSON.stringify(sender.patched.at(-1)!.card);
    expect(card).toContain("切换模型失败");
    expect(card).not.toContain("已切换模型");
  });
});

describe("SessionCommands 会话卡片回调", () => {
  const useAction: CardAction = {
    rawValue: { cmd: "use", s: "ses_2", c: "oc_1" },
    messageId: "om_card",
    chatId: "oc_1",
    operatorOpenId: "ou_1",
  };

  test("非白名单用户被拒，无副作用", async () => {
    const { commands, sessionMap } = setup({ allowed: false });
    await sessionMap.addSession("oc_1", "ses_1", "一", "ou_1");
    const res = commands.handleCardAction(useAction) as { toast: { type: string } };
    expect(res.toast.type).toBe("error");
    await tick();
    expect((await sessionMap.getActive("oc_1"))?.sessionID).toBe("ses_1");
  });

  test("use：同步 toast + 后台切换 + 刷新卡片", async () => {
    const { commands, sessionMap, sender } = setup();
    await sessionMap.addSession("oc_1", "ses_1", "一", "ou_1");
    await sessionMap.addSession("oc_1", "ses_2", "二", "ou_1");

    const res = commands.handleCardAction(useAction) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await tick();
    expect((await sessionMap.getActive("oc_1"))?.sessionID).toBe("ses_2");
    expect(sender.patched).toHaveLength(1);
    expect(sender.patched[0]!.messageId).toBe("om_card");
  });

  test("new：打开建会话表单卡（不再直接建会话，不 patch）", async () => {
    const { commands, sender, createSession } = setup();
    const res = commands.handleCardAction({
      rawValue: { cmd: "new", c: "oc_1" },
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await flush();
    expect(createSession).not.toHaveBeenCalled();
    expect(sender.patched).toHaveLength(0);
    expect(sender.cards).toHaveLength(1);
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("setup_submit");
  });

  test("审批卡 value 不会被会话/向导路由误处理", () => {
    const { commands } = setup();
    const res = commands.handleCardAction({
      rawValue: { t: "tok", d: "once" },
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
  });
});

function buttonValues(card: object): unknown[] {
  // 递归收集：会话行按钮现在嵌在 column_set → column 内。
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec.tag === "button") out.push((rec.behaviors as Array<{ value: unknown }>)[0]?.value);
    for (const v of Object.values(rec)) walk(v);
  };
  walk((card as { body: { elements: unknown } }).body.elements);
  return out;
}

describe("SessionCommands /sessions（全量列表 + 分页 + 已绑标记）", () => {
  const sessionsRaw = (n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `ses_${String(i).padStart(2, "0")}`,
      title: `会话 ${i}`,
      time: { updated: 1_000_000 - i * 1000 },
      location: { directory: `/home/ubuntu/work/app${i}` },
    }));

  const openAction = (sessionID: string, operatorOpenId = "ou_1") => ({
    rawValue: { cmd: "open", s: sessionID, c: "oc_1" },
    messageId: "om_list",
    chatId: "oc_1",
    operatorOpenId,
  });

  test("全量列表：按最近更新倒序 + 目录尾段 + 总数", async () => {
    const { commands, sender } = setup({ allSessions: async () => ({ data: sessionsRaw(3) }) });
    await commands.handleText(message("/ls"));
    const text = JSON.stringify(sender.cards[0]!.card);
    const i0 = text.indexOf("会话 0");
    const i1 = text.indexOf("会话 1");
    const i2 = text.indexOf("会话 2");
    expect(i0).toBeGreaterThan(-1);
    expect(i0).toBeLessThan(i1);
    expect(i1).toBeLessThan(i2);
    expect(text).toContain("📍 app1");
    expect(text).toContain("共 3 个会话");
    expect(buttonValues(sender.cards[0]!.card)).toContainEqual({ cmd: "open", s: "ses_00", c: "oc_1" });
  });

  test("已绑话题标记：bindThread 后显示已绑 / 再开话题", async () => {
    const { commands, sender, sessionMap } = setup({ allSessions: async () => ({ data: sessionsRaw(2) }) });
    await sessionMap.bindThread("omt_0", "ses_00", "oc_1", "ou_1", "om_root");
    await commands.handleText(message("/ls"));
    const text = JSON.stringify(sender.cards[0]!.card);
    expect(text).toContain("💬 已绑话题");
    expect(text).toContain("▶️ 再开");
    expect(text).toContain("▶️ 进入");
    expect(await sessionMap.threadIdForSession("ses_00")).toBe("omt_0");
  });

  test("分页：每页 5 条；翻页 patch 同一卡片到第 2 页", async () => {
    const { commands, sender } = setup({ allSessions: async () => ({ data: sessionsRaw(7) }), sessionPageSize: 5 });
    await commands.handleText(message("/ls"));
    expect(buttonValues(sender.cards[0]!.card)).toContainEqual({ cmd: "list", p: 1, c: "oc_1" });
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("第 1/2 页 · 共 7 个会话");

    const res = commands.handleCardAction({
      rawValue: { cmd: "list", p: 1, c: "oc_1" },
      messageId: "om_list",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("info");
    await flush();
    expect(sender.patched.at(-1)!.messageId).toBe("om_list");
    const patched = JSON.stringify(sender.patched.at(-1)!.card);
    expect(patched).toContain("第 2/2 页 · 共 7 个会话");
    expect(patched).toContain("会话 6");
  });

  test("回退：session.list 抛错 → 用 SessionMap 映射表列表", async () => {
    const { commands, sender, sessionMap } = setup({
      allSessions: async () => {
        throw new Error("boom");
      },
    });
    await sessionMap.addSession("oc_1", "ses_map", "映射会话", "ou_1");
    await commands.handleText(message("/ls"));
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("ses_map");
  });

  test("回退：形状不可识别 → SessionMap 映射表列表", async () => {
    const { commands, sender, sessionMap } = setup({ allSessions: async () => ({ foo: 1 }) });
    await sessionMap.addSession("oc_1", "ses_map2", "映射会话2", "ou_1");
    await commands.handleText(message("/ls"));
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("ses_map2");
  });

  test("非白名单用户点击 open 被拒且无副作用", async () => {
    const { commands, sender } = setup({
      allowed: false,
      allSessions: async () => ({ data: sessionsRaw(1) }),
      getSession: async () => ({ id: "ses_00" }),
    });
    const res = commands.handleCardAction(openAction("ses_00", "ou_intruder")) as {
      toast: { type: string };
    };
    expect(res.toast.type).toBe("error");
    await tick();
    expect(sender.repliedCards).toHaveLength(0);
  });
});

describe("SessionCommands 进入话题（open 动作）", () => {
  const raw = { id: "ses_old", title: "历史会话", time: { updated: 900 }, location: { directory: "/home/ubuntu/work/app" } };
  const action = {
    rawValue: { cmd: "open", s: "ses_old", c: "oc_1" },
    messageId: "om_list",
    chatId: "oc_1",
    operatorOpenId: "ou_1",
  };

  test("会话存在：主聊天流发恢复卡 + bindRoot（此时无 thread）", async () => {
    const { commands, sender, sessionMap } = setup({ getSession: async () => raw });

    const res = (await commands.handleCardAction(action)) as { toast: { type: string; content: string } };
    expect(res.toast.content).toContain("进入话题");
    await flush();

    // 恢复卡发在主聊天流（sendCard），不是 reply_in_thread。
    expect(sender.repliedCards).toHaveLength(0);
    const opened = sender.cards.at(-1)!;
    expect(opened.chatId).toBe("oc_1");
    const cardText = JSON.stringify(opened.card);
    expect(cardText).toContain("🔄 历史会话");
    expect(cardText).toContain("ses_old");
    expect(cardText).toContain("/home/ubuntu/work/app");

    // 只绑 root（卡片消息 id）；thread_id 要等用户首次回复后才产生。
    expect((await sessionMap.resolveByRoot("om_card_1"))?.sessionID).toBe("ses_old");
    expect(await sessionMap.threadIdForSession("ses_old")).toBeUndefined();
    // 恢复卡阶段不再读回消息元数据。
    expect(sender.metaCalls).toBe(0);
  });

  test("只影响被点的那一个会话：其它会话不被绑定", async () => {
    const { commands, sender, sessionMap } = setup({ getSession: async () => raw });
    await sessionMap.addSession("oc_1", "ses_other", "其它会话", "ou_1", { setActive: false });

    await commands.handleCardAction(action);
    await flush();

    expect((await sessionMap.resolveByRoot("om_card_1"))?.sessionID).toBe("ses_old");
    expect(await sessionMap.threadIdForSession("ses_old")).toBeUndefined();
    expect(await sessionMap.threadIdForSession("ses_other")).toBeUndefined();
    expect(await sessionMap.resolveBySession("ses_other")).toBeDefined();
    // 只发了一张恢复卡，且没有对别的会话做任何 reply。
    expect(sender.cards).toHaveLength(1);
    expect(sender.repliedCards).toHaveLength(0);
  });

  test("会话不存在：toast「会话不存在」+ patch 提示卡 + 不发恢复卡", async () => {
    const { commands, sender } = setup({ getSession: async () => undefined });
    const res = (await commands.handleCardAction(action)) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
    expect(res.toast.content).toContain("会话不存在");
    await flush();
    expect(sender.cards).toHaveLength(0);
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("会话不存在");
  });

  test("发送恢复卡失败 → patch 提示卡、不绑定", async () => {
    const { commands, sender, sessionMap } = setup({ getSession: async () => raw });
    sender.failSendCard = true;
    await commands.handleCardAction(action);
    await flush();
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("会话不存在");
    expect(await sessionMap.threadIdForSession("ses_old")).toBeUndefined();
    expect(await sessionMap.resolveByRoot("om_card_1")).toBeUndefined();
    expect(sender.repliedCards).toHaveLength(0);
  });
});

describe("SessionCommands /resume（续聊历史会话）", () => {
  const rawSessions = [
    { id: "ses_newest", title: "最新", time: { updated: 2000 }, location: { directory: "/home/ubuntu/work/a" } },
    { id: "ses_mid", title: "中间", time: { updated: 1000 } },
  ];
  const base = {
    allSessions: async () => ({ data: rawSessions }),
    getSession: async () => rawSessions[0],
  };

  test("/resume（无参）对最近更新的会话直接发恢复卡并绑 root", async () => {
    const { commands, sender, sessionMap } = setup(base);
    await commands.handleText(message("/resume"));
    const opened = sender.cards.at(-1)!;
    expect(JSON.stringify(opened.card)).toContain("🔄 最新");
    expect(JSON.stringify(opened.card)).toContain("ses_newest");
    expect((await sessionMap.resolveByRoot("om_card_1"))?.sessionID).toBe("ses_newest");
    expect(await sessionMap.threadIdForSession("ses_newest")).toBeUndefined();
    expect(await sessionMap.threadIdForSession("ses_mid")).toBeUndefined();
  });

  test("/resume 2 选列表第 2 个会话", async () => {
    const { commands, sender, sessionMap } = setup(base);
    await commands.handleText(message("/resume 2"));
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain("🔄 中间");
    expect((await sessionMap.resolveByRoot("om_card_1"))?.sessionID).toBe("ses_mid");
    expect(await sessionMap.threadIdForSession("ses_mid")).toBeUndefined();
    expect(await sessionMap.threadIdForSession("ses_newest")).toBeUndefined();
    expect(sender.cards).toHaveLength(1);
  });

  test("/resume 序号越界 → 提示，不发恢复卡", async () => {
    const { commands, sender } = setup(base);
    await commands.handleText(message("/resume 9"));
    expect(sender.texts.join("\n")).toContain("越界");
    expect(sender.cards).toHaveLength(0);
  });

  test("/resume 非数字参数 → 用法提示", async () => {
    const { commands, sender } = setup(base);
    await commands.handleText(message("/resume abc"));
    expect(sender.texts.join("\n")).toContain("/resume [序号]");
  });

  test("/resume 没有会话 → 提示", async () => {
    const { commands, sender } = setup({ allSessions: async () => ({ data: [] }) });
    await commands.handleText(message("/resume"));
    expect(sender.texts.join("\n")).toContain("没有可续聊的会话");
  });

  test("话题内 /resume 被拒 → 提示去主聊天流", async () => {
    const { commands, sender } = setup(base);
    await commands.handleText(threadMsg("/resume"));
    expect(sender.cards).toHaveLength(0);
    expect(sender.replies.at(-1)!.text).toContain("主聊天流");
  });
});

describe("SessionCommands 恢复卡标题 + 摘要（任务 B）", () => {
  const raw = { id: "ses_old", title: "历史会话", time: { updated: 900 }, location: { directory: "/home/ubuntu/work/app" } };
  const action = {
    rawValue: { cmd: "open", s: "ses_old", c: "oc_1" },
    messageId: "om_list",
    chatId: "oc_1",
    operatorOpenId: "ou_1",
  };

  test("标题用会话主题（🔄 前缀），摘要在火后 patch 回同一张恢复卡", async () => {
    const summarize = vi.fn(async (_input: SummarizeSessionInput): Promise<SessionSummaryOutcome> => ({ summary: "1. 目标 A", source: "generated" }));
    const { commands, sender, sessionMap } = setup({ getSession: async () => raw, summarizeSession: summarize });

    await commands.handleCardAction(action);
    await flush();

    const opened = sender.cards.at(-1)!;
    expect(JSON.stringify(opened.card)).toContain("🔄 历史会话");
    expect(JSON.stringify(opened.card)).toContain("正在总结该会话");

    const patched = sender.patched.at(-1)!;
    expect(patched.messageId).toBe("om_card_1");
    expect(JSON.stringify(patched.card)).toContain("1. 目标 A");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0]).toMatchObject({ sessionID: "ses_old", directory: "/home/ubuntu/work/app" });
    // 摘要 patch 回同一张恢复卡；此时仍只绑 root、无 thread。
    expect((await sessionMap.resolveByRoot("om_card_1"))?.sessionID).toBe("ses_old");
    expect(await sessionMap.threadIdForSession("ses_old")).toBeUndefined();
    expect(sender.repliedCards).toHaveLength(0);
  });

  test("摘要失败 → patch 成「生成失败」文案（不抛）", async () => {
    const { commands, sender } = setup({
      getSession: async () => raw,
      summarizeSession: async () => ({ source: "none", error: "boom" }),
    });
    await commands.handleCardAction(action);
    await flush();
    expect(sender.patched.at(-1)!.messageId).toBe("om_card_1");
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("摘要生成失败");
  });

  test("摘要求解抛异常 → 只 log，恢复卡与 root 绑定不受影响", async () => {
    const { commands, sender, sessionMap } = setup({
      getSession: async () => raw,
      summarizeSession: async () => { throw new Error("kaput"); },
    });
    await commands.handleCardAction(action);
    await flush();
    expect(JSON.stringify(sender.cards.at(-1)!.card)).toContain("🔄 历史会话");
    expect((await sessionMap.resolveByRoot("om_card_1"))?.sessionID).toBe("ses_old");
    expect(await sessionMap.threadIdForSession("ses_old")).toBeUndefined();
    expect(sender.patched).toHaveLength(0);
  });

  test("resumeSummary=false → 无摘要区块、不调用摘要", async () => {
    const summarize = vi.fn(async (): Promise<SessionSummaryOutcome> => ({ summary: "x", source: "generated" }));
    const { commands, sender } = setup({
      getSession: async () => raw,
      summarizeSession: summarize,
      resumeSummary: false,
    });
    await commands.handleCardAction(action);
    await flush();
    expect(JSON.stringify(sender.cards.at(-1)!.card)).not.toContain("摘要");
    expect(summarize).not.toHaveBeenCalled();
    expect(sender.patched).toHaveLength(0);
  });

  test("未装配 summarizeSession → 不显示摘要占位", async () => {
    const { commands, sender } = setup({ getSession: async () => raw });
    await commands.handleCardAction(action);
    await flush();
    expect(JSON.stringify(sender.cards.at(-1)!.card)).not.toContain("摘要");
  });
});

describe("SessionCommands 最近使用记录（RecentStore）", () => {
  test("LRU 去重 + 限长", async () => {
    const storage = new FakeStorage();
    const recent = new RecentStore(storage, log, { dirs: 2, models: 2 });
    await recent.addDir("/a");
    await recent.addDir("/b");
    await recent.addDir("/a");
    await recent.addDir("/c");
    expect(await recent.listDirs()).toEqual(["/c", "/a"]);
    await recent.addModel({ providerID: "p", id: "m1", name: "M1" });
    await recent.addModel({ providerID: "p", id: "m2", name: "M2" });
    await recent.addModel({ providerID: "p", id: "m1", name: "M1" });
    expect((await recent.listModels()).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(storage.raw(RECENT_DIRS_KEY)).toEqual(["/c", "/a"]);
    expect(Array.isArray(storage.raw(RECENT_MODELS_KEY))).toBe(true);
  });
});

describe("SessionCommands 建会话表单（P6.1）", () => {
  const rootElements = (card: object): Array<Record<string, unknown>> =>
    (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

  test("/form 主聊天流直接发表单卡（form 在根节点）", async () => {
    const { commands, sender, wizard } = setup();
    await commands.handleText(message("/form"));
    expect(sender.cards).toHaveLength(1);
    const roots = rootElements(sender.cards[0]!.card);
    expect(roots[0]!.tag).toBe("form");
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("setup_submit");
    // 顺带起向导（用于保留标题/锚点）
    expect(await wizard.get("oc_1")).toBeDefined();
  });

  test("/form 在话题内被拒（提示去主聊天流）", async () => {
    const { commands, sender } = setup();
    await commands.handleText(threadMsg("/form"));
    expect(sender.cards).toHaveLength(0);
    expect(sender.replies.at(-1)!.text).toContain("主聊天流");
  });

  test("/new 直接就是表单卡（form 在根节点），不再是目录选择卡", async () => {
    const { commands, sender } = setup();
    await commands.handleText(message("/new 标题"));
    const roots = rootElements(sender.cards[0]!.card);
    expect(roots[0]!.tag).toBe("form");
    const text = JSON.stringify(sender.cards[0]!.card);
    expect(text).toContain("setup_submit");
    expect(text).not.toContain("选择工作目录");
  });

  test("点「一次填完」把当前卡 patch 成表单卡", async () => {
    const { commands, sender } = setup();
    await commands.handleText(message("/new"));
    const res = commands.handleCardAction({
      rawValue: { wizard: "form" },
      messageId: "om_setup",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("info");
    await flush();
    const patched = sender.patched.at(-1)!;
    expect(patched.messageId).toBe("om_setup");
    expect(rootElements(patched.card)[0]!.tag).toBe("form");
  });

  test("表单提交：校验目录 → 建会话(dir/model/perm/gateMode) + 开话题 + 绑定", async () => {
    const { commands, sender, createSession, sessionMap, wizard } = setup();
    sender.threadIdFor = (id) => (id === "om_ready" ? "omt_new" : undefined);
    await commands.handleText(message("/new 我的项目"));

    const res = commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir: "/home/ubuntu/work/app", model: "anthropic/claude-sonnet-4", perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await flush();

    expect(createSession).toHaveBeenCalledTimes(1);
    const input = createSession.mock.calls[0]![0];
    expect(input.directory).toBe("/home/ubuntu/work/app");
    expect(input.model?.id).toBe("claude-sonnet-4");
    expect(input.perm).toBe("edit");
    expect(input.gateMode).toBe("gate");
    expect(input.permissions).toEqual(
      expect.arrayContaining([{ action: "edit", resource: "*", effect: "allow" }]),
    );
    // 话题锚点 = 表单卡消息本身；不再发送独立锚点文本
    expect(sender.texts).toHaveLength(0);
    expect(sender.repliedCards).toHaveLength(1);
    expect(sender.repliedCards[0]!.messageId).toBe("om_form");
    expect(sender.repliedCards[0]!.replyInThread).toBe(true);
    expect((await sessionMap.resolveByThread("omt_new"))?.sessionID).toBe("ses_new_1");
    expect((await sessionMap.resolveByRoot("om_form"))?.sessionID).toBe("ses_new_1");
    // 表单卡被改写为话题根成功卡（标题 = ✅ 已创建 · <标题>）
    const createdCard = sender.patched.at(-1)!;
    expect(createdCard.messageId).toBe("om_form");
    expect(JSON.stringify(createdCard.card)).toContain("✅ 已创建 · 我的项目");
    expect(await wizard.get("oc_1")).toBeUndefined();
  });

  test("仅 form_value（无 value）也能路由并建会话", async () => {
    const { commands, createSession } = setup();
    await commands.handleText(message("/form"));
    commands.handleCardAction({
      rawValue: undefined,
      formValue: { dir: "/home/ubuntu/work/fresh", perm: "readonly" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].perm).toBe("readonly");
    expect(createSession.mock.calls[0]![0].model).toBeUndefined();
  });

  test("非法目录：不建会话，回带错误说明并保留已填项的卡片", async () => {
    const { commands, sender, createSession } = setup();
    await commands.handleText(message("/new"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir: "/etc", model: "openai/gpt-5", perm: "trust" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).not.toHaveBeenCalled();
    const patched = sender.patched.at(-1)!;
    expect(patched.messageId).toBe("om_form");
    const text = JSON.stringify(patched.card);
    expect(text).toContain("不在允许范围内");
    expect(text).toContain("/etc"); // 保留已填目录
    expect(text).toContain("trust"); // 保留已选权限
    expect(rootElements(patched.card)[0]!.tag).toBe("form");
  });

  test("表单目录留空 → 使用允许根目录建会话（不报错）", async () => {
    const { commands, createSession, sender } = setup();
    await commands.handleText(message("/new 空目录"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].directory).toBe("/home/ubuntu");
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("/home/ubuntu");
  });

  test("表单目录不存在 → 目录容错：视为自动创建后建会话", async () => {
    const { commands, createSession } = setup();
    await commands.handleText(message("/new 新目录"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir: "/home/ubuntu/work/created-now", perm: "readonly" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].directory).toBe("/home/ubuntu/work/created-now");
  });

  test("表单失效后重复提交不再建会话（防重复）", async () => {
    const { commands, sender, createSession } = setup();
    await commands.handleText(message("/form"));
    const submit = () => ({
      rawValue: { cmd: "setup.form" },
      formValue: { dir: "/home/ubuntu/work/dup", perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    commands.handleCardAction(submit());
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    // 向导已消费 → 第二次提交视为失效，不再建会话
    commands.handleCardAction(submit());
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sender.patched.at(-1)!.card)).toContain("表单已失效");
  });

  test("非白名单用户表单提交被拒，无副作用", async () => {
    const { commands, createSession } = setup({ allowed: false });
    const res = commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir: "/home/ubuntu/work/x", perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("error");
    await tick();
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("SessionCommands 表单目录下拉（P6.3）", () => {
  const rootElements = (card: object): Array<Record<string, unknown>> =>
    (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

  test("/dir 预填后表单下拉 initial_option 命中该子目录（并回显输入框）", async () => {
    const { commands, sender } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /home/ubuntu/my-app"));
    const text = JSON.stringify(sender.cards.at(-1)!.card);
    expect(text).toContain("dir_select");
    expect(text).toContain('"initial_option":"/home/ubuntu/my-app"');
    expect(text).toContain("/home/ubuntu/my-app");
    // 下拉选项来自允许根目录的一级子目录
    expect(text).toContain("🏠 /home/ubuntu（就用这个根目录）");
    expect(text).toContain("📦 my-app");
  });

  test("/dir 预填任意路径：下拉未命中则回退 __custom__，输入框仍回显", async () => {
    const { commands, sender } = setup();
    await commands.handleText(message("/new"));
    await commands.handleText(message("/dir /home/ubuntu/work/anywhere"));
    const text = JSON.stringify(sender.cards.at(-1)!.card);
    expect(text).toContain('"initial_option":"__custom__"');
    expect(text).toContain("/home/ubuntu/work/anywhere");
  });

  test("提交：dir_select 选中目录优先于文本输入", async () => {
    const { commands, createSession } = setup();
    await commands.handleText(message("/new 下拉优先"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir: "/home/ubuntu/work/typed", dir_select: "/home/ubuntu/work/picked", perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].directory).toBe("/home/ubuntu/work/picked");
  });

  test("提交：dir_select=__custom__ 时用文本输入", async () => {
    const { commands, createSession } = setup();
    await commands.handleText(message("/new 手填"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir: "/home/ubuntu/work/typed", dir_select: "__custom__", perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].directory).toBe("/home/ubuntu/work/typed");
  });

  test("提交：下拉与输入皆空 → 用允许根目录", async () => {
    const { commands, createSession } = setup();
    await commands.handleText(message("/new 空"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir_select: "__custom__", perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].directory).toBe("/home/ubuntu");
  });

  test("提交：下拉选中不存在的目录 → 仍走目录容错（自动创建）", async () => {
    const { commands, createSession } = setup();
    await commands.handleText(message("/new 新目录"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir_select: "/home/ubuntu/work/from-dropdown", perm: "readonly" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0].directory).toBe("/home/ubuntu/work/from-dropdown");
  });

  test("提交：下拉选中越界目录 → 拒绝，不建会话并回错误卡", async () => {
    const { commands, sender, createSession } = setup();
    await commands.handleText(message("/new 越界"));
    commands.handleCardAction({
      rawValue: { cmd: "setup.form" },
      formValue: { dir_select: "/etc", perm: "edit" },
      messageId: "om_form",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await flush();
    expect(createSession).not.toHaveBeenCalled();
    const patched = sender.patched.at(-1)!;
    expect(patched.messageId).toBe("om_form");
    const text = JSON.stringify(patched.card);
    expect(text).toContain("不在允许范围内");
    expect(text).toContain("/etc");
    expect(rootElements(patched.card)[0]!.tag).toBe("form");
  });
});

describe("SessionCommands 插队（/steer 与 /now）", () => {
  async function withActive() {
    const ctx = setup();
    await ctx.sessionMap.addSession("oc_1", "ses_live", "在跑的会话", "ou_1", { setActive: true });
    return ctx;
  }

  test("/steer <文本>：以 steer 立即插队发送（不新建会话、不发普通回执）", async () => {
    const { commands, sender, steerPrompt } = await withActive();
    const handled = await commands.handleText(message("/steer 先看这个"));
    expect(handled).toBe(true);
    expect(steerPrompt).toHaveBeenCalledTimes(1);
    const call = steerPrompt.mock.calls[0]!;
    expect(call[1]).toBe("ses_live");
    expect(call[2]).toBe("先看这个");
    expect(sender.texts).toHaveLength(0);
  });

  test("/steer 无参数：回用法提示，不发送", async () => {
    const { commands, sender, steerPrompt } = await withActive();
    await commands.handleText(message("/steer"));
    expect(steerPrompt).not.toHaveBeenCalled();
    expect(sender.texts.at(-1)).toContain("用法");
  });

  test("/now：把已排队消息提升为 steer 并回报条数", async () => {
    const { commands, sender, promoteQueued } = await withActive();
    promoteQueued.mockResolvedValue(3);
    await commands.handleText(message("/now"));
    expect(promoteQueued).toHaveBeenCalledWith("ses_live");
    expect(sender.texts.at(-1)).toContain("3 条");
  });

  test("/now：没有排队消息时如实提示", async () => {
    const { commands, sender } = await withActive();
    await commands.handleText(message("/now"));
    expect(sender.texts.at(-1)).toContain("没有排队中的消息");
  });

  test("话题内 /steer 允许使用，并解析到话题会话", async () => {
    const { commands, sessionMap, steerPrompt } = await withActive();
    await sessionMap.bindThread("omt_1", "ses_live", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/steer 立即处理"));
    expect(steerPrompt).toHaveBeenCalledTimes(1);
    expect(steerPrompt.mock.calls[0]![1]).toBe("ses_live");
  });
});
