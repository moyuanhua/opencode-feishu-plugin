import { describe, expect, test } from "vitest";
import { isUserAllowed, matchesAny, OwnerPolicy, OWNER_STORAGE_KEY } from "../src/security/allowlist.js";
import { FakeStorage } from "./helpers.js";

describe("isUserAllowed / matchesAny", () => {
  test("白名单为空一律拒绝", () => {
    expect(isUserAllowed("ou_1", [])).toBe(false);
  });

  test("命中白名单", () => {
    expect(isUserAllowed("ou_1", ["ou_1"])).toBe(true);
    expect(isUserAllowed("ou_2", ["ou_1"])).toBe(false);
    expect(isUserAllowed(undefined, ["ou_1"])).toBe(false);
  });

  test("工具名匹配", () => {
    expect(matchesAny("read", ["read"])).toBe(true);
    expect(matchesAny("bash", ["*"])).toBe(true);
    expect(matchesAny("bashx", ["bash*"])).toBe(true);
    expect(matchesAny("bash", ["read"])).toBe(false);
  });
});

describe("OwnerPolicy", () => {
  test("allowUsers 非空：仅白名单", async () => {
    const policy = new OwnerPolicy(new FakeStorage(), ["ou_a"]);
    await policy.load();
    expect(await policy.admit("ou_a")).toBe(true);
    expect(await policy.admit("ou_b")).toBe(false);
  });

  test("allowUsers 为空：首个发消息者绑定为 owner 并持久化", async () => {
    const storage = new FakeStorage();
    const policy = new OwnerPolicy(storage, []);
    await policy.load();
    expect(await policy.admit("ou_first")).toBe(true);
    expect(storage.raw(OWNER_STORAGE_KEY)).toBe("ou_first");
    // 后续只有 owner 允许
    expect(await policy.admit("ou_second")).toBe(false);
    expect(await policy.admit("ou_first")).toBe(true);
  });

  test("重启后从 storage 恢复 owner", async () => {
    const storage = new FakeStorage();
    storage.seed(OWNER_STORAGE_KEY, "ou_persisted");
    const policy = new OwnerPolicy(storage, []);
    await policy.load();
    expect(await policy.admit("ou_persisted")).toBe(true);
    expect(await policy.admit("ou_stranger")).toBe(false);
  });

  test("storage 抛异常时不影响内存放行", async () => {
    const broken = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
      remove: async () => undefined,
    };
    const policy = new OwnerPolicy(broken, []);
    await policy.load();
    expect(await policy.admit("ou_x")).toBe(true);
  });
});
