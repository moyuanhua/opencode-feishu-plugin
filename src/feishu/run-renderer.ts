/**
 * 运行卡片渲染（纯函数，无 IO，可单测）。
 *
 * 卡片 JSON 2.0；与上游 lark-bridge 的 `run-renderer.ts` 对齐折叠策略：
 * - 连续工具块 ≥ 3 时折叠为一个摘要面板（**只保留名称行**，丢弃 body，防 30KB 超限）；
 * - 运行中：历史工具折叠、**最新一个展开**；终态：整体折叠为摘要；
 * - < 3 个工具各自渲染为（默认折叠的）面板。
 *
 * 体积保护：先按字段截断，再对整个卡片做 markdown 内容的降级截断
 * （`enforceSize`），保证序列化 ≤ `MAX_CARD_BYTES`。
 */
import { MAX_CARD_BYTES, truncateCardContent, type CardTemplate } from "./cards.js";
import type { RunBlock, RunState, ToolEntry } from "./run-state.js";

const COLLAPSE_TOOL_THRESHOLD = 3;
const HEADER_SUMMARY_MAX = 80;
const TOOL_INPUT_MAX = 600;
const TOOL_OUTPUT_MAX = 600;
const OUTPUT_FIRST_LINE_MAX = 200;
const TEXT_ELEMENT_MAX = 8 * 1024;

interface ToolGroup {
  readonly kind: "tools";
  readonly tools: ToolEntry[];
}
interface TextGroup {
  readonly kind: "text";
  readonly content: string;
}
type Group = ToolGroup | TextGroup;

/** 渲染整张运行卡片。 */
export function renderRunCard(state: RunState): object {
  const elements: object[] = [];

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === "text") {
      if (group.content.trim()) elements.push(markdown(truncateCardContent(group.content, TEXT_ELEMENT_MAX)));
    } else {
      elements.push(...renderToolGroup(group.tools, state.terminal !== "running"));
    }
  }

  if (state.terminal === "error") {
    elements.push(note(`⚠️ 运行失败：${truncateSingleLine(state.errorMsg ?? "未知错误", 200)}`));
  } else if (state.terminal === "done" && elements.length === 0) {
    elements.push(note("_（未返回内容）_"));
  }

  if (state.terminal === "running" && (state.footer || state.model)) {
    elements.push(footerElement(state));
  } else if (state.terminal !== "running" && state.model) {
    // 终态也保留模型信息，方便回看这条运行用的是哪个模型。
    elements.push(note(`🤖 ${state.model}`));
  }

  const card = {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: summaryText(state) },
    },
    header: {
      title: { tag: "plain_text", content: "OpenCode" },
      template: template(state),
    },
    body: { elements },
  };
  return enforceSize(card);
}

/** 连续的工具块归为一组；文本块单独成组，保持原始顺序。 */
function groupBlocks(blocks: readonly RunBlock[]): Group[] {
  const groups: Group[] = [];
  let toolBuf: ToolEntry[] = [];
  for (const block of blocks) {
    if (block.kind === "tool") {
      toolBuf.push(block.tool);
      continue;
    }
    if (toolBuf.length > 0) {
      groups.push({ kind: "tools", tools: toolBuf });
      toolBuf = [];
    }
    groups.push({ kind: "text", content: block.content });
  }
  if (toolBuf.length > 0) groups.push({ kind: "tools", tools: toolBuf });
  return groups;
}

/** 折叠策略（对齐上游 run-renderer）：≥3 折叠，最新一个展开。 */
function renderToolGroup(tools: readonly ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((tool) => toolPanel(tool, false));
  }
  if (finalized) {
    return [collapsedSummary(tools, true)];
  }
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1]!;
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedSummary(prior, false));
  out.push(toolPanel(latest, true));
  return out;
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeader(tool),
    expanded,
    border: tool.status === "error" ? "red" : "grey",
    body: toolBody(tool),
  });
}

/** 折叠摘要：只有名称行，无 body（工具越多越省体积）。 */
function collapsedSummary(tools: readonly ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? "（已结束）" : "";
  const title = `🔧 **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeader(t)}`).join("\n");
  return collapsiblePanel({
    title,
    expanded: false,
    border: "blue",
    body: headerList,
  });
}

function toolHeader(tool: ToolEntry): string {
  const icon = tool.status === "done" ? "✅" : tool.status === "error" ? "❌" : "🔧";
  const summary = summarizeInput(tool.input);
  return summary ? `${icon} **${tool.name}** — ${summary}` : `${icon} **${tool.name}**`;
}

function toolBody(tool: ToolEntry): string {
  const parts: string[] = [];
  const input = renderInput(tool.input);
  if (input) parts.push(`**输入**\n\`\`\`\n${input}\n\`\`\``);
  if (tool.output) {
    const firstLine = truncateSingleLine(tool.output, OUTPUT_FIRST_LINE_MAX);
    if (tool.status === "error") {
      parts.push(`**错误**\n\`\`\`\n${firstLine}\n\`\`\``);
    } else {
      parts.push(`**结果**\n${firstLine}`);
    }
  } else if (tool.status === "running") {
    parts.push("_运行中…_");
  }
  return parts.length > 0 ? parts.join("\n\n") : "_无输出_";
}

/** 输入摘要（提取常见字段，单行截断）。 */
function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") {
    return typeof input === "string" ? truncateSingleLine(input, HEADER_SUMMARY_MAX) : "";
  }
  const rec = input as Record<string, unknown>;
  const pick = (key: string): string => (typeof rec[key] === "string" ? truncateSingleLine(rec[key] as string, HEADER_SUMMARY_MAX) : "");
  return (
    pick("command") ||
    pick("file_path") ||
    pick("path") ||
    pick("query") ||
    pick("url") ||
    pick("pattern") ||
    pick("description") ||
    truncateSingleLine(safeJson(input), HEADER_SUMMARY_MAX)
  );
}

function renderInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  const text = typeof input === "string" ? input : safeJson(input);
  return truncateSingleLine(text, TOOL_INPUT_MAX);
}

function collapsiblePanel(opts: {
  readonly title: string;
  readonly expanded: boolean;
  readonly border: "grey" | "red" | "blue";
  readonly body: string;
}): object {
  return {
    tag: "collapsible_panel",
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: opts.body, text_size: "notation" }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: "markdown", content: titleMd },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
    icon_position: "follow_text",
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: "markdown", content };
}

function note(content: string): object {
  return { tag: "markdown", content, text_size: "notation" };
}

function footerElement(state: RunState): object {
  const status = state.footer;
  const text =
    status === "thinking"
      ? "🧠 正在思考…"
      : status === "tool_running"
        ? "🧰 正在调用工具…"
        : status === "queued"
          ? "⏳ 已排队，等待当前任务结束…"
          : status === "streaming"
            ? "✍️ 正在输出…"
            : "⏳ 处理中…";
  const model = state.model ? `　·　🤖 ${state.model}` : "";
  return note(`${text}${model}`);
}

function template(state: RunState): CardTemplate {
  if (state.terminal === "error") return "red";
  if (state.terminal === "done") return "green";
  return "blue";
}

function summaryText(state: RunState): string {
  if (state.terminal === "error") return "运行失败";
  if (state.terminal === "done") return "已完成";
  if (state.footer === "queued") return "已排队";
  if (state.footer === "tool_running") return "正在调用工具";
  if (state.footer === "streaming") return "正在输出";
  return "思考中";
}

function truncateSingleLine(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 体积保护：先按字段截断仍可能超限（多个工具组 + 长文本），
 * 这里对卡片内所有 markdown 内容分级截断；若结构本身（面板/图标）仍超限，
 * 再逐步丢弃**最旧**的 body 元素（保留最新的内容与页脚），直到 ≤ 30KB。
 */
function enforceSize(card: object): object {
  if (byteLength(card) <= MAX_CARD_BYTES) return card;

  let best: Record<string, unknown> = card as Record<string, unknown>;
  for (const limit of [8192, 4096, 1024, 256, 128]) {
    best = shrinkMarkdown(best, limit);
    if (byteLength(best) <= MAX_CARD_BYTES) return best;
  }

  const body = best.body as { elements?: unknown[] } | undefined;
  const elements = Array.isArray(body?.elements) ? body.elements : [];
  for (const keep of [40, 24, 12, 6, 3]) {
    if (elements.length <= keep) continue;
    const trimmed = { ...best, body: { ...body, elements: elements.slice(-keep) } };
    if (byteLength(trimmed) <= MAX_CARD_BYTES) return trimmed;
  }
  return { ...best, body: { ...body, elements: elements.slice(-1) } };
}

function shrinkMarkdown(card: Record<string, unknown>, limit: number): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (rec.tag === "markdown" && typeof rec.content === "string") {
      rec.content = truncateCardContent(rec.content, limit);
    }
    for (const value of Object.values(rec)) visit(value);
  };
  visit(clone);
  return clone;
}

function byteLength(value: object): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
