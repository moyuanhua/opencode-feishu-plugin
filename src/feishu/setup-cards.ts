/**
 * 建会话向导卡片构建与按钮 value 解析（P6，纯函数，可单测）。
 *
 * 按钮 value 约定（统一走 `wizard` 字段，与审批卡 `{t,d}` / 会话卡 `{cmd}` 区分）：
 * - 目录： `{ wizard: "dir", d: <path> }`
 * - 模型： `{ wizard: "model", p: <providerID>, m: <id>, n?: <name>, sid?: <sessionID> }`
 * - 权限： `{ wizard: "perm", v: <preset>, sid?: <sessionID> }`
 * - 分页： `{ wizard: "more", page: <n>, sid?: <sessionID> }`
 * - 确认： `{ wizard: "confirm" }`；取消：`{ wizard: "cancel" }`
 *
 * 带 `sid` 表示这是**已存在会话**的操作卡（话题内 `/model` `/perm`），点击后直接改该会话；
 * 不带 `sid` 表示**建会话向导**，点击后推进向导状态机。
 *
 * 卡片 JSON 2.0：按钮直放 `body.elements`，回调用 `behaviors`。
 */
import type { ModelRef, PermissionPreset } from "../types.js";
import { truncateCardContent } from "./cards.js";
import { PERMISSION_PRESETS, presetLabel, type PresetInfo } from "./perm-presets.js";
import { modelLabel } from "./models.js";

export interface ModelCardInput {
  /** 全量可用模型（用于「更多」分页）。 */
  readonly models: readonly ModelRef[];
  /** 最近使用（最新在前）。 */
  readonly recent: readonly ModelRef[];
  readonly current?: ModelRef;
  /** 0 = 最近/当前视图；>=1 = 全量分页。 */
  readonly page: number;
  readonly pageSize: number;
  readonly recentLimit: number;
  /** 已存在会话的操作卡（话题内）带 sid。 */
  readonly sid?: string;
}

export interface PermCardInput {
  readonly current?: PermissionPreset;
  readonly sid?: string;
}

export interface ConfirmCardInput {
  readonly title?: string;
  readonly dir?: string;
  readonly model?: ModelRef;
  readonly perm?: PermissionPreset;
}

export type SetupCardValue =
  | { readonly kind: "dir"; readonly dir: string }
  | { readonly kind: "model"; readonly model: ModelRef; readonly sid?: string }
  | { readonly kind: "perm"; readonly preset: PermissionPreset; readonly sid?: string }
  | { readonly kind: "more"; readonly page: number; readonly sid?: string }
  | { readonly kind: "confirm" }
  | { readonly kind: "cancel" }
  /** `/new` 首卡的「一次填完（表单）」按钮：把当前卡 patch 成表单卡。 */
  | { readonly kind: "form" };

/** 表单提交按钮 value 的标记（`cmd` 与审批卡/会话卡区分开）。 */
export const SETUP_FORM_CMD = "setup.form";
/** 表单容器 name（全局唯一）。 */
export const SETUP_FORM_NAME = "setup_form";
/** 表单内交互组件 name（全局唯一）。 */
export const SETUP_FORM_FIELDS = { dir: "dir", model: "model", perm: "perm", submit: "setup_submit" } as const;
/** 模型下拉最多展示的选项数（最近 + 常用）。 */
export const SETUP_FORM_MAX_MODELS = 15;
/** 表单默认权限档位（未显式选择时）。 */
export const SETUP_FORM_DEFAULT_PERM: PermissionPreset = "edit";

function button(text: string, type: "primary" | "default", value: Record<string, unknown>): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

function headerCard(title: string, template: string, elements: object[]): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { elements },
  };
}

function refKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}`;
}

/** 去重（按 provider/id）并保持顺序。 */
function dedupeRefs(refs: readonly ModelRef[]): ModelRef[] {
  const seen = new Set<string>();
  const out: ModelRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/** 目录选择卡：最近目录按钮 + 手动输入提示。 */
export function buildDirCard(input: { readonly recent: readonly string[]; readonly allowedRoots?: readonly string[] }): object {
  const recent = input.recent.slice(0, 10);
  const lines = ["请选择 OpenCode 会话的工作目录。", ""];
  if (input.allowedRoots && input.allowedRoots.length > 0) {
    lines.push(`允许的根目录：${input.allowedRoots.map((r) => `\`${r}\``).join("、")}`);
    lines.push("");
  }
  lines.push("✍️ **手动输入**：发送 `/dir <绝对路径>`（例如 `/dir /home/ubuntu/work/my-app`）。");
  if (recent.length > 0) {
    lines.push("", "**最近使用：**");
    recent.forEach((dir, i) => lines.push(`${i + 1}. \`${dir}\``));
  }
  const elements: object[] = [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }];
  elements.push(button("📝 一次填完（表单）", "default", { wizard: "form" }));
  for (const dir of recent) {
    elements.push(button(`📁 ${shorten(dir, 40)}`, "default", { wizard: "dir", d: dir }));
  }
  return headerCard("📁 选择工作目录", "blue", elements);
}

/** 模型选择卡：当前/最近按钮 + 「更多」分页 + 手动输入提示。 */
export function buildModelCard(input: ModelCardInput): object {
  const lines: string[] = [];
  if (input.current) lines.push(`当前模型：**${modelLabel(input.current)}**`);
  lines.push("✍️ **手动输入**：发送 `/model <关键词>`（例如 `/model claude`）。");
  const recent = dedupeRefs([...(input.current ? [input.current] : []), ...input.recent]).slice(
    0,
    Math.max(1, input.recentLimit),
  );

  const elements: object[] = [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }];
  const pageSize = Math.max(1, input.pageSize);

  if (input.page <= 0 && recent.length > 0) {
    for (const model of recent) {
      const isCurrent = input.current && refKey(input.current) === refKey(model);
      elements.push(button(`🧠 ${shorten(modelLabel(model), 30)}`, isCurrent ? "primary" : "default", modelValue(model, input.sid)));
    }
    if (input.models.length > recent.length) {
      elements.push(button("更多 ▸", "default", moreValue(1, input.sid)));
    }
  } else {
    const pageNum = input.page <= 0 ? 1 : input.page;
    const slice = input.models.slice((pageNum - 1) * pageSize, pageNum * pageSize);
    if (slice.length === 0 && recent.length > 0) {
      for (const model of recent) {
        elements.push(button(`🧠 ${shorten(modelLabel(model), 30)}`, "default", modelValue(model, input.sid)));
      }
    } else {
      for (const model of slice) {
        const isCurrent = input.current && refKey(input.current) === refKey(model);
        elements.push(
          button(`🧠 ${shorten(modelLabel(model), 30)}`, isCurrent ? "primary" : "default", modelValue(model, input.sid)),
        );
      }
      if (pageNum > 1) elements.push(button("◂ 上一页", "default", moreValue(pageNum - 1, input.sid)));
      if (pageNum * pageSize < input.models.length) {
        elements.push(button("下一页 ▸", "default", moreValue(pageNum + 1, input.sid)));
      }
    }
  }
  return headerCard("🧠 选择模型", "blue", elements);
}

/** 权限选择卡：四档按钮 + 每档一句话说明。 */
export function buildPermCard(input: PermCardInput): object {
  const lines = ["请选择权限档位（影响本会话的工具审批）：", ""];
  for (const info of PERMISSION_PRESETS) {
    const mark = input.current === info.id ? " ← 当前" : "";
    lines.push(`${info.icon} **${info.label}**：${info.description}${mark}`);
  }
  const elements: object[] = [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }];
  for (const info of PERMISSION_PRESETS) {
    elements.push(button(presetLabel(info.id), input.current === info.id ? "primary" : "default", permValue(info.id, input.sid)));
  }
  return headerCard("🔐 选择权限档位", "orange", elements);
}

/** 确认卡：目录/模型/权限汇总 + 创建/取消。 */
export function buildConfirmCard(input: ConfirmCardInput): object {
  const lines = [
    "**即将创建会话：**",
    `- 标题：${input.title?.trim() || "(默认时间戳)"}`,
    `- 目录：\`${input.dir ?? "(未选择)"}\``,
    `- 模型：${input.model ? modelLabel(input.model) : "(默认)"}`,
    `- 权限：${input.perm ? presetLabel(input.perm) : "(未选择)"}`,
    "",
    "确认后将自动为你开好一个话题，直接进话题干活。",
  ];
  return headerCard("✅ 确认创建会话", "green", [
    { tag: "markdown", content: truncateCardContent(lines.join("\n")) },
    button("✅ 创建", "primary", { wizard: "confirm" }),
    button("✖️ 取消", "default", { wizard: "cancel" }),
  ]);
}

/** 操作完成/取消后的小结果卡（无按钮）。 */
export function buildSetupDoneCard(title: string, lines: readonly string[], template = "grey"): object {
  return headerCard(title, template, [
    { tag: "markdown", content: truncateCardContent(lines.join("\n") || "(无)") },
  ]);
}

export interface SetupFormValuesInput {
  readonly dir?: string;
  readonly model?: ModelRef;
  readonly perm?: PermissionPreset;
}

export interface SetupFormCardInput {
  /** 可用模型（兜底选项来源）。 */
  readonly models: readonly ModelRef[];
  /** 最近使用模型（最新在前，优先展示）。 */
  readonly recent: readonly ModelRef[];
  /** 向导中已选模型 / 会话默认模型（`initial_option`）。 */
  readonly defaultModel?: ModelRef;
  readonly allowedRoots?: readonly string[];
  /** 校验失败时的错误说明（会保留 `values` 已填项）。 */
  readonly error?: string;
  /** 预填/回显值。 */
  readonly values?: SetupFormValuesInput;
}

/**
 * 建会话**表单卡**（P6.1，纯函数，JSON 2.0）。
 *
 * 官方结构硬要求（见 FEISHU_FORM_REQUIREMENTS.md）：
 * - `form` 容器放在 `body.elements` 根节点（不被其它组件嵌套）；
 * - 表单内交互组件 `name` 全局唯一，且至少一个带 `form_action_type:"submit"` 的按钮；
 * - 不出现 1.0 的 `tag:"action"` 容器。
 */
export function buildSetupFormCard(input: SetupFormCardInput): object {
  const values = input.values ?? {};
  const dirValue = values.dir ?? "";

  // 模型下拉：默认/已选 → 最近 → 常用，去重后 cap 到 ~15。
  const candidates = dedupeRefs([
    ...(input.defaultModel ? [input.defaultModel] : []),
    ...(values.model ? [values.model] : []),
    ...input.recent,
    ...input.models,
  ]);
  const defaultRef =
    values.model ??
    input.defaultModel ??
    candidates[0];
  const options = candidates.slice(0, SETUP_FORM_MAX_MODELS);
  if (defaultRef && !options.some((m) => refKey(m) === refKey(defaultRef))) {
    options.unshift(defaultRef);
    options.length = Math.min(options.length, SETUP_FORM_MAX_MODELS);
  }
  const modelOptions = options.map((m) => ({
    text: { tag: "plain_text", content: shorten(modelLabel(m), 80) },
    value: refKey(m),
  }));

  const permOptions = PERMISSION_PRESETS.map((info) => ({
    text: { tag: "plain_text", content: shorten(`${info.icon} ${info.label}：${info.description}`, 80) },
    value: info.id,
  }));

  const lines = ["一次填好，点「创建会话」即可自动开话题。"];
  if (input.allowedRoots && input.allowedRoots.length > 0) {
    lines.push("", `目录需为**绝对路径**且在允许范围内：${input.allowedRoots.map((r) => `\`${r}\``).join("、")}`);
  }

  const formElements: object[] = [];
  if (input.error) {
    formElements.push({ tag: "markdown", content: truncateCardContent(`⚠️ **提交失败**：${input.error}`) });
  }
  formElements.push(
    { tag: "markdown", content: truncateCardContent(lines.join("\n")) },
    {
      tag: "input",
      name: SETUP_FORM_FIELDS.dir,
      required: true,
      width: "fill",
      placeholder: {
        tag: "plain_text",
        content: "工作目录（绝对路径），例如 /home/ubuntu/work/my-app",
      },
      default_value: dirValue,
    },
    {
      tag: "select_static",
      name: SETUP_FORM_FIELDS.model,
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "选择模型（可选，默认继承当前）" },
      options: modelOptions,
      ...(defaultRef && options.some((m) => refKey(m) === refKey(defaultRef))
        ? { initial_option: refKey(defaultRef) }
        : {}),
    },
    {
      tag: "select_static",
      name: SETUP_FORM_FIELDS.perm,
      type: "default",
      width: "fill",
      placeholder: { tag: "plain_text", content: "选择权限档位" },
      options: permOptions,
      initial_option: values.perm ?? SETUP_FORM_DEFAULT_PERM,
    },
    {
      tag: "column_set",
      flex_mode: "none",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              name: SETUP_FORM_FIELDS.submit,
              type: "primary",
              text: { tag: "plain_text", content: "✅ 创建会话" },
              behaviors: [{ type: "callback", value: { cmd: SETUP_FORM_CMD } }],
              form_action_type: "submit",
            },
          ],
        },
      ],
    },
  );

  return headerCard("📝 一次填完建会话", "blue", [
    { tag: "form", name: SETUP_FORM_NAME, elements: formElements },
  ]);
}

/** 表单提交数据（已解析/收敛）。 */
export interface SetupFormSubmission {
  readonly dir: string;
  readonly model?: ModelRef;
  readonly perm?: PermissionPreset;
}

/**
 * 解析表单提交 `action.form_value`：`{ dir, model, perm }`。
 * - `model`：`providerID/modelID`（首个 `/` 切分）；
 * - `perm`：合法档位 key，否则忽略；
 * - 非法/空输入返回 `undefined`；结构合法但 `dir` 为空时返回 `{dir:""}` 交由上层报错。
 */
export function parseSetupFormValues(formValue: unknown): SetupFormSubmission | undefined {
  if (typeof formValue !== "object" || formValue === null || Array.isArray(formValue)) return undefined;
  const rec = formValue as Record<string, unknown>;
  const dir = typeof rec[SETUP_FORM_FIELDS.dir] === "string" ? (rec[SETUP_FORM_FIELDS.dir] as string).trim() : "";

  let model: ModelRef | undefined;
  const modelRaw = rec[SETUP_FORM_FIELDS.model];
  if (typeof modelRaw === "string") {
    const value = modelRaw.trim();
    const slash = value.indexOf("/");
    if (slash > 0 && slash < value.length - 1) {
      model = { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
    }
  }

  const permRaw = rec[SETUP_FORM_FIELDS.perm];
  const perm = isPreset(permRaw) ? permRaw : undefined;

  return { dir, ...(model ? { model } : {}), ...(perm ? { perm } : {}) };
}

/** 是否为建会话表单的提交回调标记（`value = {cmd:"setup.form"}`）。 */
export function isSetupFormAction(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).cmd === SETUP_FORM_CMD;
}

function modelValue(model: ModelRef, sid: string | undefined): Record<string, unknown> {
  return {
    wizard: "model",
    p: model.providerID,
    m: model.id,
    ...(model.name ? { n: model.name } : {}),
    ...(sid ? { sid } : {}),
  };
}

function moreValue(page: number, sid: string | undefined): Record<string, unknown> {
  return { wizard: "more", page, ...(sid ? { sid } : {}) };
}

function permValue(preset: PermissionPreset, sid: string | undefined): Record<string, unknown> {
  return { wizard: "perm", v: preset, ...(sid ? { sid } : {}) };
}

/** 解析向导/会话操作卡按钮 value；非本类卡片返回 undefined。 */
export function parseSetupCardValue(raw: unknown): SetupCardValue | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;

  let parsed: unknown = rec;
  if (typeof rec.value === "string") {
    try {
      parsed = JSON.parse(rec.value);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = parsed as Record<string, unknown>;

  const sid = typeof value.sid === "string" && value.sid ? value.sid : undefined;
  switch (value.wizard) {
    case "dir": {
      const dir = typeof value.d === "string" ? value.d : "";
      return dir ? { kind: "dir", dir } : undefined;
    }
    case "model": {
      const providerID = typeof value.p === "string" ? value.p : "";
      const id = typeof value.m === "string" ? value.m : "";
      if (!providerID || !id) return undefined;
      const name = typeof value.n === "string" && value.n ? value.n : undefined;
      return { kind: "model", model: { providerID, id, ...(name ? { name } : {}) }, ...(sid ? { sid } : {}) };
    }
    case "perm": {
      const preset = value.v;
      if (!isPreset(preset)) return undefined;
      return { kind: "perm", preset, ...(sid ? { sid } : {}) };
    }
    case "more": {
      const page = typeof value.page === "number" && Number.isFinite(value.page) ? Math.max(0, Math.floor(value.page)) : NaN;
      if (Number.isNaN(page)) return undefined;
      return { kind: "more", page, ...(sid ? { sid } : {}) };
    }
    case "confirm":
      return { kind: "confirm" };
    case "cancel":
      return { kind: "cancel" };
    case "form":
      return { kind: "form" };
    default:
      return undefined;
  }
}

function isPreset(value: unknown): value is PermissionPreset {
  return typeof value === "string" && PERMISSION_PRESETS.some((p) => p.id === value);
}

function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 供 SessionCommands 复用：权限档位说明（纯文本）。 */
export function presetDescription(info: PresetInfo): string {
  return `${info.icon} ${info.label}：${info.description}`;
}
