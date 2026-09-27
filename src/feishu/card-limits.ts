/**
 * 卡片内容守卫（纯函数，无 IO，可单测）。
 *
 * 背景（真实线上 BUG）：飞书**单张卡片最多支持 5 个表格组件**，超限时
 * `im.message.patch` 直接 400 `code=230099 card table number over limit`。
 * 一次 assistant 回复里出现 5 个以上 markdown 对照表时，**每一次 patch 都失败**，
 * 卡片停在旧内容 → 用户感知为「机器人卡死」。
 *
 * 本模块负责：
 * 1. 识别 markdown 表格块（表头行 + 分隔行 `|---|---|` + 含 `|` 的正文行组）；
 * 2. 超过额度时把多余表格**降级为围栏代码块**（内容不丢，只是不再被飞书当成表格）；
 * 3. 卡片级累计计数（多个 markdown 元素**共用**一个额度），并对元素总数做上限保护
 *    （飞书单卡组件数上限约 200；超限时丢弃最旧元素，避免发出去 400）。
 *
 * 关键正确性：**代码块内的 `|` 绝不被识别为表格**（见 `computeFenceMask`），
 * 因此降级后（围栏代码块）再次处理是幂等的，不会无限降级。
 */

/** 默认单卡最多保留的 markdown 表格数（留 1 个余量给同卡其它表格来源）。 */
export const DEFAULT_CARD_MAX_TABLES = 4;
/** 配置夹取范围：至少 1，飞书硬上限 5。 */
export const CARD_MAX_TABLES_MIN = 1;
export const CARD_MAX_TABLES_MAX = 5;
/** 单卡组件数软上限（飞书约 200）；超出则丢弃最旧元素。 */
export const DEFAULT_CARD_MAX_ELEMENTS = 200;

/** markdown 表格块的行区间（0-based，闭区间）。 */
export interface MarkdownTableSpan {
  /** 表头行索引。 */
  readonly start: number;
  /** 最后一个正文行索引（单列表格时等于分隔行）。 */
  readonly end: number;
}

/** 累计表格额度：多个 markdown 元素共用一个 `CardMarkdownBudget`。 */
export interface CardMarkdownBudget {
  readonly max: number;
  remaining: number;
  /** 累计识别到的表格数。 */
  tables: number;
  /** 累计被降级（改为代码块）的表格数。 */
  degraded: number;
}

export interface CardLimitOptions {
  readonly maxTables?: number;
  readonly maxElements?: number;
}

export interface CardLimitReport {
  /** 整卡累计识别到的表格数。 */
  readonly tables: number;
  /** 整卡累计被降级的表格数。 */
  readonly degradedTables: number;
  /** 处理后整卡组件数。 */
  readonly elements: number;
  /** 因超过组件数上限而丢弃的元素数（从最旧开始丢）。 */
  readonly droppedElements: number;
}

export interface CardLimitResult {
  readonly card: object;
  readonly report: CardLimitReport;
}

/** 把配置值夹取到合法范围（1–5），非法值回退默认 4。 */
export function clampMaxTables(value: number | undefined): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_CARD_MAX_TABLES;
  return Math.min(CARD_MAX_TABLES_MAX, Math.max(CARD_MAX_TABLES_MIN, n));
}

export function createCardMarkdownBudget(max = DEFAULT_CARD_MAX_TABLES): CardMarkdownBudget {
  const clamped = clampMaxTables(max);
  return { max: clamped, remaining: clamped, tables: 0, degraded: 0 };
}

/**
 * 识别 markdown 表格块。
 *
 * 规则（与 GFM 对齐的保守实现）：
 * - 一个表格块 = 「含 `|` 的表头行」+「分隔行」+「若干含 `|` 的正文行」；
 * - 分隔行：至少 1 个 `|`，且每个单元格形如 `:?-+:?`；
 * - **忽略围栏代码块（``` / ~~~）内的所有行**——这是「代码块内 `|` 不误判」的关键；
 * - 正文行遇到空行 / 不含 `|` / 新的分隔行即结束。
 */
export function findMarkdownTables(text: string): MarkdownTableSpan[] {
  if (!text || !text.includes("|")) return [];
  const lines = text.split("\n");
  const fence = computeFenceMask(lines);
  const spans: MarkdownTableSpan[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (fence[i] || !isSeparatorRow(line)) {
      i += 1;
      continue;
    }
    // 分隔行必须在表头行之后，且表头行本身含 `|`、不在代码块内、不是分隔行。
    if (i === 0 || fence[i - 1]) {
      i += 1;
      continue;
    }
    const header = lines[i - 1]!;
    if (header.trim() === "" || !header.includes("|") || isSeparatorRow(header)) {
      i += 1;
      continue;
    }
    let end = i;
    let j = i + 1;
    while (j < lines.length && !fence[j]) {
      const body = lines[j]!;
      if (body.trim() === "" || !body.includes("|") || isSeparatorRow(body)) break;
      end = j;
      j += 1;
    }
    spans.push({ start: i - 1, end });
    i = end + 1;
  }
  return spans;
}

/** 统计文本里的 markdown 表格块数量（代码块内的 `|` 不算）。 */
export function countMarkdownTables(text: string): number {
  return findMarkdownTables(text).length;
}

/**
 * 保留前 `max` 个表格，其余**降级为围栏代码块**（内容一字不丢，只是不再渲染为表格）。
 * 返回降级后的文本与被降级的表格数；未超限时原样返回且 `degraded=0`。
 */
export function degradeExtraTables(
  text: string,
  max = DEFAULT_CARD_MAX_TABLES,
): { text: string; degraded: number } {
  const keep = Math.max(0, Math.floor(max));
  const spans = findMarkdownTables(text);
  if (spans.length <= keep) return { text, degraded: 0 };

  const extras = spans.slice(keep);
  const starts = new Set(extras.map((s) => s.start));
  const ends = new Set(extras.map((s) => s.end));
  // 选一个不会与正文冲突的围栏符号（正文已含 ``` 则用 ~~~）。
  const fence = text.includes("```") ? "~~~" : "```";

  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (starts.has(i)) out.push(fence);
    out.push(lines[i]!);
    if (ends.has(i)) out.push(fence);
  }
  return { text: out.join("\n"), degraded: extras.length };
}

/**
 * 对单段 markdown 应用**共享额度**：识别到的表格先消耗 `budget.remaining`，
 * 超出的部分降级。返回处理后的文本（`budget` 就地更新）。
 */
export function toCardMarkdown(text: string, budget: CardMarkdownBudget): string {
  const spans = findMarkdownTables(text);
  if (spans.length === 0) return text;
  budget.tables += spans.length;
  const keep = Math.max(0, Math.min(spans.length, budget.remaining));
  budget.remaining -= keep;
  if (keep === spans.length) return text;
  budget.degraded += spans.length - keep;
  return degradeExtraTables(text, keep).text;
}

/**
 * 整卡守卫：对卡片内**所有** markdown 元素按出现顺序累计表格额度（整卡共享），
 * 并把组件数收敛到上限内（超限丢弃最旧元素）。
 *
 * 纯函数：返回**新卡片**（深拷贝后处理），不修改入参。
 */
export function enforceCardLimits(card: object, options: CardLimitOptions = {}): CardLimitResult {
  const maxTables = clampMaxTables(options.maxTables);
  const maxElements =
    typeof options.maxElements === "number" && Number.isFinite(options.maxElements)
      ? Math.max(1, Math.floor(options.maxElements))
      : DEFAULT_CARD_MAX_ELEMENTS;

  const clone = deepClone(card);
  const budget = createCardMarkdownBudget(maxTables);
  visitMarkdown(clone, (content) => toCardMarkdown(content, budget));

  let elements = countElements(clone);
  let dropped = 0;
  if (elements > maxElements) {
    const body = (clone as { body?: { elements?: unknown } }).body;
    if (body && Array.isArray(body.elements)) {
      // 从最旧开始丢，保留最新的内容（与 run-renderer 的体积保护策略一致）。
      while (elements > maxElements && body.elements.length > 1) {
        body.elements.shift();
        dropped += 1;
        elements = countElements(clone);
      }
    }
  }

  return {
    card: clone,
    report: { tables: budget.tables, degradedTables: budget.degraded, elements, droppedElements: dropped },
  };
}

/** 遍历卡片内所有 `{tag:"markdown", content}` 节点，就地替换 `content`。 */
function visitMarkdown(node: unknown, fn: (content: string) => string): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) visitMarkdown(item, fn);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (rec.tag === "markdown" && typeof rec.content === "string") {
    rec.content = fn(rec.content);
  }
  for (const value of Object.values(rec)) visitMarkdown(value, fn);
}

/** 统计卡片内带 `tag` 的组件数（飞书按组件计元素数）。 */
function countElements(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) {
    let total = 0;
    for (const item of node) total += countElements(item);
    return total;
  }
  const rec = node as Record<string, unknown>;
  let total = typeof rec.tag === "string" ? 1 : 0;
  for (const value of Object.values(rec)) total += countElements(value);
  return total;
}

/** 逐行标记是否处于围栏代码块内（``` / ~~~，允许最多 3 空格缩进）。 */
function computeFenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let fenceChar: "`" | "~" | undefined;
  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = match?.[1];
    const char = marker?.[0] as "`" | "~" | undefined;
    if (char && (!fenceChar || fenceChar === char)) {
      // 开启或关闭围栏：该行本身视为「代码块内」，避免把围栏行当表格。
      fenceChar = fenceChar ? undefined : char;
      mask.push(true);
      continue;
    }
    mask.push(fenceChar !== undefined);
  }
  return mask;
}

/**
 * 单独一行是否是 markdown 表格分隔行：
 * 至少含 1 个 `|`，且去掉首尾 `|` 后每个单元格都形如 `:?-+:?`。
 */
function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = inner.split("|").map((c) => c.trim());
  if (cells.length < 1) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
