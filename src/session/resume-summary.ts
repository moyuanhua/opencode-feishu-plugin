/**
 * 恢复卡（任务 B）的会话摘要获取：**三条路径**（成本从低到高）。
 *
 * 1. **复用**：读会话**完整消息**（`session.message.list` / `{data:[...]}`），找最近一条
 *    `type:"compaction"` 且 `status:"completed"` 的 `summary` 直接渲染，**零模型调用**；
 *    注意 `/session/{id}/context` 返回的是**精简形状**（不含 summary 字段），不能用它复用。
 * 2. **快摘要（默认路径）**：无原生摘要时，**绝不喂整个会话**——只取最近 N 条消息构造
 *    精简转写（每条截断、总量 ≤6K 字符，见 `buildTranscript`），调用**无会话上下文**的
 *    临时生成（`ctx.generate.text`），prompt 见 `RESUME_SUMMARY_PROMPT`，秒级完成。
 * 3. **原生压缩（用户主动）**：见 `session/compact.ts` —— 只有用户点「🗜 压缩并总结」才会
 *    调 `session.compact`；插件**绝不隐式触发**（压缩会修改会话历史）。
 *
 * 纯逻辑 + 注入 IO，便于单测；**永不抛异常**（异常/超时收敛为结果对象）。
 */
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";

/** 生成摘要用的固定 prompt（"用不超过 5 条要点总结本会话"）。 */
export const RESUME_SUMMARY_PROMPT =
  "用不超过 5 条要点总结本会话：目标、已完成、当前状态/阻塞、下一步。只输出要点，不要展开。";

/** 快摘要转写总量上限（字符）。一条消息再长也会被截断到 `TRANSCRIPT_LINE_LIMIT`。 */
export const TRANSCRIPT_LIMIT = 6000;
/** 快摘要转写单条消息上限（字符），避免一条超大 assistant 文本吃满预算。 */
export const TRANSCRIPT_LINE_LIMIT = 600;
/** 快摘要转写最多取多少条消息（从最近往前）。 */
export const TRANSCRIPT_MAX_MESSAGES = 40;

export type SessionSummarySource = "reused" | "generated" | "none";

export interface SummarizeSessionInput {
  readonly sessionID: string;
  readonly directory?: string;
  /** 单次快摘要（读消息 + 生成）总超时；超时按失败处理。 */
  readonly timeoutMs: number;
}

export interface SessionSummaryOutcome {
  readonly summary?: string;
  readonly source: SessionSummarySource;
  readonly error?: string;
}

export interface SummarizeSessionDeps {
  readonly log: Logger;
  /**
   * 读会话**完整消息**（`session.message.list` / `/api/session/{id}/message`）；缺省 = 跳过复用路径。
   * 不能传 `/context`（精简形状，无 summary）。
   */
  readonly readMessages?: (sessionID: string, directory: string | undefined) => Promise<unknown>;
  /**
   * **无会话上下文**的临时生成（`ctx.generate.text`）。
   * 刻意不暴露 `session.generate`——那会把整个会话喂给模型（大会话必超时）。
   */
  readonly generateText?: (prompt: string, directory: string | undefined) => Promise<unknown>;
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
 * 从会话完整消息里提取**最近一条** `status:"completed"` 的 compaction 摘要。
 *
 * 形状：`SessionMessage.Info[]` / `{data:[...]}` / `{messages:[...]}` / `{items:[...]}`。
 * compaction 消息带 `type:"compaction"` + `status:"running"|"completed"|"failed"` + `summary`；
 * **只认 completed**（running/failed 的 summary 不可用，跳过并继续往前找）。
 * 从后往前找，取第一个非空 summary；找不到返回 undefined。
 */
export function extractLatestSummary(raw: unknown): string | undefined {
  const list = extractArray(raw);
  if (!list) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const item = list[i];
    if (!isRecord(item)) continue;
    if (item.type !== "compaction") continue;
    if (item.status !== "completed") continue;
    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    if (summary) return summary;
  }
  return undefined;
}

/**
 * 从会话完整消息构造一份**精简转写**（快摘要的输入，**不喂整个会话**）。
 *
 * - 从**最近往前**收集 user/assistant 文本，保证最近的对话一定在预算内；
 * - 每条消息截断到 `TRANSCRIPT_LINE_LIMIT`，总量 ≤ `limit`；
 * - 跳过 reasoning / tool / system 等（只保留能表达"聊了什么"的文本）。
 */
export function buildTranscript(
  raw: unknown,
  limit = TRANSCRIPT_LIMIT,
  lineLimit = TRANSCRIPT_LINE_LIMIT,
): string | undefined {
  const list = extractArray(raw);
  if (!list || list.length === 0) return undefined;
  const lines: string[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (item.type === "user" && typeof item.text === "string") {
      const text = clip(item.text.trim(), lineLimit);
      if (text) lines.push(`用户：${text}`);
    } else if (item.type === "assistant" && Array.isArray(item.content)) {
      const text = clip(
        item.content
          .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
          .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
          .filter(Boolean)
          .join("\n"),
        lineLimit,
      );
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

/** 拼快摘要的实际 prompt：固定指令 + 精简转写（转写缺失时只用指令）。 */
export function buildSummaryPrompt(transcript: string | undefined): string {
  return transcript ? `${RESUME_SUMMARY_PROMPT}\n\n会话最近记录：\n${transcript}` : RESUME_SUMMARY_PROMPT;
}

/**
 * 复用或生成会话摘要。永不抛异常；超时/失败收敛为 `{source:"none", error}`。
 *
 * - 命中已有 compaction 摘要 → `reused`（零模型调用）；
 * - 否则读完整消息 → `buildTranscript` → `generateText`（无会话上下文）→ `generated`；
 * - 任何失败/超时 → `none`（调用方降级文案）。
 */
export async function summarizeSession(
  deps: SummarizeSessionDeps,
  input: SummarizeSessionInput,
): Promise<SessionSummaryOutcome> {
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs));

  // 1) 复用已有 compaction 摘要（零模型调用）。转写与生成共用同一次读取。
  let messages: unknown;
  if (deps.readMessages) {
    try {
      messages = await withTimeout(deps.readMessages(input.sessionID, input.directory), timeoutMs);
      const reused = extractLatestSummary(messages);
      if (reused) return { summary: reused, source: "reused" };
    } catch (err) {
      deps.log.debug("读取会话消息失败，继续尝试快摘要", {
        sessionID: input.sessionID,
        error: errorMessage(err),
      });
    }
  }

  // 2) 快摘要：精简转写 + 无会话上下文的临时生成。
  if (!deps.generateText) return { source: "none" };
  try {
    const transcript = buildTranscript(messages);
    const raw = await withTimeout(
      deps.generateText(buildSummaryPrompt(transcript), input.directory),
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

/** 兼容 `{text}` / `{"data":{"text":...}}` / 直接字符串。 */
export function extractGeneratedText(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (!isRecord(raw)) return undefined;
  if (typeof raw.text === "string" && raw.text.trim()) return raw.text.trim();
  const data = raw.data;
  if (isRecord(data) && typeof data.text === "string" && data.text.trim()) return data.text.trim();
  return undefined;
}

function clip(text: string, limit: number): string {
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) : text;
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
