import { describe, expect, test } from "vitest";
import { buildSessionListCard, parseSessionCardValue } from "../src/feishu/session-cards.js";
import type { SessionEntry } from "../src/feishu/session-map.js";

const entries: SessionEntry[] = [
  { sessionID: "ses_aaa", title: "一", updatedAt: 1 },
  { sessionID: "ses_bbb", title: "二", updatedAt: 2 },
];

function buttonsOf(card: object): Array<Record<string, unknown>> {
  const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
  return elements.filter((e) => e.tag === "button");
}

describe("buildSessionListCard", () => {
  test("2.0 + update_multi + 每会话一个切换按钮 + 一个新建按钮", () => {
    const card = buildSessionListCard({ chatId: "oc_1", sessions: entries, activeID: "ses_bbb" });
    const root = card as Record<string, unknown>;
    expect(root.schema).toBe("2.0");
    expect((root.config as Record<string, unknown>).update_multi).toBe(true);

    const buttons = buttonsOf(card);
    expect(buttons).toHaveLength(3);
    const values = buttons.map((b) => parseSessionCardValue((b.behaviors as Array<{ value: unknown }>)[0]!.value));
    expect(values).toEqual([
      { cmd: "use", sessionID: "ses_aaa", chatId: "oc_1" },
      { cmd: "use", sessionID: "ses_bbb", chatId: "oc_1" },
      { cmd: "new", chatId: "oc_1" },
    ]);
    // 当前会话按钮高亮
    expect(buttons[1]!.type).toBe("primary");
    expect(buttons[0]!.type).toBe("default");
  });

  test("空列表只有新建按钮且含引导文案", () => {
    const card = buildSessionListCard({ chatId: "oc_1", sessions: [] });
    expect(buttonsOf(card)).toHaveLength(1);
    expect(JSON.stringify(card)).toContain("还没有会话");
  });
});

describe("parseSessionCardValue", () => {
  test("use 需要 sessionID", () => {
    expect(parseSessionCardValue({ cmd: "use", s: "ses_1", c: "oc_1" })).toEqual({
      cmd: "use",
      sessionID: "ses_1",
      chatId: "oc_1",
    });
    expect(parseSessionCardValue({ cmd: "use", c: "oc_1" })).toBeUndefined();
  });

  test("new 不要求 sessionID", () => {
    expect(parseSessionCardValue({ cmd: "new", c: "oc_1" })).toEqual({ cmd: "new", chatId: "oc_1" });
  });

  test("审批卡 value / 非对象返回 undefined", () => {
    expect(parseSessionCardValue({ t: "tok", d: "once" })).toBeUndefined();
    expect(parseSessionCardValue("x")).toBeUndefined();
    expect(parseSessionCardValue(null)).toBeUndefined();
  });
});
