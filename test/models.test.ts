import { describe, expect, test } from "vitest";
import {
  extractSessionModel,
  matchModel,
  modelLabel,
  modelMatchErrorText,
  normalizeModelList,
  sameModel,
  type ModelEntry,
} from "../src/feishu/models.js";

const rawModels = [
  { providerID: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4", enabled: true, time: { released: 200 } },
  { providerID: "openai", id: "gpt-5", name: "GPT-5", enabled: true, time: { released: 300 } },
  { providerID: "openai", id: "gpt-5-mini", name: "GPT-5 mini", enabled: true, time: { released: 250 } },
  { providerID: "openai", id: "hidden", name: "Hidden", enabled: false },
  { providerID: "", id: "bad", name: "Bad" },
];

describe("normalizeModelList", () => {
  test("兼容数组与 {data:[]}，过滤 disabled / 非法", () => {
    const arr = normalizeModelList(rawModels);
    expect(arr.map((m) => m.id)).toEqual(["claude-sonnet-4", "gpt-5", "gpt-5-mini"]);
    const wrapped = normalizeModelList({ data: rawModels });
    expect(wrapped).toHaveLength(3);
    expect(wrapped.find((m) => m.id === "gpt-5")?.released).toBe(300);
    expect(normalizeModelList(null)).toEqual([]);
    expect(normalizeModelList({ weird: true })).toEqual([]);
  });
});

const models: ModelEntry[] = normalizeModelList(rawModels);

describe("matchModel", () => {
  test("空查询 → empty", () => {
    expect(matchModel("  ", models)).toMatchObject({ ok: false, reason: "empty" });
  });

  test("provider/id 与 id 精确命中", () => {
    expect(matchModel("openai/gpt-5", models)).toMatchObject({ ok: true, model: { id: "gpt-5" } });
    expect(matchModel("claude-sonnet-4", models)).toMatchObject({ ok: true, model: { id: "claude-sonnet-4" } });
  });

  test("name 精确命中", () => {
    expect(matchModel("GPT-5", models)).toMatchObject({ ok: true, model: { id: "gpt-5" } });
  });

  test("模糊唯一命中", () => {
    expect(matchModel("claude", models)).toMatchObject({ ok: true, model: { id: "claude-sonnet-4" } });
  });

  test("模糊歧义 → 返回候选", () => {
    const result = matchModel("gpt", models);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.candidates.map((m) => m.id).sort()).toEqual(["gpt-5", "gpt-5-mini"]);
    }
  });

  test("无匹配", () => {
    expect(matchModel("zzz", models)).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("modelLabel / sameModel / 错误文案", () => {
  test("label 优先 name", () => {
    expect(modelLabel({ providerID: "p", id: "m", name: "Pretty" })).toBe("Pretty");
    expect(modelLabel({ providerID: "p", id: "m" })).toBe("p/m");
  });

  test("sameModel", () => {
    expect(sameModel({ providerID: "p", id: "m" }, { providerID: "p", id: "m" })).toBe(true);
    expect(sameModel({ providerID: "p", id: "m" }, { providerID: "p", id: "n" })).toBe(false);
    expect(sameModel(undefined, { providerID: "p", id: "m" })).toBe(false);
  });

  test("错误文案覆盖三类", () => {
    expect(modelMatchErrorText("empty", [])).toContain("/model");
    expect(modelMatchErrorText("not_found", [])).toContain("没有匹配");
    expect(modelMatchErrorText("ambiguous", [models[0]!])).toContain("多个");
  });
});

describe("extractSessionModel（读回校验）", () => {
  test("Session.Info（{model:{providerID,id}}）", () => {
    expect(extractSessionModel({ id: "ses_1", model: { providerID: "opencode-go", id: "glm-5.3-flash" } })).toEqual({
      providerID: "opencode-go",
      id: "glm-5.3-flash",
    });
  });

  test("直接 Model.Ref 也可解析", () => {
    expect(extractSessionModel({ providerID: "p", id: "m" })).toEqual({ providerID: "p", id: "m" });
  });

  test("缺失/非法返回 undefined", () => {
    expect(extractSessionModel(undefined)).toBeUndefined();
    expect(extractSessionModel({ id: "ses_1" })).toBeUndefined();
    expect(extractSessionModel({ model: { providerID: "p" } })).toBeUndefined();
    expect(extractSessionModel({ model: null })).toBeUndefined();
  });
});
