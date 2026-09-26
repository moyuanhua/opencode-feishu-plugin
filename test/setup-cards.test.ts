import { describe, expect, test } from "vitest";
import {
  buildConfirmCard,
  buildDirCard,
  buildModelCard,
  buildPermCard,
  buildSetupDoneCard,
  buildSetupFormCard,
  buildSetupFormDirOptions,
  isSetupFormAction,
  parseSetupCardValue,
  parseSetupFormValues,
  resolveSetupFormDir,
  SETUP_FORM_DIR_CUSTOM,
  SETUP_FORM_FIELDS,
  SETUP_FORM_MAX_MODELS,
  SETUP_FORM_NAME,
} from "../src/feishu/setup-cards.js";
import { MAX_CARD_BYTES } from "../src/feishu/cards.js";
import type { ModelRef } from "../src/types.js";

const json = (card: object): string => JSON.stringify(card);
const bodyElements = (card: object): Array<Record<string, unknown>> =>
  (card as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

const MODELS: ModelRef[] = Array.from({ length: 18 }, (_, i) => ({
  providerID: i % 2 === 0 ? "openai" : "anthropic",
  id: `model-${i}`,
  name: `模型 ${i}`,
}));

describe("buildDirCard", () => {
  test("最近目录按钮 + 手动输入提示 + allowedRoots + 表单入口", () => {
    const card = buildDirCard({ recent: ["/home/ubuntu/work/a", "/home/ubuntu/work/b"], allowedRoots: ["/home/ubuntu"] });
    expect(json(card)).toContain("手动输入");
    expect(json(card)).toContain("/dir");
    expect(json(card)).toContain("/home/ubuntu/work/a");
    expect(json(card)).toContain("允许的根目录");
    const buttons = bodyElements(card).filter((e) => e.tag === "button");
    // 「一次填完（表单）」+ 2 个最近目录
    expect(buttons.length).toBe(3);
    expect(json(card)).toContain("一次填完");
    expect(json(card)).toContain('"wizard":"form"');
    expect((card as { schema: string }).schema).toBe("2.0");
  });
});

describe("buildModelCard", () => {
  test("最近/当前视图：当前高亮 + 「更多」分页", () => {
    const card = buildModelCard({
      models: MODELS,
      recent: [MODELS[0]!, MODELS[1]!],
      current: MODELS[0]!,
      page: 0,
      pageSize: 4,
      recentLimit: 5,
    });
    const buttons = bodyElements(card).filter((e) => e.tag === "button");
    // 当前 + 最近去重后 2 个，加「更多」1 个
    expect(buttons.length).toBe(3);
    const more = buttons.find((b) => json(b).includes("更多"));
    expect(json(more!)).toContain('"page":1');
  });

  test("分页视图：上一页/下一页", () => {
    const card = buildModelCard({ models: MODELS, recent: [], page: 2, pageSize: 4, recentLimit: 5 });
    const text = json(card);
    expect(text).toContain("上一页");
    expect(text).toContain("下一页");
    expect(text).toContain("model-4");
  });

  test("带 sid 的按钮 value 编入 sid", () => {
    const card = buildModelCard({ models: MODELS, recent: [MODELS[0]!], page: 0, pageSize: 4, recentLimit: 5, sid: "ses_t" });
    expect(json(card)).toContain('"sid":"ses_t"');
  });

  test("大量模型 + 多页仍在 30KB 内", () => {
    const card = buildModelCard({ models: MODELS, recent: MODELS.slice(0, 5), page: 1, pageSize: 4, recentLimit: 5 });
    expect(Buffer.byteLength(json(card), "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });
});

describe("buildPermCard", () => {
  test("四档按钮 + 每档说明 + 当前高亮", () => {
    const card = buildPermCard({ current: "edit" });
    const buttons = bodyElements(card).filter((e) => e.tag === "button");
    expect(buttons.length).toBe(4);
    const text = json(card);
    for (const label of ["只读", "可编辑", "高风险审批", "完全信任"]) expect(text).toContain(label);
    const current = buttons.find((b) => (b.type as string) === "primary");
    expect(json(current!)).toContain("可编辑");
  });

  test("带 sid 的权限按钮", () => {
    const card = buildPermCard({ sid: "ses_t" });
    expect(json(card)).toContain('"sid":"ses_t"');
  });
});

describe("buildConfirmCard", () => {
  test("汇总目录/模型/权限 + 创建/取消", () => {
    const card = buildConfirmCard({
      title: "标题",
      dir: "/home/ubuntu/work/app",
      model: { providerID: "openai", id: "gpt-5", name: "GPT-5" },
      perm: "readonly",
    });
    const text = json(card);
    expect(text).toContain("/home/ubuntu/work/app");
    expect(text).toContain("GPT-5");
    expect(text).toContain("只读");
    const buttons = bodyElements(card).filter((e) => e.tag === "button");
    expect(buttons.length).toBe(2);
    expect(json(buttons[0]!)).toContain("confirm");
    expect(json(buttons[1]!)).toContain("cancel");
  });
});

describe("parseSetupCardValue", () => {
  test("dir / model / perm / more / confirm / cancel", () => {
    expect(parseSetupCardValue({ wizard: "dir", d: "/x" })).toEqual({ kind: "dir", dir: "/x" });
    expect(parseSetupCardValue({ wizard: "model", p: "p", m: "m", n: "N", sid: "s" })).toEqual({
      kind: "model",
      model: { providerID: "p", id: "m", name: "N" },
      sid: "s",
    });
    expect(parseSetupCardValue({ wizard: "perm", v: "trust" })).toEqual({ kind: "perm", preset: "trust" });
    expect(parseSetupCardValue({ wizard: "more", page: 3 })).toEqual({ kind: "more", page: 3 });
    expect(parseSetupCardValue({ wizard: "confirm" })).toEqual({ kind: "confirm" });
    expect(parseSetupCardValue({ wizard: "cancel" })).toEqual({ kind: "cancel" });
    expect(parseSetupCardValue({ wizard: "form" })).toEqual({ kind: "form" });
  });

  test("兼容 JSON 字符串 value，非法返回 undefined", () => {
    expect(parseSetupCardValue({ value: '{"wizard":"dir","d":"/y"}' })).toEqual({ kind: "dir", dir: "/y" });
    expect(parseSetupCardValue({ wizard: "perm", v: "bogus" })).toBeUndefined();
    expect(parseSetupCardValue({ wizard: "model", p: "", m: "m" })).toBeUndefined();
    expect(parseSetupCardValue({ wizard: "more", page: "x" })).toBeUndefined();
    expect(parseSetupCardValue({ t: "tok", d: "once" })).toBeUndefined();
    expect(parseSetupCardValue(null)).toBeUndefined();
  });
});

describe("buildSetupDoneCard", () => {
  test("结果卡无按钮", () => {
    const card = buildSetupDoneCard("✅ 完成", ["line"], "green");
    expect(json(card)).toContain("完成");
    expect(bodyElements(card).some((e) => e.tag === "button")).toBe(false);
  });
});

/** 递归收集表单内的组件（含 column_set/column 嵌套）。 */
function collectFormElements(elements: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const el of elements) {
    out.push(el);
    if (Array.isArray(el.elements)) out.push(...collectFormElements(el.elements as Record<string, unknown>[]));
    if (Array.isArray(el.columns)) {
      for (const col of el.columns as Record<string, unknown>[]) {
        if (Array.isArray(col.elements)) out.push(...collectFormElements(col.elements as Record<string, unknown>[]));
      }
    }
  }
  return out;
}

const formRoot = (card: object): Record<string, unknown> => bodyElements(card)[0]!;

describe("buildSetupFormCard（P6.1 表单卡）", () => {
  test("form 在 body.elements 根节点且为唯一顶层元素，schema 2.0 + update_multi", () => {
    const card = buildSetupFormCard({ models: MODELS, recent: MODELS.slice(0, 3), defaultModel: MODELS[0] });
    const roots = bodyElements(card);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.tag).toBe("form");
    expect(roots[0]!.name).toBe(SETUP_FORM_NAME);
    expect((card as { schema: string }).schema).toBe("2.0");
    expect((card as { config: { update_multi: boolean } }).config.update_multi).toBe(true);
  });

  test("交互组件 name 全局唯一 + input 可留空 + 提交按钮带提交行为", () => {
    const card = buildSetupFormCard({ models: MODELS, recent: MODELS.slice(0, 3) });
    const form = formRoot(card);
    const els = collectFormElements(form.elements as Record<string, unknown>[]);
    const names = els.map((e) => e.name).filter((n): n is string => typeof n === "string");
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(Object.values(SETUP_FORM_FIELDS)));

    const input = els.find((e) => e.tag === "input")!;
    // 目录留空 = 使用允许根目录，故不再必填。
    expect(input.required).toBe(false);
    expect(JSON.stringify(input)).toContain("留空");

    const submit = els.find((e) => e.form_action_type === "submit")!;
    expect(submit).toBeTruthy();
    expect(submit.tag).toBe("button");
    const behaviors = submit.behaviors as Array<{ type: string; value: { cmd: string } }>;
    expect(behaviors[0]!.type).toBe("callback");
    expect(behaviors[0]!.value.cmd).toBe("setup.form");
  });

  test("表单文案说明目录容错（留空=允许根目录；不存在自动创建）", () => {
    const card = buildSetupFormCard({ models: MODELS, recent: [], allowedRoots: ["/home/ubuntu"] });
    const text = json(card);
    expect(text).toContain("留空");
    expect(text).toContain("自动创建");
    expect(text).toContain("允许根目录");
  });

  test("不含 1.0 的 tag:action 容器", () => {
    expect(json(buildSetupFormCard({ models: MODELS, recent: [] }))).not.toContain('"tag":"action"');
  });

  test("模型下拉 cap 15 + initial_option 默认模型；权限四档 initial_option", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ providerID: "p", id: `m${i}`, name: `M${i}` }));
    const card = buildSetupFormCard({ models: many, recent: [], defaultModel: many[0] });
    const els = collectFormElements(formRoot(card).elements as Record<string, unknown>[]);
    const model = els.find((e) => e.tag === "select_static" && e.name === SETUP_FORM_FIELDS.model)!;
    const modelOptions = model.options as unknown[];
    expect(modelOptions.length).toBeLessThanOrEqual(SETUP_FORM_MAX_MODELS);
    expect(model.initial_option).toBe("p/m0");

    const perm = els.find((e) => e.tag === "select_static" && e.name === SETUP_FORM_FIELDS.perm)!;
    expect((perm.options as unknown[]).length).toBe(4);
    expect(perm.initial_option).toBe("edit");
  });

  test("错误说明 + 保留已填项（dir/perm）", () => {
    const card = buildSetupFormCard({
      models: MODELS,
      recent: [],
      error: "目录不在允许范围内。",
      values: { dir: "/bad/dir", perm: "trust" },
    });
    const text = json(card);
    expect(text).toContain("目录不在允许范围内");
    const els = collectFormElements(formRoot(card).elements as Record<string, unknown>[]);
    expect(els.find((e) => e.tag === "input")!.default_value).toBe("/bad/dir");
    expect(els.find((e) => e.name === SETUP_FORM_FIELDS.perm)!.initial_option).toBe("trust");
  });

  test("体积在 30KB 内", () => {
    const card = buildSetupFormCard({ models: MODELS, recent: MODELS.slice(0, 5), allowedRoots: ["/home/ubuntu"] });
    expect(Buffer.byteLength(json(card), "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });
});

/** 取表单卡里的目录下拉组件。 */
function dirSelectOf(card: object): Record<string, unknown> {
  const els = collectFormElements(formRoot(card).elements as Record<string, unknown>[]);
  return els.find((e) => e.tag === "select_static" && e.name === SETUP_FORM_FIELDS.dirSelect)!;
}
const dirOptionValues = (select: Record<string, unknown>): string[] =>
  (select.options as Array<{ value: string }>).map((o) => o.value);

describe("buildSetupFormCard 目录下拉（P6.3）", () => {
  const SUBDIRS = [
    { path: "/home/ubuntu/work/a", isRepo: false },
    { path: "/home/ubuntu/work/repo", isRepo: true },
  ];

  test("含 dir_select：手动输入 + 根目录 + 一级子目录（去重）", () => {
    const card = buildSetupFormCard({
      models: MODELS,
      recent: [],
      rootSubdirs: [...SUBDIRS, { path: "/home/ubuntu/work/a", isRepo: false }, { path: "/home/ubuntu", isRepo: false }],
      allowedRoots: ["/home/ubuntu"],
    });
    const select = dirSelectOf(card);
    expect(select.tag).toBe("select_static");
    const values = dirOptionValues(select);
    expect(values[0]).toBe(SETUP_FORM_DIR_CUSTOM);
    expect(values[1]).toBe("/home/ubuntu");
    expect(values).toEqual(
      expect.arrayContaining(["/home/ubuntu/work/a", "/home/ubuntu/work/repo", "/home/ubuntu"]),
    );
    // 去重：重复项只出现一次
    expect(values.filter((v) => v === "/home/ubuntu/work/a")).toHaveLength(1);
    expect(values.filter((v) => v === "/home/ubuntu")).toHaveLength(1);
    // 手动输入文案 + 根目录文案 + 仓库前缀
    expect(json(card)).toContain("✍️ 手动输入路径");
    expect(json(card)).toContain("🏠 /home/ubuntu（就用这个根目录）");
    expect(json(card)).toContain("📦 repo");
    // 默认选中「手动输入」（手填优先）
    expect(select.initial_option).toBe(SETUP_FORM_DIR_CUSTOM);
  });

  test("只保留第一个允许根目录", () => {
    const options = buildSetupFormDirOptions({
      subdirs: [],
      allowedRoots: ["/home/ubuntu", "/home/ubuntu/work"],
    });
    expect(options.map((o) => o.value)).toEqual([SETUP_FORM_DIR_CUSTOM, "/home/ubuntu"]);
  });

  test("扫描降级：无子目录时仍有 __custom__ + 根目录两项", () => {
    const options = buildSetupFormDirOptions({ subdirs: [], allowedRoots: ["/home/ubuntu"] });
    expect(options).toHaveLength(2);
    expect(options[0]!.value).toBe(SETUP_FORM_DIR_CUSTOM);
    expect(options[1]!.value).toBe("/home/ubuntu");
  });

  test("initial_option：状态目录命中子目录则选中它，否则 __custom__", () => {
    const hit = buildSetupFormCard({
      models: MODELS,
      recent: [],
      rootSubdirs: SUBDIRS,
      allowedRoots: ["/home/ubuntu"],
      values: { dir: "/home/ubuntu/work/a" },
    });
    const select = dirSelectOf(hit);
    expect(select.initial_option).toBe("/home/ubuntu/work/a");
    // 目录输入框仍回显
    const els = collectFormElements(formRoot(hit).elements as Record<string, unknown>[]);
    expect(els.find((e) => e.tag === "input")!.default_value).toBe("/home/ubuntu/work/a");

    const miss = buildSetupFormCard({
      models: MODELS,
      recent: [],
      rootSubdirs: SUBDIRS,
      allowedRoots: ["/home/ubuntu"],
      values: { dir: "/home/ubuntu/work/elsewhere" },
    });
    expect(dirSelectOf(miss).initial_option).toBe(SETUP_FORM_DIR_CUSTOM);
  });

  test("错误重渲染时仍保留目录下拉的 initial_option", () => {
    const card = buildSetupFormCard({
      models: MODELS,
      recent: [],
      rootSubdirs: SUBDIRS,
      allowedRoots: ["/home/ubuntu"],
      error: "目录不在允许范围内。",
      values: { dir: "/home/ubuntu/work/a" },
    });
    expect(dirSelectOf(card).initial_option).toBe("/home/ubuntu/work/a");
  });
});

describe("resolveSetupFormDir（提交目录优先级）", () => {
  test("下拉选中（≠__custom__）优先于文本输入", () => {
    expect(resolveSetupFormDir({ dir: "/typed", dirSelect: "/picked" }, ["/root"])).toBe("/picked");
  });

  test("__custom__ → 用文本输入；为空 → 允许根目录", () => {
    expect(resolveSetupFormDir({ dir: "/typed", dirSelect: SETUP_FORM_DIR_CUSTOM }, ["/root"])).toBe("/typed");
    expect(resolveSetupFormDir({ dir: "   ", dirSelect: SETUP_FORM_DIR_CUSTOM }, ["/home/ubuntu"])).toBe("/home/ubuntu");
    expect(resolveSetupFormDir({ dir: "" }, ["/home/ubuntu"])).toBe("/home/ubuntu");
  });

  test("无下拉且无输入且无允许根 → 空串", () => {
    expect(resolveSetupFormDir({ dir: "" }, [])).toBe("");
  });
});

describe("parseSetupFormValues / isSetupFormAction（P6.1）", () => {
  test("解析 dir / model(provider/id) / perm", () => {
    expect(parseSetupFormValues({ dir: " /home/ubuntu/work ", model: "anthropic/claude-sonnet-4", perm: "readonly" })).toEqual({
      dir: "/home/ubuntu/work",
      model: { providerID: "anthropic", id: "claude-sonnet-4" },
      perm: "readonly",
    });
  });

  test("解析 dir_select（下拉），不因存在而改变既有字段", () => {
    expect(parseSetupFormValues({ dir: "", dir_select: "/home/ubuntu/work/a", perm: "edit" })).toEqual({
      dir: "",
      dirSelect: "/home/ubuntu/work/a",
      perm: "edit",
    });
    expect(parseSetupFormValues({ dir: " /x ", dir_select: "__custom__" })).toEqual({ dir: "/x", dirSelect: "__custom__" });
    // 无 dir_select 时不带该字段（向后兼容旧卡片）
    expect(parseSetupFormValues({ dir: "/x" })).toEqual({ dir: "/x" });
  });

  test("非法 model / perm 被忽略；非对象返回 undefined", () => {
    expect(parseSetupFormValues({ dir: "/x", model: "no-slash", perm: "bogus" })).toEqual({ dir: "/x" });
    expect(parseSetupFormValues({ dir: "", model: "a/" })).toEqual({ dir: "" });
    expect(parseSetupFormValues(null)).toBeUndefined();
    expect(parseSetupFormValues([])).toBeUndefined();
    expect(parseSetupFormValues("x")).toBeUndefined();
  });

  test("isSetupFormAction 只认 {cmd:'setup.form'}", () => {
    expect(isSetupFormAction({ cmd: "setup.form" })).toBe(true);
    expect(isSetupFormAction({ wizard: "form" })).toBe(false);
    expect(isSetupFormAction({ cmd: "new" })).toBe(false);
    expect(isSetupFormAction(null)).toBe(false);
  });
});
