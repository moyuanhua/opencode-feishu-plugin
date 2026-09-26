import { describe, expect, test } from "vitest";
import {
  describeCardActionEvent,
  extractMessageText,
  isP2PChat,
  parseCardAction,
  parseIncomingMessage,
  stripMentionPlaceholders,
} from "../src/feishu/events.js";

describe("extractMessageText", () => {
  test("text 类型解析并去掉 @占位符", () => {
    expect(extractMessageText("text", JSON.stringify({ text: "@_user_1 你好" }))).toBe("你好");
  });

  test("post 富文本拼接", () => {
    const post = JSON.stringify({
      title: "标题",
      content: [
        [{ tag: "text", text: "第一段" }],
        [
          { tag: "a", text: "链接", href: "https://x" },
          { tag: "img" },
        ],
      ],
    });
    expect(extractMessageText("post", post)).toBe("标题\n第一段\n链接(https://x)[图片]");
  });

  test("非文本类型返回占位描述", () => {
    expect(extractMessageText("image", "{}")).toBe("[图片]");
    expect(extractMessageText("audio", "{}")).toBe("[语音消息]");
    expect(extractMessageText("weird", "{}")).toBe("[不支持的消息类型: weird]");
  });

  test("坏 JSON 不抛异常", () => {
    expect(extractMessageText("text", "not-json")).toBe("");
  });
});

describe("stripMentionPlaceholders", () => {
  test("多处占位符", () => {
    expect(stripMentionPlaceholders("@_user_1 @_user_12 hi")).toBe("hi");
  });
});

describe("parseIncomingMessage", () => {
  const base = {
    event_id: "evt_1",
    sender: { sender_id: { open_id: "ou_sender" } },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hi" }),
      create_time: "123",
    },
  };

  test("解析 p2p 文本", () => {
    const msg = parseIncomingMessage(base);
    expect(msg).toMatchObject({
      eventId: "evt_1",
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "p2p",
      messageType: "text",
      text: "hi",
      senderOpenId: "ou_sender",
      createTime: "123",
    });
  });

  test("缺 chat_id / message_id 返回 undefined", () => {
    expect(parseIncomingMessage({ message: { message_id: "x" } })).toBeUndefined();
    expect(parseIncomingMessage({ message: { chat_id: "x" } })).toBeUndefined();
    expect(parseIncomingMessage(null)).toBeUndefined();
  });

  test("空 content 返回 undefined", () => {
    expect(parseIncomingMessage({ message: { message_id: "m", chat_id: "c", content: "" } })).toBeUndefined();
  });

  test("isP2PChat", () => {
    expect(isP2PChat("p2p")).toBe(true);
    expect(isP2PChat("group")).toBe(false);
    expect(isP2PChat(undefined)).toBe(false);
  });
});

describe("parseCardAction", () => {
  test("解析 context 路径 + 对象 value", () => {
    const action = parseCardAction({
      context: { open_message_id: "om_card", open_chat_id: "oc_1" },
      operator: { open_id: "ou_op" },
      action: { value: { t: "tok", d: "once" } },
      token: "cb_token",
    });
    expect(action).toEqual({
      rawValue: { t: "tok", d: "once" },
      messageId: "om_card",
      chatId: "oc_1",
      operatorOpenId: "ou_op",
      callbackToken: "cb_token",
    });
  });

  test("兼容顶层 message id 与 JSON 字符串 value", () => {
    const action = parseCardAction({
      open_message_id: "om_top",
      operator: { open_id: "ou_op" },
      action: { value: '{"t":"tok","d":"reject"}' },
    });
    expect(action?.messageId).toBe("om_top");
    expect(action?.rawValue).toEqual({ t: "tok", d: "reject" });
  });

  test("无 operator 返回 undefined", () => {
    expect(parseCardAction({ action: { value: {} } })).toBeUndefined();
  });
});

describe("describeCardActionEvent（P5.2 回调诊断）", () => {
  test("只返回键名与布尔，不泄露 token / open_id / value 的值", () => {
    const diag = describeCardActionEvent({
      token: "SECRET_TOKEN",
      context: { open_message_id: "om_1", open_chat_id: "oc_1", thread_id: "omt_1" },
      operator: { open_id: "ou_secret" },
      action: { value: { t: "approval-token", d: "once" } },
      extra: true,
    });
    expect(diag.hasThreadId).toBe(true);
    expect(diag.hasRootId).toBe(false);
    expect(diag.hasOpenMessageId).toBe(true);
    expect(diag.hasOpenChatId).toBe(true);
    expect(diag.hasOperator).toBe(true);
    expect(diag.hasToken).toBe(true);
    expect(diag.contextKeys).toEqual(expect.arrayContaining(["open_message_id", "open_chat_id", "thread_id"]));
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain("SECRET_TOKEN");
    expect(serialized).not.toContain("ou_secret");
    expect(serialized).not.toContain("approval-token");
  });

  test("主聊天流回调（无 thread_id）", () => {
    const diag = describeCardActionEvent({
      context: { open_message_id: "om_1", open_chat_id: "oc_1" },
      operator: { open_id: "ou_1" },
      action: { value: {} },
    });
    expect(diag.hasThreadId).toBe(false);
    expect(diag.hasOpenMessageId).toBe(true);
  });

  test("非对象输入不抛异常", () => {
    expect(() => describeCardActionEvent(null)).not.toThrow();
    expect(describeCardActionEvent(null).hasOperator).toBe(false);
  });
});
