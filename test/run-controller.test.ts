import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";
import { createRunController, type RunController } from "../src/feishu/run-controller.js";

const log = createLogger({ level: "error", sink: () => undefined });

interface Sent {
  readonly chatId: string;
  readonly card: object;
  readonly messageId: string;
}
interface Patched {
  readonly messageId: string;
  readonly card: object;
}

class FakeSender implements FeishuSender {
  readonly sent: Sent[] = [];
  readonly patched: Patched[] = [];
  private seq = 0;

  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    const messageId = `om_${this.seq++}`;
    this.sent.push({ chatId, card, messageId });
    return { ok: true, messageId };
  }

  async replyCard(_messageId: string, card: object): Promise<SendCardResult> {
    const messageId = `om_${this.seq++}`;
    this.sent.push({ chatId: "reply", card, messageId });
    return { ok: true, messageId };
  }

  async patchCard(messageId: string, card: object): Promise<{ ok: boolean }> {
    this.patched.push({ messageId, card });
    return { ok: true };
  }

  async sendText(): Promise<SendCardResult> {
    return { ok: true };
  }

  async replyText(): Promise<SendCardResult> {
    return { ok: true };
  }

  async getMessageMeta(): Promise<undefined> {
    return undefined;
  }

  async deleteMessage(): Promise<void> {}
}

const cardText = (card: object): string => JSON.stringify(card);
const lastPatchFor = (sender: FakeSender, messageId: string): string => {
  const hits = sender.patched.filter((p) => p.messageId === messageId);
  return hits.length > 0 ? cardText(hits[hits.length - 1]!.card) : "";
};

function setup(enabled = true): { sender: FakeSender; controller: RunController } {
  const sender = new FakeSender();
  const controller = createRunController({ sender, log, enabled, throttleMs: 400 });
  return { sender, controller };
}

describe("run controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("beginRun 先发回执卡（思考中）", async () => {
    const { sender, controller } = setup();
    const result = await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer" });
    expect(result.ok).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(cardText(sender.sent[0]!.card)).toContain("正在思考");
    expect(controller.hasActive("ses_1")).toBe(true);
    controller.dispose();
  });

  test("流式文本节流更新 + execution.succeeded 强制收尾", async () => {
    const { sender, controller } = setup();
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer" });

    controller.apply("ses_1", { type: "execution.started" });
    controller.apply("ses_1", { type: "text.delta", delta: "hello" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_0")).toContain("hello");

    controller.apply("ses_1", { type: "execution.succeeded" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_0")).toContain("已完成");
    expect(controller.hasActive("ses_1")).toBe(false);
    controller.dispose();
  });

  test("运行中再次 beginRun 走 queue：排队卡片 + 上一个结束后晋升", async () => {
    const { sender, controller } = setup();
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer" });
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "queue" });
    expect(cardText(sender.sent[1]!.card)).toContain("已排队");

    // 第一次执行开始/结束，收尾第一张卡。
    controller.apply("ses_1", { type: "execution.started" });
    controller.apply("ses_1", { type: "execution.succeeded" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_0")).toContain("已完成");

    // 第二次执行开始：排队卡晋升为 active。
    controller.apply("ses_1", { type: "execution.started" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_1")).toContain("正在思考");
    controller.dispose();
  });

  test("enabled=false 时不发卡", async () => {
    const { sender, controller } = setup(false);
    const result = await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer" });
    expect(result.ok).toBe(false);
    expect(sender.sent).toHaveLength(0);
    controller.dispose();
  });

  test("replyToMessageId 有值时用 reply 发回执卡（话题内）", async () => {
    const { sender, controller } = setup();
    const result = await controller.beginRun({
      sessionID: "ses_1",
      chatId: "oc_1",
      delivery: "steer",
      replyToMessageId: "om_src",
    });
    expect(result.ok).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.chatId).toBe("reply");
    expect(sender.sent[0]!.messageId).toBe("om_0");
    controller.dispose();
  });

  test("无 active 时事件被忽略，不抛异常", () => {
    const { sender, controller } = setup();
    controller.apply("ses_missing", { type: "text.delta", delta: "x" });
    expect(sender.patched).toHaveLength(0);
    controller.dispose();
  });

  test("多会话互不干扰", async () => {
    const { sender, controller } = setup();
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer" });
    await controller.beginRun({ sessionID: "ses_2", chatId: "oc_1", delivery: "steer" });
    controller.apply("ses_1", { type: "text.delta", delta: "one" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_0")).toContain("one");
    expect(lastPatchFor(sender, "om_1")).toBe("");
    controller.dispose();
  });

  test("beginRun 带 model → 页脚显示模型", async () => {
    const { sender, controller } = setup();
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer", model: "GPT-5" });
    expect(cardText(sender.sent[0]!.card)).toContain("🤖 GPT-5");
    controller.dispose();
  });

  test("setModel 更新运行中卡片页脚", async () => {
    const { sender, controller } = setup();
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer" });
    controller.setModel("ses_1", "Claude Sonnet 4");
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_0")).toContain("🤖 Claude Sonnet 4");
    controller.dispose();
  });

  test("注入 buildStopValue → 回执卡/运行卡带「强制停止」按钮", async () => {
    const sender = new FakeSender();
    const controller = createRunController({
      sender,
      log,
      enabled: true,
      throttleMs: 400,
      buildStopValue: (sessionID) => ({ cmd: "stop", sid: sessionID, t: `signed_${sessionID}` }),
    });
    const res = await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "steer" });
    expect(res.ok).toBe(true);
    const text = cardText(sender.sent[0]!.card);
    expect(text).toContain("强制停止");
    expect(text).toContain("signed_ses_1");
    controller.apply("ses_1", { type: "execution.succeeded" });
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_0")).toContain("⏹ 停止");
    controller.dispose();
  });

  test("staleQueued：排队超时只上报一次，execution.started 后重置", async () => {
    const { controller } = setup();
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "queue" });
    const base = Date.now();
    expect(controller.staleQueued(60_000, base + 120_000)).toEqual(["ses_1"]);
    expect(controller.staleQueued(60_000, base + 120_000)).toEqual([]);
    // 执行开始（晋升为 active）→ 重置标记；结束后再次排队可重新上报。
    controller.apply("ses_1", { type: "execution.started" });
    controller.apply("ses_1", { type: "execution.succeeded" });
    await vi.advanceTimersByTimeAsync(0);
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "queue" });
    expect(controller.staleQueued(60_000, Date.now() + 120_000)).toEqual(["ses_1"]);
    controller.dispose();
  });

  test("finalizeQueued：排队卡收尾为失败/中断态", async () => {
    const { sender, controller } = setup();
    await controller.beginRun({ sessionID: "ses_1", chatId: "oc_1", delivery: "queue" });
    controller.finalizeQueued("ses_1", "已中断（排队超时）");
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchFor(sender, "om_0")).toContain("已中断");
    controller.dispose();
  });
});
