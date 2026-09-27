/**
 * 飞书会话命令：解析与纯文本工具（无 IO，可单测）。
 *
 * 命令只在 p2p 文本消息以 `/` 开头时触发；解析失败/未知命令由上层回帮助提示，
 * **绝不**把命令文本当作 prompt 发给模型。
 */
import type { SessionEntry } from "./session-map.js";

export type CommandName =
  | "new"
  | "sessions"
  | "use"
  | "resume"
  | "current"
  | "stop"
  | "help"
  | "dir"
  | "model"
  | "perm"
  | "cd"
  | "cancel"
  | "form"
  | "steer"
  | "now"
  | "unknown";

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
  resume: "resume",
  current: "current",
  stop: "stop",
  help: "help",
  dir: "dir",
  cd: "cd",
  model: "model",
  perm: "perm",
  permission: "perm",
  permissions: "perm",
  cancel: "cancel",
  form: "form",
  steer: "steer",
  now: "now",
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

/** `/help` 文案。`scope` 决定显示哪些命令（话题内不展示被禁命令）。 */
export function helpText(scope: "main" | "thread" = "main"): string {
  if (scope === "thread") {
    return [
      "**OpenCode 话题命令**",
      "`/current` — 查看本话题对应的会话",
      "`/stop` — 中断本话题会话正在跑的任务",
      "`/steer <文本>` — 发送一条**立即插队**的消息（打断当前步骤插入执行）",
      "`/now` — 把本会话**已排队**的未执行消息全部改为立即插队执行",
      "`/model [关键词]` — 查看 / 切换本话题会话的模型",
      "`/perm [档位]` — 查看 / 修改本话题会话的权限预设",
      "`/cd <绝对路径>` — 切换本话题会话的工作目录",
      "`/help` — 显示本帮助",
      "",
      "建会话与会话管理（`/new` `/form` `/sessions` `/use` `/dir` `/cancel`）请回到**主聊天流**操作。",
    ].join("\n");
  }
  return [
    "**OpenCode 会话命令**",
    "`/new [标题]` — 直接打开发建会话表单卡（与 `/form` 等价，提交后自动开话题）",
    "`/form [标题]` — 同上，`/new` 的等价入口",
    "`/dir <绝对路径>` — 预填表单的工作目录（留空 = 允许根目录；不存在会自动创建）",
    "`/model [关键词]` — 预填表单的模型；话题内切换当前会话模型",
    "`/perm [档位]` — 预填表单的权限；话题内修改当前会话权限",
    "`/cancel` — 放弃建会话表单",
    "`/sessions`（别名 `/ls`）— **全部**会话列表卡片（含「▶️ 进入话题」）",
    "`/use <序号|会话id前缀>` — 切换当前会话（旧行为）",
    "`/resume [序号]` — 续聊历史会话：对最近更新（或第 N 个）会话直接开话题",
    "`/current` — 查看当前会话",
    "`/stop` — 中断当前会话正在跑的任务",
    "`/steer <文本>` — 发送一条**立即插队**的消息（打断当前步骤插入执行）",
    "`/now` — 把当前会话**已排队**的未执行消息全部改为立即插队执行",
    "`/help` — 显示本帮助",
  ].join("\n");
}

/** 话题内允许的命令白名单（P5.2 更新）：current/stop/help + 会话内操作 model/perm/cd。 */
const THREAD_ALLOWED: ReadonlySet<CommandName> = new Set<CommandName>([
  "current",
  "stop",
  "steer",
  "now",
  "help",
  "model",
  "perm",
  "cd",
  "unknown",
]);

/** 话题内该命令是否可用；`/new` `/sessions` `/use` `/dir` `/cancel` 在话题内被禁。 */
export function isCommandAllowedInThread(name: CommandName): boolean {
  return THREAD_ALLOWED.has(name);
}

/** 话题内敲了被禁命令时的提示文案（引导去主聊天流）。 */
export function threadForbiddenText(raw: string): string {
  const name = raw ? `\`/${raw}\`` : "该命令";
  return `话题内不支持 ${name}。\n\n建会话/会话管理请回到**主聊天流**操作（\`/new\`、\`/form\`、\`/sessions\`、\`/use\`、\`/resume\`、\`/dir\`、\`/cancel\`）。`;
}

/** 话题会话标题：取首条消息摘要，如 `话题: 帮我看看这个 bug`。 */
export function topicTitle(text: string, max = 20): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const summary = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  return summary ? `话题: ${summary}` : "话题会话";
}

