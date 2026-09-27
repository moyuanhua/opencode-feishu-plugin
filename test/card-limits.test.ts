import { describe, expect, test, vi } from "vitest";
import {
  CARD_MAX_TABLES_MAX,
  DEFAULT_CARD_MAX_ELEMENTS,
  DEFAULT_CARD_MAX_TABLES,
  clampMaxTables,
  countMarkdownTables,
  createCardMarkdownBudget,
  degradeExtraTables,
  enforceCardLimits,
  findMarkdownTables,
  toCardMarkdown,
} from "../src/feishu/card-limits.js";
import { renderRunCard } from "../src/feishu/run-renderer.js";
import { buildSessionOpenedCard } from "../src/feishu/session-cards.js";
import { createFeishuSender } from "../src/feishu/sender.js";
import { createLogger } from "../src/logger.js";
import { initialRunState, reduce, type RunEvent, type RunState } from "../src/feishu/run-state.js";

const log = createLogger({ level: "error", sink: () => undefined });

/** 生成一个 markdown 表格（列内容用 tag 区分，便于断言内容未丢）。 */
const table = (tag: string): string =>
  [`| ${tag} | 值 |`, "| --- | --- |", `| ${tag}-1 | ${tag}-2 |`].join("\n");

const tables = (n: number, prefix = "T"): string =>
  Array.from({ length: n }, (_, i) => table(`${prefix}${i + 1}`)).join("\n\n");

/** 遍历卡片内所有 markdown 元素，累计表格数（用于断言整卡 ≤ 上限）。 */
function cardTables(card: object): number {
  let total = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec.tag === "markdown" && typeof rec.content === "string") {
      total += countMarkdownTables(rec.content);
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(card);
  return total;
}

const run = (...events: RunEvent[]): RunState =>
  events.reduce((state, event) => reduce(state, event), initialRunState());

describe("countMarkdownTables", () => {
  test("标准表格 / 多表格 / 无表格", () => {
    expect(countMarkdownTables(table("A"))).toBe(1);
    expect(countMarkdownTables(tables(3))).toBe(3);
    expect(countMarkdownTables("普通文本，没有表格")).toBe(0);
    expect(countMarkdownTables("a | b\nc | d")).toBe(0); // 没有分隔行，不算表格
  });

  test("支持无首尾竖线 / 对齐分隔行", () => {
    expect(countMarkdownTables("a | b\n:--- | ---:\n1 | 2")).toBe(1);
    expect(countMarkdownTables("| a | b |\n|---:|:---|\n| 1 | 2 |")).toBe(1);
  });

  test("代码块内的 `|` 不被误判为表格（``` 与 ~~~）", () => {
    const fenced = ["```text", "| not | a | table |", "| --- | --- |", "| 1 | 2 |", "```"].join("\n");
    expect(countMarkdownTables(fenced)).toBe(0);
    const tilde = ["~~~", "| x | y |", "| --- | --- |", "~~~"].join("\n");
    expect(countMarkdownTables(tilde)).toBe(0);
    // 代码块内不算，代码块外的真表格仍要算。
    expect(countMarkdownTables(`${fenced}\n\n${table("real")}`)).toBe(1);
  });

  test("findMarkdownTables 返回表头到正文的行区间", () => {
    const spans = findMarkdownTables(["前言", table("A"), "结尾"].join("\n"));
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(1);
    expect(spans[0]!.end).toBe(3);
  });
});

describe("degradeExtraTables", () => {
  test("未超限 / 无表格：原样返回，degraded=0", () => {
    expect(degradeExtraTables("no table")).toEqual({ text: "no table", degraded: 0 });
    const four = tables(4);
    expect(degradeExtraTables(four, 4)).toEqual({ text: four, degraded: 0 });
  });

  test("5 个表格、上限 4：保留前 4、降级 1，且内容一字不丢", () => {
    const out = degradeExtraTables(tables(5), 4);
    expect(out.degraded).toBe(1);
    expect(countMarkdownTables(out.text)).toBe(4); // 只降级了超出的那个
    for (let i = 1; i <= 5; i += 1) {
      expect(out.text).toContain(`T${i}-1`); // 被降级的表格内容仍在
      expect(out.text).toContain(`T${i}-2`);
    }
    expect(out.text).toContain("```"); // 降级形态：围栏代码块
  });

  test("再次降级是幂等的（代码块不再被识别为表格）", () => {
    const once = degradeExtraTables(tables(6), 4).text;
    const twice = degradeExtraTables(once, 4);
    expect(twice.degraded).toBe(0);
    expect(twice.text).toBe(once);
  });

  test("上限 0：全部降级", () => {
    const out = degradeExtraTables(tables(3), 0);
    expect(out.degraded).toBe(3);
    expect(countMarkdownTables(out.text)).toBe(0);
  });
});

describe("toCardMarkdown（共享额度）", () => {
  test("多个元素累计消耗同一额度", () => {
    const budget = createCardMarkdownBudget(4);
    const a = toCardMarkdown(tables(3, "A"), budget); // 用掉 3
    const b = toCardMarkdown(tables(3, "B"), budget); // 只剩 1，降级 2
    expect(countMarkdownTables(a)).toBe(3);
    expect(countMarkdownTables(b)).toBe(1);
    expect(budget.tables).toBe(6);
    expect(budget.degraded).toBe(2);
    expect(budget.remaining).toBe(0);
  });
});

describe("enforceCardLimits", () => {
  test("整卡累计：两个元素各 3 个表 → 共 6 个，保留 4 降级 2", () => {
    const card = { body: { elements: [{ tag: "markdown", content: tables(3, "A") }, { tag: "markdown", content: tables(3, "B") }] } };
    const { card: out, report } = enforceCardLimits(card, { maxTables: 4 });
    expect(report.tables).toBe(6);
    expect(report.degradedTables).toBe(2);
    expect(cardTables(out)).toBe(4);
    // 纯函数：不改动入参。
    expect(cardTables(card)).toBe(6);
  });

  test("组件数超限：丢弃最旧元素，保留最新", () => {
    const elements = Array.from({ length: 250 }, (_, i) => ({ tag: "markdown", content: `m${i}` }));
    const { card: out, report } = enforceCardLimits({ body: { elements } });
    expect(report.droppedElements).toBeGreaterThan(0);
    expect(report.elements).toBeLessThanOrEqual(DEFAULT_CARD_MAX_ELEMENTS);
    const body = (out as { body: { elements: Array<{ content: string }> } }).body;
    expect(body.elements.at(-1)!.content).toBe("m249"); // 最新保留
    expect(body.elements[0]!.content).not.toBe("m0"); // 最旧被丢
  });

  test("无表格无超限：内容不变", () => {
    const card = { body: { elements: [{ tag: "markdown", content: "hello" }] } };
    const { card: out, report } = enforceCardLimits(card);
    expect(cardTables(out)).toBe(0);
    expect(report).toEqual({ tables: 0, degradedTables: 0, elements: 1, droppedElements: 0 });
    expect((out as { body: { elements: Array<{ content: string }> } }).body.elements[0]!.content).toBe("hello");
  });
});

describe("运行卡 / 会话根卡整卡表格数 ≤ 上限", () => {
  test("运行卡：跨两个 markdown 元素共 6 个表 → ≤ cardMaxTables，onLimit 上报", () => {
    const onLimit = vi.fn();
    const state = run(
      { type: "text.started", assistantMessageID: "m1" },
      { type: "text.delta", delta: tables(3, "A"), assistantMessageID: "m1" },
      { type: "tool.input.started", id: "t1", name: "bash" },
      { type: "text.started", assistantMessageID: "m2" },
      { type: "text.delta", delta: tables(3, "B"), assistantMessageID: "m2" },
    );
    const card = renderRunCard(state, undefined, { maxTables: 4, onLimit });
    expect(cardTables(card)).toBeLessThanOrEqual(4);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(onLimit.mock.calls[0]![0]).toMatchObject({ tables: 6, degradedTables: 2 });
  });

  test("运行卡：自定义上限 5 生效", () => {
    const state = run(
      { type: "text.started", assistantMessageID: "m1" },
      { type: "text.delta", delta: tables(6), assistantMessageID: "m1" },
    );
    expect(cardTables(renderRunCard(state, undefined, { maxTables: 5 }))).toBeLessThanOrEqual(5);
  });

  test("恢复卡摘要：5 个表 → 保留 4 降级 1，onLimit 上报", () => {
    const onLimit = vi.fn();
    const card = buildSessionOpenedCard({
      title: "会话",
      sessionID: "ses_1",
      summary: tables(5, "S"),
      onLimit,
    });
    expect(cardTables(card)).toBeLessThanOrEqual(DEFAULT_CARD_MAX_TABLES);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(onLimit.mock.calls[0]![0]).toMatchObject({ tables: 5, degradedTables: 1 });
  });
});

describe("clampMaxTables", () => {
  test("默认 4，夹取 1–5", () => {
    expect(clampMaxTables(undefined)).toBe(DEFAULT_CARD_MAX_TABLES);
    expect(clampMaxTables(0)).toBe(1);
    expect(clampMaxTables(99)).toBe(CARD_MAX_TABLES_MAX);
    expect(clampMaxTables(3)).toBe(3);
  });
});

describe("发送层兜底守卫", () => {
  test("未守卫的卡片经 sendCard 后表格数也被收敛", async () => {
    const calls: Array<{ payload: unknown }> = [];
    const client = {
      im: {
        message: {
          create: vi.fn(async (payload: unknown) => {
            calls.push({ payload });
            return { code: 0, data: { message_id: "om_1" } };
          }),
          reply: vi.fn(async () => ({ code: 0, data: { message_id: "om_2" } })),
          patch: vi.fn(async () => ({ code: 0 })),
        },
      },
    };
    const sender = createFeishuSender(client as never, log, { cardMaxTables: 4 });
    const card = { schema: "2.0", body: { elements: [{ tag: "markdown", content: tables(6) }] } };
    await sender.sendCard("oc_1", card);
    const content = (calls[0]!.payload as { data: { content: string } }).data.content;
    const sent = JSON.parse(content) as object;
    expect(cardTables(sent)).toBeLessThanOrEqual(4);
  });
});
