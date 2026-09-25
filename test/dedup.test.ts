import { describe, expect, test } from "vitest";
import { createLogger } from "../src/logger.js";
import { MessageDedup, MESSAGE_KEY_PREFIX } from "../src/feishu/dedup.js";
import type { StorageLike } from "../src/types.js";
import { FakeStorage } from "./helpers.js";

const log = createLogger({ level: "error", sink: () => undefined });

describe("MessageDedup", () => {
  test("首次认领 true，同实例再次认领 false", async () => {
    const storage = new FakeStorage();
    const dedup = new MessageDedup(storage, log);
    expect(await dedup.claim("om_1")).toBe(true);
    expect(await dedup.claim("om_1")).toBe(false);
    expect(storage.raw(`${MESSAGE_KEY_PREFIX}om_1`)).toMatchObject({ at: expect.any(Number) });
  });

  test("另一实例已写入 storage：本实例也判为重复", async () => {
    const storage = new FakeStorage();
    storage.seed(`${MESSAGE_KEY_PREFIX}om_2`, { at: Date.now() });
    const dedup = new MessageDedup(storage, log);
    expect(await dedup.claim("om_2")).toBe(false);
  });

  test("storage 中的记录超过 TTL 视为未见过", async () => {
    const storage = new FakeStorage();
    storage.seed(`${MESSAGE_KEY_PREFIX}om_3`, { at: 800 });
    const dedup = new MessageDedup(storage, log, { now: () => 1000, ttlMs: 100 });
    expect(await dedup.claim("om_3")).toBe(true);
    expect(await dedup.claim("om_3")).toBe(false);
  });

  test("空 messageId 不参与去重，不阻塞", async () => {
    const storage = new FakeStorage();
    const dedup = new MessageDedup(storage, log);
    expect(await dedup.claim("")).toBe(true);
    expect(await dedup.claim("")).toBe(true);
  });

  test("storage 异常时降级为处理（fail-open，不丢消息）", async () => {
    const broken: StorageLike = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
      remove: async () => {},
    };
    const dedup = new MessageDedup(broken, log);
    expect(await dedup.claim("om_4")).toBe(true);
  });
});
