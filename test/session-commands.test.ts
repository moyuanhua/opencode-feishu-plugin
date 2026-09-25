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

  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    this.cards.push({ chatId, card });
    return { ok: true, messageId: "om_card" };
  }
  async patchCard(messageId: string, card: object): Promise<{ ok: boolean; error?: string }> {
    this.patched.push({ messageId, card });
    return { ok: true };
  }
  async sendText(chatId: string, text: string): Promise<SendCardResult> {
    this.texts.push(text);
    return { ok: true, messageId: "om_text" };
  }
  async deleteMessage(): Promise<void> {}
}

function message(text: string): IncomingMessage {
  return {
    eventId: "ev_1",
    messageId: "om_in",
    chatId: "oc_1",
    chatType: "p2p",
    messageType: "text",
    text,
    senderOpenId: "ou_1",
  };
}

function setup(over: { allowed?: boolean } = {}) {
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

  test("/new 指定标题：建会话 + 设为当前 + 回复", async () => {
    const { commands, sessionMap, sender, createSession } = setup();
    expect(await commands.handleText(message("/new 我的标题"))).toBe(true);
    expect(createSession).toHaveBeenCalledWith("我的标题");
    const active = await sessionMap.getActive("oc_1");
    expect(active?.sessionID).toBe("ses_new_1");
    expect(sender.texts.join("\n")).toContain("我的标题");
    expect(sender.texts.join("\n")).toContain("ses_new_1");
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
