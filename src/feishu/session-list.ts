/**
 * opencode **全量**会话列表的归一化与展示工具（纯函数，无 IO，可单测）。
 *
 * `ctx.session.list()` 的返回形状在不同运行时版本不稳定：
 * - Promise 客户端：`{ data: SessionInfo[], cursor }`；
 * - 部分版本/适配层直接返回数组，或 `{ sessions: [...] }` / `{ items: [...] }`。
 *
 * 这里做兼容归一化：识别不出数组形状时返回 `undefined`，由调用方
 * （`SessionCommands`）回退到 `SessionMap` 映射表列表并 `log.warn`。
 *
 * 时间字段同样不一：JSON 里通常是 ms 数字，但也可能是 ISO 字符串 / `Date` /
 * Effect `DateTime`（`{ epochMillis }`）。`toMillis` 全部兜住。
 */

/** 归一化后的会话条目（列表展示用）。 */
export interface SessionListEntry {
  readonly sessionID: string;
  readonly title: string;
  /** 最近更新时间（ms；0 = 未知）。 */
  readonly updatedAt: number;
  /** 会话工作目录（`location.directory`）。 */
  readonly directory?: string;
}

/**
 * 归一化 `ctx.session.list()` 的返回值。
 * 返回 `undefined` = 无法识别的形状（调用方回退）；空数组是合法结果。
 */
export function normalizeSessionList(raw: unknown): SessionListEntry[] | undefined {
  const array = extractArray(raw);
  if (!array) return undefined;
  const out: SessionListEntry[] = [];
  const seen = new Set<string>();
  for (const item of array) {
    const entry = normalizeSessionInfo(item);
    if (!entry || seen.has(entry.sessionID)) continue;
    seen.add(entry.sessionID);
    out.push(entry);
  }
  return sortByUpdatedDesc(out);
}

/** 归一化单个会话（`ctx.session.get()` / 列表元素）；缺 id 视为非法。 */
export function normalizeSessionInfo(raw: unknown): SessionListEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const sessionID = str(raw.id) || str(raw.sessionID);
  if (!sessionID) return undefined;
  const title = str(raw.title) || str(raw.slug);
  const updatedAt = extractUpdatedAt(raw);
  const directory = extractDirectory(raw);
  return {
    sessionID,
    title,
    updatedAt,
    ...(directory ? { directory } : {}),
  };
}

/** 从 `ctx.session.get()` 原始返回里提取标题（trim 后；空串返回 undefined）。 */
export function extractSessionTitle(raw: unknown): string | undefined {
  const title = normalizeSessionInfo(raw)?.title.trim();
  return title ? title : undefined;
}

/**
 * 把 number(ms) / 数字字符串 / ISO 字符串 / Date / Effect DateTime 归一成 ms。
 * 无法识别返回 0。
 */
export function toMillis(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }
  if (isRecord(value)) {
    // Effect DateTime 常见字段名。
    for (const key of ["epochMillis", "epochMilliseconds", "millis", "value"]) {
      const ms = toMillis(value[key]);
      if (ms > 0) return ms;
    }
  }
  return 0;
}

/** 按最近更新倒序（并列时按 id 稳定排序），不修改入参。 */
export function sortByUpdatedDesc(entries: readonly SessionListEntry[]): SessionListEntry[] {
  return [...entries].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.sessionID.localeCompare(b.sessionID),
  );
}

/**
 * `SessionMap` 回退列表 → 全量列表条目。
 * 映射表里的 `updatedAt` 可能是 0（旧记录），原样保留（展示「时间未知」）。
 */
export function fallbackEntries(
  entries: readonly { readonly sessionID: string; readonly title: string; readonly updatedAt: number }[],
): SessionListEntry[] {
  return sortByUpdatedDesc(
    entries.map((entry) => ({
      sessionID: entry.sessionID,
      title: entry.title,
      updatedAt: Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 ? entry.updatedAt : 0,
    })),
  );
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD / 时间未知。 */
export function relativeTime(fromMs: number, nowMs: number): string {
  if (!Number.isFinite(fromMs) || fromMs <= 0) return "时间未知";
  const diff = nowMs - fromMs;
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(fromMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 目录尾段：`/a/b/c` → `c`；空串返回空串。 */
export function directoryTail(dir: string): string {
  const trimmed = dir.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function extractArray(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    for (const key of ["data", "sessions", "items"]) {
      if (Array.isArray(raw[key])) return raw[key] as unknown[];
    }
  }
  return undefined;
}

function extractUpdatedAt(raw: Record<string, unknown>): number {
  const time = isRecord(raw.time) ? raw.time : undefined;
  const candidates: unknown[] = [
    time?.updated,
    raw.updatedAt,
    raw.updated,
    time?.created,
    raw.createdAt,
    raw.created,
  ];
  for (const candidate of candidates) {
    const ms = toMillis(candidate);
    if (ms > 0) return ms;
  }
  return 0;
}

function extractDirectory(raw: Record<string, unknown>): string {
  if (isRecord(raw.location)) {
    const directory = str(raw.location.directory);
    if (directory) return directory;
  }
  return str(raw.directory) || (typeof raw.location === "string" ? raw.location : "");
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
