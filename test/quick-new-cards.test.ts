import { describe, expect, test } from "vitest";
import {
  buildQuickNewProposalCard,
  buildQuickNewResolvedCard,
  buildQuickNewThinkingCard,
  parseQuickNewActionValue,
} from "../src/feishu/quick-new-cards.js";

describe("buildQuickNewProposalCard", () => {
  test("包含标题/目录/摘要与 创建/取消 两个按钮（value 带 id）", () => {
    const card = JSON.stringify(
      buildQuickNewProposalCard({
        id: "qn_om_1",
        title: "修下载 bug",
        directory: "/Users/code/zlib",
        textPreview: "帮我修一下下载的 bug\n第二行",
        reason: "消息提到下载 bug",
      }),
    );
    expect(card).toContain("建议新建会话");
    expect(card).toContain("修下载 bug");
    expect(card).toContain("/Users/code/zlib");
    expect(card).toContain("帮我修一下下载的 bug");
    expect(card).toContain("依据");
    expect(card).toContain('"cmd":"quicknew"');
    expect(card).toContain('"op":"create"');
    expect(card).toContain('"op":"cancel"');
    expect(card).toContain('"id":"qn_om_1"');
  });

  test("无 reason 时不渲染依据行；预览压平换行", () => {
    const card = JSON.stringify(
      buildQuickNewProposalCard({
        id: "qn_2",
        title: "t",
        directory: "/a",
        textPreview: "第一行\n\n第二行",
      }),
    );
    expect(card).not.toContain("依据");
    expect(card).toContain("第一行 第二行");
  });
});

describe("构建器与解析器", () => {
  test("thinking / resolved 卡可构建", () => {
    expect(JSON.stringify(buildQuickNewThinkingCard())).toContain("正在识别意图");
    expect(JSON.stringify(buildQuickNewResolvedCard("✅ 已创建", "目录 /a", "green"))).toContain("已创建");
  });

  test("parseQuickNewActionValue：create/cancel 合法，其余非法", () => {
    expect(parseQuickNewActionValue({ cmd: "quicknew", op: "create", id: "x" })).toEqual({
      op: "create",
      id: "x",
    });
    expect(parseQuickNewActionValue({ cmd: "quicknew", op: "cancel", id: " y " })).toEqual({
      op: "cancel",
      id: "y",
    });
    expect(parseQuickNewActionValue({ cmd: "other", op: "create", id: "x" })).toBeUndefined();
    expect(parseQuickNewActionValue({ cmd: "quicknew", op: "delete", id: "x" })).toBeUndefined();
    expect(parseQuickNewActionValue({ cmd: "quicknew", op: "create" })).toBeUndefined();
    expect(parseQuickNewActionValue(null)).toBeUndefined();
    expect(parseQuickNewActionValue([1])).toBeUndefined();
  });
});
