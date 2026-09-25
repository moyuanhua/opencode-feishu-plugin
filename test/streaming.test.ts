import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStreamingController } from "../src/feishu/streaming.js";
import { createLogger } from "../src/logger.js";
import type { FeishuSender, SendCardResult } from "../src/feishu/sender.js";

const log = createLogger({ level: "error", sink: () => undefined });

class FakeSender implements FeishuSender {
  readonly sent: Array<{ chatId: string; card: object }> = [];
  readonly patched: Array<{ messageId: string; card: object }> = [];
  async sendCard(chatId: string, card: object): Promise<SendCardResult> {
    this.sent.push({ chatId, card });
    return { ok: true, messageId: "om_stream" };
  }
  async patchCard(messageId: string, card: object): Promise<{ ok: boolean }> {
    this.patched.push({ messageId, card });
    return { ok: true };
  }
  async sendText(): Promise<SendCardResult> {
    return { ok: true };
  }
  async deleteMessage(): Promise<void> {}
}

const cardText = (card: object): string => JSON.stringify(card);
const lastPatchText = (sender: FakeSender): string =>
  cardText(sender.patched[sender.patched.length - 1]!.card);

function setup(link: { chatId: string; openId: string } | null = { chatId: "oc_1", openId: "ou_1" }) {
  const sender = new FakeSender();
  const controller = createStreamingController({
    sender,
    log,
    enabled: true,
    throttleMs: 400,
    getLink: async () => link ?? undefined,
  });
  return { sender, controller };
}

describe("streaming controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("懒开卡 + 节流更新 + 定稿最终文本", async () => {
    const { sender, controller } = setup();

    controller.onStarted("ses_1");
    controller.onDelta("ses_1", "Hello");
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.sent).toHaveLength(1);

    controller.onDelta("ses_1", " world");
    await vi.advanceTimersByTimeAsync(400);
    expect(sender.patched.length).toBeGreaterThanOrEqual(1);

    controller.onEnded("ses_1", "Hello world final");
    await vi.advanceTimersByTimeAsync(0);
    expect(lastPatchText(sender)).toContain("Hello world final");

    controller.dispose();
  });

  test("无飞书映射则静默丢弃，不发消息", async () => {
    const { sender, controller } = setup(null);
    controller.onDelta("ses_x", "hi");
    await vi.advanceTimersByTimeAsync(400);
    expect(sender.sent).toHaveLength(0);
    expect(sender.patched).toHaveLength(0);
    controller.dispose();
  });

  test("onStarted 为新消息重置状态", async () => {
    const { sender, controller } = setup();
    controller.onStarted("ses_1");
    controller.onDelta("ses_1", "first");
    await vi.advanceTimersByTimeAsync(400);
    controller.onEnded("ses_1", "first");
    await vi.advanceTimersByTimeAsync(0);

    controller.onStarted("ses_1");
    controller.onDelta("ses_1", "second");
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.sent).toHaveLength(2);
    expect(cardText(sender.sent[1]!.card)).toContain("second");
    controller.dispose();
  });

  test("enabled=false 时完全不动", async () => {
    const sender = new FakeSender();
    const controller = createStreamingController({
      sender,
      log,
      enabled: false,
      throttleMs: 400,
      getLink: async () => ({ chatId: "oc_1", openId: "ou_1" }),
    });
    controller.onDelta("ses_1", "hi");
    await vi.advanceTimersByTimeAsync(400);
    expect(sender.sent).toHaveLength(0);
    controller.dispose();
  });
});
