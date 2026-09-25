import { describe, expect, test } from "vitest";
import { CHAT_KEY_PREFIX, SessionMap, SESSION_KEY_PREFIX } from "../src/feishu/session-map.js";
import { createLogger } from "../src/logger.js";
import { FakeStorage } from "./helpers.js";

const log = createLogger({ level: "error", sink: () => undefined });

describe("SessionMap", () => {
  test("link 双向持久化 + 内存可同步判定", async () => {
    const storage = new FakeStorage();
    const map = new SessionMap(storage, log);
    await map.link("oc_1", "ses_1", "ou_1");

    expect(map.hasSession("ses_1")).toBe(true);
    expect(map.getSessionIdForChat("oc_1")).toBe("ses_1");
    expect(storage.raw(`${CHAT_KEY_PREFIX}oc_1`)).toEqual({ sessionID: "ses_1", openId: "ou_1" });
    expect(storage.raw(`${SESSION_KEY_PREFIX}ses_1`)).toEqual({ chatId: "oc_1", openId: "ou_1" });
  });

  test("冷缓存时从 storage 回填", async () => {
    const storage = new FakeStorage();
    storage.seed(`${SESSION_KEY_PREFIX}ses_9`, { chatId: "oc_9", openId: "ou_9" });
    const map = new SessionMap(storage, log);

    const link = await map.resolveBySession("ses_9");
    expect(link).toEqual({ chatId: "oc_9", openId: "ou_9" });
    expect(map.hasSession("ses_9")).toBe(true);
  });

  test("storage 无记录返回 undefined", async () => {
    const map = new SessionMap(new FakeStorage(), log);
    expect(await map.resolveBySession("ses_x")).toBeUndefined();
    expect(await map.resolveByChat("oc_x")).toBeUndefined();
  });

  test("storage 异常时降级不抛", async () => {
    const broken = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
      remove: async () => undefined,
    };
    const map = new SessionMap(broken, log);
    expect(await map.resolveBySession("ses_x")).toBeUndefined();
    await expect(map.link("oc_1", "ses_1", "ou_1")).resolves.toBeUndefined();
    // 内存仍可用
    expect(map.hasSession("ses_1")).toBe(true);
  });
});
