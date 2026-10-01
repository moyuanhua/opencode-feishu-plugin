import { describe, expect, test } from "vitest";
import {
  describeCardActionEvent,
  extractMessageText,
  isP2PChat,
  parseBotMenuEvent,
  parseCardAction,
  parseIncomingAttachment,
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

describe("机器人自定义菜单事件解析", () => {
  const base = {
    schema: "2.0",
    header: { event_id: "evt_menu_1", event_type: "application.bot.menu_v6" },
    event: {
      operator: {
        operator_name: "张三",
        operator_id: { union_id: "on_x", user_id: "u_1", open_id: "ou_owner" },
      },
      event_key: "new",
      timestamp: 1669364458,
    },
  };

  test("解析 event_key + 操作人 open_id + 事件 id", () => {
    expect(parseBotMenuEvent(base)).toEqual({
      eventId: "evt_menu_1",
      eventKey: "new",
      operatorOpenId: "ou_owner",
    });
  });

  test("兼容 SDK 长连接实收的拍平形状（header/event 提升到顶层）", () => {
    expect(
      parseBotMenuEvent({
        schema: "2.0",
        event_id: "evt_flat_1",
        event_type: "application.bot.menu_v6",
        tenant_key: "t",
        app_id: "cli_x",
        event_key: "sessions",
        operator: { operator_name: "张三", operator_id: { union_id: "on", user_id: "u", open_id: "ou_flat" } },
        timestamp: 1669364458,
      }),
    ).toEqual({ eventId: "evt_flat_1", eventKey: "sessions", operatorOpenId: "ou_flat" });
  });

  test("缺操作人 / 缺 event_key / 非法形状返回 undefined", () => {
    expect(parseBotMenuEvent({ header: { event_id: "e" }, event: { event_key: "new" } })).toBeUndefined();
    expect(
      parseBotMenuEvent({ header: { event_id: "e" }, event: { operator: { operator_id: { open_id: "ou" } } } }),
    ).toBeUndefined();
    expect(parseBotMenuEvent(null)).toBeUndefined();
    expect(parseBotMenuEvent("x")).toBeUndefined();
  });
});

describe("附件解析（图片/文件）", () => {
  test("image 消息解析出 image_key 附件", () => {
    const msg = parseIncomingMessage({
      event_id: "evt_img",
      sender: { sender_id: { open_id: "ou_1" } },
      message: {
        message_id: "om_img",
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v2_abc" }),
      },
    });
    expect(msg?.text).toBe("[图片]");
    expect(msg?.attachment).toEqual({ kind: "image", fileKey: "img_v2_abc" });
  });

  test("file 消息解析出 file_key + file_name", () => {
    const msg = parseIncomingMessage({
      event_id: "evt_file",
      sender: { sender_id: { open_id: "ou_1" } },
      message: {
        message_id: "om_file",
        chat_id: "oc_1",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file_v2_xyz", file_name: "报告.pdf" }),
      },
    });
    expect(msg?.text).toBe("[文件]");
    expect(msg?.attachment).toEqual({ kind: "file", fileKey: "file_v2_xyz", fileName: "报告.pdf" });
  });

  test("无 key / 非法 JSON / 其它类型不产生附件", () => {
    expect(parseIncomingAttachment("image", JSON.stringify({}))).toBeUndefined();
    expect(parseIncomingAttachment("file", JSON.stringify({ file_name: "x" }))).toBeUndefined();
    expect(parseIncomingAttachment("image", "{not json")).toBeUndefined();
    expect(parseIncomingAttachment("audio", JSON.stringify({ file_key: "k" }))).toBeUndefined();
    const msg = parseIncomingMessage({
      message: {
        message_id: "om_audio",
        chat_id: "oc_1",
        message_type: "audio",
        content: JSON.stringify({ file_key: "file_1" }),
      },
    });
    expect(msg?.attachment).toBeUndefined();
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

  test("表单提交：同时读取 action.value 与 action.form_value（P6.1）", () => {
    const action = parseCardAction({
      context: { open_message_id: "om_form", open_chat_id: "oc_1" },
      operator: { open_id: "ou_op" },
      action: {
        value: { cmd: "setup.form" },
        form_value: { dir: "/home/ubuntu/work", model: "anthropic/claude-sonnet-4-5", perm: "edit" },
      },
    });
    expect(action?.rawValue).toEqual({ cmd: "setup.form" });
    expect(action?.formValue).toEqual({
      dir: "/home/ubuntu/work",
      model: "anthropic/claude-sonnet-4-5",
      perm: "edit",
    });
  });

  test("纯 value 回调不带 formValue（向后兼容）", () => {
    const action = parseCardAction({
      context: { open_message_id: "om_card", open_chat_id: "oc_1" },
      operator: { open_id: "ou_op" },
      action: { value: { t: "tok", d: "once" } },
    });
    expect(action?.rawValue).toEqual({ t: "tok", d: "once" });
    expect(action && "formValue" in action).toBe(false);
  });

  test("仅 form_value（无 value）也能解析", () => {
    const action = parseCardAction({
      operator: { open_id: "ou_op" },
      action: { form_value: { dir: "/x" } },
    });
    expect(action?.rawValue).toBeUndefined();
    expect(action?.formValue).toEqual({ dir: "/x" });
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
