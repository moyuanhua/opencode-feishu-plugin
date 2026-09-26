import { describe, expect, test } from "vitest";
import { FormRelay, type FormReplyInput } from "../src/feishu/form-relay.js";
import { createLogger } from "../src/logger.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";
import type { CardAction, SessionLink } from "../src/types.js";

class FakeSender implements FeishuSender {
  readonly cards: Array<{ messageId: string; card: object }> = [];
  readonly patched: Array<{ messageId: string; card: object }> = [];
  async sendCard(_chatId: string, card: object): Promise<SendCardResult> {
    this.cards.push({ messageId: "om_card", card });
    return { ok: true, messageId: "om_card" };
  }
  async replyCard(messageId: string, card: object): Promise<SendCardResult> {
    this.cards.push({ messageId, card });
    return { ok: true, messageId: "om_reply" };
  }
  async patchCard(messageId: string, card: object): Promise<{ ok: boolean; error?: string }> {
    this.patched.push({ messageId, card });
    return { ok: true };
  }
  async sendText(): Promise<SendCardResult> {
    return { ok: true, messageId: "om_text" };
  }
  async replyText(): Promise<SendCardResult> {
    return { ok: true, messageId: "om_text" };
  }
  async getMessageMeta(): Promise<undefined> {
    return undefined;
  }
  async deleteMessage(): Promise<void> {}
}

const FORM = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      type: "string",
      title: "继续找的方向",
      options: [
        { value: "a", label: "新开一轮" },
        { value: "b", label: "深挖 Top5" },
      ],
      custom: true,
    },
  ],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(over: { link?: SessionLink | null; allowed?: boolean } = {}) {
  const sender = new FakeSender();
  const replies: FormReplyInput[] = [];
  const relay = new FormRelay({
    sender,
    log: createLogger({ level: "error", sink: () => undefined }),
    getLink: async () => (over.link === null ? undefined : over.link ?? { chatId: "oc_1", openId: "ou_1", dir: "/home/ubuntu/.config/opencode" }),
    isAllowed: () => over.allowed ?? true,
    reply: async (input) => {
      replies.push(input);
    },
  });
  return { relay, sender, replies };
}

describe("FormRelay.onCreated", () => {
  test("有映射 → 发卡（话题内 reply）；无映射 → 不发", async () => {
    const { relay, sender } = setup({ link: { chatId: "oc_1", openId: "ou_1", replyMessageId: "om_root" } });
    await relay.onCreated({ form: FORM });
    expect(sender.cards).toHaveLength(1);
    expect(sender.cards[0]!.messageId).toBe("om_root");
    expect(JSON.stringify(sender.cards[0]!.card)).toContain("提问");

    const none = setup({ link: null });
    await none.relay.onCreated({ form: FORM });
    expect(none.sender.cards).toHaveLength(0);
  });
});

describe("FormRelay.handleCardAction / consumeText", () => {
  test("点击唯一字段选项 → 提交并携带目录", async () => {
    const { relay, sender, replies } = setup();
    await relay.onCreated({ form: FORM });

    const action: CardAction = {
      rawValue: { f: "frm_1", k: "q0", v: "a" },
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    };
    const res = relay.handleCardAction(action) as { toast: { type: string } };
    expect(res.toast.type).toBe("success");
    await tick();
    expect(replies).toEqual([
      { sessionID: "ses_1", formID: "frm_1", answer: { q0: "a" }, directory: "/home/ubuntu/.config/opencode" },
    ]);
    expect(sender.patched.length).toBeGreaterThanOrEqual(1);
  });

  test("自由文本按钮 → 下一条话题文本作为答案", async () => {
    const { relay, replies } = setup();
    await relay.onCreated({ form: FORM });

    const res = relay.handleCardAction({
      rawValue: { f: "frm_1", k: "q0", free: true },
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { content: string } };
    expect(res.toast.content).toContain("直接发送");

    expect(relay.consumeText("ses_1", "聚焦可动手的项目")).toBe(true);
    await tick();
    expect(replies[0]!.answer).toEqual({ q0: "聚焦可动手的项目" });
  });

  test("非白名单用户点击被拒，且不 dispatch", async () => {
    const { relay, replies } = setup({ allowed: false });
    await relay.onCreated({ form: FORM });
    const res = relay.handleCardAction({
      rawValue: { f: "frm_1", k: "q0", v: "a" },
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_evil",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("error");
    await tick();
    expect(replies).toHaveLength(0);
  });

  test("非表单 value 返回 undefined（交给其它路由）", () => {
    const { relay } = setup();
    expect(relay.handleCardAction({ rawValue: { cmd: "x" }, messageId: "", chatId: "", operatorOpenId: "ou_1" })).toBeUndefined();
  });
});

describe("FormRelay 事件收敛", () => {
  test("form.replied → 卡片 patch 为已提交", async () => {
    const { relay, sender } = setup();
    await relay.onCreated({ form: FORM });
    relay.onReplied({ id: "frm_1", sessionID: "ses_1", answer: { q0: "b" } });
    await tick();
    const last = sender.patched.at(-1)!;
    expect((last.card as { header: { template: string } }).header.template).toBe("green");
  });

  test("form.cancelled → 卡片 patch 为已取消", async () => {
    const { relay, sender } = setup();
    await relay.onCreated({ form: FORM });
    relay.onCancelled({ id: "frm_1", sessionID: "ses_1" });
    await tick();
    expect((sender.patched.at(-1)!.card as { header: { template: string } }).header.template).toBe("grey");
  });
});
