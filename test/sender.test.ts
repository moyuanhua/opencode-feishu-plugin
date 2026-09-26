import { describe, expect, test, vi } from "vitest";
import { createFeishuSender } from "../src/feishu/sender.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });

interface Call {
  readonly fn: string;
  readonly payload: unknown;
}

/** 极简 fake Lark client：只覆盖 im.message.* 的调用形状。 */
function makeClient(over: (call: Call) => unknown = () => ({ code: 0, data: { message_id: "om_new" } })) {
  const calls: Call[] = [];
  const client = {
    im: {
      message: {
        create: vi.fn(async (payload: unknown) => {
          calls.push({ fn: "create", payload });
          return over({ fn: "create", payload });
        }),
        reply: vi.fn(async (payload: unknown) => {
          calls.push({ fn: "reply", payload });
          return over({ fn: "reply", payload });
        }),
        patch: vi.fn(async (payload: unknown) => {
          calls.push({ fn: "patch", payload });
          return over({ fn: "patch", payload });
        }),
        get: vi.fn(async (payload: unknown) => {
          calls.push({ fn: "get", payload });
          return over({ fn: "get", payload });
        }),
        delete: vi.fn(async (payload: unknown) => {
          calls.push({ fn: "delete", payload });
          return over({ fn: "delete", payload });
        }),
      },
    },
  };
  return { client, calls };
}

// createFeishuSender 只依赖 client 的结构，运行时用 fake 即可。
const senderWith = (client: unknown) =>
  createFeishuSender(client as never, log);

describe("FeishuSender 回复能力（P5）", () => {
  test("sendCard 走 create（receive_id_type=chat_id）", async () => {
    const { client, calls } = makeClient();
    const sender = senderWith(client);
    const res = await sender.sendCard("oc_1", { schema: "2.0" });
    expect(res).toEqual({ ok: true, messageId: "om_new" });
    expect(calls[0]!.fn).toBe("create");
    const payload = calls[0]!.payload as { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string } };
    expect(payload.params.receive_id_type).toBe("chat_id");
    expect(payload.data.receive_id).toBe("oc_1");
    expect(payload.data.msg_type).toBe("interactive");
  });

  test("replyCard 走 reply，默认不带 reply_in_thread", async () => {
    const { client, calls } = makeClient(({ fn }) =>
      fn === "reply"
        ? { code: 0, data: { message_id: "om_reply", thread_id: "omt_1", root_id: "om_root" } }
        : { code: 0, data: { message_id: "om_new" } },
    );
    const sender = senderWith(client);
    const res = await sender.replyCard("om_src", { schema: "2.0" });
    expect(res).toEqual({ ok: true, messageId: "om_reply", threadId: "omt_1", rootId: "om_root" });
    const payload = calls[0]!.payload as { path: { message_id: string }; data: Record<string, unknown> };
    expect(payload.path.message_id).toBe("om_src");
    expect(payload.data.reply_in_thread).toBeUndefined();
  });

  test("replyCard replyInThread=true 带 reply_in_thread:true", async () => {
    const { client, calls } = makeClient();
    const sender = senderWith(client);
    await sender.replyCard("om_src", { schema: "2.0" }, { replyInThread: true });
    const payload = calls[0]!.payload as { data: Record<string, unknown> };
    expect(payload.data.reply_in_thread).toBe(true);
  });

  test("replyText 走 reply + text 消息体", async () => {
    const { client, calls } = makeClient();
    const sender = senderWith(client);
    const res = await sender.replyText("om_src", "你好");
    expect(res.ok).toBe(true);
    const payload = calls[0]!.payload as { data: { msg_type: string; content: string } };
    expect(payload.data.msg_type).toBe("text");
    expect(JSON.parse(payload.data.content)).toEqual({ text: "你好" });
  });

  test("reply 返回业务错误码时 ok=false", async () => {
    const { client } = makeClient(() => ({ code: 230002, msg: "no permission" }));
    const sender = senderWith(client);
    const res = await sender.replyCard("om_src", { schema: "2.0" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("230002");
  });

  test("缺少 messageId 时不发请求", async () => {
    const { client, calls } = makeClient();
    const sender = senderWith(client);
    const res = await sender.replyCard("", { schema: "2.0" });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("getMessageMeta 读回 thread/root/parent", async () => {
    const { client, calls } = makeClient(() => ({
      code: 0,
      data: { items: [{ message_id: "om_x", thread_id: "omt_1", root_id: "om_root", parent_id: "om_p" }] },
    }));
    const sender = senderWith(client);
    const meta = await sender.getMessageMeta("om_x");
    expect(meta).toEqual({ threadId: "omt_1", rootId: "om_root", parentId: "om_p" });
    expect(calls[0]!.fn).toBe("get");
  });

  test("getMessageMeta 无 items / 错误码返回 undefined", async () => {
    const empty = senderWith(makeClient(() => ({ code: 0, data: { items: [] } })).client);
    expect(await empty.getMessageMeta("om_x")).toBeUndefined();
    const bad = senderWith(makeClient(() => ({ code: 123, msg: "x" })).client);
    expect(await bad.getMessageMeta("om_x")).toBeUndefined();
  });
});
