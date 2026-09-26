import { describe, expect, test } from "vitest";
import {
  buildConfirmCard,
  buildDirCard,
  buildModelCard,
  buildPermCard,
  buildSetupDoneCard,
  parseSetupCardValue,
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
  test("最近目录按钮 + 手动输入提示 + allowedRoots", () => {
    const card = buildDirCard({ recent: ["/home/ubuntu/work/a", "/home/ubuntu/work/b"], allowedRoots: ["/home/ubuntu"] });
    expect(json(card)).toContain("手动输入");
    expect(json(card)).toContain("/dir");
    expect(json(card)).toContain("/home/ubuntu/work/a");
    expect(json(card)).toContain("允许的根目录");
    const buttons = bodyElements(card).filter((e) => e.tag === "button");
    expect(buttons.length).toBe(2);
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
