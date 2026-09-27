/**
 * 恢复卡（任务 B）的会话摘要获取：**优先复用已有摘要，缺失才异步生成**。
 *
 * 成本从低到高：
 * 1. 复用：读会话上下文（`ctx.session.context`），找最近一条 compaction/summary 消息里的
 *    `summary` 文本直接渲染，**不产生模型调用**；
 * 2. 生成：调用 `ctx.session.generate({sessionID, prompt})`（若运行时不可用，调用方可用
 *    等价接口，如 `ctx.generate.text`）；prompt 见 `RESUME_SUMMARY_PROMPT`；
 * 3. 都不可用 / 失败 / 超时 → `{ source:"none", error }`，由调用方降级为「生成失败」文案。
 *
 * 纯逻辑 + 注入 IO，便于单测；**永不抛异常**（异常/超时收敛为结果对象）。
 */
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";

/** 生成摘要用的固定 prompt（"用不超过 5 条要点总结本会话"）。 */
export const RESUME_SUMMARY_PROMPT =
  "用不超过 5 条要点总结本会话：目标、已完成、当前状态/阻塞、下一步。只输出要点，不要展开。";

export type SessionSummarySource = "reused" | "generated" | "none";

export interface SummarizeSessionInput {
  readonly sessionID: string;
  readonly directory?: string;
  /** 单次摘要（读上下文 + 生成）总超时；超时按失败处理。 */
  readonly timeoutMs: number;
}

export interface SessionSummaryOutcome {
  readonly summary?: string;
  readonly source: SessionSummarySource;
  readonly error?: string;
}

export interface SummarizeSessionDeps {
  readonly log: Logger;
  /** 读会话上下文（`ctx.session.context`）；缺省 = 跳过复用路径。 */
  readonly readContext?: (sessionID: string, directory: string | undefined) => Promise<unknown>;
  /** 生成摘要（`ctx.session.generate` 或等价接口）；缺省 = 无法生成。 */
  readonly generate?: (sessionID: string, prompt: string, directory: string | undefined) => Promise<unknown>;
}

/** 摘要超时哨兵错误，便于日志区分「超时」与「其它失败」。 */
export class SummaryTimeoutError extends Error {
  constructor() {
    super("summary-timeout");
    this.name = "SummaryTimeoutError";
  }
}

/** 给 promise 加超时；超时 reject `SummaryTimeoutError`（底层 promise 仍在跑，无法取消）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SummaryTimeoutError()), Math.max(1, ms));
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 从会话上下文消息里提取**最近一条** compaction/summary 文本。
 *
 * 兼容 `SessionMessage.Info[]`（compaction 消息带 `type:"compaction"` + `summary`），
 * 以及 `{data:[...]}` / `{messages:[...]}` / `{items:[...]}` 等包裹形状。
 * 从后往前找，取第一个非空 `summary`；找不到返回 undefined。
 */
export function extractLatestSummary(raw: unknown): string | undefined {
  const list = extractArray(raw);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!isRecord(item)) continue;
    if (item.type !== "compaction") continue;
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    if (summary) return summary;
  }
  return undefined;
}

/** 从上下文原始返回里提取一份精简转写（`ctx.session.generate` 不可用时的等价兜底）。 */
export function buildTranscript(raw: unknown, limit = 6000): string | undefined {
  const list = extractArray(raw);
  if (!list || list.length === 0) return undefined;
  const lines: string[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (item.type === "user" && typeof item.text === "string" && item.text.trim()) {
      lines.push(`用户：${item.text.trim()}`);
    } else if (item.type === "assistant" && Array.isArray(item.content)) {
      const text = item.content
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
        .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
        .filter(Boolean)
        .join("\n");
      if (text) lines.push(`助手：${text}`);
    }
  }
  if (lines.length === 0) return undefined;
  // 从最近的记录向前拼，保证最近的对话一定在预算内。
  const recent: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const size = Buffer.byteLength(line, "utf8");
    if (bytes + size > limit && recent.length > 0) break;
    recent.unshift(line);
    bytes += size;
  }
  return recent.join("\n").slice(0, limit);
}

/**
 * 复用或生成会话摘要。永不抛异常；超时/失败收敛为 `{source:"none", error}`。
 */
export async function summarizeSession(
  deps: SummarizeSessionDeps,
  input: SummarizeSessionInput,
): Promise<SessionSummaryOutcome> {
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));

  // 1) 复用已有 compaction 摘要（零模型调用）。
  if (deps.readContext) {
    try {
      const raw = await withTimeout(deps.readContext(input.sessionID, input.directory), timeoutMs);
      const reused = extractLatestSummary(raw);
      if (reused) return { summary: reused, source: "reused" };
    } catch (err) {
      deps.log.debug("读取会话上下文失败，继续尝试生成摘要", {
        sessionID: input.sessionID,
        error: errorMessage(err),
      });
    }
  }

  // 2) 异步生成。
  if (!deps.generate) return { source: "none" };
  try {
    const raw = await withTimeout(
      deps.generate(input.sessionID, RESUME_SUMMARY_PROMPT, input.directory),
      timeoutMs,
    );
    const generated = extractGeneratedText(raw);
    if (generated) return { summary: generated, source: "generated" };
    return { source: "none", error: "empty-summary" };
  } catch (err) {
    const error = errorMessage(err);
    deps.log.warn("生成会话摘要失败", {
      sessionID: input.sessionID,
      timedOut: err instanceof SummaryTimeoutError,
      error,
    });
    return { source: "none", error };
  }
}

/** 兼容 `{text}` / `{\"data\":{\"text\":...}}` / 直接字符串。 */
export function extractGeneratedText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (!isRecord(raw)) return undefined;
  if (typeof raw.text === "string" && raw.text.trim()) return raw.text.trim();
  const data = raw.data;
  if (isRecord(data) && typeof data.text === "string" && data.text.trim()) return data.text.trim();
  return undefined;
}

function extractArray(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    for (const key of ["data", "messages", "items"]) {
      if (Array.isArray(raw[key])) return raw[key] as unknown[];
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
