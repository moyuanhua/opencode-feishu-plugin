/**
 * 主聊天流「AI 会话管理」的意图识别与字段解析（issue #2 演进）。
 *
 * 用户在主聊天流发普通文本时，AI 判断意图并尽量解析字段：
 * - `create`：建会话——解析 目录/标题/权限档位/模型（最终以**预填表单**由用户确认提交）；
 * - `list`：列出会话（直接出会话列表卡）；
 * - `chat`：闲聊 / 其他（回管理台提示卡）。
 *
 * **目录优先（重要）**：`create` 时 dir 绝不允许留空，AI 必须给出一个确定目录：
 * - `given`：用户消息里明确给的路径；
 * - `existing`：命中候选清单（最近使用 / 历史会话目录，语义匹配）；
 * - `new`：都不命中 → 在允许根目录下新建（`<允许根目录>/<主题英文短横线>`）。
 * 表单只在目录确定后出现（目录已预填）；`existing/new` 的路径由调用方复核（防幻觉）。
 * 权限档位限定四档；模型必须命中可选列表。
 * 本模块只做纯逻辑（prompt 拼装 / 结果解析 / 匹配 / slug），模型调用与校验由调用方注入。
 */

/** 建会话权限档位（与 `PermissionPreset` 一致；此处独立声明避免层间耦合）。 */
export const QUICK_NEW_PERMS = ["readonly", "edit", "askHigh", "trust"] as const;
export type QuickNewPerm = (typeof QUICK_NEW_PERMS)[number];

/** 目录来源：用户指定 / 命中候选 / AI 新建。 */
export const QUICK_NEW_DIR_SOURCES = ["given", "existing", "new"] as const;
export type QuickNewDirSource = (typeof QUICK_NEW_DIR_SOURCES)[number];

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

/** 意图：建会话 / 列会话 / 进入会话 / 闲聊 / 需要向用户澄清。 */
export const QUICK_NEW_INTENTS = ["create", "list", "enter", "chat", "clarify"] as const;
export type QuickNewIntent = (typeof QUICK_NEW_INTENTS)[number];

/** 多轮澄清里的一轮（用户消息或助手提问）。 */
export interface QuickNewTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** 模型输出（意图 + 建会话字段）。 */
export interface QuickNewDecision {
  readonly intent: QuickNewIntent;
  readonly directory?: string;
  /** 目录来源（create 时：given/existing/new）。 */
  readonly dirSource?: QuickNewDirSource;
  readonly title?: string;
  readonly perm?: QuickNewPerm;
  readonly model?: string;
  /** enter 意图：目标会话（序号 / 标题关键词 / id 前缀）。 */
  readonly target?: string;
  /** clarify 意图：向用户提出的确认问题。 */
  readonly question?: string;
  readonly reason?: string;
}

export const QUICK_NEW_INSTRUCTION = [
  "你是飞书 AI 助手「管理台」的意图识别器。用户在管理台（尚未进入任何会话）发来一条消息，可能是一句自然语言，也可能是 /命令（/new、/form、/dir、/model、/perm、/sessions、/use、/resume）。",
  "判断意图并尽量解析建会话字段。只输出一个 JSON 对象，不要任何其他文字：",
  '{"intent":"create|list|enter|chat|clarify","dir":"<绝对路径>","dir_source":"given|existing|new","title":"<不超过20字的会话标题>","perm":"readonly|edit|askHigh|trust|空","model":"<providerID/modelID 或空>","target":"<要进入的会话：序号/标题关键词/id 前缀>","question":"<需要向用户确认的一句话>","reason":"<一句话理由>"}',
  "规则：",
  "- 列出/查看会话（/sessions、有哪些会话）→ intent=list，其余字段留空。",
  "- 进入/继续/切换已有会话（/use、/resume、打开第N个、继续上次那个）→ intent=enter，target=序号或标题关键词；无法确定是哪一个 → intent=clarify。",
  "- 需要新建会话执行的开发/操作任务（/new、/form、描述任务）→ intent=create；闲聊、问候、询问用法、无法归类 → chat。",
  "- 命令参数要采纳：/new 标题→title；/dir 路径→dir(dir_source=\"given\")；/model x→model；/perm x→perm。",
  "- **目录规则（create 时 dir 绝不允许为空，按优先级）：**",
  "  候选目录包括：最近使用目录、**允许根目录的一级子目录**、历史会话目录（可能带标题线索）。",
  "  ① 用户消息里明确给了路径 → dir=该路径，dir_source=\"given\"；",
  "  ② 否则先看候选里有没有语义匹配的现成目录（尤其允许根目录的一级子目录）→ dir=该候选路径原文，dir_source=\"existing\"；",
  "  ③ 能根据任务给出合理的英文小写短横线新目录名 → dir=<允许根目录下该新目录>，dir_source=\"new\"；",
  "  ④ **拿不准用哪个目录**（表述含糊、既可能用现成也可能要新建、候选无法判断）→ intent=clarify，question=一句中文提问：列出 2-3 个候选目录，或询问是否允许新建（给出建议的新目录名）。切勿在拿不准时擅自替用户选定目录。",
  "- perm 依据用户表述（只读→readonly、可编辑→edit、高风险→askHigh、完全信任→trust）；用户没说就留空。",
  "- model 只能从候选模型中精确复制 providerID/modelID；用户没说就留空。",
  "- dir 必须是绝对路径；绝不编造用户未提及、也不在候选/允许根目录范围内的既有路径。",
].join("\n");

/** 拼装发给模型的 prompt（允许根目录 + 候选目录 + 候选模型 + 历史对话 + 用户消息，均有截断保护）。 */
export function buildQuickNewPrompt(input: {
  readonly text: string;
  readonly candidates: readonly QuickNewCandidate[];
  readonly models?: readonly QuickNewModelOption[];
  readonly allowedRoots?: readonly string[];
  /** 多轮澄清历史（用户消息 / 助手提问），按时间顺序。 */
  readonly history?: readonly QuickNewTurn[];
}): string {
  const roots = (input.allowedRoots ?? []).slice(0, 8).map((r) => `- ${r}`).join("\n");
  const dirs = input.candidates
    .slice(0, 60)
    .map((c) => `- ${c.path}${c.label ? `（${c.label}）` : ""}`)
    .join("\n");
  const models = (input.models ?? [])
    .slice(0, 30)
    .map((m) => `- ${m.providerID}/${m.id}${m.name ? `（${m.name}）` : ""}`)
    .join("\n");
  const history = (input.history ?? [])
    .slice(-8)
    .map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.text.slice(0, 500)}`)
    .join("\n");
  return [
    QUICK_NEW_INSTRUCTION,
    "",
    "允许根目录（新建目录时只能放在这些目录之下）：",
    roots || "（无）",
    "",
    "候选目录：",
    dirs || "（无）",
    "",
    "候选模型：",
    models || "（无）",
    ...(history ? ["", "历史对话（用于理解下面这条消息是对上一轮追问的回答）：", history] : []),
    "",
    "用户消息：",
    input.text.slice(0, 2000),
  ].join("\n");
}

function isPerm(value: unknown): value is QuickNewPerm {
  return typeof value === "string" && (QUICK_NEW_PERMS as readonly string[]).includes(value);
}

function isDirSource(value: unknown): value is QuickNewDirSource {
  return typeof value === "string" && (QUICK_NEW_DIR_SOURCES as readonly string[]).includes(value);
}

function isIntent(value: unknown): value is QuickNewIntent {
  return typeof value === "string" && (QUICK_NEW_INTENTS as readonly string[]).includes(value);
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
  const intent = isIntent(obj.intent) ? obj.intent : undefined;
  if (!intent) return undefined;
  const dir =
    typeof obj.dir === "string" ? obj.dir.trim() : typeof obj.directory === "string" ? obj.directory.trim() : "";
  const dirSource = isDirSource(obj.dir_source)
    ? obj.dir_source
    : isDirSource(obj.dirSource)
      ? obj.dirSource
      : undefined;
  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 30) : "";
  const perm = isPerm(obj.perm) ? obj.perm : undefined;
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  const target = typeof obj.target === "string" ? obj.target.trim().slice(0, 200) : "";
  const question = typeof obj.question === "string" ? obj.question.trim().slice(0, 1000) : "";
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 200) : "";
  return {
    intent,
    ...(dir ? { directory: dir } : {}),
    ...(dirSource ? { dirSource } : {}),
    ...(title ? { title } : {}),
    ...(perm ? { perm } : {}),
    ...(model ? { model } : {}),
    ...(target ? { target } : {}),
    ...(question ? { question } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * 标题 → ASCII 目录 slug（小写、非字母数字转 `-`、截断 40）。
 * 中文标题（无 ASCII 字符）返回空串，由调用方改用允许根目录兜底。
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
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
