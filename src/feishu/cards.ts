/**
 * 飞书卡片 JSON 构建（纯函数）。
 *
 * 采用卡片 JSON 2.0 结构，并通过 `im.message.create` / `im.message.patch` 收发与更新。
 * 关键约束（飞书官方文档）：
 * - 更新卡片前后都必须在 `config` 显式声明 `update_multi: true`；
 * - 卡片消息体 ≤ 30KB，这里会截断 markdown 到 28KB 留余量；
 * - 更新单条消息频控 5 QPS，节流默认 ≥400ms。
 *
 * 这里不 import 飞书 SDK，保证可单测。
 */

export const MAX_CARD_BYTES = 28 * 1024;
const TRUNCATION_SUFFIX = "\n\n*（内容过长，已截断）*";
const CODE_FENCE = "\n```";

/** 飞书允许的卡片标题颜色。 */
export type CardTemplate = "blue" | "green" | "orange" | "red" | "purple" | "grey";

export interface ApprovalCardInput {
  readonly requestID: string;
  readonly sessionID: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly message?: string;
  /** true = 该请求带 save[]，「始终允许」才会持久化。 */
  readonly canPersistAlways: boolean;
  /** 按钮 value 里的自签 token。 */
  readonly token: string;
  readonly maxResourcesShown: number;
}

export interface ApprovalOutcome {
  readonly reply: "once" | "always" | "reject";
  readonly operatorOpenId: string;
  readonly at: number;
}

/** 流式回复卡片。 */
export function buildStreamingCard(markdown: string, opts: { readonly title?: string; readonly template?: CardTemplate } = {}): object {
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: opts.title ?? "OpenCode" },
      template: opts.template ?? "blue",
    },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(markdown || "正在思考…") }],
    },
  };
}

/** 审批卡片（通过一次 / 始终允许 / 拒绝）。 */
export function buildApprovalCard(input: ApprovalCardInput): object {
  const resources = input.resources.length > 0 ? input.resources : ["（未提供资源）"];
  const shown = resources.slice(0, input.maxResourcesShown);
  const hidden = resources.length - shown.length;
  const resourceLines = shown.map((r) => `- \`${escapeInline(r)}\``).join("\n");
  const overflow = hidden > 0 ? `\n…另有 ${hidden} 项` : "";

  const lines = [`**操作**：\`${escapeInline(input.action)}\``, "", "**资源**：", `${resourceLines}${overflow}`];
  if (input.message) lines.push("", `**说明**：${input.message}`);

  const rejectHint = "⚠️ 拒绝会同时驳回本会话其他待批请求。";
  lines.push("", rejectHint);
  if (!input.canPersistAlways) {
    lines.push("ℹ️ 本请求未携带保存项，「始终允许」等价于「允许一次」。");
  }

  const alwaysLabel = input.canPersistAlways ? "🔓 始终允许" : "🔓 始终允许（同一次）";

  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🔐 OpenCode 权限请求" },
      template: "orange",
    },
    body: {
      elements: [
        { tag: "markdown", content: truncateCardContent(lines.join("\n")) },
        {
          tag: "action",
          actions: [
            button("✅ 允许一次", "primary", { t: input.token, d: "once" }),
            button(alwaysLabel, "default", { t: input.token, d: "always" }),
            button("❌ 拒绝", "danger", { t: input.token, d: "reject" }),
          ],
        },
      ],
    },
  };
}

/** 审批完成后的结果卡片（无按钮）。 */
export function buildResolvedCard(input: ApprovalCardInput, outcome: ApprovalOutcome): object {
  const label =
    outcome.reply === "reject" ? "❌ 已拒绝" : outcome.reply === "always" ? "🔓 已始终允许" : "✅ 已允许一次";
  const template: CardTemplate = outcome.reply === "reject" ? "red" : "green";
  const when = new Date(outcome.at).toISOString();

  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: label }, template },
    body: {
      elements: [
        {
          tag: "markdown",
          content: truncateCardContent(
            `**操作**：\`${escapeInline(input.action)}\`\n\n**处理人**：\`${escapeInline(mask(outcome.operatorOpenId))}\`\n\n**时间**：${when}`,
          ),
        },
      ],
    },
  };
}

function button(text: string, type: "primary" | "default" | "danger", value: Record<string, unknown>): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    value: JSON.stringify(value),
  };
}

/** 转义 markdown 行内代码里的反引号，避免破坏渲染。 */
function escapeInline(text: string): string {
  return text.replace(/`/g, "\\`").replace(/\n/g, " ");
}

function mask(id: string): string {
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}

/**
 * 按 UTF-8 字节截断到飞书上限内，保证不切断多字节字符，并闭合代码围栏。
 */
export function truncateCardContent(text: string, limit = MAX_CARD_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return closeCodeFences(text);

  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8") + Buffer.byteLength(CODE_FENCE, "utf8");
  const effective = limit - suffixBytes;
  if (effective <= 0) return TRUNCATION_SUFFIX;

  let truncated = bytes.subarray(0, effective).toString("utf8");
  // TextDecoder 可能留下半个多字节字符，用 replacement char 表现；直接切到最后一个换行更稳。
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > truncated.length * 0.8) truncated = truncated.slice(0, lastNewline);
  return `${closeCodeFences(truncated)}${TRUNCATION_SUFFIX}`;
}

function closeCodeFences(text: string): string {
  const fences = text.match(/```/g);
  if (fences && fences.length % 2 !== 0) return `${text}${CODE_FENCE}`;
  return text;
}
