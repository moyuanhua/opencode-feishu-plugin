/**
 * 会话列表卡片构建与按钮 value 解析（纯函数，可单测）。
 *
 * 按钮 value 约定：
 * - 进入/再开话题：`{ cmd: "open", s: <sessionID>, c: <chatId> }`
 * - 翻页：`{ cmd: "list", p: <page>, c: <chatId> }`
 * - 新建：`{ cmd: "new", c: <chatId> }`
 * - 切换（旧卡片兼容）：`{ cmd: "use", s: <sessionID>, c: <chatId> }`
 *
 * 与审批卡一样走 `card.action.trigger`，`im.message.patch` 更新，必须 `update_multi: true`。
 * 卡片 JSON 2.0：按钮直放 `body.elements`（**不能**用 1.0 的 `tag:"action"` 容器），
 * 回调数据走 `behaviors`。
 */
import { truncateCardContent, type CardTemplate } from "./cards.js";
import { enforceCardLimits, type CardLimitReport } from "./card-limits.js";
import { shortSessionId } from "./commands.js";
import { directoryTail, relativeTime } from "./session-list.js";
import {
  topicStatusFooter,
  topicStatusMeta,
  topicStatusTitle,
  type TopicStatusView,
} from "../session/topic-status.js";
import type { SessionRootCardBase } from "../types.js";

/** 列表中的一行（序号为全局 1-based，跨页连续）。 */
export interface SessionListRow {
  readonly index: number;
  readonly sessionID: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly directory?: string;
  /** 已存在 `thread:<tid>` 映射（显示「再开话题」）。 */
  readonly bound: boolean;
  /** 该会话是当前会话（按钮高亮）。 */
  readonly active?: boolean;
}

export interface SessionListCardInput {
  readonly chatId: string;
  /** 当前页的行（已切好页）。 */
  readonly rows: readonly SessionListRow[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  /** 相对时间基准，便于单测；默认 Date.now。 */
  readonly now?: number;
  readonly title?: string;
}

export type SessionCardValue =
  | { readonly cmd: "use"; readonly sessionID: string; readonly chatId: string }
  | { readonly cmd: "new"; readonly chatId: string }
  | { readonly cmd: "open"; readonly sessionID: string; readonly chatId: string }
  | { readonly cmd: "list"; readonly page: number; readonly chatId: string }
  | { readonly cmd: "compact"; readonly sessionID: string; readonly token: string };

/** 飞书卡片 JSON 2.0 按钮：回调数据走 behaviors，value 为对象；2.0 不支持 tag:"action" 容器。 */
function button(text: string, type: "primary" | "default" | "danger", value: Record<string, unknown>): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

/** 单行会话展示：`1. 标题（短id）· 3 小时前 · 💬 已绑话题 · 📍目录`。 */
export function sessionRowLine(row: SessionListRow, now: number): string {
  const title = truncateTitle(row.title.trim() || "(未命名)");
  const marks: string[] = [relativeTime(row.updatedAt, now)];
  if (row.bound) marks.push("💬 已绑话题");
  if (row.directory) marks.push(`📍 ${directoryTail(row.directory)}`);
  if (row.active) marks.push("← 当前");
  return `${row.index}. ${title}（\`${shortSessionId(row.sessionID)}\`）· ${marks.join(" · ")}`;
}

/**
 * 构建全量会话列表卡片：
 * - 每行 = 左列会话文字 + 右列「▶️ 进入 / ▶️ 再开话题」按钮（`column_set` 并排，值 `{cmd:"open"}`）；
 * - 底部翻页按钮（`{cmd:"list"}`）与「➕ 新建会话」（`{cmd:"new"}`，发 `/form` 表单卡）。
 */
export function buildSessionListCard(input: SessionListCardInput): object {
  const now = input.now ?? Date.now();
  const elements: object[] = [];

  if (input.rows.length === 0) {
    elements.push({
      tag: "markdown",
      content: truncateCardContent(
        "还没有会话。点下方「➕ 新建会话」创建，或直接在话题里发消息自动创建。",
      ),
    });
  } else {
    // 每行一个「文字 + 按钮」并排结构（column_set）：
    // 避免"一列按钮堆在列表下方、无法对应到具体会话"的观感。
    input.rows.forEach((row, i) => {
      if (i > 0) elements.push({ tag: "hr", margin: "2px 0px 2px 0px" });
      elements.push({
        tag: "column_set",
        flex_mode: "none",
        horizontal_spacing: "small",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 5,
            vertical_align: "center",
            elements: [{ tag: "markdown", content: truncateCardContent(sessionRowLine(row, now)) }],
          },
          {
            tag: "column",
            width: "auto",
            vertical_align: "center",
            elements: [
              button(row.bound ? "▶️ 再开" : "▶️ 进入", row.active ? "primary" : "default", {
                cmd: "open",
                s: row.sessionID,
                c: input.chatId,
              }),
            ],
          },
        ],
      });
    });
  }

  // 分页控件（仅在有需要时出现）。
  if (input.page > 0) {
    elements.push(button("⬅️ 上一页", "default", { cmd: "list", p: input.page - 1, c: input.chatId }));
  }
  if (input.page + 1 < input.pageCount) {
    elements.push(button("➡️ 下一页", "default", { cmd: "list", p: input.page + 1, c: input.chatId }));
  }
  elements.push(button("➕ 新建会话", "default", { cmd: "new", c: input.chatId }));

  if (input.total > 0) {
    elements.push({
      tag: "markdown",
      content: `第 ${input.page + 1}/${input.pageCount} 页 · 共 ${input.total} 个会话`,
      text_size: "notation",
    });
  }

  const template: CardTemplate = "blue";
  return guardCard({
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: input.title ?? "🧩 OpenCode 会话（全部）" },
      template,
    },
    body: { elements },
  });
}

/** 解析会话卡片按钮 value；非会话卡片返回 undefined（交给审批卡路由）。 */
export function parseSessionCardValue(raw: unknown): SessionCardValue | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const chatId = typeof record.c === "string" ? record.c : "";
  if (record.cmd === "new") return { cmd: "new", chatId };
  if (record.cmd === "use" || record.cmd === "open") {
    const sessionID = typeof record.s === "string" ? record.s : "";
    if (!sessionID) return undefined;
    return record.cmd === "open" ? { cmd: "open", sessionID, chatId } : { cmd: "use", sessionID, chatId };
  }
  if (record.cmd === "list") {
    const page = parsePage(record.p);
    return { cmd: "list", page, chatId };
  }
  if (record.cmd === "compact") {
    const sessionID = typeof record.s === "string" ? record.s : "";
    const token = typeof record.t === "string" ? record.t : "";
    if (!sessionID || !token) return undefined;
    return { cmd: "compact", sessionID, token };
  }
  return undefined;
}

/** 恢复卡压缩按钮的 value（`{cmd:"compact", s, t}`）；缺省不渲染按钮。 */
export interface SessionOpenedCompactButton {
  readonly sessionID: string;
  /** 自签 token（由调用方签名，每次构建都可重签）。 */
  readonly token: string;
}

/**
 * **统一的话题根卡构建器**：`created` / `resumed` 两种风格 + 可选工作状态。
 *
 * - 构建 / 状态刷新**共用**本函数：先用持久化的 `SessionRootCardBase` 还原摘要与元信息，
 *   再叠加状态（颜色 + 页脚），从而保证状态刷新**不会丢摘要**。
 * - `status` 缺省 = 不渲染状态页脚、header 保持 `green`（创建/旧卡片兼容路径）。
 * - 标题默认原样（`topicStatusInTitle=false`）；开启时加状态 emoji 前缀。
 */
export function buildSessionRootCard(
  base: SessionRootCardBase,
  status?: TopicStatusView,
  options: {
    readonly now?: number;
    readonly statusInTitle?: boolean;
    /** 状态刷新时重签的压缩按钮 token（不落盘）。 */
    readonly compactToken?: string;
    /** 单卡最多保留的 markdown 表格数（默认 4，夹取 1–5）。 */
    readonly maxTables?: number;
    /** 发生表格降级 / 元素丢弃时回调（调用方按 sessionID 记日志）。 */
    readonly onLimit?: (report: CardLimitReport) => void;
  } = {},
): object {
  const now = options.now ?? Date.now();
  const elements: object[] = [];
  let headerTitle: string;

  if (base.style === "created") {
    const title = base.title.trim() || "(未命名)";
    headerTitle = `✅ 已创建 · ${title}`;
    elements.push({ tag: "markdown", content: truncateCardContent(renderCreatedBody(title, base)) });
  } else {
    const title = truncateTitle(base.title.trim() || "(未命名)");
    headerTitle = `🔄 ${title}`;
    elements.push({ tag: "markdown", content: truncateCardContent(renderResumedBody(title, base, now)) });
    if (base.compactButton && options.compactToken) {
      // 「🗜 压缩并总结」按钮直放 body.elements（JSON 2.0 不支持 1.0 的 tag:"action" 容器）。
      elements.push(
        button("🗜 压缩并总结", "default", {
          cmd: "compact",
          s: base.sessionID,
          t: options.compactToken,
        }),
      );
    }
  }

  if (status) {
    elements.push({ tag: "markdown", content: topicStatusFooter(status, now), text_size: "notation" });
  }

  const template: CardTemplate = status ? topicStatusMeta(status.kind).color : "green";
  const content =
    status && options.statusInTitle ? topicStatusTitle(headerTitle, status, true) : headerTitle;
  return guardCard(
    {
      schema: "2.0",
      config: { update_multi: true },
      header: { title: { tag: "plain_text", content }, template },
      body: { elements },
    },
    options,
  );
}

/**
 * 卡片内容守卫封装：整卡表格累计 ≤`maxTables`（超出降级为代码块），组件数 ≤200。
 * `onLimit` 仅在**确实发生**降级 / 丢弃时回调，避免正常卡片产生噪声日志。
 */
function guardCard(
  card: object,
  options: { readonly maxTables?: number; readonly onLimit?: (report: CardLimitReport) => void } = {},
): object {
  const { card: guarded, report } = enforceCardLimits(card, { maxTables: options.maxTables });
  if (options.onLimit && (report.degradedTables > 0 || report.droppedElements > 0)) {
    options.onLimit(report);
  }
  return guarded;
}

/** `resumed` 风格正文（恢复卡）。 */
function renderResumedBody(title: string, base: SessionRootCardBase, now: number): string {
  const lines = [`会话「${title}」：\`${base.sessionID}\``];
  const setup: string[] = [];
  if (base.dir) setup.push(`- 目录：\`${base.dir}\``);
  if (base.model) setup.push(`- 模型：${base.model}`);
  if (base.updatedAt && base.updatedAt > 0) {
    setup.push(`- 最近活动：${relativeTime(base.updatedAt, now)}`);
  }
  if (setup.length > 0) lines.push("", ...setup);
  lines.push("", "**回复本卡片**即可继续这个历史会话（飞书回复会在本卡下形成话题）。");
  if (base.summary || base.summaryPending || base.compactPending || base.compactError) {
    lines.push("", `**${base.summaryLabel ?? "摘要"}**：`);
    if (base.summaryPending) lines.push("⏳ 正在总结该会话…");
    if (base.compactPending) lines.push("🗜 正在压缩会话…（压缩会修改会话历史，请稍候）");
    if (base.summary) lines.push(base.summary);
    if (base.compactError) lines.push(base.compactError);
  }
  lines.push(
    "",
    "话题内可用：`/current` `/stop` `/model` `/perm` `/cd` `/help`。",
    "会话管理（`/new` `/sessions` `/resume`）请回到主聊天流。",
  );
  return lines.join("\n");
}

/** `created` 风格正文（建会话成功卡）。 */
function renderCreatedBody(title: string, base: SessionRootCardBase): string {
  const lines = [`会话「${title}」已创建：\`${base.sessionID}\``];
  const setup: string[] = [];
  if (base.dir) setup.push(`- 目录：\`${base.dir}\``);
  if (base.model) setup.push(`- 模型：${base.model}`);
  if (base.perm) setup.push(`- 权限：${base.perm}`);
  if (setup.length > 0) lines.push("", ...setup);
  lines.push("", "点进本话题直接发消息即可，OpenCode 就在这个会话里干活。");
  if (base.note) lines.push("", base.note);
  return lines.join("\n");
}

/**
 * 「进入话题 / 恢复会话」成功卡（P7 + 任务 B）：`reply_in_thread` 落到新话题内，是话题的根卡。
 *
 * 标题 = `🔄 <会话标题>`（截断保护），因此**话题显示名就是会话主题**；
 * 正文含会话 ID / 目录 / 模型 / 最近活动 / 指引，可选**摘要区块**：
 * - `summary` 有值 → 渲染摘要（`summaryLabel` 区分「复用原生摘要」/「已压缩」/「快摘要」）；
 * - `summaryPending=true` → 显示「⏳ 正在总结该会话…」；
 * - `compactPending=true` → 显示「🗜 正在压缩会话…」；
 * - `compactError` → 显示压缩失败/超时说明。
 *
 * `compactButton` 存在时渲染「🗜 压缩并总结」按钮（**用户主动**触发原生压缩）。
 */
export function buildSessionOpenedCard(input: {
  readonly title: string;
  readonly sessionID: string;
  readonly dir?: string;
  readonly model?: string;
  readonly updatedAt?: number;
  readonly now?: number;
  /** 任务 B：会话摘要（已生成 / 复用 / 已压缩）。 */
  readonly summary?: string;
  /** 摘要来源标注（如「会话摘要」「已压缩 · 会话摘要」）；缺省只显示「摘要：」。 */
  readonly summaryLabel?: string;
  /** 任务 B：摘要生成中占位。 */
  readonly summaryPending?: boolean;
  /** 压缩进行中占位。 */
  readonly compactPending?: boolean;
  /** 压缩失败/超时说明。 */
  readonly compactError?: string;
  /** 「🗜 压缩并总结」按钮（用户主动触发原生压缩）。 */
  readonly compactButton?: SessionOpenedCompactButton;
  /** 单卡最多保留的 markdown 表格数（默认 4，夹取 1–5）。 */
  readonly maxTables?: number;
  /** 发生表格降级 / 元素丢弃时回调（调用方按 sessionID 记日志）。 */
  readonly onLimit?: (report: CardLimitReport) => void;
}): object {
  const base: SessionRootCardBase = {
    style: "resumed",
    title: input.title,
    sessionID: input.sessionID,
    ...(input.dir ? { dir: input.dir } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.summaryLabel ? { summaryLabel: input.summaryLabel } : {}),
    ...(input.summaryPending ? { summaryPending: true } : {}),
    ...(input.compactPending ? { compactPending: true } : {}),
    ...(input.compactError ? { compactError: input.compactError } : {}),
    ...(input.compactButton ? { compactButton: true } : {}),
  };
  return buildSessionRootCard(base, undefined, {
    now: input.now ?? Date.now(),
    ...(input.compactButton ? { compactToken: input.compactButton.token } : {}),
    ...(input.maxTables !== undefined ? { maxTables: input.maxTables } : {}),
    ...(input.onLimit ? { onLimit: input.onLimit } : {}),
  });
}

/** 恢复卡「🗜 压缩并总结」的**待压缩态**卡片（点击后立刻反馈）。
 *
 * 白名单 / 验签 / 防重放 / 后台压缩与轮询由 `CompactController` 负责；
 * 本函数只负责构建「🗜 正在压缩会话…」卡片。
 */
export function buildResumeCompactPendingCard(
  title: string,
  sessionID: string,
  token: string,
  now: number,
): object {
  return buildSessionOpenedCard({
    title,
    sessionID,
    now,
    compactPending: true,
    compactButton: { sessionID, token },
  });
}

/** 会话不存在 / 进入话题失败时的提示卡（patch 到原列表卡位置）。 */
export function buildSessionMissingCard(sessionID: string, reason?: string): object {
  const lines = [
    `会话 \`${sessionID}\` 不存在或不可用（可能已被删除，或不属于本机可见范围）。`,
    "",
    "发送 `/sessions` 重新获取列表。",
  ];
  if (reason) lines.splice(1, 0, "", `原因：${reason}`);
  return guardCard({
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "⚠️ 会话不存在" }, template: "orange" },
    body: { elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }] },
  });
}

/**
 * `/new` 的一键进入卡：机器人把这张卡 reply 到用户消息并 `reply_in_thread`，
 * 卡片即落在新话题内；用户直接在话题里发消息即可。无任何按钮（话题内不做会话管理）。
 */
export function buildSessionReadyCard(input: {
  readonly title: string;
  readonly sessionID: string;
  readonly dir?: string;
  readonly model?: string;
  readonly perm?: string;
}): object {
  const title = input.title.trim() || "(未命名)";
  const lines = [`会话「${title}」已创建：\`${input.sessionID}\``];
  const setup: string[] = [];
  if (input.dir) setup.push(`- 目录：\`${input.dir}\``);
  if (input.model) setup.push(`- 模型：${input.model}`);
  if (input.perm) setup.push(`- 权限：${input.perm}`);
  if (setup.length > 0) lines.push("", ...setup);
  lines.push(
    "",
    "**在本话题内直接发消息**，OpenCode 就在这个会话里干活。",
    "",
    "话题内可用：`/current` `/stop` `/model` `/perm` `/cd` `/help`。",
    "会话管理（`/new` `/sessions` `/use`）请回到主聊天流。",
  );
  return guardCard({
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "✅ 会话已就绪" }, template: "green" },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }],
    },
  });
}

export interface SessionCreatedCardInput {
  readonly title: string;
  readonly sessionID: string;
  readonly dir?: string;
  readonly model?: string;
  readonly perm?: string;
  /** 额外说明（如自动开话题失败时的手动创建指引）。 */
  readonly note?: string;
}

/**
 * 建会话成功后的**话题根卡**（P6.2）：把用户提交的建会话表单卡就地改写成这张卡。
 *
 * 因为这张卡同时是话题的根消息，标题会成为话题的显示名，所以标题固定为
 * `✅ 已创建 · <会话标题>` —— 让人一眼看出这是一个已成功创建会话的话题。
 * 正文包含会话 ID / 目录 / 模型 / 权限与「点进话题直接发消息即可」的指引。
 */
export function buildSessionCreatedCard(input: SessionCreatedCardInput): object {
  return buildSessionRootCard({
    style: "created",
    title: input.title,
    sessionID: input.sessionID,
    ...(input.dir ? { dir: input.dir } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.perm ? { perm: input.perm } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
}

function truncateTitle(title: string, max = 30): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

function parsePage(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
