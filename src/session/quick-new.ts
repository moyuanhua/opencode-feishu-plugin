/**
 * 主聊天流「AI 会话管理」的意图识别与字段解析（issue #2 演进）。
 *
 * 用户在主聊天流发普通文本时，AI 判断意图并尽量解析字段：
 * - `create`：建会话——解析 目录/标题/权限档位/模型（最终以**预填表单**由用户确认提交）；
 * - `list`：列出会话（直接出会话列表卡）；
 * - `chat`：闲聊 / 其他（回管理台提示卡）。
 *
 * 防幻觉：目录必须命中候选清单；权限档位限定四档；模型必须命中可选列表。
 * 本模块只做纯逻辑（prompt 拼装 / 结果解析 / 匹配），模型调用与卡片由调用方注入。
 */

/** 建会话权限档位（与 `PermissionPreset` 一致；此处独立声明避免层间耦合）。 */
export const QUICK_NEW_PERMS = ["readonly", "edit", "askHigh", "trust"] as const;
export type QuickNewPerm = (typeof QUICK_NEW_PERMS)[number];

/** 候选工作目录：来自最近使用记录或本机会话（`label` 为会话标题，辅助语义匹配）。 */
export interface QuickNewCandidate {
  readonly path: string;
  readonly label?: string;
}

/** 可选模型（用于把「用 glm 那个」解析成精确引用）。 */
export interface QuickNewModelOption {
  readonly providerID: string;
  readonly id: string;
  readonly name?: string;
}

/** 模型输出（意图 + 建会话字段）。 */
export interface QuickNewDecision {
  readonly intent: "create" | "list" | "chat";
  readonly directory?: string;
  readonly title?: string;
  readonly perm?: QuickNewPerm;
  readonly model?: string;
  readonly reason?: string;
}

export const QUICK_NEW_INSTRUCTION = [
  "你是飞书 AI 助手「管理台」的意图识别器。用户在管理台（还没有会话）发来一条消息。",
  "判断意图并尽量解析建会话字段。只输出一个 JSON 对象，不要任何其他文字：",
  '{"intent":"create|list|chat","dir":"<绝对路径或空字符串>","title":"<不超过20字的会话标题>","perm":"readonly|edit|askHigh|trust|空","model":"<providerID/modelID 或空>","reason":"<一句话理由>"}',
  "规则：",
  "- 列出/查看会话 → intent=list，其余字段留空。",
  "- 需要新建会话执行的开发/操作任务 → intent=create；闲聊、问候、询问用法 → chat。",
  "- dir 只能从候选目录中选择（语义最匹配的那个）；找不到合适的就留空字符串。",
  "- perm 依据用户表述（只读→readonly、可编辑→edit、高风险→askHigh、完全信任→trust）；用户没说就留空。",
  "- model 只能从候选模型中精确复制 providerID/modelID；用户没说就留空。",
].join("\n");

/** 拼装发给模型的 prompt（候选目录 + 候选模型 + 用户消息，均有截断保护）。 */
export function buildQuickNewPrompt(input: {
  readonly text: string;
  readonly candidates: readonly QuickNewCandidate[];
  readonly models?: readonly QuickNewModelOption[];
}): string {
  const dirs = input.candidates
    .slice(0, 40)
    .map((c) => `- ${c.path}${c.label ? `（${c.label}）` : ""}`)
    .join("\n");
  const models = (input.models ?? [])
    .slice(0, 30)
    .map((m) => `- ${m.providerID}/${m.id}${m.name ? `（${m.name}）` : ""}`)
    .join("\n");
  return [
    QUICK_NEW_INSTRUCTION,
    "",
    "候选目录：",
    dirs || "（无）",
    "",
    "候选模型：",
    models || "（无）",
    "",
    "用户消息：",
    input.text.slice(0, 2000),
  ].join("\n");
}

function isPerm(value: unknown): value is QuickNewPerm {
  return typeof value === "string" && (QUICK_NEW_PERMS as readonly string[]).includes(value);
}

/**
 * 解析模型输出（容忍 ```json 围栏与前后杂讯）。无法识别时返回 undefined。
 * `intent=create` 但无目录/权限也是合法结果（调用方按"未解析"处理，交给表单补全）。
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
  const intent =
    obj.intent === "create" || obj.intent === "list" || obj.intent === "chat" ? obj.intent : undefined;
  if (!intent) return undefined;
  const dir =
    typeof obj.dir === "string" ? obj.dir.trim() : typeof obj.directory === "string" ? obj.directory.trim() : "";
  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 30) : "";
  const perm = isPerm(obj.perm) ? obj.perm : undefined;
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 200) : "";
  return {
    intent,
    ...(dir ? { directory: dir } : {}),
    ...(title ? { title } : {}),
    ...(perm ? { perm } : {}),
    ...(model ? { model } : {}),
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

/**
 * 在候选模型中匹配模型给出的引用（先精确 `providerID/id`，再按 id / 名称兜底）。
 * 未命中返回 undefined（防幻觉）。
 */
export function matchModelOption(
  model: string | undefined,
  models: readonly QuickNewModelOption[],
): QuickNewModelOption | undefined {
  if (!model) return undefined;
  const norm = (s: string): string => s.trim().toLowerCase();
  const target = norm(model);
  return (
    models.find((m) => norm(`${m.providerID}/${m.id}`) === target) ??
    models.find((m) => norm(m.id) === target) ??
    models.find((m) => m.name !== undefined && norm(m.name) === target)
  );
}
