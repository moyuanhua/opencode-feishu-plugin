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

function button(text: string, type: "primary" | "default" | "danger", value: Record<string, unknown>): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    value: JSON.stringify(value),
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
  if (switchButtons.length > 0) elements.push({ tag: "action", actions: switchButtons });
  elements.push({ tag: "action", actions: [button("➕ 新建会话", "default", { cmd: "new", c: input.chatId })] });

  const template: CardTemplate = "blue";
  return {
    schema: "2.0",
    config: { update_multi: true, wide_screen_mode: true },
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
