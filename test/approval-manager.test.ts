import { describe, expect, test } from "vitest";
import { ApprovalManager, type ReplyInput } from "../src/permission.js";
import { ReplayGuard, signApproval, verifyApproval } from "../src/security/token.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";
import { createLogger } from "../src/logger.js";
import type { CardAction, SessionLink } from "../src/types.js";

const SECRET = "unit-test-secret";
const NOW = 1_700_000_000_000;

class FakeSender implements FeishuSender {
  readonly sent: Array<{ chatId: string; card: object }> = [];
  readonly patched: Array<{ messageId: string; card: object }> = [];
  readonly texts: string[] = [];
  failSend = false;

  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    this.sent.push({ chatId, card });
    return this.failSend ? { ok: false, error: "boom" } : { ok: true, messageId: "om_card_1" };
  }
  async patchCard(messageId: string, card: object): Promise<{ ok: boolean; error?: string }> {
    this.patched.push({ messageId, card });
    return { ok: true };
  }
  async sendText(chatId: string, text: string): Promise<SendCardResult> {
    this.texts.push(`${chatId}:${text}`);
    return { ok: true, messageId: "om_text" };
  }
  async deleteMessage(): Promise<void> {}
}

function setup(over: { allowed?: string[]; link?: SessionLink | null } = {}) {
  const sender = new FakeSender();
  const replies: ReplyInput[] = [];
  const log = createLogger({ level: "error", sink: () => undefined });
  const manager = new ApprovalManager({
    config: { permissionGate: "gate", allowTools: [], denyTools: [], approvalTtlMs: 60_000, maxResourcesShown: 8 },
    log,
    sign: ({ requestID, sessionID, openId }) =>
      signApproval({ r: requestID, s: sessionID, u: openId, ttlMs: 60_000, now: NOW }, SECRET),
    verify: (token, expect) => verifyApproval(token, SECRET, { now: NOW + 1, expect }),
    replay: new ReplayGuard(60_000, () => NOW),
    sender,
    getLink: async () => (over.link === null ? undefined : over.link ?? { chatId: "oc_1", openId: "ou_1" }),
    isAllowed: (openId) => (over.allowed ?? ["ou_1"]).includes(openId),
    reply: async (input) => {
      replies.push(input);
    },
    now: () => NOW,
  });
  return { manager, sender, replies };
}

const REQUEST = {
  id: "per_1",
  sessionID: "ses_1",
  action: "bash",
  resources: ["rm -rf /tmp/x"],
  save: ["/tmp/x"],
};

function tokenFrom(sender: FakeSender): string {
  const card = sender.sent[0]?.card as { body: { elements: Array<Record<string, unknown>> } };
  const btn = (card.body.elements as Array<Record<string, unknown>>).find((e) => e.tag === "button") as {
    behaviors: Array<{ value: { t: string } }>;
  };
  const value = btn.behaviors[0]!.value;
  return value.t;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ApprovalManager.onAsked", () => {
  test("有映射则发卡；同 requestID 只发一次", async () => {
    const { manager, sender } = setup();
    await manager.onAsked(REQUEST);
    await manager.onAsked(REQUEST);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.chatId).toBe("oc_1");
  });

  test("无映射不发卡", async () => {
    const { manager, sender } = setup({ link: null });
    await manager.onAsked(REQUEST);
    expect(sender.sent).toHaveLength(0);
  });

  test("发送失败不抛异常", async () => {
    const { manager, sender } = setup();
    sender.failSend = true;
    await expect(manager.onAsked(REQUEST)).resolves.toBeUndefined();
  });
});

describe("ApprovalManager.handleCardAction", () => {
  test("合法点击：返回 toast，异步 reply + 更新卡片", async () => {
    const { manager, sender, replies } = setup();
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);

    const action: CardAction = { rawValue: { t: token, d: "once" }, messageId: "om_card_1", chatId: "oc_1", operatorOpenId: "ou_1" };
    const response = manager.handleCardAction(action) as { toast: { type: string } };
    expect(response.toast.type).toBe("success");

    await tick();
    expect(replies).toEqual([{ sessionID: "ses_1", requestID: "per_1", reply: "once" }]);
    expect(sender.patched).toHaveLength(1);
    expect((sender.patched[0]!.card as { header: { template: string } }).header.template).toBe("green");
  });

  test("非白名单用户被拒，且不 reply", async () => {
    const { manager, sender, replies } = setup();
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);
    const response = manager.handleCardAction({
      rawValue: { t: token, d: "once" },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_evil",
    }) as { toast: { type: string } };
    expect(response.toast.type).toBe("error");
    await tick();
    expect(replies).toHaveLength(0);
  });

  test("token 绑定他人时拒绝", async () => {
    // token 绑定 ou_1，但点击者 ou_2 在白名单里
    const { manager, sender, replies } = setup({ allowed: ["ou_1", "ou_2"] });
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);
    const response = manager.handleCardAction({
      rawValue: { t: token, d: "once" },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_2",
    }) as { toast: { type: string } };
    expect(response.toast.type).toBe("error");
    await tick();
    expect(replies).toHaveLength(0);
  });

  test("重放同一 token 只生效一次", async () => {
    const { manager, sender, replies } = setup();
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);
    const action: CardAction = { rawValue: { t: token, d: "reject" }, messageId: "om_card_1", chatId: "oc_1", operatorOpenId: "ou_1" };

    const first = manager.handleCardAction(action) as { toast: { type: string } };
    await tick();
    const second = manager.handleCardAction(action) as { toast: { type: string; content: string } };

    expect(first.toast.type).toBe("warning"); // reject → warning toast
    expect(second.toast.type).toBe("warning");
    expect(second.toast.content).toContain("已处理");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.reply).toBe("reject");
  });

  test("畸形 value 返回 error", () => {
    const { manager } = setup();
    const response = manager.handleCardAction({
      rawValue: { t: "x", d: "nope" },
      messageId: "",
      chatId: "",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(response.toast.type).toBe("error");
  });
});

describe("ApprovalManager.onReplied", () => {
  test("未由点击更新的卡片在 replied 时收敛", async () => {
    const { manager, sender } = setup();
    await manager.onAsked(REQUEST);
    manager.onReplied({ sessionID: "ses_1", requestID: "per_1", reply: "reject" });
    await tick();
    expect(sender.patched).toHaveLength(1);
    expect((sender.patched[0]!.card as { header: { template: string } }).header.template).toBe("red");

    // 已消费，再次 replied 不再 patch
    manager.onReplied({ sessionID: "ses_1", requestID: "per_1", reply: "reject" });
    await tick();
    expect(sender.patched).toHaveLength(1);
  });
});
