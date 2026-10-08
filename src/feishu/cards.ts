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
  /**
   * 「✅ 本会话内允许该工具」按钮的自签 token（任务 A）。
   * 缺省 = 不渲染该按钮（`sessionAllowButton=false` 或运行时未装配签名）。
   */
  readonly allowSessionToken?: string;
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
    config: { update_multi: true },
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

  const buttons: object[] = [
    button("✅ 允许一次", "primary", { t: input.token, d: "once" }),
    button(alwaysLabel, "default", { t: input.token, d: "always" }),
  ];
  // 任务 A：会话粒度的中间档位。仅当配置开启且装配了签名时出现。
  if (input.allowSessionToken) {
    buttons.push(
      button("✅ 本会话内允许该工具", "default", {
        cmd: "allow_session",
        a: input.action,
        t: input.allowSessionToken,
      }),
    );
  }
  buttons.push(button("❌ 拒绝", "danger", { t: input.token, d: "reject" }));

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: "🔐 OpenCode 权限请求" },
      template: "orange",
    },
    body: {
      elements: [
        { tag: "markdown", content: truncateCardContent(lines.join("\n")) },
        ...buttons,
      ],
    },
  };
}

/** 「本会话内允许」点击后的结果卡（无按钮）。 */
export interface SessionAllowOutcome {
  readonly action: string;
  readonly operatorOpenId: string;
  readonly at: number;
}

export function buildSessionAllowResolvedCard(input: ApprovalCardInput, outcome: SessionAllowOutcome): object {
  const when = new Date(outcome.at).toISOString();
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: `✅ 已允许本会话内 ${outcome.action}` },
      template: "green",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: truncateCardContent(
            [
              `**操作**：\`${escapeInline(input.action)}\``,
              "",
              "本会话内后续调用该工具将**不再询问**（其它会话不受影响）。",
              "",
              `**处理人**：\`${escapeInline(mask(outcome.operatorOpenId))}\``,
              `**时间**：${when}`,
            ].join("\n"),
          ),
        },
      ],
    },
  };
}

/**
 * 主聊天流「管理台」提示卡（P5，决策 1）：普通文本不进入任何会话，只回这张卡。
 */
export function buildConsoleHintCard(): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "🛠️ OpenCode 管理台" }, template: "blue" },
    body: {
      elements: [
        {
          tag: "markdown",
          content: truncateCardContent(
            [
              "这里是**会话管理台**，不会直接执行任务。",
              "",
              "- `/new [标题]` — 打开发建会话表单卡，提交后自动为你开好一个话题",
              "- `/form` — 与 `/new` 等价，同为表单入口（目录 + 模型 + 权限）",
              "- `/sessions`（别名 `/ls`）— 查看 / 切换会话",
              "- `/help` — 查看全部命令",
              "",
              "进入话题后直接发消息，OpenCode 就在那个会话里干活。",
            ].join("\n"),
          ),
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
    config: { update_multi: true },
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

/**
 * 审批「未生效」卡片：`permission.reply` 失败时**保留卡片**（不误判成功/撤回），
 * 展示原因并给出「🔁 重试」按钮（携带重签的 token）。
 */
export interface ApprovalFailedInput {
  readonly reason: string;
  /** true = 请求已失效 / 命中非持有实例（not found）。 */
  readonly notFound?: boolean;
  readonly retry?: { readonly label: string; readonly value: Record<string, unknown> };
}

export function buildApprovalFailedCard(input: ApprovalCardInput, failed: ApprovalFailedInput): object {
  const lines = [
    `**操作**：\`${escapeInline(input.action)}\``,
    "",
    "⚠️ **审批未生效**：本次操作没有送达 OpenCode，会话可能仍在等待。",
    "",
    `**原因**：${escapeInline(failed.reason)}`,
  ];
  if (failed.notFound) {
    lines.push(
      "",
      "该请求可能已由**另一个 opencode 实例**处理、或已过期失效。可点下方「🔁 重试」；若仍失败，请回到该会话重新触发一次操作。",
    );
  } else {
    lines.push("", "请稍后点下方「🔁 重试」。");
  }
  const elements: object[] = [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }];
  if (failed.retry) elements.push(cardButton(failed.retry.label, "primary", failed.retry.value));
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "❌ 审批未生效" }, template: "red" },
    body: { elements },
  };
}

/**
 * 卡死 / 排队超时提示卡（任务 B）：提示已自动中断，并带「强制停止」按钮供重试。
 * 与运行卡一致：JSON 2.0，按钮直放 `body.elements`，回调走 `behaviors`。
 */
export function buildStopNoticeCard(input: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly stopValue?: Record<string, unknown>;
  readonly template?: CardTemplate;
}): object {
  const elements: object[] = [
    { tag: "markdown", content: truncateCardContent(input.lines.join("\n") || "(无)") },
  ];
  if (input.stopValue) elements.push(cardButton("⏹ 强制停止", "danger", input.stopValue));
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: input.title }, template: input.template ?? "orange" },
    body: { elements },
  };
}

/**
 * 飞书卡片 JSON 2.0 按钮。
 *
 * 2.0 **不再支持** 1.0 的 `tag:"action"` / `actions` 容器（会直接 400），
 * 按钮必须直接放进 `body.elements`；回调数据用 `behaviors:[{type:"callback", value}]`
 * 且 `value` 必须是对象（事件里 `action.value` 原样带回）。
 */
export function cardButton(
  text: string,
  type: "primary" | "default" | "danger",
  value: Record<string, unknown>,
): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

function button(text: string, type: "primary" | "default" | "danger", value: Record<string, unknown>): object {
  return cardButton(text, type, value);
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

/**
 * 「完整回答」卡（P8.3）：长回答单独成卡，不与被工具噪声塞满的运行卡抢空间。
 * 正文做 24KB 上限截断（超过该阈值的走 `.md` 文件，见 index.ts 的 sendFinalAnswer）。
 */
export function buildFinalAnswerCard(text: string): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "✅ 完整回答" }, template: "green" },
    body: { elements: [{ tag: "markdown", content: truncateCardContent(text, 24 * 1024) }] },
  };
}
