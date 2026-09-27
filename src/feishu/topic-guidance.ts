/**
 * 主题软引导（P5.3，纯逻辑 + 可注入依赖，便于单测）。
 *
 * 背景：一个飞书话题 = 一个会话，标题即「主题」。用户要求**不拦截**离题消息，
 * 只做**软引导**：在 system 里注入一句轻量说明，让模型在用户明显跑题时
 * 简短提示「可用 /new 开新会话」，但不要因此拒答或长篇说教。
 *
 * 安全/边界：
 * - 只对**从飞书发起的会话**注入（由 `resolveSession` 判定）；
 * - 非飞书会话（本地 TUI 等）`resolveSession` 返回 undefined，**绝不注入**；
 * - 任何异常都只 warn，绝不影响模型执行（不向外抛）。
 */
import type { Logger } from "../types.js";
import { errorMessage } from "../logger.js";

/** 标记 key：写入 SystemPart.metadata，用于去重，避免同一请求重复注入。 */
export const TOPIC_GUIDANCE_MARKER = "opencode-feishu-topic-guidance";

/** system 注入项的最小形状（与 `@opencode/ai` 的 `SystemPart` 对齐）。 */
interface SystemTextPart {
  readonly type: "text";
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TopicGuidanceInput {
  readonly sessionID: string;
  /** 待注入的 system 数组（`SessionContext.system`）。 */
  readonly system: unknown;
}

export interface TopicGuidanceDeps {
  readonly log: Logger;
  /**
   * 解析会话是否为**飞书发起的会话**（能投递到飞书的会话）。
   * 返回 undefined = 非飞书会话 → 跳过注入。
   */
  readonly resolveSession: (sessionID: string) => Promise<{ readonly chatId: string } | undefined>;
  /** 取会话标题（先 SessionMap，再 `ctx.session.get` 兜底）；无标题返回 undefined。 */
  readonly resolveTitle: (sessionID: string, chatId: string) => Promise<string | undefined>;
}

/** 生成主题软引导文案（纯函数）。 */
export function buildTopicGuidance(title: string): string {
  return `本会话主题：「${title}」。若用户明显转向与该主题无关的任务，可简短提醒他用 /new 开新会话；不要因此拒绝回答，也不要长篇说教。`;
}

/**
 * 对一次模型上下文请求做主题软引导注入。
 * **永不抛异常**：任何失败只 warn 并原样返回。
 */
export async function injectTopicGuidance(
  input: TopicGuidanceInput,
  deps: TopicGuidanceDeps,
): Promise<void> {
  try {
    if (!Array.isArray(input.system)) return;
    const system = input.system as SystemTextPart[];
    if (system.some(isGuidancePart)) return; // 同一请求已注入过
    const link = await deps.resolveSession(input.sessionID);
    if (!link) return; // 非飞书会话：绝不注入
    const title = (await deps.resolveTitle(input.sessionID, link.chatId))?.trim();
    if (!title) return; // 取不到标题：跳过
    system.push({
      type: "text",
      text: buildTopicGuidance(title),
      metadata: { [TOPIC_GUIDANCE_MARKER]: true },
    });
  } catch (err) {
    deps.log.warn("主题软引导注入失败", { sessionID: input.sessionID, error: errorMessage(err) });
  }
}

function isGuidancePart(part: unknown): boolean {
  if (typeof part !== "object" || part === null) return false;
  const metadata = (part as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  return (metadata as Record<string, unknown>)[TOPIC_GUIDANCE_MARKER] === true;
}
