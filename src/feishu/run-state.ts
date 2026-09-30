/**
 * 运行卡片状态与**纯函数** reducer（无 IO，可单测）。
 *
 * 一张「运行卡片」对应一条飞书入站消息的完整回合：
 *
 *   已收到（思考中 / 已排队） → 工具调用块 → 流式文本块 → 完成 / 失败
 *
 * 设计要点：
 * - 状态只由事件驱动，`reduce(state, event)` 是不可变更新，便于单测与回放；
 * - 按 `assistantMessageID` 区分 step：新的 assistant 消息会关闭上一条流式文本块，
 *   保证多 step 的文本不会首尾拼接；
 * - 工具块按 `id` 归并（started → input → success/error）；
 * - footer（状态页脚）与 terminal（终态）由事件切换，渲染层只读取状态。
 */

export type ToolStatus = "running" | "done" | "error";

export interface ToolEntry {
  readonly id: string;
  readonly name: string;
  /** 工具输入（对象或字符串），由 `tool.input.ended` 填充。 */
  readonly input?: unknown;
  readonly status: ToolStatus;
  /** 结果文本（成功输出或错误信息），由 `tool.success` / `tool.error` 填充。 */
  readonly output?: string;
}

export type RunBlock =
  | { readonly kind: "text"; readonly content: string; readonly streaming: boolean }
  | { readonly kind: "tool"; readonly tool: ToolEntry };

/** 卡片底部状态页脚。null = 运行结束，不再显示。 */
export type FooterStatus = "thinking" | "tool_running" | "streaming" | "queued" | null;

export type Terminal = "running" | "done" | "error";

export interface RunState {
  readonly blocks: RunBlock[];
  readonly footer: FooterStatus;
  readonly terminal: Terminal;
  readonly errorMsg?: string;
  /** 当前正在输出的 assistant 消息 id（用于区分 step）。 */
  readonly assistantMessageID?: string;
  /** 当前会话模型展示名（P6，运行卡页脚展示）。 */
  readonly model?: string;
  /** 终态：完整回答已单独成卡/成文件发送 → 卡内文本收缩为提示（P8.3）。 */
  readonly finalSeparated?: boolean;
}

/** 归一化事件：把 SSE 事件名 + 关键字段收敛成 reducer 可直接消费的形状。 */
export type RunEvent =
  | { readonly type: "queued" }
  | { readonly type: "execution.started" }
  | { readonly type: "execution.succeeded" }
  | { readonly type: "execution.failed"; readonly error?: string }
  | { readonly type: "model.set"; readonly model: string }
  | { readonly type: "text.started"; readonly assistantMessageID?: string }
  | { readonly type: "text.delta"; readonly delta: string; readonly assistantMessageID?: string }
  | { readonly type: "text.ended"; readonly text?: string; readonly assistantMessageID?: string }
  | { readonly type: "tool.input.started"; readonly id: string; readonly name: string; readonly assistantMessageID?: string }
  | { readonly type: "tool.input.ended"; readonly id: string; readonly input?: unknown; readonly assistantMessageID?: string }
  | { readonly type: "tool.success"; readonly id: string; readonly output?: string; readonly assistantMessageID?: string }
  | { readonly type: "tool.error"; readonly id: string; readonly output?: string; readonly assistantMessageID?: string }
  /** 完整回答已单独发送（终态收缩卡内正文）。 */
  | { readonly type: "final.separated" };

export function initialRunState(): RunState {
  return { blocks: [], footer: "thinking", terminal: "running" };
}

/** 关闭所有仍在流式输出的文本块（不变更已关闭的块）。 */
function closeStreamingText(blocks: readonly RunBlock[]): RunBlock[] {
  return blocks.map((b) => (b.kind === "text" && b.streaming ? { ...b, streaming: false } : b));
}

/** 统一处理「新的 assistant step」：不同 id 时关闭旧流式文本块。 */
function stepTransition(state: RunState, assistantMessageID: string | undefined): RunBlock[] {
  if (!assistantMessageID || assistantMessageID === state.assistantMessageID) return [...state.blocks];
  return closeStreamingText(state.blocks);
}

function withAssistantID(state: RunState, assistantMessageID: string | undefined): RunState {
  if (!assistantMessageID || assistantMessageID === state.assistantMessageID) return state;
  return { ...state, assistantMessageID };
}

/** 就地更新一个工具块；未知 id 返回原状态（忽略迟到/越界事件）。 */
function patchTool(
  state: RunState,
  id: string,
  update: (tool: ToolEntry) => ToolEntry,
): RunState {
  let found = false;
  const blocks = state.blocks.map((b) => {
    if (b.kind !== "tool" || b.tool.id !== id) return b;
    found = true;
    return { kind: "tool" as const, tool: update(b.tool) };
  });
  return found ? { ...state, blocks } : state;
}

/**
 * 纯 reducer。所有分支都返回新对象（未变化时返回原引用），
 * 调用方（run-controller）负责节流 patch。
 */
export function reduce(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "queued":
      return { ...state, footer: "queued", terminal: "running" };

    case "execution.started":
      return { ...state, footer: "thinking", terminal: "running" };

    case "execution.succeeded":
      return { ...state, blocks: closeStreamingText(state.blocks), terminal: "done", footer: null };

    case "execution.failed":
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        terminal: "error",
        errorMsg: event.error ?? "未知错误",
        footer: null,
      };

    case "model.set":
      return { ...state, model: event.model };

    case "text.started": {
      const next = withAssistantID(state, event.assistantMessageID);
      return {
        ...next,
        blocks: closeStreamingText(next.blocks),
        footer: "streaming",
        terminal: "running",
      };
    }

    case "text.delta": {
      if (!event.delta) return state;
      const base = stepTransition(state, event.assistantMessageID);
      const last = base[base.length - 1];
      const blocks: RunBlock[] =
        last && last.kind === "text" && last.streaming
          ? [...base.slice(0, -1), { ...last, content: last.content + event.delta }]
          : [...base, { kind: "text", content: event.delta, streaming: true }];
      const next = withAssistantID(state, event.assistantMessageID);
      return { ...next, blocks, footer: "streaming", terminal: "running" };
    }

    case "text.ended": {
      const blocks = state.blocks;
      const last = blocks[blocks.length - 1];
      let nextBlocks: RunBlock[];
      if (last && last.kind === "text" && last.streaming) {
        nextBlocks = [...blocks.slice(0, -1), { ...last, content: event.text ?? last.content, streaming: false }];
      } else if (event.text) {
        nextBlocks = [...closeStreamingText(blocks), { kind: "text", content: event.text, streaming: false }];
      } else {
        nextBlocks = closeStreamingText(blocks);
      }
      return { ...state, blocks: nextBlocks, footer: "streaming" };
    }

    case "tool.input.started": {
      const next = withAssistantID(state, event.assistantMessageID);
      const blocks = next.blocks.map((b) =>
        b.kind === "tool" && b.tool.id === event.id
          ? { kind: "tool" as const, tool: { ...b.tool, name: event.name, status: "running" as const } }
          : b,
      );
      const existing = blocks.some((b) => b.kind === "tool" && b.tool.id === event.id);
      if (!existing) blocks.push({ kind: "tool", tool: { id: event.id, name: event.name, status: "running" } });
      return {
        ...next,
        blocks: closeStreamingText(blocks),
        footer: "tool_running",
        terminal: "running",
      };
    }

    case "tool.input.ended":
      return patchTool(state, event.id, (tool) => ({ ...tool, input: event.input }));

    case "tool.success":
      return patchTool(state, event.id, (tool) => ({ ...tool, status: "done", output: event.output }));

    case "tool.error":
      return patchTool(state, event.id, (tool) => ({
        ...tool,
        status: "error",
        output: event.output,
      }));

    case "final.separated":
      return { ...state, finalSeparated: true };

    default:
      return state;
  }
}
