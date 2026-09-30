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

describe("renderRunCard 强制停止按钮", () => {
  const stopValue = { cmd: "stop", sid: "ses_1", t: "signed-token" };

  const stopButton = (card: object): Record<string, unknown> | undefined =>
    bodyElements(card).find((e) => e.tag === "button");

  test("运行中：danger 强停按钮，JSON 2.0 callback，无 1.0 tag:action", () => {
    const card = renderRunCard(run({ type: "execution.started" }), stopValue);
    const btn = stopButton(card);
    expect(btn).toBeTruthy();
    expect(btn!.type).toBe("danger");
    expect((btn!.behaviors as Array<Record<string, unknown>>)[0]).toEqual({
      type: "callback",
      value: stopValue,
    });
    const text = json(card);
    expect(text).toContain("⏹ 强制停止");
    expect(text).not.toContain('"tag":"action"');
    expect(text).not.toContain('"actions"');
  });

  test("排队中也是 danger 强停按钮", () => {
    const card = renderRunCard(run({ type: "queued" }), stopValue);
    const btn = stopButton(card);
    expect(btn?.type).toBe("danger");
    expect(json(card)).toContain("强制停止");
  });

  test("终态：default 样式「停止」，点击由上层回「已结束」", () => {
    const card = renderRunCard(
      run({ type: "execution.started" }, { type: "text.delta", delta: "hi" }, { type: "execution.succeeded" }),
      stopValue,
    );
    const btn = stopButton(card);
    expect(btn?.type).toBe("default");
    const text = json(card);
    expect(text).toContain("⏹ 停止");
    expect(text).not.toContain("强制停止");
  });

  test("失败终态也带 default 停止按钮", () => {
    const card = renderRunCard(
      run({ type: "execution.started" }, { type: "execution.failed", error: "boom" }),
      stopValue,
    );
    expect(stopButton(card)?.type).toBe("default");
  });

  test("缺省不渲染按钮（向后兼容）", () => {
    expect(stopButton(renderRunCard(run({ type: "execution.started" })))).toBeUndefined();
  });

  test("带强停按钮的超长卡片仍 ≤ 30KB 且按钮保留", () => {
    const events: RunEvent[] = [{ type: "text.started", assistantMessageID: "m1" }];
    for (let i = 0; i < 40; i += 1) {
      events.push({ type: "text.delta", delta: "x".repeat(2000), assistantMessageID: "m1" });
      events.push({ type: "tool.input.started", id: `t${i}`, name: "bash" });
      events.push({ type: "tool.input.ended", id: `t${i}`, input: { command: "y".repeat(3000) } });
      events.push({ type: "tool.success", id: `t${i}`, output: "z".repeat(3000) });
    }
    const card = renderRunCard(run(...events), stopValue);
    expect(Buffer.byteLength(json(card), "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(stopButton(card)).toBeTruthy();
  });
});

describe("运行卡瘦身（P8.3）", () => {
  const toolState = (n: number): RunState => ({
    blocks: Array.from({ length: n }, (_, i) => ({
      kind: "tool" as const,
      tool: { id: `t${i}`, name: "shell", status: "done" as const, output: `out${i}` },
    })),
    footer: "tool_running",
    terminal: "running",
  });

  test("工具块超上限 → 省略提示 + 只保留最近 N 个", () => {
    const card = JSON.stringify(renderRunCard(toolState(20), undefined, { maxTools: 12 }));
    expect(card).toContain("已省略前 8 次工具调用");
    expect(card).not.toContain("out0");
    expect(card).toContain("out19");
  });

  test("未超上限 → 不出现省略提示", () => {
    const card = JSON.stringify(renderRunCard(toolState(5), undefined, { maxTools: 12 }));
    expect(card).not.toContain("已省略");
  });

  test("finalSeparated → 末尾文本收缩为提示", () => {
    const long = "这是完整回答的正文".repeat(20);
    const state: RunState = {
      blocks: [
        { kind: "tool", tool: { id: "t1", name: "shell", status: "done" as const } },
        { kind: "text", content: long, streaming: false },
      ],
      footer: null,
      terminal: "done",
      finalSeparated: true,
    };
    const card = JSON.stringify(renderRunCard(state));
    expect(card).toContain("完整回答已单独发送");
    expect(card).not.toContain("这是完整回答的正文");
  });
});
