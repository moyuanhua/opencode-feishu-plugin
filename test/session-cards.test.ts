import { describe, expect, test } from "vitest";
import {
  buildSessionListCard,
  buildSessionReadyCard,
  buildSessionCreatedCard,
  buildSessionOpenedCard,
  buildSessionMissingCard,
  parseSessionCardValue,
  type SessionListRow,
} from "../src/feishu/session-cards.js";

const NOW = 1_700_000_000_000;

function buttonsOf(card: object): Array<Record<string, unknown>> {
  const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
  return elements.filter((e) => e.tag === "button");
}

function rows(): SessionListRow[] {
  return [
    { index: 1, sessionID: "ses_aaa", title: "一", updatedAt: NOW - 60_000, bound: false },
    { index: 2, sessionID: "ses_bbb", title: "二", updatedAt: NOW - 3 * 3600_000, bound: true, directory: "/home/ubuntu/work/app" },
  ];
}

describe("buildSessionListCard", () => {
  test("2.0 + update_multi + 每会话一个 open 按钮 + 分页/新建按钮", () => {
    const card = buildSessionListCard({
      chatId: "oc_1",
      rows: rows(),
      page: 0,
      pageCount: 2,
      total: 10,
      now: NOW,
    });
    const root = card as Record<string, unknown>;
    expect(root.schema).toBe("2.0");
    expect((root.config as Record<string, unknown>).update_multi).toBe(true);

    const buttons = buttonsOf(card);
    // 2 个 open + 1 个下一页 + 1 个新建
    expect(buttons).toHaveLength(4);
    const values = buttons.map((b) => parseSessionCardValue((b.behaviors as Array<{ value: unknown }>)[0]!.value));
    expect(values).toEqual([
      { cmd: "open", sessionID: "ses_aaa", chatId: "oc_1" },
      { cmd: "open", sessionID: "ses_bbb", chatId: "oc_1" },
      { cmd: "list", page: 1, chatId: "oc_1" },
      { cmd: "new", chatId: "oc_1" },
    ]);
  });

  test("已绑话题按钮文案为「再开话题」，未绑为「进入话题」；含相对时间/目录标记", () => {
    const card = buildSessionListCard({
      chatId: "oc_1",
      rows: rows(),
      page: 0,
      pageCount: 1,
      total: 2,
      now: NOW,
    });
    const text = JSON.stringify(card);
    expect(text).toContain("▶️ 进入话题");
    expect(text).toContain("▶️ 再开话题");
    expect(text).toContain("1 分钟前");
    expect(text).toContain("3 小时前");
    expect(text).toContain("💬 已绑话题");
    expect(text).toContain("📍 app");
    expect(text).toContain("第 1/1 页 · 共 2 个会话");
  });

  test("分页：第一页无上一页、末页无下一页", () => {
    const first = buildSessionListCard({ chatId: "oc_1", rows: rows(), page: 0, pageCount: 3, total: 20, now: NOW });
    const firstValues = buttonsOf(first).map((b) => parseSessionCardValue((b.behaviors as Array<{ value: unknown }>)[0]!.value));
    expect(firstValues.some((v) => v?.cmd === "list" && v.page === -1)).toBe(false);
    expect(firstValues).toContainEqual({ cmd: "list", page: 1, chatId: "oc_1" });

    const last = buildSessionListCard({ chatId: "oc_1", rows: rows(), page: 2, pageCount: 3, total: 20, now: NOW });
    const lastValues = buttonsOf(last).map((b) => parseSessionCardValue((b.behaviors as Array<{ value: unknown }>)[0]!.value));
    expect(lastValues).toContainEqual({ cmd: "list", page: 1, chatId: "oc_1" });
    expect(lastValues.some((v) => v?.cmd === "list" && v.page === 3)).toBe(false);
  });

  test("空列表只有新建按钮且含引导文案", () => {
    const card = buildSessionListCard({ chatId: "oc_1", rows: [], page: 0, pageCount: 1, total: 0, now: NOW });
    const buttons = buttonsOf(card);
    expect(buttons).toHaveLength(1);
    expect(parseSessionCardValue((buttons[0]!.behaviors as Array<{ value: unknown }>)[0]!.value)).toEqual({
      cmd: "new",
      chatId: "oc_1",
    });
    expect(JSON.stringify(card)).toContain("还没有会话");
  });

  test("卡片结构：JSON 2.0、无 1.0 tag:\"action\"、≤30KB", () => {
    const many: SessionListRow[] = Array.from({ length: 20 }, (_, i) => ({
      index: i + 1,
      sessionID: `ses_${i}`.padEnd(40, "x"),
      title: "很长的会话标题".repeat(10),
      updatedAt: NOW - i * 60_000,
      bound: i % 2 === 0,
      directory: "/home/ubuntu/work/some/deep/path/to/project",
    }));
    const card = buildSessionListCard({ chatId: "oc_1", rows: many, page: 0, pageCount: 1, total: 20, now: NOW });
    const json = JSON.stringify(card);
    expect(json).not.toContain('"tag":"action"');
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(30 * 1024);
    // 按钮直放 body.elements
    const elements = (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    expect(elements.every((e) => e.tag !== "action")).toBe(true);
  });
});

describe("buildSessionOpenedCard（进入话题成功卡）", () => {
  test("标题含会话标题；正文含 id/目录/最近活动/可用命令；无按钮", () => {
    const card = buildSessionOpenedCard({
      title: "我的项目",
      sessionID: "ses_old_1",
      dir: "/home/ubuntu/work/app",
      updatedAt: NOW - 7200_000,
      now: NOW,
    }) as { header: { title: { content: string } }; body: { elements: Array<Record<string, unknown>> } };
    expect(card.header.title.content).toBe("✅ 已进入会话 · 我的项目");
    const text = JSON.stringify(card);
    expect(text).toContain("ses_old_1");
    expect(text).toContain("/home/ubuntu/work/app");
    expect(text).toContain("2 小时前");
    expect(text).toContain("/current");
    expect(text).toContain("本话题内直接发消息");
    expect(buttonsOf(card)).toHaveLength(0);
  });

  test("空标题回退 (未命名)", () => {
    expect(JSON.stringify(buildSessionOpenedCard({ title: "  ", sessionID: "s" }))).toContain("✅ 已进入会话 · (未命名)");
  });
});

describe("buildSessionMissingCard", () => {
  test("含会话 id 与原因，无按钮", () => {
    const card = buildSessionMissingCard("ses_gone", "boom") as Record<string, unknown>;
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
    const text = JSON.stringify(card);
    expect(text).toContain("ses_gone");
    expect(text).toContain("boom");
    expect(buttonsOf(card)).toHaveLength(0);
  });
});

describe("buildSessionReadyCard", () => {
  test("一键进入卡：2.0 + 无按钮 + 展示标题与会话 id", () => {
    const card = buildSessionReadyCard({ title: "我的标题", sessionID: "ses_new_1" }) as Record<string, unknown>;
    expect(card.schema).toBe("2.0");
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
    expect(buttonsOf(card)).toHaveLength(0);
    const text = JSON.stringify(card);
    expect(text).toContain("我的标题");
    expect(text).toContain("ses_new_1");
    expect(text).toContain("本话题内直接发消息");
  });

  test("空标题回退 (未命名)", () => {
    expect(JSON.stringify(buildSessionReadyCard({ title: "  ", sessionID: "s" }))).toContain("(未命名)");
  });
});

describe("buildSessionCreatedCard（话题根成功卡）", () => {
  test("标题为 `✅ 已创建 · <标题>`，正文含 id/目录/模型/权限与直接发消息指引", () => {
    const card = buildSessionCreatedCard({
      title: "我的项目",
      sessionID: "ses_new_1",
      dir: "/home/ubuntu/work/app",
      model: "Claude Sonnet 4",
      perm: "可编辑",
    }) as { header: { title: { content: string } } };
    expect(card.header.title.content).toBe("✅ 已创建 · 我的项目");
    const text = JSON.stringify(card);
    expect(text).toContain("ses_new_1");
    expect(text).toContain("/home/ubuntu/work/app");
    expect(text).toContain("Claude Sonnet 4");
    expect(text).toContain("可编辑");
    expect(text).toContain("点进本话题直接发消息即可");
    expect(buttonsOf(card)).toHaveLength(0);
  });

  test("失败分支：标题仍是成功卡，附手动创建话题指引", () => {
    const card = buildSessionCreatedCard({
      title: "T",
      sessionID: "s",
      note: "⚠️ 自动开话题失败：请在 `/sessions` 的会话卡上手动「创建话题」",
    });
    expect(JSON.stringify(card)).toContain("自动开话题失败");
    expect(JSON.stringify(card)).toContain("✅ 已创建 · T");
  });

  test("空标题回退 (未命名)", () => {
    expect(JSON.stringify(buildSessionCreatedCard({ title: "  ", sessionID: "s" }))).toContain("✅ 已创建 · (未命名)");
  });
});

describe("parseSessionCardValue", () => {
  test("open 需要 sessionID", () => {
    expect(parseSessionCardValue({ cmd: "open", s: "ses_1", c: "oc_1" })).toEqual({
      cmd: "open",
      sessionID: "ses_1",
      chatId: "oc_1",
    });
    expect(parseSessionCardValue({ cmd: "open", c: "oc_1" })).toBeUndefined();
  });

  test("list 解析页码（非法回退 0）", () => {
    expect(parseSessionCardValue({ cmd: "list", p: 3, c: "oc_1" })).toEqual({ cmd: "list", page: 3, chatId: "oc_1" });
    expect(parseSessionCardValue({ cmd: "list", p: 0, c: "oc_1" })).toEqual({ cmd: "list", page: 0, chatId: "oc_1" });
    expect(parseSessionCardValue({ cmd: "list", c: "oc_1" })).toEqual({ cmd: "list", page: 0, chatId: "oc_1" });
  });

  test("use 需要 sessionID（旧卡片兼容）", () => {
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
