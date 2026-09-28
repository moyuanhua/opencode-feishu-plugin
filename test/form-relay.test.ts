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
  readonly deleted: string[] = [];
  /** 设为 true 模拟撤回失败（超时限/无权限）。 */
  failDelete = false;
  async deleteMessage(messageId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.failDelete) return { ok: false, error: "recall denied" };
    this.deleted.push(messageId);
    return { ok: true };
  }
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
  const cancels: Array<{ sessionID: string; formID: string; directory?: string }> = [];
  const relay = new FormRelay({
    sender,
    log: createLogger({ level: "error", sink: () => undefined }),
    getLink: async () => (over.link === null ? undefined : over.link ?? { chatId: "oc_1", openId: "ou_1", dir: "/home/ubuntu/.config/opencode" }),
    isAllowed: () => over.allowed ?? true,
    reply: async (input) => {
      replies.push(input);
    },
    cancel: async (input) => {
      cancels.push(input);
    },
  });
  return { relay, sender, replies, cancels };
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
    // 作答完成 → 撤回表单卡（不再残留待填卡）。
    expect(sender.deleted).toContain("om_card");
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
  test("form.replied → 撤回表单卡", async () => {
    const { relay, sender } = setup();
    await relay.onCreated({ form: FORM });
    relay.onReplied({ id: "frm_1", sessionID: "ses_1", answer: { q0: "b" } });
    await tick();
    expect(sender.deleted).toContain("om_card");
  });

  test("form.cancelled → 撤回表单卡", async () => {
    const { relay, sender } = setup();
    await relay.onCreated({ form: FORM });
    relay.onCancelled({ id: "frm_1", sessionID: "ses_1" });
    await tick();
    expect(sender.deleted).toContain("om_card");
  });

  test("撤回失败（超时限）→ 降级 patch 结果卡", async () => {
    const { relay, sender } = setup();
    sender.failDelete = true;
    await relay.onCreated({ form: FORM });
    relay.onReplied({ id: "frm_1", sessionID: "ses_1", answer: { q0: "b" } });
    await tick();
    const last = sender.patched.at(-1)!;
    expect((last.card as { header: { template: string } }).header.template).toBe("green");
  });
});

describe("FormRelay 文本作答归一化", () => {
  test("直接回复文本命中选项 label → 用选项 value（无需先点按钮）", async () => {
    const { relay, replies } = setup();
    await relay.onCreated({ form: FORM });
    // 不点任何按钮，直接发文字。
    expect(relay.consumeText("ses_1", "深挖 Top5")).toBe(true);
    await tick();
    expect(replies[0]!.answer).toEqual({ q0: "b" });
  });

  test("直接回复未命中选项 → 视为手动输入原文", async () => {
    const { relay, replies } = setup();
    await relay.onCreated({ form: FORM });
    expect(relay.consumeText("ses_1", "聚焦可落地的小项目")).toBe(true);
    await tick();
    expect(replies[0]!.answer).toEqual({ q0: "聚焦可落地的小项目" });
  });

  test("boolean 字段文本（是/否）→ 布尔值", async () => {
    const boolForm = {
      id: "frm_b",
      sessionID: "ses_b",
      title: "确认",
      metadata: { kind: "question" },
      fields: [{ key: "ok", type: "boolean", title: "是否继续" }],
    };
    const { relay, replies } = setup();
    await relay.onCreated({ form: boolForm });
    expect(relay.consumeText("ses_b", "是")).toBe(true);
    await tick();
    expect(replies[0]!.answer).toEqual({ ok: true });
  });
});

describe("FormRelay 纯选项题：非选项文本按普通消息处理", () => {
  const OPTION_ONLY = {
    id: "frm_opt",
    sessionID: "ses_opt",
    title: "选一个",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "怎么访问服务器",
        options: [
          { value: "ssh", label: "生成 SSH 公钥给你加（推荐）" },
          { value: "paste", label: "你代为执行并贴回输出" },
        ],
      },
    ],
  };

  test("非选项文本 → 不作为答案，取消表单并返回 false（交由上层当 prompt）", async () => {
    const { relay, replies, cancels, sender } = setup();
    await relay.onCreated({ form: OPTION_ONLY });
    expect(relay.consumeText("ses_opt", "我担心你会误删数据，怎么办？")).toBe(false);
    await tick();
    expect(replies).toHaveLength(0);
    expect(cancels).toEqual([{ sessionID: "ses_opt", formID: "frm_opt", directory: "/home/ubuntu/.config/opencode" }]);
    expect(sender.deleted).toContain("om_card");
  });

  test("回复序号（1）→ 命中第一个选项", async () => {
    const { relay, replies } = setup();
    await relay.onCreated({ form: OPTION_ONLY });
    expect(relay.consumeText("ses_opt", "1")).toBe(true);
    await tick();
    expect(replies[0]!.answer).toEqual({ q0: "ssh" });
  });

  test("回复 label 原文 → 命中该选项", async () => {
    const { relay, replies } = setup();
    await relay.onCreated({ form: OPTION_ONLY });
    expect(relay.consumeText("ses_opt", "你代为执行并贴回输出")).toBe(true);
    await tick();
    expect(replies[0]!.answer).toEqual({ q0: "paste" });
  });

  test("允许自填（custom=true）→ 任意文本仍是答案", async () => {
    const custom = {
      ...OPTION_ONLY,
      id: "frm_custom",
      sessionID: "ses_custom",
      fields: [{ ...OPTION_ONLY.fields[0]!, custom: true }],
    };
    const { relay, replies } = setup();
    await relay.onCreated({ form: custom });
    expect(relay.consumeText("ses_custom", "我自定义的答案")).toBe(true);
    await tick();
    expect(replies[0]!.answer).toEqual({ q0: "我自定义的答案" });
  });
});
