import { describe, expect, test } from "vitest";
import { initialRunState, reduce, type RunEvent, type RunState } from "../src/feishu/run-state.js";

const run = (...events: RunEvent[]): RunState => events.reduce((state, event) => reduce(state, event), initialRunState());

describe("run-state reducer", () => {
  test("初始状态：思考中、运行中、无块", () => {
    const state = initialRunState();
    expect(state.footer).toBe("thinking");
    expect(state.terminal).toBe("running");
    expect(state.blocks).toEqual([]);
  });

  test("queued 事件切换页脚为已排队", () => {
    const state = run({ type: "queued" });
    expect(state.footer).toBe("queued");
    expect(state.terminal).toBe("running");
  });

  test("text.delta 累积到同一个流式文本块，页脚为正在输出", () => {
    const state = run(
      { type: "execution.started" },
      { type: "text.started", assistantMessageID: "msg_1" },
      { type: "text.delta", delta: "Hello", assistantMessageID: "msg_1" },
      { type: "text.delta", delta: " world", assistantMessageID: "msg_1" },
    );
    expect(state.blocks).toHaveLength(1);
    const block = state.blocks[0]!;
    expect(block.kind).toBe("text");
    if (block.kind === "text") expect(block.content).toBe("Hello world");
    expect(state.footer).toBe("streaming");
  });

  test("text.ended 用完整文本定稿并关闭流式标记", () => {
    const state = run(
      { type: "text.started", assistantMessageID: "msg_1" },
      { type: "text.delta", delta: "partial", assistantMessageID: "msg_1" },
      { type: "text.ended", text: "final answer", assistantMessageID: "msg_1" },
    );
    const block = state.blocks[0]!;
    expect(block.kind).toBe("text");
    if (block.kind === "text") {
      expect(block.content).toBe("final answer");
      expect(block.streaming).toBe(false);
    }
  });

  test("按 assistantMessageID 区分 step：新 step 不会拼到旧文本块", () => {
    const state = run(
      { type: "text.started", assistantMessageID: "msg_1" },
      { type: "text.delta", delta: "first", assistantMessageID: "msg_1" },
      { type: "text.ended", text: "first", assistantMessageID: "msg_1" },
      { type: "text.started", assistantMessageID: "msg_2" },
      { type: "text.delta", delta: "second", assistantMessageID: "msg_2" },
    );
    expect(state.assistantMessageID).toBe("msg_2");
    expect(state.blocks).toHaveLength(2);
    const [a, b] = state.blocks;
    if (a!.kind === "text") expect(a!.content).toBe("first");
    if (b!.kind === "text") expect(b!.content).toBe("second");
  });

  test("tool.input.started 关闭文本流并追加 running 工具；页脚切换为调用工具", () => {
    const state = run(
      { type: "text.started", assistantMessageID: "msg_1" },
      { type: "text.delta", delta: "let me check", assistantMessageID: "msg_1" },
      { type: "tool.input.started", id: "tool_1", name: "bash", assistantMessageID: "msg_1" },
    );
    expect(state.footer).toBe("tool_running");
    const text = state.blocks[0]!;
    expect(text.kind).toBe("text");
    if (text.kind === "text") expect(text.streaming).toBe(false);
    const tool = state.blocks[1]!;
    expect(tool.kind).toBe("tool");
    if (tool.kind === "tool") {
      expect(tool.tool).toMatchObject({ id: "tool_1", name: "bash", status: "running" });
    }
  });

  test("tool.input.ended / success / error 按 id 归并", () => {
    const state = run(
      { type: "tool.input.started", id: "t1", name: "read" },
      { type: "tool.input.ended", id: "t1", input: { file_path: "/etc/hosts" } },
      { type: "tool.input.started", id: "t2", name: "bash" },
      { type: "tool.success", id: "t1", output: "127.0.0.1 localhost" },
      { type: "tool.error", id: "t2", output: "command not found" },
    );
    const tools = state.blocks.filter((b) => b.kind === "tool");
    expect(tools).toHaveLength(2);
    const [t1, t2] = tools;
    if (t1!.kind === "tool") {
      expect(t1!.tool.status).toBe("done");
      expect(t1!.tool.input).toEqual({ file_path: "/etc/hosts" });
      expect(t1!.tool.output).toBe("127.0.0.1 localhost");
    }
    if (t2!.kind === "tool") {
      expect(t2!.tool.status).toBe("error");
      expect(t2!.tool.output).toBe("command not found");
    }
  });

  test("未知工具 id 的事件被忽略", () => {
    const state = run({ type: "tool.success", id: "ghost", output: "x" });
    expect(state.blocks).toHaveLength(0);
  });

  test("execution.succeeded 清页脚、标记完成并关闭流式文本", () => {
    const state = run(
      { type: "text.started", assistantMessageID: "msg_1" },
      { type: "text.delta", delta: "done", assistantMessageID: "msg_1" },
      { type: "execution.succeeded" },
    );
    expect(state.terminal).toBe("done");
    expect(state.footer).toBeNull();
    const block = state.blocks[0]!;
    if (block.kind === "text") expect(block.streaming).toBe(false);
  });

  test("execution.failed 标记错误并保留错误信息", () => {
    const state = run({ type: "execution.failed", error: "boom" });
    expect(state.terminal).toBe("error");
    expect(state.errorMsg).toBe("boom");
    expect(state.footer).toBeNull();
  });

  test("text.ended 交错到达（工具事件已关闭流式块）：回填既有块，不重复追加", () => {
    const state = run(
      { type: "text.started", assistantMessageID: "m1" },
      { type: "text.delta", delta: "你好", assistantMessageID: "m1" },
      { type: "text.delta", delta: "世界", assistantMessageID: "m1" },
      // 模型同一步里调用了工具（工具事件关闭流式文本块）
      { type: "tool.input.started", id: "t1", name: "shell", assistantMessageID: "m1" },
      // text.ended 在工具事件之后到达，携带该消息全文
      { type: "text.ended", text: "你好世界", assistantMessageID: "m1" },
    );
    const texts = state.blocks.filter((b) => b.kind === "text");
    expect(texts).toHaveLength(1);
    if (texts[0]!.kind === "text") {
      expect(texts[0]!.content).toBe("你好世界");
      expect(texts[0]!.streaming).toBe(false);
    }
    // 工具块保留
    expect(state.blocks.some((b) => b.kind === "tool" && b.tool.id === "t1")).toBe(true);
  });

  test("text.ended 带全文但确实没有历史块：正常追加", () => {
    const state = run({ type: "text.ended", text: "直接来的全文", assistantMessageID: "m1" });
    expect(state.blocks).toEqual([
      { kind: "text", content: "直接来的全文", streaming: false, msg: "m1" },
    ]);
  });

  test("text.ended 交错且内容与既有块无前缀关系：保留两块（内容不同）", () => {
    const state = run(
      { type: "text.delta", delta: "好的", assistantMessageID: "m1" },
      { type: "tool.input.started", id: "t1", name: "shell", assistantMessageID: "m1" },
      { type: "text.ended", text: "完全不同的新内容", assistantMessageID: "m2" },
    );
    const texts = state.blocks.filter((b) => b.kind === "text").map((b) => (b.kind === "text" ? b.content : ""));
    expect(texts).toEqual(["好的", "完全不同的新内容"]);
  });

  test("text.ended 全文跨工具前后多段：只回填后缀，前段不重复（流式末尾）", () => {
    const state = run(
      { type: "text.delta", delta: "前段文字", assistantMessageID: "m1" },
      { type: "tool.input.started", id: "t1", name: "shell", assistantMessageID: "m1" },
      { type: "text.delta", delta: "后段文字", assistantMessageID: "m1" },
      { type: "text.ended", text: "前段文字后段文字", assistantMessageID: "m1" },
    );
    const texts = state.blocks.filter((b) => b.kind === "text").map((b) => (b.kind === "text" ? b.content : ""));
    // 而不是 ["前段文字", "前段文字后段文字"]（前段出现两次）
    expect(texts).toEqual(["前段文字", "后段文字"]);
  });

  test("text.ended 全文跨多段且目标块已被工具关闭：保持分段、不重复", () => {
    const state = run(
      { type: "text.delta", delta: "AAA", assistantMessageID: "m1" },
      { type: "tool.input.started", id: "t1", name: "shell", assistantMessageID: "m1" },
      { type: "text.delta", delta: "BBB", assistantMessageID: "m1" },
      { type: "tool.input.started", id: "t2", name: "read", assistantMessageID: "m1" },
      { type: "text.ended", text: "AAABBB", assistantMessageID: "m1" },
    );
    const texts = state.blocks.filter((b) => b.kind === "text").map((b) => (b.kind === "text" ? b.content : ""));
    expect(texts).toEqual(["AAA", "BBB"]);
  });
});
