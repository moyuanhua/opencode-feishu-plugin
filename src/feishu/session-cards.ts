/**
 * 会话列表卡片构建与按钮 value 解析（纯函数，可单测）。
 *
 * 按钮 value 约定：
 * - 切换：`{ cmd: "use", s: <sessionID>, c: <chatId> }`
 * - 新建：`{ cmd: "new", c: <chatId> }`
 *
 * 与审批卡一样走 `card.action.trigger`，`im.message.patch` 更新，必须 `update_multi: true`。
 */
import { truncateCardContent, type CardTemplate } from "./cards.js";
import { sessionLine } from "./commands.js";
import type { SessionEntry } from "./session-map.js";

export interface SessionListCardInput {
  readonly chatId: string;
  readonly sessions: readonly SessionEntry[];
  readonly activeID?: string;
  readonly title?: string;
}

export type SessionCardValue =
  | { readonly cmd: "use"; readonly sessionID: string; readonly chatId: string }
  | { readonly cmd: "new"; readonly chatId: string };

/** 飞书卡片 JSON 2.0 按钮：回调数据走 behaviors，value 为对象；2.0 不支持 tag:"action" 容器。 */
function button(text: string, type: "primary" | "default" | "danger", value: Record<string, unknown>): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

/** 构建会话列表卡片：每行一个「切换 N」按钮 + 底部「新建会话」。 */
export function buildSessionListCard(input: SessionListCardInput): object {
  const lines = input.sessions.length
    ? input.sessions.map((entry, index) => sessionLine(entry, index, input.activeID)).join("\n")
    : "还没有会话。直接发消息即可自动创建，或点击下方「新建会话」。";

  const switchButtons = input.sessions.map((entry, index) =>
    button(`切换 ${index + 1}`, entry.sessionID === input.activeID ? "primary" : "default", {
      cmd: "use",
      s: entry.sessionID,
      c: input.chatId,
    }),
  );

  const elements: object[] = [{ tag: "markdown", content: truncateCardContent(lines) }];
  // 2.0：按钮直接放进 elements（不能包在 tag:"action" 里）
  elements.push(...switchButtons);
  elements.push(button("➕ 新建会话", "default", { cmd: "new", c: input.chatId }));

  const template: CardTemplate = "blue";
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: input.title ?? "🧩 OpenCode 会话" },
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
  if (record.cmd === "use") {
    const sessionID = typeof record.s === "string" ? record.s : "";
    if (!sessionID) return undefined;
    return { cmd: "use", sessionID, chatId };
  }
  return undefined;
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

