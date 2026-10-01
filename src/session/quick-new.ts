/**
 * 主聊天流「一句话建会话」的意图/目录解析（issue #2）。
 *
 * 用户在主聊天流发普通文本时，允许 AI 介入：
 * - 判断意图（是否是需要新建会话来执行的**任务**，还是闲聊）；
 * - 从**候选目录**（最近使用 + 本机会话目录）中选出最匹配的工作目录。
 *
 * 本模块只做纯逻辑（prompt 拼装 / 结果解析），模型调用与卡片由调用方注入，
 * 便于单测。候选目录**只允许**来自候选清单——模型给出的路径必须命中候选，
 * 否则视为未识别（防幻觉路径）。
 */

/** 候选工作目录：来自最近使用记录或本机会话（`label` 为会话标题，辅助语义匹配）。 */
export interface QuickNewCandidate {
  readonly path: string;
  readonly label?: string;
}

/** 模型输出（意图 + 目录 + 标题）。 */
export interface QuickNewDecision {
  readonly intent: "task" | "chat";
  readonly directory?: string;
  readonly title?: string;
  readonly reason?: string;
}

export const QUICK_NEW_INSTRUCTION = [
  "你是飞书 AI 助手「管理台」的意图识别器。用户在管理台（还没有会话）发来一条消息。",
  "请判断它是不是一个需要新建会话去执行的开发/操作任务，并从候选目录中选出最合适的工作目录。",
  "只输出一个 JSON 对象，不要任何其他文字：",
  '{"intent":"task|chat","dir":"<绝对路径或空字符串>","title":"<不超过20字的会话标题>","reason":"<一句话理由>"}',
  "规则：",
  "- 闲聊、问候、询问用法 → intent=chat，dir 留空。",
  "- 明确的开发/操作任务（改 bug、写代码、整理文件、跑脚本等）→ intent=task。",
  "- dir 只能从候选目录中选择（语义最匹配的那个）；找不到合适的就留空字符串。",
].join("\n");

/** 拼装发给模型的 prompt（候选清单 + 用户消息，均有截断保护）。 */
export function buildQuickNewPrompt(text: string, candidates: readonly QuickNewCandidate[]): string {
  const list = candidates
    .slice(0, 40)
    .map((c) => `- ${c.path}${c.label ? `（${c.label}）` : ""}`)
    .join("\n");
  return [
    QUICK_NEW_INSTRUCTION,
    "",
    "候选目录：",
    list || "（无）",
    "",
    "用户消息：",
    text.slice(0, 2000),
  ].join("\n");
}

/**
 * 解析模型输出（容忍 ```json 围栏与前后杂讯）。无法识别时返回 undefined。
 * `intent=task` 但不含目录也是合法结果（调用方自行处理"未解析到目录"）。
 */
export function parseQuickNewDecision(raw: string | undefined): QuickNewDecision | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const intent = obj.intent === "task" ? "task" : obj.intent === "chat" ? "chat" : undefined;
  if (!intent) return undefined;
  const dir = typeof obj.dir === "string" ? obj.dir.trim() : typeof obj.directory === "string" ? obj.directory.trim() : "";
  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 30) : "";
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 200) : "";
  return {
    intent,
    ...(dir ? { directory: dir } : {}),
    ...(title ? { title } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * 在候选清单中匹配模型给出的路径（容忍尾部斜杠差异）。
 * 命中返回候选的规范路径；未命中返回 undefined（防幻觉路径）。
 */
export function matchCandidateDirectory(
  directory: string | undefined,
  candidates: readonly QuickNewCandidate[],
): string | undefined {
  if (!directory) return undefined;
  const normalize = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  const target = normalize(directory);
  const hit = candidates.find((c) => normalize(c.path) === target);
  return hit?.path;
}
