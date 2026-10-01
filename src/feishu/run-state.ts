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
  | {
      readonly kind: "text";
      readonly content: string;
      readonly streaming: boolean;
      /** 所属 assistant 消息 id（ended 全文按消息回填时用；缺省 = 未知）。 */
      readonly msg?: string;
    }
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

/**
 * 从后往前找最后一个「内容非空且是 `text` 前缀」的文本块（交错 ended 的回填目标）。
 * 找不到返回 -1（调用方按"无 delta 的纯 ended"追加新块）。
 */
function lastPrefixTextIndex(blocks: readonly RunBlock[], text: string): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i]!;
    if (block.kind !== "text") continue;
    if (block.content && text.startsWith(block.content)) return i;
  }
  return -1;
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
          ? [...base.slice(0, -1), { ...last, content: last.content + event.delta, ...(event.assistantMessageID ? { msg: event.assistantMessageID } : {}) }]
          : [...base, { kind: "text", content: event.delta, streaming: true, ...(event.assistantMessageID ? { msg: event.assistantMessageID } : {}) }];
      const next = withAssistantID(state, event.assistantMessageID);
      return { ...next, blocks, footer: "streaming", terminal: "running" };
    }

    case "text.ended": {
      const blocks = state.blocks;
      const endedText = event.text;
      const endedMsg = event.assistantMessageID;

      // 无消息 id（旧路径兜底）：最后一块流式 → 关闭；带全文 → 回填前缀匹配块；否则原样关闭。
      if (!endedMsg) {
        const last = blocks[blocks.length - 1];
        let nextBlocks: RunBlock[];
        if (last && last.kind === "text" && last.streaming) {
          nextBlocks = [...blocks.slice(0, -1), { ...last, content: endedText ?? last.content, streaming: false }];
        } else if (endedText) {
          const idx = lastPrefixTextIndex(blocks, endedText);
          nextBlocks =
            idx >= 0
              ? blocks.map((b, i) => (i === idx && b.kind === "text" ? { ...b, content: endedText, streaming: false } : b))
              : [...closeStreamingText(blocks), { kind: "text", content: endedText, streaming: false }];
        } else {
          nextBlocks = closeStreamingText(blocks);
        }
        return { ...state, blocks: nextBlocks, footer: "streaming" };
      }

      // 找到该消息的最后一段文本块（可能仍在流式，也可能已被工具事件提前关闭）。
      let targetIdx = -1;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const b = blocks[i]!;
        if (b.kind === "text" && b.msg === endedMsg) {
          targetIdx = i;
          break;
        }
      }
      const tail = blocks[blocks.length - 1];
      if (targetIdx < 0 && tail && tail.kind === "text" && tail.streaming) targetIdx = blocks.length - 1;

      // 该消息没有文本块（如无 delta 的纯 ended 携带全文）→ 追加。
      if (targetIdx < 0) {
        if (!endedText) return { ...state, blocks: closeStreamingText(blocks), footer: "streaming" };
        return {
          ...state,
          blocks: [
            ...closeStreamingText(blocks),
            { kind: "text", content: endedText, streaming: false, msg: endedMsg },
          ],
          footer: "streaming",
        };
      }

      // `ended.text` 是**整条消息的全文**（实测与 delta 之和一致），可能跨越工具前后多段文本：
      // 先累计目标块之前、同消息文本的长度，再取后缀，避免把前段内容重复写进目标块。
      const target = blocks[targetIdx]!;
      let earlierLen = 0;
      for (let i = 0; i < targetIdx; i += 1) {
        const b = blocks[i]!;
        if (b.kind === "text" && b.msg === endedMsg) earlierLen += b.content.length;
      }
      let content = target.kind === "text" ? target.content : "";
      if (endedText !== undefined && endedText.length >= earlierLen) {
        const suffix = endedText.slice(earlierLen);
        if (suffix.length >= content.length) content = suffix; // 只在更完整时回填，避免内容回退
      }
      const nextBlocks = blocks.map((b, i) =>
        i === targetIdx && b.kind === "text" ? { ...b, content, streaming: false } : b,
      );
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
