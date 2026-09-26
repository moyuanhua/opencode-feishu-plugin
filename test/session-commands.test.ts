import { describe, expect, test, vi } from "vitest";
import { SessionMap } from "../src/feishu/session-map.js";
import { SessionCommands, type CreateSessionInput } from "../src/session-commands.js";
import { WizardStore, WIZARD_KEY_PREFIX } from "../src/feishu/wizard.js";
import { RecentStore, RECENT_DIRS_KEY, RECENT_MODELS_KEY } from "../src/feishu/recent.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";
import type { DirValidation } from "../src/feishu/dirs.js";
import { createLogger } from "../src/logger.js";
import type { CardAction, IncomingMessage, ModelRef, PermissionPreset } from "../src/types.js";
import type { ModelEntry } from "../src/feishu/models.js";
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

  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    this.cards.push({ chatId, card });
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

function setup(over: { allowed?: boolean; threadRouting?: boolean } = {}) {
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
  const switchSessionModel = vi.fn(async (_sessionID: string, _model: ModelRef) => undefined);
  const applyPermissionPreset = vi.fn(async (_sessionID: string, _preset: PermissionPreset) => undefined);
  const moveSessionDir = vi.fn(async (_sessionID: string, _dir: string) => undefined);
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
    applyPermissionPreset,
    moveSessionDir,
    validateDir: fakeValidate,
    allowedRoots: ["/home/ubuntu"],
    threadRouting: over.threadRouting ?? true,
    now: () => 1000,
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

  test("/sessions 发送会话卡片", async () => {
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

  test("new：后台新建并刷新卡片", async () => {
    const { commands, sessionMap, sender, createSession } = setup();
    const res = commands.handleCardAction({
      rawValue: { cmd: "new", c: "oc_1" },
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await tick();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(await sessionMap.getActive("oc_1")).toBeDefined();
    expect(sender.patched).toHaveLength(1);
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
