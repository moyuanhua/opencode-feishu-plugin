import { describe, expect, test } from "vitest";
import {
  buildApprovalCard,
  buildConsoleHintCard,
  buildResolvedCard,
  buildStreamingCard,
  MAX_CARD_BYTES,
  truncateCardContent,
} from "../src/feishu/cards.js";

const baseInput = {
  requestID: "per_1",
  sessionID: "ses_1",
  action: "bash",
  resources: ["rm -rf /tmp/x", "another"],
  canPersistAlways: true,
  token: "tok-123",
  maxResourcesShown: 8,
};

describe("buildApprovalCard", () => {
  test("2.0 结构 + update_multi + 三个按钮", () => {
    const card = buildApprovalCard(baseInput) as Record<string, unknown>;
    expect(card.schema).toBe("2.0");
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
    const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const buttons = elements.filter((e) => e.tag === "button");
    expect(buttons).toHaveLength(3);
    const values = buttons.map((b) => (b.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value);
    expect(values.map((v) => v.d)).toEqual(["once", "always", "reject"]);
    for (const v of values) expect(v.t).toBe("tok-123");
  });

  test("无 save 时提示 always 等价 once，且拒绝含级联警示", () => {
    const card = JSON.stringify(buildApprovalCard({ ...baseInput, canPersistAlways: false }));
    expect(card).toContain("等价");
    expect(card).toContain("其他待批");
  });

  test("超过 maxResourcesShown 时省略", () => {
    const resources = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const card = JSON.stringify(buildApprovalCard({ ...baseInput, resources, maxResourcesShown: 3 }));
    expect(card).toContain("r2");
    expect(card).not.toContain("r3");
    expect(card).toContain("另有 9 项");
  });
});

describe("buildResolvedCard", () => {
  test("拒绝为红色，允许为绿色，且无按钮", () => {
    const rejected = buildResolvedCard(baseInput, { reply: "reject", operatorOpenId: "ou_1", at: 0 }) as Record<string, unknown>;
    expect((rejected.header as Record<string, unknown>).template).toBe("red");
    expect(JSON.stringify(rejected)).not.toContain('"tag":"button"');

    const allowed = buildResolvedCard(baseInput, { reply: "always", operatorOpenId: "ou_1", at: 0 }) as Record<string, unknown>;
    expect((allowed.header as Record<string, unknown>).template).toBe("green");
  });
});

describe("buildStreamingCard", () => {
  test("空内容显示思考占位", () => {
    const card = JSON.stringify(buildStreamingCard(""));
    expect(card).toContain("正在思考");
  });
});

describe("buildConsoleHintCard", () => {
  test("管理台提示卡：JSON 2.0 + 无按钮 + 指向 /new 与 /sessions", () => {
    const card = buildConsoleHintCard() as Record<string, unknown>;
    expect(card.schema).toBe("2.0");
    expect((card.config as Record<string, unknown>).update_multi).toBe(true);
    const text = JSON.stringify(card);
    expect(text).toContain("/new");
    expect(text).toContain("/sessions");
    expect(text).not.toContain('"tag":"button"');
  });
});

describe("truncateCardContent", () => {
  test("短内容原样返回", () => {
    expect(truncateCardContent("hello")).toBe("hello");
  });

  test("超长内容截断到上限内并闭合代码围栏", () => {
    const text = "```\n" + "a".repeat(200_000);
    const out = truncateCardContent(text);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(out).toContain("已截断");
    const fences = out.match(/```/g) ?? [];
    expect(fences.length % 2).toBe(0);
  });
});
