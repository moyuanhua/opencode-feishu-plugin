import { describe, expect, test } from "vitest";
import { CHAT_KEY_PREFIX, CHAT_SESSIONS_SUFFIX, SessionMap, SESSION_KEY_PREFIX } from "../src/feishu/session-map.js";
import { createLogger } from "../src/logger.js";
import { FakeStorage } from "./helpers.js";

const log = createLogger({ level: "error", sink: () => undefined });
const NOW = 1_700_000_000_000;
const sessionsKey = (chatId: string) => `${CHAT_KEY_PREFIX}${chatId}${CHAT_SESSIONS_SUFFIX}`;

describe("SessionMap 多会话", () => {
  test("addSession 双向持久化 + 内存可同步判定", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "标题一", "ou_1");

    expect(map.hasSession("ses_1")).toBe(true);
    expect(map.getSessionIdForChat("oc_1")).toBe("ses_1");
    expect(storage.raw(sessionsKey("oc_1"))).toEqual({
      sessions: [{ sessionID: "ses_1", title: "标题一", updatedAt: NOW }],
      active: "ses_1",
    });
    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_1`)).toEqual({ chatId: "oc_1", openId: "ou_1" });
  });

  test("多会话：listSessions 保持插入顺序，setActive 切换当前", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "一", "ou_1");
    await map.addSession("oc_1", "ses_2", "二", "ou_1");
    await map.addSession("oc_1", "ses_3", "三", "ou_1");

    const list = await map.listSessions("oc_1");
    expect(list.map((s) => s.sessionID)).toEqual(["ses_1", "ses_2", "ses_3"]);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_3");

    expect(await map.setActive("oc_1", "ses_2")).toBe(true);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_2");
    expect(map.getSessionIdForChat("oc_1")).toBe("ses_2");
    // 非当前会话仍然可被权限路由解析
    expect(await map.resolveBySession("ses_1")).toEqual({ chatId: "oc_1", openId: "ou_1" });
  });

  test("setActive 未知会话返回 false 且不改动 active", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "一", "ou_1");

    expect(await map.setActive("oc_1", "ses_x")).toBe(false);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_1");
  });

  test("removeSession：移除当前会话回退到剩余最后一个，并删 session 索引", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "一", "ou_1");
    await map.addSession("oc_1", "ses_2", "二", "ou_1");

    expect(await map.removeSession("oc_1", "ses_2")).toBe(true);
    expect((await map.listSessions("oc_1")).map((s) => s.sessionID)).toEqual(["ses_1"]);
    expect((await map.getActive("oc_1"))?.sessionID).toBe("ses_1");
    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_2`)).toBeUndefined();
    expect(await map.removeSession("oc_1", "ses_x")).toBe(false);
  });

  test("renameSession 更新标题；不存在返回 false", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log, { now: () => NOW });
    await map.addSession("oc_1", "ses_1", "旧", "ou_1");

    expect(await map.renameSession("oc_1", "ses_1", "新")).toBe(true);
    expect((await map.listSessions("oc_1"))[0]?.title).toBe("新");
    expect(await map.renameSession("oc_1", "ses_x", "新")).toBe(false);
  });

  test("向后兼容：读到旧单值 key 时迁移成多会话结构", async () => {
    const storage = new FakeStorage();
    storage.seed(`${CHAT_KEY_PREFIX}oc_legacy`, { sessionID: "ses_old", openId: "ou_old" });
    const map = new SessionMap(storage, log, { now: () => NOW });

    const active = await map.getActive("oc_legacy");
    expect(active?.sessionID).toBe("ses_old");
    expect(map.getSessionIdForChat("oc_legacy")).toBe("ses_old");
    expect(map.hasSession("ses_old")).toBe(true);
    // 新结构已写入，旧 key 已删除
    expect(storage.raw(sessionsKey("oc_legacy"))).toEqual({
      sessions: [{ sessionID: "ses_old", title: "", updatedAt: NOW }],
      active: "ses_old",
    });
    expect(storage.raw(`${CHAT_KEY_PREFIX}oc_legacy`)).toBeUndefined();
    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_old`)).toEqual({ chatId: "oc_legacy", openId: "ou_old" });
    // 迁移后可正常新增/切换
    await map.addSession("oc_legacy", "ses_new", "新", "ou_old");
    expect(await map.setActive("oc_legacy", "ses_old")).toBe(true);
  });

  test("冷缓存时从 session 索引回填", async () => {
    const storage = new FakeStorage();
    storage.seed(`${SESSION_KEY_PREFIX}ses_9`, { chatId: "oc_9", openId: "ou_9" });
    const map = new SessionMap(storage, log);

    expect(await map.resolveBySession("ses_9")).toEqual({ chatId: "oc_9", openId: "ou_9" });
    expect(map.hasSession("ses_9")).toBe(true);
  });

  test("storage 无记录返回 undefined", async () => {
    const map = new SessionMap(new FakeStorage(), log);
    expect(await map.resolveBySession("ses_x")).toBeUndefined();
    expect(await map.resolveByChat("oc_x")).toBeUndefined();
    expect(await map.getActive("oc_x")).toBeUndefined();
    expect(await map.listSessions("oc_x")).toEqual([]);
  });

  test("storage 异常时降级不抛", async () => {
    const broken = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
      remove: async () => {
        throw new Error("boom");
      },
    };
    const map = new SessionMap(broken, log);
    expect(await map.resolveBySession("ses_x")).toBeUndefined();
    expect(await map.getActive("oc_x")).toBeUndefined();
    await expect(map.addSession("oc_1", "ses_1", "t", "ou_1")).resolves.toBeUndefined();
    // 内存仍可用
    expect(map.hasSession("ses_1")).toBe(true);
  });
});
