/**
 * 「一句话建会话」卡片（issue #2）：识别中 → 建议卡（创建 / 取消）→ 结果卡。
 * 纯构建 + value 解析，便于单测；按钮回调统一 `{cmd:"quicknew", op, id}`。
 */
import { truncateCardContent } from "./cards.js";

function button(text: string, type: "primary" | "default" | "danger", value: Record<string, unknown>): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

/** 识别中占位卡（分析完成后会被 patch 成建议卡或管理台提示卡）。 */
export function buildQuickNewThinkingCard(): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "🤔 正在识别意图与目录…" }, template: "blue" },
    body: {
      elements: [
        { tag: "markdown", content: "正在判断这条消息是否需要新建会话，以及最合适的工作目录…" },
      ],
    },
  };
}

export interface QuickNewProposalInput {
  /** 待办条目 id（按钮回传；条目存 storage，含原文/目录/锚点消息）。 */
  readonly id: string;
  readonly title: string;
  readonly directory: string;
  /** 原消息摘要（展示用）。 */
  readonly textPreview: string;
  readonly reason?: string;
}

/** 建议卡：AI 已判断好的 意图 + 目录，一键创建并发送。 */
export function buildQuickNewProposalCard(input: QuickNewProposalInput): object {
  const preview = input.textPreview.trim().replace(/\n+/g, " ").slice(0, 120);
  const lines = [
    `**任务**：${input.title}`,
    `**目录**：\`${input.directory}\``,
    ...(input.reason ? [`**依据**：${input.reason}`] : []),
    "",
    `原消息：${preview}`,
  ];
  const elements: object[] = [
    { tag: "markdown", content: truncateCardContent(lines.join("\n")) },
    {
      tag: "markdown",
      content: "点「创建并发送」= 建会话 + 自动开话题 + 把原消息发进去开始处理。",
      text_size: "notation",
    },
    button("✅ 创建并发送", "primary", { cmd: "quicknew", op: "create", id: input.id }),
    button("❌ 取消", "default", { cmd: "quicknew", op: "cancel", id: input.id }),
  ];
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "🆕 建议新建会话" }, template: "turquoise" },
    body: { elements },
  };
}

/** 结果卡（已创建 / 已取消 / 已过期 / 失败）：无按钮，只作收敛展示。 */
export function buildQuickNewResolvedCard(
  title: string,
  note: string,
  template: "grey" | "green" | "orange" | "red" = "grey",
): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements: [{ tag: "markdown", content: truncateCardContent(note) }] },
  };
}

export interface QuickNewActionValue {
  readonly op: "create" | "cancel";
  readonly id: string;
}

/** 解析 quicknew 按钮 value；非法返回 undefined。 */
export function parseQuickNewActionValue(raw: unknown): QuickNewActionValue | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.cmd !== "quicknew") return undefined;
  const op = value.op === "create" || value.op === "cancel" ? value.op : undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!op || !id) return undefined;
  return { op, id };
}
