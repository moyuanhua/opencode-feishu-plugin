import { describe, expect, test } from "vitest";
import { ApprovalManager, type ReplyInput } from "../src/permission.js";
import {
  ReplayGuard,
  signAllowSession,
  signApproval,
  verifyAllowSession,
  verifyApproval,
} from "../src/security/token.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";
import { createLogger } from "../src/logger.js";
import type { CardAction, SessionLink } from "../src/types.js";

const SECRET = "unit-test-secret";
const NOW = 1_700_000_000_000;

class FakeSender implements FeishuSender {
  readonly sent: Array<{ chatId: string; card: object }> = [];
  readonly patched: Array<{ messageId: string; card: object }> = [];
  readonly texts: string[] = [];
  readonly repliedCards: Array<{ messageId: string; card: object }> = [];
  readonly deleted: string[] = [];
  failSend = false;
  failDelete = false;

  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    this.sent.push({ chatId, card });
    return this.failSend ? { ok: false, error: "boom" } : { ok: true, messageId: "om_card_1" };
  }
  async replyCard(messageId: string, card: object): Promise<SendCardResult> {
    this.repliedCards.push({ messageId, card });
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
  async replyText(): Promise<SendCardResult> {
    return { ok: true };
  }
  async getMessageMeta(): Promise<undefined> {
    return undefined;
  }
  async sendFile(): Promise<{ ok: boolean }> { return { ok: true }; }
  async deleteMessage(messageId: string): Promise<{ ok: boolean; error?: string }> {
    this.deleted.push(messageId);
    return this.failDelete ? { ok: false, error: "too late" } : { ok: true };
  }
}

function setup(
  over: {
    allowed?: string[];
    link?: SessionLink | null;
    sessionAllowButton?: boolean;
    allowSession?: (input: { sessionID: string; action: string }) => Promise<void>;
    hasSessionAllow?: (input: { sessionID: string; action: string }) => boolean;
    /** 让 `reply` 抛错（模拟跨实例 / 请求不存在）。 */
    replyThrows?: string;
  } = {},
) {
  const sender = new FakeSender();
  const replies: ReplyInput[] = [];
  const allowCalls: Array<{ sessionID: string; action: string }> = [];
  /** 可变故障开关：测试可在重试前清掉。 */
  const faults: { replyThrows?: string } = { ...(over.replyThrows ? { replyThrows: over.replyThrows } : {}) };
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
      if (faults.replyThrows) throw new Error(faults.replyThrows);
    },
    sessionAllowButton: over.sessionAllowButton ?? true,
    signAllowSession: ({ requestID, sessionID, action }) =>
      signAllowSession({ requestID, sessionID, action, ttlMs: 60_000, now: NOW }, SECRET),
    verifyAllowSession: (token, expect) =>
      verifyAllowSession(token, SECRET, {
        now: NOW + 1,
        ...(expect?.sessionID ? { expectSessionID: expect.sessionID } : {}),
        ...(expect?.action ? { expectAction: expect.action } : {}),
      }),
    allowSession: async (input) => {
      allowCalls.push(input);
      if (over.allowSession) await over.allowSession(input);
    },
    ...(over.hasSessionAllow ? { hasSessionAllow: over.hasSessionAllow } : {}),
    now: () => NOW,
  });
  return { manager, sender, replies, allowCalls, faults };
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

  test("会话绑定话题（replyMessageId）时审批卡用 reply 落话题", async () => {
    const { manager, sender } = setup({ link: { chatId: "oc_1", openId: "ou_1", replyMessageId: "om_root" } });
    await manager.onAsked(REQUEST);
    expect(sender.sent).toHaveLength(0);
    expect(sender.repliedCards).toHaveLength(1);
    expect(sender.repliedCards[0]!.messageId).toBe("om_root");
    expect(sender.repliedCards[0]!.card).toMatchObject({ schema: "2.0" });
  });
});

describe("ApprovalManager.handleCardAction", () => {
  test("合法点击：返回 toast，异步 reply + 撤回卡片", async () => {
    const { manager, sender, replies } = setup();
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);

    const action: CardAction = { rawValue: { t: token, d: "once" }, messageId: "om_card_1", chatId: "oc_1", operatorOpenId: "ou_1" };
    const response = manager.handleCardAction(action) as { toast: { type: string } };
    expect(response.toast.type).toBe("info");

    await tick();
    expect(replies).toEqual([{ sessionID: "ses_1", requestID: "per_1", reply: "once" }]);
    expect(sender.deleted).toEqual(["om_card_1"]);
    expect(sender.patched).toHaveLength(0);
  });

  test("撤回失败（超时限）→ 降级 patch 结果卡", async () => {
    const { manager, sender, replies } = setup();
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);
    sender.failDelete = true;

    manager.handleCardAction({
      rawValue: { t: token, d: "once" },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await tick();
    expect(replies).toHaveLength(1);
    expect(sender.deleted).toEqual(["om_card_1"]);
    expect(sender.patched).toHaveLength(1);
    expect((sender.patched[0]!.card as { header: { template: string } }).header.template).toBe("green");
  });

  test("reply 失败（not found）→ 保留卡片并 patch 红色失败卡 + 重试按钮（不误报成功）", async () => {
    const { manager, sender, faults } = setup({ replyThrows: "Permission request not found: per_1" });
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);

    const res = manager.handleCardAction({
      rawValue: { t: token, d: "once" },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("info");

    await tick();
    // 不误撤回、不显示成功结果卡；改为红色「未生效」卡 + 重试
    expect(sender.deleted).toHaveLength(0);
    expect(sender.patched).toHaveLength(1);
    const card = sender.patched[0]!.card as {
      header: { template: string; title: { content: string } };
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.header.template).toBe("red");
    expect(card.header.title.content).toContain("未生效");
    const btn = card.body.elements.find((e) => e.tag === "button") as {
      behaviors: Array<{ value: { t: string; d: string } }>;
    };
    expect(btn.behaviors[0]!.value.d).toBe("once");
    expect(btn.behaviors[0]!.value.t).toBeTruthy();

    // 故障恢复 → 点重试按钮（重签 token）→ reply 成功 → 撤回卡片
    faults.replyThrows = undefined;
    manager.handleCardAction({
      rawValue: btn.behaviors[0]!.value,
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await tick();
    expect(sender.deleted).toContain("om_card_1");
  });

  test("跨实例（本实例未跟踪该卡片）：reply 失败 → 发可见失败提示，不静默", async () => {
    const { manager, sender, faults } = setup();
    faults.replyThrows = "Permission request not found: per_x";
    // 直接签一个该实例没跟踪过的请求 token（模拟回调落到非持有实例）。
    const tok = signApproval({ r: "per_x", s: "ses_1", u: "ou_1", ttlMs: 60_000, now: NOW }, SECRET);
    manager.handleCardAction({
      rawValue: { t: tok, d: "once" },
      messageId: "om_x",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await tick();
    expect(sender.texts.some((t) => t.includes("审批未生效"))).toBe(true);
  });

  test("会话带 dir 时 reply 携带目录（跨 location 路由）", async () => {
    const { manager, sender, replies } = setup({
      link: { chatId: "oc_1", openId: "ou_1", dir: "/home/ubuntu/.config/opencode" },
    });
    await manager.onAsked(REQUEST);
    const token = tokenFrom(sender);
    manager.handleCardAction({
      rawValue: { t: token, d: "once" },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await tick();
    expect(replies).toEqual([
      { sessionID: "ses_1", requestID: "per_1", reply: "once", directory: "/home/ubuntu/.config/opencode" },
    ]);
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

    expect(first.toast.type).toBe("info"); // 先回执「处理中」，成功与否由卡片收敛体现
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

describe("ApprovalManager 会话内允许（任务 A）", () => {
  function allowValueFrom(sender: FakeSender): { cmd: string; a: string; t: string } {
    const card = sender.sent[0]?.card as { body: { elements: Array<Record<string, unknown>> } };
    const btn = card.body.elements.find(
      (e) => e.tag === "button" && ((e.text as { content: string }).content === "✅ 本会话内允许该工具"),
    ) as { behaviors: Array<{ value: { cmd: string; a: string; t: string } }> } | undefined;
    if (!btn) throw new Error("allow_session button missing");
    return btn.behaviors[0]!.value;
  }

  test("卡片含按钮，点击 → 持久化 + 答复 once + 撤回卡片", async () => {
    const { manager, sender, replies, allowCalls } = setup();
    await manager.onAsked(REQUEST);
    const value = allowValueFrom(sender);

    const res = manager.handleCardAction({
      rawValue: value,
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("info");

    await tick();
    expect(allowCalls).toEqual([{ sessionID: "ses_1", action: "bash" }]);
    expect(replies).toEqual([{ sessionID: "ses_1", requestID: "per_1", reply: "once" }]);
    expect(sender.deleted).toEqual(["om_card_1"]);
    expect(sender.patched).toHaveLength(0);
  });

  test("会话放行撤回失败 → 降级 patch 专用结果卡", async () => {
    const { manager, sender, allowCalls } = setup();
    await manager.onAsked(REQUEST);
    const value = allowValueFrom(sender);
    sender.failDelete = true;

    manager.handleCardAction({
      rawValue: value,
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await tick();
    expect(allowCalls).toHaveLength(1);
    expect(sender.patched).toHaveLength(1);
    const patched = JSON.stringify(sender.patched[0]!.card);
    expect(patched).toContain("已允许本会话内 bash");
    expect(patched).not.toContain('"tag":"button"');
  });

  test("会话放行 reply 失败 → 保留卡片并 patch 失败卡 + 「本会话内允许」重试按钮", async () => {
    const { manager, sender, allowCalls } = setup({ replyThrows: "Permission request not found: per_1" });
    await manager.onAsked(REQUEST);
    const value = allowValueFrom(sender);

    manager.handleCardAction({
      rawValue: value,
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    });
    await tick();
    expect(allowCalls).toHaveLength(1); // 会话级放行仍已写入（幂等）
    expect(sender.deleted).toHaveLength(0); // 不误撤回
    expect(sender.patched).toHaveLength(1);
    const card = sender.patched[0]!.card as {
      header: { template: string; title: { content: string } };
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.header.template).toBe("red");
    expect(card.header.title.content).toContain("未生效");
    const btn = card.body.elements.find((e) => e.tag === "button") as {
      behaviors: Array<{ value: { cmd: string; a: string; t: string } }>;
    };
    expect(btn.behaviors[0]!.value.cmd).toBe("allow_session");
    expect(btn.behaviors[0]!.value.a).toBe("bash");
    expect(btn.behaviors[0]!.value.t).toBeTruthy();
  });

  test("非白名单用户被拒，且不写入、不 reply", async () => {
    const { manager, sender, replies, allowCalls } = setup({ allowed: ["ou_1"] });
    await manager.onAsked(REQUEST);
    const value = allowValueFrom(sender);
    const res = manager.handleCardAction({
      rawValue: value,
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_evil",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("error");
    await tick();
    expect(allowCalls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  test("伪造 / action 不匹配 → 验签失败", async () => {
    const { manager, sender, allowCalls } = setup();
    await manager.onAsked(REQUEST);
    const value = allowValueFrom(sender);

    const forged = manager.handleCardAction({
      rawValue: { ...value, t: `${value.t}x` },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { content: string } };
    expect(forged.toast.content).toContain("审批凭证无效");

    const mismatch = manager.handleCardAction({
      rawValue: { ...value, a: "edit" },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { content: string } };
    expect(mismatch.toast.content).toContain("action-mismatch");

    await tick();
    expect(allowCalls).toHaveLength(0);
  });

  test("sessionID 不匹配（token 属于别的会话）→ 拒绝", async () => {
    const { manager, allowCalls } = setup();
    await manager.onAsked(REQUEST);
    // 手动签发一个绑定别的会话的 token；tracked 卡片会话是 ses_1。
    const foreign = signAllowSession(
      { requestID: "per_1", sessionID: "ses_other", action: "bash", ttlMs: 60_000, now: NOW },
      SECRET,
    );
    const res = manager.handleCardAction({
      rawValue: { cmd: "allow_session", a: "bash", t: foreign },
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { content: string } };
    expect(res.toast.content).toContain("会话不匹配");
    await tick();
    expect(allowCalls).toHaveLength(0);
  });

  test("重复点击只回 toast，不报错、不重复写入", async () => {
    const { manager, sender, allowCalls } = setup();
    await manager.onAsked(REQUEST);
    const value = allowValueFrom(sender);
    const action: CardAction = { rawValue: value, messageId: "om_card_1", chatId: "oc_1", operatorOpenId: "ou_1" };

    const first = manager.handleCardAction(action) as { toast: { type: string } };
    await tick();
    const second = manager.handleCardAction(action) as { toast: { type: string; content: string } };
    expect(first.toast.type).toBe("info");
    expect(second.toast.type).toBe("warning");
    expect(second.toast.content).toContain("已处理");
    expect(allowCalls).toHaveLength(1);
  });

  test("已生效：hasSessionAllow=true 时回 info toast，仍答复当前请求", async () => {
    const { manager, sender, replies, allowCalls } = setup({ hasSessionAllow: () => true });
    await manager.onAsked(REQUEST);
    const value = allowValueFrom(sender);
    const res = manager.handleCardAction({
      rawValue: value,
      messageId: "om_card_1",
      chatId: "oc_1",
      operatorOpenId: "ou_1",
    }) as { toast: { type: string } };
    expect(res.toast.type).toBe("info");
    await tick();
    expect(allowCalls).toHaveLength(1); // 幂等写入仍执行（无副作用）
    expect(replies).toHaveLength(1);
  });

  test("配置关闭：审批卡不含该按钮", async () => {
    const { manager, sender } = setup({ sessionAllowButton: false });
    await manager.onAsked(REQUEST);
    expect(JSON.stringify(sender.sent[0]!.card)).not.toContain("allow_session");
  });
});

describe("ApprovalManager.hasPendingFor（看门狗判活：等审批属合法等待）", () => {
  test("未决为 true；replied 后为 false；无关会话 false", async () => {
    const { manager } = setup();
    expect(manager.hasPendingFor("ses_1")).toBe(false);
    await manager.onAsked(REQUEST);
    expect(manager.hasPendingFor("ses_1")).toBe(true);
    expect(manager.hasPendingFor("ses_other")).toBe(false);
    manager.onReplied({ sessionID: "ses_1", requestID: "per_1", reply: "once" });
    expect(manager.hasPendingFor("ses_1")).toBe(false);
  });
});

describe("ApprovalManager.onReplied", () => {
  test("未由点击更新的卡片在 replied 时撤回", async () => {
    const { manager, sender } = setup();
    await manager.onAsked(REQUEST);
    manager.onReplied({ sessionID: "ses_1", requestID: "per_1", reply: "reject" });
    await tick();
    expect(sender.deleted).toEqual(["om_card_1"]);

    // 已消费，再次 replied 不再处理
    manager.onReplied({ sessionID: "ses_1", requestID: "per_1", reply: "reject" });
    await tick();
    expect(sender.deleted).toEqual(["om_card_1"]);
  });

  test("replied 撤回失败 → 降级 patch 结果卡", async () => {
    const { manager, sender } = setup();
    await manager.onAsked(REQUEST);
    sender.failDelete = true;
    manager.onReplied({ sessionID: "ses_1", requestID: "per_1", reply: "reject" });
    await tick();
    expect(sender.patched).toHaveLength(1);
    expect((sender.patched[0]!.card as { header: { template: string } }).header.template).toBe("red");
  });
});
