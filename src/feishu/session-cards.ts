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
import { shortSessionId } from "./commands.js";
import { directoryTail, relativeTime } from "./session-list.js";

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
  | { readonly cmd: "list"; readonly page: number; readonly chatId: string };

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
 * - 每行一个「▶️ 进入话题 / ▶️ 再开话题」按钮（值 `{cmd:"open"}`）；
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
    const lines = input.rows.map((row) => sessionRowLine(row, now)).join("\n");
    elements.push({ tag: "markdown", content: truncateCardContent(lines) });
    for (const row of input.rows) {
      elements.push(
        button(row.bound ? "▶️ 再开话题" : "▶️ 进入话题", row.active ? "primary" : "default", {
          cmd: "open",
          s: row.sessionID,
          c: input.chatId,
        }),
      );
    }
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
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: input.title ?? "🧩 OpenCode 会话（全部）" },
      template,
    },
    body: { elements },
  };
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
  return undefined;
}

/**
 * 「进入话题」成功卡（P7）：`reply_in_thread` 落到新话题内，是话题的根卡。
 * 标题含会话标题；正文含会话 ID / 目录 / 最近活动 / 可用命令。
 */
export function buildSessionOpenedCard(input: {
  readonly title: string;
  readonly sessionID: string;
  readonly dir?: string;
  readonly updatedAt?: number;
  readonly now?: number;
}): object {
  const title = input.title.trim() || "(未命名)";
  const lines = [`会话「${title}」：\`${input.sessionID}\``];
  const setup: string[] = [];
  if (input.dir) setup.push(`- 目录：\`${input.dir}\``);
  if (input.updatedAt && input.updatedAt > 0) {
    setup.push(`- 最近活动：${relativeTime(input.updatedAt, input.now ?? Date.now())}`);
  }
  if (setup.length > 0) lines.push("", ...setup);
  lines.push(
    "",
    "**在本话题内直接发消息**，OpenCode 就接着这个历史会话继续干活。",
    "",
    "话题内可用：`/current` `/stop` `/model` `/perm` `/cd` `/help`。",
    "会话管理（`/new` `/sessions` `/resume`）请回到主聊天流。",
  );
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: `✅ 已进入会话 · ${title}` }, template: "green" },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }],
    },
  };
}

/** 会话不存在 / 进入话题失败时的提示卡（patch 到原列表卡位置）。 */
export function buildSessionMissingCard(sessionID: string, reason?: string): object {
  const lines = [
    `会话 \`${sessionID}\` 不存在或不可用（可能已被删除，或不属于本机可见范围）。`,
    "",
    "发送 `/sessions` 重新获取列表。",
  ];
  if (reason) lines.splice(1, 0, "", `原因：${reason}`);
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "⚠️ 会话不存在" }, template: "orange" },
    body: { elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }] },
  };
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
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "✅ 会话已就绪" }, template: "green" },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }],
    },
  };
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
  const title = input.title.trim() || "(未命名)";
  const lines = [`会话「${title}」已创建：\`${input.sessionID}\``];
  const setup: string[] = [];
  if (input.dir) setup.push(`- 目录：\`${input.dir}\``);
  if (input.model) setup.push(`- 模型：${input.model}`);
  if (input.perm) setup.push(`- 权限：${input.perm}`);
  if (setup.length > 0) lines.push("", ...setup);
  lines.push("", "点进本话题直接发消息即可，OpenCode 就在这个会话里干活。");
  if (input.note) lines.push("", input.note);
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: `✅ 已创建 · ${title}` }, template: "green" },
    body: {
      elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }],
    },
  };
}

function truncateTitle(title: string, max = 30): string {
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

function parsePage(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}
