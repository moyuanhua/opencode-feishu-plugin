import { describe, expect, test } from "vitest";
import { MAX_CARD_BYTES } from "../src/feishu/cards.js";
import { renderRunCard } from "../src/feishu/run-renderer.js";
import { initialRunState, reduce, type RunEvent, type RunState } from "../src/feishu/run-state.js";

const run = (...events: RunEvent[]): RunState => events.reduce((state, event) => reduce(state, event), initialRunState());

const bodyElements = (card: object): Array<Record<string, unknown>> =>
  (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

const panels = (card: object): Array<Record<string, unknown>> =>
  bodyElements(card).filter((e) => e.tag === "collapsible_panel");

const json = (card: object): string => JSON.stringify(card);

describe("renderRunCard", () => {
  test("卡片 JSON 2.0 + update_multi + 页脚", () => {
    const card = renderRunCard(run({ type: "execution.started" })) as Record<string, unknown>;
    expect(card.schema).toBe("2.0");
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
    expect(json(card)).toContain("正在思考");
  });

  test("已排队页脚", () => {
    expect(json(renderRunCard(run({ type: "queued" })))).toContain("已排队");
  });

  test("两个工具：各自一个折叠面板，均不展开", () => {
    const state = run(
      { type: "tool.input.started", id: "t1", name: "read" },
      { type: "tool.input.started", id: "t2", name: "bash" },
    );
    const card = renderRunCard(state);
    const list = panels(card);
    expect(list).toHaveLength(2);
    expect(list.every((p) => p.expanded === false)).toBe(true);
  });

  test("≥3 个工具运行中：历史折叠为摘要、最新一个展开", () => {
    const state = run(
      { type: "tool.input.started", id: "t1", name: "read" },
      { type: "tool.input.started", id: "t2", name: "grep" },
      { type: "tool.input.started", id: "t3", name: "bash" },
      { type: "tool.input.started", id: "t4", name: "write" },
    );
    const card = renderRunCard(state);
    const list = panels(card);
    expect(list).toHaveLength(2);
    // 第一个是摘要（折叠），第二个是最新工具（展开）。
    expect(list[0]!.expanded).toBe(false);
    expect(list[1]!.expanded).toBe(true);
    expect(json(card)).toContain("3 个工具调用");
    expect(json(card)).toContain("🔧 **write**");
  });

  test("终态时 ≥3 个工具整体折叠为单个摘要（含已结束）", () => {
    const state = run(
      { type: "tool.input.started", id: "t1", name: "read" },
      { type: "tool.input.started", id: "t2", name: "grep" },
      { type: "tool.input.started", id: "t3", name: "bash" },
      { type: "execution.succeeded" },
    );
    const card = renderRunCard(state);
    const list = panels(card);
    expect(list).toHaveLength(1);
    expect(list[0]!.expanded).toBe(false);
    expect(json(card)).toContain("已结束");
    expect(json(card)).not.toContain("正在思考");
  });

  test("出错工具红色边框 + 错误摘要首行", () => {
    const state = run(
      { type: "tool.input.started", id: "t1", name: "bash" },
      { type: "tool.error", id: "t1", output: "line1 failed\nline2 detail" },
    );
    const card = renderRunCard(state);
    const panel = panels(card)[0]!;
    expect((panel.border as Record<string, unknown>).color).toBe("red");
    expect(json(card)).toContain("line1 failed");
  });

  test("流式文本渲染为 markdown，完成后不再显示运行页脚", () => {
    const running = renderRunCard(
      run(
        { type: "text.started", assistantMessageID: "m1" },
        { type: "text.delta", delta: "hello", assistantMessageID: "m1" },
      ),
    );
    expect(json(running)).toContain("hello");
    expect(json(running)).toContain("正在输出");

    const done = renderRunCard(run({ type: "text.started" }, { type: "text.delta", delta: "hello" }, { type: "execution.succeeded" }));
    expect(json(done)).not.toContain("正在输出");
  });

  test("超长内容被压到卡片上限内", () => {
    const events: RunEvent[] = [{ type: "text.started", assistantMessageID: "m1" }];
    for (let i = 0; i < 40; i += 1) {
      events.push({ type: "text.delta", delta: "x".repeat(2000), assistantMessageID: "m1" });
      events.push({ type: "tool.input.started", id: `t${i}`, name: "bash" });
      events.push({ type: "tool.input.ended", id: `t${i}`, input: { command: "y".repeat(3000) } });
      events.push({ type: "tool.success", id: `t${i}`, output: "z".repeat(3000) });
    }
    const card = renderRunCard(run(...events));
    expect(Buffer.byteLength(json(card), "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  test("运行页脚含当前模型；终态保留模型行", () => {
    const running = run({ type: "execution.started" }, { type: "model.set", model: "GPT-5" });
    expect(json(renderRunCard(running))).toContain("🤖 GPT-5");
    const done = run(
      { type: "execution.started" },
      { type: "model.set", model: "GPT-5" },
      { type: "execution.succeeded" },
    );
    const text = json(renderRunCard(done));
    expect(text).toContain("🤖 GPT-5");
    expect(text).not.toContain("正在思考");
  });
});
