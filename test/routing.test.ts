import { describe, expect, test } from "vitest";
import { commandScope, decideRoute } from "../src/feishu/routing.js";

describe("decideRoute", () => {
  test("命令优先（主聊天流 / 话题都由命令层处理）", () => {
    expect(decideRoute({ hasThread: false, isCommand: true, threadKnown: false, rootKnown: false })).toEqual({
      kind: "command",
    });
    expect(decideRoute({ hasThread: true, isCommand: true, threadKnown: true, rootKnown: false })).toEqual({
      kind: "command",
    });
  });

  test("主聊天流普通文本 → main-hint（不进入任何会话）", () => {
    expect(decideRoute({ hasThread: false, isCommand: false, threadKnown: false, rootKnown: false })).toEqual({
      kind: "main-hint",
    });
  });

  test("话题命中 → use-session(thread)", () => {
    expect(decideRoute({ hasThread: true, isCommand: false, threadKnown: true, rootKnown: false })).toEqual({
      kind: "use-session",
      source: "thread",
    });
  });

  test("thread 未命中但 root 命中 → use-session(root)", () => {
    expect(decideRoute({ hasThread: true, isCommand: false, threadKnown: false, rootKnown: true })).toEqual({
      kind: "use-session",
      source: "root",
    });
  });

  test("即使无 threadId，root 命中 → use-session(root)（话题首条消息只带 root_id）", () => {
    expect(decideRoute({ hasThread: false, isCommand: false, threadKnown: false, rootKnown: true })).toEqual({
      kind: "use-session",
      source: "root",
    });
  });

  test("话题内都未命中 → create-in-thread", () => {
    expect(decideRoute({ hasThread: true, isCommand: false, threadKnown: false, rootKnown: false })).toEqual({
      kind: "create-in-thread",
    });
  });

  test("thread 命中优先于 root", () => {
    expect(decideRoute({ hasThread: true, isCommand: false, threadKnown: true, rootKnown: true })).toEqual({
      kind: "use-session",
      source: "thread",
    });
  });
});

describe("commandScope", () => {
  test("有 threadId = 话题内，否则主聊天流", () => {
    expect(commandScope(true)).toBe("thread");
    expect(commandScope(false)).toBe("main");
  });
});
