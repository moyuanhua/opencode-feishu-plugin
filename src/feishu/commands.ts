/**
 * 飞书会话命令：解析与纯文本工具（无 IO，可单测）。
 *
 * 命令只在 p2p 文本消息以 `/` 开头时触发；解析失败/未知命令由上层回帮助提示，
 * **绝不**把命令文本当作 prompt 发给模型。
 */
import type { SessionEntry } from "./session-map.js";

export type CommandName = "new" | "sessions" | "use" | "current" | "stop" | "help" | "unknown";

export interface ParsedCommand {
  readonly name: CommandName;
  /** 命令后的原始参数（已 trim，可含空格）。 */
  readonly args: string;
  /** 原始命令词（不含前导 `/`），用于帮助与日志。 */
  readonly raw: string;
}

const ALIASES: Readonly<Record<string, CommandName>> = {
  new: "new",
  sessions: "sessions",
  ls: "sessions",
  use: "use",
  current: "current",
  stop: "stop",
  help: "help",
};

/** 是否是命令（以 `/` 开头）。 */
export function isCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

/**
 * 解析命令。非命令返回 undefined；`/` 或空命令词视为 `help`；
 * 未登记的命令词返回 `unknown`（上层回帮助提示）。
 */
export function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1).trim();
  if (!body) return { name: "help", args: "", raw: "" };
  const wsIndex = body.search(/\s/);
  const raw = wsIndex < 0 ? body : body.slice(0, wsIndex);
  const args = wsIndex < 0 ? "" : body.slice(wsIndex + 1).trim();
  return { name: ALIASES[raw.toLowerCase()] ?? "unknown", args, raw };
}

/** `/new` 缺省标题（时间戳）。 */
export function defaultSessionTitle(now: number): string {
  return `飞书会话 ${new Date(now).toISOString()}`;
}

/** 会话 id 的短展示形式（卡片空间有限）。 */
export function shortSessionId(sessionID: string): string {
  return sessionID.length <= 12 ? sessionID : `${sessionID.slice(0, 12)}…`;
}

export type SessionMatch =
  | { readonly ok: true; readonly entry: SessionEntry }
  | { readonly ok: false; readonly reason: "empty" | "not_found" | "ambiguous" };

/**
 * 把 `/use` 参数解析为目标会话：
 * - 纯数字 → 1-based 序号
 * - 其它 → 会话 id 前缀匹配（唯一才算命中）
 */
export function matchSession(arg: string, sessions: readonly SessionEntry[]): SessionMatch {
  const query = arg.trim();
  if (!query) return { ok: false, reason: "empty" };
  if (/^\d+$/.test(query)) {
    const index = Number.parseInt(query, 10) - 1;
    const entry = sessions[index];
    return entry ? { ok: true, entry } : { ok: false, reason: "not_found" };
  }
  const matches = sessions.filter((s) => s.sessionID.toLowerCase().startsWith(query.toLowerCase()));
  if (matches.length === 1) return { ok: true, entry: matches[0]! };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: false, reason: "not_found" };
}

/** 单行会话展示：`1. 标题（短id） ← 当前`。 */
export function sessionLine(entry: SessionEntry, index: number, activeID?: string): string {
  const mark = activeID && entry.sessionID === activeID ? " ← 当前" : "";
  const title = entry.title.trim() || "(未命名)";
  return `${index + 1}. ${title}（\`${shortSessionId(entry.sessionID)}\`）${mark}`;
}

/** `/use` 失败时的提示文案。 */
export function useErrorText(reason: "empty" | "not_found" | "ambiguous"): string {
  switch (reason) {
    case "empty":
      return "用法：/use <序号|会话id前缀>，例如 `/use 2` 或 `/use ses_abc`。";
    case "ambiguous":
      return "该前缀匹配到多个会话，请输入更长的会话 id 前缀。";
    case "not_found":
    default:
      return "未找到匹配的会话，先用 /sessions 查看列表。";
  }
}

/** `/help` 文案。 */
export function helpText(): string {
  return [
    "**OpenCode 会话命令**",
    "`/new [标题]` — 新建会话并切换（缺省标题为时间戳）",
    "`/sessions`（别名 `/ls`）— 会话列表卡片",
    "`/use <序号|会话id前缀>` — 切换当前会话",
    "`/current` — 查看当前会话",
    "`/stop` — 中断当前会话正在跑的任务",
    "`/help` — 显示本帮助",
  ].join("\n");
}
