import { describe, expect, test } from "vitest";
import { buildQuickNewThinkingCard } from "../src/feishu/quick-new-cards.js";

describe("buildQuickNewThinkingCard", () => {
  test("占位卡：包含识别提示与卡片骨架", () => {
    const card = JSON.stringify(buildQuickNewThinkingCard());
    expect(card).toContain("正在识别");
    expect(card).toContain('"schema":"2.0"');
  });
});
