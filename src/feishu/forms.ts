/**
 * OpenCode 表单（`form.created` / `question` 工具）→ 飞书卡片（纯函数，可单测）。
 *
 * 背景：agent 调用 `question` 工具（或其它 form 类交互）时，opencode 会创建一个
 * **pending form** 并阻塞当前执行，等待 `session.form.reply`。飞书侧若不转发，
 * 执行会永久卡住、后续消息全部排队。本模块负责把 form 渲染成可点击的飞书卡片，
 * 并把点击/文本答复归一化成 `Form.Answer`。
 *
 * 与飞书 SDK 解耦，保证可单测。
 */
import { MAX_CARD_BYTES, cardButton, truncateCardContent, type CardTemplate } from "./cards.js";

export type FormValue = string | number | boolean | string[];

export interface FormOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface FormField {
  readonly key: string;
  /** string | number | integer | boolean | multiselect | external（未知值按 string 处理）。 */
  readonly type: string;
  readonly title?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly hidden?: boolean;
  readonly options?: readonly FormOption[];
  /** true = 允许用户自填（不选选项）。 */
  readonly custom?: boolean;
  readonly default?: FormValue;
}

export interface FormLike {
  readonly id: string;
  readonly sessionID: string;
  readonly title: string;
  readonly metadata?: Record<string, unknown>;
  readonly fields: readonly FormField[];
}

/** 按钮回传值：`{ f: formID, k: fieldKey, v?: value, free?: true }`。 */
export interface FormActionValue {
  readonly f: string;
  readonly k: string;
  readonly v?: FormValue;
  readonly free?: boolean;
}

/** 表单提交按钮回传值：`{ f: formID, submit: true }`（输入框内容走 `action.form_value`）。 */
export interface FormSubmitAction {
  readonly f: string;
  readonly submit: true;
}

/** 表单容器 name（全局唯一；飞书要求 form 容器直挂 body.elements 根节点）。 */
export const FORM_CONTAINER_NAME = "opencode_form";
/** 提交按钮组件 name（尽量不与字段 key 冲突）。 */
export const FORM_SUBMIT_NAME = "__opencode_submit__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function asValue(value: unknown): FormValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) return value as string[];
  return undefined;
}

function normalizeOptions(value: unknown): FormOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: FormOption[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const v = asString(raw.value);
    if (!v) continue;
    out.push({
      value: v,
      label: asString(raw.label) || v,
      ...(asString(raw.description) ? { description: asString(raw.description) } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** 归一化 opencode form 载荷（容忍字段缺失，非法返回 undefined）。 */
export function normalizeForm(raw: unknown): FormLike | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asString(raw.id);
  const sessionID = asString(raw.sessionID);
  if (!id || !sessionID) return undefined;
  const fieldsRaw = Array.isArray(raw.fields) ? raw.fields : [];
  const fields: FormField[] = [];
  for (const f of fieldsRaw) {
    if (!isRecord(f)) continue;
    const key = asString(f.key);
    if (!key) continue;
    const options = normalizeOptions(f.options);
    const def = asValue(f.default);
    fields.push({
      key,
      type: asString(f.type) || "string",
      ...(asString(f.title) ? { title: asString(f.title) } : {}),
      ...(asString(f.description) ? { description: asString(f.description) } : {}),
      ...(f.required === true ? { required: true } : {}),
      ...(f.hidden === true ? { hidden: true } : {}),
      ...(options ? { options } : {}),
      ...(f.custom === true ? { custom: true } : {}),
      ...(def !== undefined ? { default: def } : {}),
    });
  }
  return {
    id,
    sessionID,
    title: asString(raw.title) || "需要你的确认",
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
    fields,
  };
}

/** 解析按钮点击 value；非表单按钮返回 undefined。 */
export function parseFormAction(raw: unknown): FormActionValue | undefined {
  if (!isRecord(raw)) return undefined;
  const f = asString(raw.f);
  const k = asString(raw.k);
  if (!f || !k) return undefined;
  if (raw.free === true) return { f, k, free: true };
  if (!("v" in raw)) return undefined;
  const v = asValue(raw.v);
  if (v === undefined) return undefined;
  return { f, k, v };
}

export function isFormAction(raw: unknown): boolean {
  return parseFormAction(raw) !== undefined;
}

/** 解析表单提交按钮 value（`{ f, submit: true }`）；非提交按钮返回 undefined。 */
export function parseFormSubmit(raw: unknown): FormSubmitAction | undefined {
  if (!isRecord(raw)) return undefined;
  const f = asString(raw.f);
  if (!f || raw.submit !== true) return undefined;
  return { f, submit: true };
}

/** 尚未回答的字段 key（忽略 hidden）。 */
export function missingFields(form: FormLike, answers: Readonly<Record<string, FormValue>>): string[] {
  return form.fields
    .filter((f) => f.hidden !== true && answers[f.key] === undefined)
    .map((f) => f.key);
}

export function isComplete(form: FormLike, answers: Readonly<Record<string, FormValue>>): boolean {
  const visible = form.fields.filter((f) => f.hidden !== true);
  if (visible.length === 0) return true;
  return missingFields(form, answers).length === 0;
}

function fieldTitle(field: FormField): string {
  return field.title?.trim() || field.key;
}

function isQuestion(form: FormLike): boolean {
  return form.metadata?.kind === "question";
}

function headerFor(form: FormLike): { text: string; template: CardTemplate } {
  return isQuestion(form)
    ? { text: "❓ OpenCode 提问", template: "purple" }
    : { text: "📝 OpenCode 需要确认", template: "blue" };
}

function answerLabel(field: FormField, value: FormValue): string {
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  const opt = field.options?.find((o) => o.value === String(value));
  return opt?.label ?? String(value);
}

/** 该字段是否接受自由文本（无选项且非布尔，或允许自填）。 */
function fieldAllowsInput(field: FormField): boolean {
  if (field.type === "boolean") return false;
  return (field.options?.length ?? 0) === 0 || field.custom === true;
}

function inputPlaceholder(field: FormField): string {
  if ((field.options?.length ?? 0) > 0) return "✍️ 或在此填写自定义答案";
  return field.description?.trim() || `输入「${fieldTitle(field)}」`;
}

/**
 * 渲染待回答表单卡：
 * - **选项 / 布尔字段**：一块说明 + 选项按钮（点击即回填，可跨轮次作答）；
 * - **可自由输入字段**：卡片内**直接渲染输入框**（不再让用户到话题里发文字），底部「✅ 提交」一次提交；
 *   同时仍兼容「直接在话题里发文字作答」（`FormRelay.consumeText`）。
 * 已选中的选项加 ✅ 前缀；多字段未填完时提示还差哪些。
 */
export function buildFormCard(
  form: FormLike,
  answers: Readonly<Record<string, FormValue>>,
  opts: { readonly notice?: string } = {},
): object {
  const top: object[] = [];
  /** 需要放进 form 容器的元素（输入框 + 纯文本字段的标题）。 */
  const inputs: object[] = [];
  const visible = form.fields.filter((f) => f.hidden !== true);

  if (visible.length === 0) {
    top.push({ tag: "markdown", content: truncateCardContent("（表单无字段）") });
  }

  for (const field of visible) {
    const value = answers[field.key];
    const hasOptions = (field.options?.length ?? 0) > 0;
    const lines: string[] = [`**${fieldTitle(field)}**`];
    if (field.description) lines.push(field.description);

    if (!hasOptions && field.type !== "boolean") {
      // 纯自由文本字段：标题 + 输入框，整块放进表单容器。
      if (value !== undefined) lines.push(`✅ 已填：**${answerLabel(field, value)}**`);
      inputs.push({ tag: "markdown", content: truncateCardContent(lines.join("\n")) });
      inputs.push({
        tag: "input",
        name: field.key,
        required: false,
        width: "fill",
        placeholder: { tag: "plain_text", content: inputPlaceholder(field) },
        ...(typeof value === "string" && value ? { default_value: value } : {}),
      });
      continue;
    }

    // 选项 / 布尔字段：说明 + 按钮（点击即回填，不必等提交）。
    if (value !== undefined) lines.push(`✅ 已选：**${answerLabel(field, value)}**`);
    top.push({ tag: "markdown", content: truncateCardContent(lines.join("\n")) });

    for (const opt of field.options ?? []) {
      const selected = value !== undefined && answerLabel(field, value) === opt.label;
      const label = `${selected ? "✅ " : ""}${opt.label}`;
      top.push(cardButton(label, selected ? "primary" : "default", { f: form.id, k: field.key, v: opt.value }));
    }
    if (field.type === "boolean") {
      for (const b of [true, false]) {
        const selected = value === b;
        top.push(
          cardButton(`${selected ? "✅ " : ""}${b ? "是" : "否"}`, selected ? "primary" : "default", {
            f: form.id,
            k: field.key,
            v: b,
          }),
        );
      }
    }
    // 有选项 + 允许自填 → 额外给一个输入框（放进表单容器）。
    if (fieldAllowsInput(field)) {
      inputs.push({
        tag: "input",
        name: field.key,
        required: false,
        width: "fill",
        placeholder: { tag: "plain_text", content: inputPlaceholder(field) },
        ...(typeof value === "string" && value ? { default_value: value } : {}),
      });
    }
  }

  const missingKeys = missingFields(form, answers);
  const missing = missingKeys.map((k) => {
    const f = form.fields.find((x) => x.key === k);
    return f ? fieldTitle(f) : k;
  });
  // 剩余字段是否全是「纯选项题」（有选项且不允许自填）→ 提示要点选项/序号。
  const optionOnly =
    missingKeys.length > 0 &&
    missingKeys.every((k) => {
      const f = form.fields.find((x) => x.key === k);
      return (f?.options?.length ?? 0) > 0 && f?.custom !== true;
    });
  const hints: string[] = [];
  if (opts.notice) hints.push(opts.notice);
  if (missing.length > 0 && visible.length > 1) {
    hints.push(`还需回答：${missing.join("、")}${optionOnly ? "（点选项或回复序号）" : "（在输入框作答）"}`);
  } else if (missing.length > 0) {
    hints.push(
      optionOnly
        ? "请点击上方选项（或回复序号，如 1）；发送其它内容会作为普通消息处理。"
        : "在下方输入框作答后点「✅ 提交」即可（也可直接在话题里发文字回答）。",
    );
  }

  const body: object[] = [
    ...top,
    ...hints.map((h) => ({ tag: "markdown", content: truncateCardContent(h) })),
  ];
  if (inputs.length > 0) {
    body.push({
      tag: "form",
      name: FORM_CONTAINER_NAME,
      elements: [
        ...inputs,
        {
          tag: "button",
          name: FORM_SUBMIT_NAME,
          type: "primary",
          form_action_type: "submit",
          text: { tag: "plain_text", content: "✅ 提交" },
          behaviors: [{ type: "callback", value: { f: form.id, submit: true } }],
        },
      ],
    });
  }

  const header = headerFor(form);
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: header.text }, template: header.template },
    body: { elements: body.slice(0, 80) },
  };
}

export type FormOutcome = "answered" | "cancelled" | "error";

/** 表单被回答 / 取消 / 提交失败后的结果卡（无按钮）。 */
export function buildFormResolvedCard(
  form: FormLike,
  answers: Readonly<Record<string, FormValue>>,
  outcome: FormOutcome,
  error?: string,
): object {
  const map: Record<FormOutcome, { label: string; template: CardTemplate }> = {
    answered: { label: "✅ 已提交", template: "green" },
    cancelled: { label: "✖️ 已取消", template: "grey" },
    error: { label: "❌ 提交失败", template: "red" },
  };
  const { label, template } = map[outcome];

  const lines: string[] = [`**${form.title}**`];
  for (const field of form.fields) {
    if (field.hidden === true) continue;
    const value = answers[field.key];
    if (value === undefined) continue;
    lines.push(`- ${fieldTitle(field)}：**${answerLabel(field, value)}**`);
  }
  if (outcome === "error" && error) lines.push("", `错误：${error}`);

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: label }, template },
    body: { elements: [{ tag: "markdown", content: truncateCardContent(lines.join("\n")) }] },
  };
}

/** 卡片体积上限（供调用方断言/测试）。 */
export { MAX_CARD_BYTES };
