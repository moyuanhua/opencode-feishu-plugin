import { describe, expect, test } from "vitest";
import {
  buildFormCard,
  buildFormResolvedCard,
  isComplete,
  isFormAction,
  missingFields,
  normalizeForm,
  parseFormAction,
  parseFormSubmit,
  type FormLike,
} from "../src/feishu/forms.js";

const QUESTION: FormLike = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    {
      key: "q0",
      type: "string",
      title: "继续找的方向",
      description: "选一个",
      options: [
        { value: "a", label: "新开一轮 (推荐)" },
        { value: "b", label: "深挖 Top5" },
      ],
      custom: true,
    },
  ],
};

function elements(card: object): Array<Record<string, unknown>> {
  return (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
}

describe("normalizeForm", () => {
  test("保留字段并过滤非法项", () => {
    const form = normalizeForm({
      id: "frm_1",
      sessionID: "ses_1",
      title: "T",
      metadata: { kind: "question" },
      fields: [
        { key: "q0", type: "string", options: [{ value: "a", label: "A" }, { value: "", label: "x" }] },
        { type: "string" },
      ],
    });
    expect(form).toBeDefined();
    expect(form!.fields).toHaveLength(1);
    expect(form!.fields[0]!.options).toEqual([{ value: "a", label: "A" }]);
    expect(form!.metadata).toEqual({ kind: "question" });
  });

  test("缺 id/sessionID 返回 undefined", () => {
    expect(normalizeForm({ id: "frm_1" })).toBeUndefined();
    expect(normalizeForm(null)).toBeUndefined();
  });
});

describe("parseFormAction", () => {
  test("解析选项点击", () => {
    expect(parseFormAction({ f: "frm_1", k: "q0", v: "a" })).toEqual({ f: "frm_1", k: "q0", v: "a" });
  });
  test("解析自由文本按钮", () => {
    expect(parseFormAction({ f: "frm_1", k: "q0", free: true })).toEqual({ f: "frm_1", k: "q0", free: true });
  });
  test("非表单/非法 value 返回 undefined", () => {
    expect(parseFormAction({ cmd: "x" })).toBeUndefined();
    expect(parseFormAction({ f: "frm_1", k: "q0" })).toBeUndefined();
    expect(isFormAction({ f: "frm_1", k: "q0", v: {} })).toBe(false);
  });
});

describe("parseFormSubmit", () => {
  test("解析提交按钮 value", () => {
    expect(parseFormSubmit({ f: "frm_1", submit: true })).toEqual({ f: "frm_1", submit: true });
  });
  test("非提交按钮返回 undefined", () => {
    expect(parseFormSubmit({ f: "frm_1", k: "q0", v: "a" })).toBeUndefined();
    expect(parseFormSubmit({ f: "frm_1" })).toBeUndefined();
    expect(parseFormSubmit({ submit: true })).toBeUndefined();
    expect(parseFormSubmit(null)).toBeUndefined();
  });
});

describe("missingFields / isComplete", () => {
  test("单字段未答 → 未完成", () => {
    expect(missingFields(QUESTION, {})).toEqual(["q0"]);
    expect(isComplete(QUESTION, {})).toBe(false);
  });
  test("答完 → 完成", () => {
    expect(isComplete(QUESTION, { q0: "a" })).toBe(true);
  });
  test("hidden 字段不计入", () => {
    const form: FormLike = { ...QUESTION, fields: [{ key: "h", type: "string", hidden: true }] };
    expect(isComplete(form, {})).toBe(true);
  });
});

describe("buildFormCard", () => {
  test("question 表头 + 选项按钮（submit 在 form 容器内）", () => {
    const card = buildFormCard(QUESTION, {});
    const els = elements(card);
    expect(JSON.stringify((card as { header: unknown }).header)).toContain("提问");
    const buttons = els.filter((e) => e.tag === "button");
    expect(buttons).toHaveLength(2); // 2 选项（提交按钮在 form 容器内）
    expect(buttons[0]!.behaviors).toEqual([{ type: "callback", value: { f: "frm_1", k: "q0", v: "a" } }]);
    // 有选项 + custom=true → 额外给输入框 + 提交按钮（放进 form 容器）。
    const form = els.find((e) => e.tag === "form") as { elements: Array<Record<string, unknown>> } | undefined;
    expect(form).toBeDefined();
    const input = form!.elements.find((e) => e.tag === "input") as { name: string } | undefined;
    expect(input?.name).toBe("q0");
    const submit = form!.elements.find((e) => e.tag === "button") as
      | { form_action_type: string; behaviors: Array<{ value: unknown }> }
      | undefined;
    expect(submit?.form_action_type).toBe("submit");
    expect(submit?.behaviors).toEqual([{ type: "callback", value: { f: "frm_1", submit: true } }]);
  });

  test("纯文本字段：直接渲染输入框，不再有「直接回复答案」按钮", () => {
    const form: FormLike = {
      ...QUESTION,
      fields: [{ key: "note", type: "string", title: "备注", description: "写点什么" }],
    };
    const card = buildFormCard(form, {});
    expect(JSON.stringify(card)).not.toContain("直接回复答案");
    const els = elements(card);
    const formEl = els.find((e) => e.tag === "form") as { elements: Array<Record<string, unknown>> } | undefined;
    expect(formEl).toBeDefined();
    const input = formEl!.elements.find((e) => e.tag === "input") as
      | { name: string; placeholder: { content: string } }
      | undefined;
    expect(input?.name).toBe("note");
    expect(input?.placeholder.content).toBe("写点什么");
  });

  test("已选选项加 ✅ 并高亮", () => {
    const card = buildFormCard(QUESTION, { q0: "b" });
    const buttons = elements(card).filter((e) => e.tag === "button");
    expect((buttons[1]!.text as { content: string }).content).toContain("✅");
    expect(buttons[1]!.type).toBe("primary");
  });

  test("boolean 字段渲染是/否按钮", () => {
    const form: FormLike = { ...QUESTION, fields: [{ key: "ok", type: "boolean", title: "确认？" }] };
    const buttons = elements(buildFormCard(form, {})).filter((e) => e.tag === "button");
    const values = buttons.map((b) => (b.behaviors as Array<{ value: unknown }>)[0]!.value);
    expect(values).toContainEqual({ f: "frm_1", k: "ok", v: true });
    expect(values).toContainEqual({ f: "frm_1", k: "ok", v: false });
    // 纯布尔字段不需要输入框 → 无 form 容器
    expect(elements(buildFormCard(form, {})).some((e) => e.tag === "form")).toBe(false);
  });
});

describe("buildFormResolvedCard", () => {
  test("answered 绿色并回显答案 label", () => {
    const card = buildFormResolvedCard(QUESTION, { q0: "a" }, "answered");
    expect((card as { header: { template: string } }).header.template).toBe("green");
    expect(JSON.stringify(card)).toContain("新开一轮 (推荐)");
  });
  test("cancelled 灰色", () => {
    expect((buildFormResolvedCard(QUESTION, {}, "cancelled") as { header: { template: string } }).header.template).toBe("grey");
  });
});
