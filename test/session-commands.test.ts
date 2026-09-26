import { describe, expect, test, vi } from "vitest";
import { SessionMap } from "../src/feishu/session-map.js";
import { SessionCommands } from "../src/session-commands.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";
import { createLogger } from "../src/logger.js";
import type { CardAction, IncomingMessage } from "../src/types.js";
import { FakeStorage } from "./helpers.js";

const log = createLogger({ level: "error", sink: () => undefined });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeSender implements FeishuSender {
  readonly cards: Array<{ chatId: string; card: object }> = [];
  readonly patched: Array<{ messageId: string; card: object }> = [];
  readonly texts: string[] = [];
  readonly replies: Array<{ messageId: string; text: string; replyInThread?: boolean }> = [];
  readonly repliedCards: Array<{ messageId: string; card: object; replyInThread?: boolean }> = [];
  /** `getMessageMeta` 返回的 thread_id（模拟 reply 后读回）。 */
  threadIdFor: (messageId: string) => string | undefined = () => undefined;
  failReply = false;

  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    this.cards.push({ chatId, card });
    return { ok: true, messageId: "om_card" };
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

function setup(over: { allowed?: boolean; threadRouting?: boolean } = {}) {
  const storage = new FakeStorage();
  const sessionMap = new SessionMap(storage, log, { now: () => 1000 });
  const sender = new FakeSender();
  let seq = 0;
  const createSession = vi.fn(async (_title: string) => ({ id: `ses_new_${++seq}` }));
  const interruptSession = vi.fn(async (_sessionID: string) => undefined);
  const commands = new SessionCommands({
    log,
    sessionMap,
    sender,
    isAllowed: () => over.allowed ?? true,
    createSession,
    interruptSession,
    threadRouting: over.threadRouting ?? true,
    now: () => 1000,
  });
  return { commands, sessionMap, sender, createSession, interruptSession };
}

describe("SessionCommands.handleText", () => {
  test("非命令返回 false 且无副作用", async () => {
    const { commands, sender, createSession } = setup();
    expect(await commands.handleText(message("你好"))).toBe(false);
    expect(sender.texts).toHaveLength(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  test("/new 指定标题：建会话 + 设为当前 + 一键开话题（reply_in_thread + bindThread + bindRoot）", async () => {
    const { commands, sessionMap, sender, createSession } = setup();
    sender.threadIdFor = (id) => (id === "om_ready" ? "omt_new" : undefined);
    expect(await commands.handleText(message("/new 我的标题"))).toBe(true);
    expect(createSession).toHaveBeenCalledWith("我的标题");
    const active = await sessionMap.getActive("oc_1");
    expect(active?.sessionID).toBe("ses_new_1");
    // 一键进入：引用用户消息并在话题内开新话题。
    expect(sender.repliedCards).toHaveLength(1);
    expect(sender.repliedCards[0]!.messageId).toBe("om_in");
    expect(sender.repliedCards[0]!.replyInThread).toBe(true);
    const cardText = JSON.stringify(sender.repliedCards[0]!.card);
    expect(cardText).toContain("我的标题");
    expect(cardText).toContain("ses_new_1");
    // 读回 thread_id → bindThread；卡片消息 → bindRoot。
    expect((await sessionMap.resolveByThread("omt_new"))?.sessionID).toBe("ses_new_1");
    expect((await sessionMap.resolveByRoot("om_ready"))?.sessionID).toBe("ses_new_1");
    // session 索引带上锚点，审批卡可落话题。
    expect((await sessionMap.resolveBySession("ses_new_1"))?.replyMessageId).toBe("om_in");
  });

  test("/new 一键开话题失败时回退文本回执", async () => {
    const { commands, sender } = setup();
    sender.failReply = true;
    await commands.handleText(message("/new 标题X"));
    expect(sender.repliedCards).toHaveLength(1);
    expect(sender.texts.join("\n")).toContain("标题X");
    expect(sender.texts.join("\n")).toContain("自动开话题失败");
  });

  test("/new threadRouting=false 时不建话题，只回执文本", async () => {
    const { commands, sender, sessionMap } = setup({ threadRouting: false });
    await commands.handleText(message("/new 旧行为"));
    expect(sender.repliedCards).toHaveLength(0);
    expect(sender.texts.join("\n")).toContain("旧行为");
    expect(await sessionMap.resolveByRoot("om_in")).toBeUndefined();
  });

  test("/new 缺省标题用时间戳", async () => {
    const { commands, createSession } = setup();
    await commands.handleText(message("/new"));
    expect(createSession.mock.calls[0]?.[0]).toContain("飞书会话");
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

  test("/use 未知前缀回复错误且不改当前", async () => {
    const { commands, sessionMap, sender } = setup();
    await sessionMap.addSession("oc_1", "ses_1", "一", "ou_1");
    await commands.handleText(message("/use ses_zzz"));
    expect((await sessionMap.getActive("oc_1"))?.sessionID).toBe("ses_1");
    expect(sender.texts.join("\n")).toContain("未找到");
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

  test("未知命令回帮助提示，不新建/不 prompt", async () => {
    const { commands, sender, createSession } = setup();
    expect(await commands.handleText(message("/frobnicate"))).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(sender.texts.join("\n")).toContain("/sessions");
  });
});

describe("SessionCommands 话题内命令矩阵", () => {
  const threadMsg = (text: string) =>
    message(text, { messageId: "om_t", threadId: "omt_1", rootId: "om_root", parentId: "om_root" });

  test("话题内 /new /sessions /use 被拒 → 提示去主聊天流，且无副作用", async () => {
    const { commands, sender, sessionMap, createSession } = setup();
    await commands.handleText(threadMsg("/new 标题"));
    await commands.handleText(threadMsg("/sessions"));
    await commands.handleText(threadMsg("/use 1"));
    expect(createSession).not.toHaveBeenCalled();
    expect(sender.cards).toHaveLength(0);
    expect(sender.replies).toHaveLength(3);
    expect(sender.replies.every((r) => r.messageId === "om_t")).toBe(true);
    expect(sender.replies[0]!.text).toContain("主聊天流");
    expect(await sessionMap.listSessions("oc_1")).toEqual([]);
  });

  test("话题内 /current 解析本话题会话标题；未关联时给提示", async () => {
    const { commands, sender, sessionMap } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "话题会话", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");

    await commands.handleText(threadMsg("/current"));
    expect(sender.replies.at(-1)!.text).toContain("话题会话");

    await commands.handleText(message("/current", { messageId: "om_t2", threadId: "omt_unknown" }));
    expect(sender.replies.at(-1)!.text).toContain("尚未关联");
  });

  test("话题内 /stop 中断本话题会话（reply 落话题）", async () => {
    const { commands, sender, sessionMap, interruptSession } = setup();
    await sessionMap.addSession("oc_1", "ses_t", "t", "ou_1", { setActive: false });
    await sessionMap.bindThread("omt_1", "ses_t", "oc_1", "ou_1", "om_root");
    await commands.handleText(threadMsg("/stop"));
    expect(interruptSession).toHaveBeenCalledWith("ses_t");
    expect(sender.replies.at(-1)!.messageId).toBe("om_t");
  });

  test("话题内 /help 不展示会话管理命令", async () => {
    const { commands, sender } = setup();
    await commands.handleText(threadMsg("/help"));
    const text = sender.replies.at(-1)!.text;
    expect(text).toContain("/current");
    expect(text).not.toContain("/new [标题]");
  });

  test("主聊天流 /current 仍按当前会话", async () => {
    const { commands, sender, sessionMap } = setup();
    await sessionMap.addSession("oc_1", "ses_1", "主会话", "ou_1");
    await commands.handleText(message("/current"));
    expect(sender.texts.at(-1)).toContain("主会话");
  });
});

describe("SessionCommands.handleCardAction", () => {
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

  test("审批卡 value 不会被会话路由误处理", () => {
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
