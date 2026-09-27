import { describe, expect, test } from "vitest";
import {
  TopicStatusMachine,
  computeTopicStatus,
  formatClock,
  topicStatusFooter,
  topicStatusMeta,
  topicStatusTitle,
  type TopicStatusView,
} from "../src/session/topic-status.js";
import { buildSessionRootCard } from "../src/feishu/session-cards.js";
import type { SessionRootCardBase } from "../src/types.js";

const NOW = new Date(2024, 0, 2, 12, 3).getTime();

function base(over: Partial<SessionRootCardBase> = {}): SessionRootCardBase {
  return {
    style: "resumed",
    sessionID: "ses_1",
    title: "我的项目",
    ...over,
  };
}

describe("computeTopicStatus（优先级：待审核 > 运行中 > 待回复 > 失败/中断 > 完成）", () => {
  test("待审核优先于运行中/排队/失败", () => {
    expect(
      computeTopicStatus({
        running: true,
        permissionPending: 1,
        queued: 3,
        terminal: "failed",
        reviewAction: "shell",
      }),
    ).toEqual({ kind: "review", reviewAction: "shell" });
  });

  test("运行中优先于待回复/失败", () => {
    expect(computeTopicStatus({ running: true, permissionPending: 0, queued: 2, terminal: "failed" })).toEqual({
      kind: "running",
    });
  });

  test("待回复优先于失败/中断", () => {
    expect(computeTopicStatus({ running: false, permissionPending: 0, queued: 2, terminal: "interrupted" })).toEqual({
      kind: "pending",
      queued: 2,
    });
  });

  test("失败/中断高于完成", () => {
    expect(computeTopicStatus({ running: false, permissionPending: 0, queued: 0, terminal: "failed" })).toEqual({
      kind: "failed",
    });
    expect(computeTopicStatus({ running: false, permissionPending: 0, queued: 0, terminal: "interrupted" })).toEqual({
      kind: "interrupted",
    });
  });

  test("空闲/成功终态 = 完成", () => {
    expect(computeTopicStatus({ running: false, permissionPending: 0, queued: 0, terminal: "done" })).toEqual({
      kind: "done",
    });
    expect(computeTopicStatus({ running: false, permissionPending: 0, queued: 0 })).toEqual({ kind: "done" });
  });
});

describe("TopicStatusMachine（事件 → 档位）", () => {
  test("execution.started → 运行中；重复 started 不再变化", () => {
    const m = new TopicStatusMachine();
    const first = m.reduce("s", { type: "session.execution.started", data: { sessionID: "s" } });
    expect(first?.view.kind).toBe("running");
    expect(first?.changed).toBe(true);
    const again = m.reduce("s", { type: "session.execution.started", data: { sessionID: "s" } });
    expect(again?.view.kind).toBe("running");
    expect(again?.changed).toBe(false);
  });

  test("permission.asked → 待审核（优先于运行中）；replied 后回到运行中", () => {
    const m = new TopicStatusMachine();
    m.reduce("s", { type: "session.execution.started", data: { sessionID: "s" } });
    const asked = m.reduce("s", {
      type: "permission.asked",
      data: { id: "p1", sessionID: "s", action: "shell" },
    });
    expect(asked?.view).toEqual({ kind: "review", reviewAction: "shell" });
    expect(asked?.changed).toBe(true);
    // 第二条待审核请求：档位不变（不应重复 patch）
    const asked2 = m.reduce("s", {
      type: "permission.asked",
      data: { id: "p2", sessionID: "s", action: "edit" },
    });
    expect(asked2?.changed).toBe(false);
    // 回复一条仍有待审核
    const replied1 = m.reduce("s", { type: "permission.replied", data: { sessionID: "s", requestID: "p1" } });
    expect(replied1?.view.kind).toBe("review");
    expect(replied1?.changed).toBe(false);
    // 全部回复 → 回到运行中
    const replied2 = m.reduce("s", { type: "permission.replied", data: { sessionID: "s", requestID: "p2" } });
    expect(replied2?.view.kind).toBe("running");
    expect(replied2?.changed).toBe(true);
  });

  test("inbox 排队数：enqueued/delivered/cancelled", () => {
    const m = new TopicStatusMachine();
    m.reduce("s", { type: "session.inbox.enqueued", data: { sessionID: "s", inboxID: "i1" } });
    m.reduce("s", { type: "session.inbox.enqueued", data: { sessionID: "s", inboxID: "i2" } });
    expect(m.view("s")).toEqual({ kind: "pending", queued: 2 });
    m.reduce("s", { type: "session.inbox.delivered", data: { sessionID: "s", inboxID: "i1" } });
    expect(m.view("s")).toEqual({ kind: "pending", queued: 1 });
    m.reduce("s", { type: "session.inbox.cancelled", data: { sessionID: "s", inboxID: "i2" } });
    expect(m.view("s")?.kind).toBe("done");
  });

  test("终态：succeeded/failed/interrupted 与 session.status busy/idle", () => {
    const m = new TopicStatusMachine();
    m.reduce("a", { type: "session.execution.started", data: { sessionID: "a" } });
    m.reduce("a", { type: "session.execution.succeeded", data: { sessionID: "a" } });
    expect(m.view("a")?.kind).toBe("done");

    m.reduce("b", { type: "session.execution.started", data: { sessionID: "b" } });
    m.reduce("b", { type: "session.execution.failed", data: { sessionID: "b" } });
    expect(m.view("b")?.kind).toBe("failed");

    m.reduce("c", { type: "session.execution.started", data: { sessionID: "c" } });
    m.reduce("c", { type: "session.execution.interrupted", data: { sessionID: "c", reason: "/stop" } });
    expect(m.view("c")?.kind).toBe("interrupted");

    const busy = m.reduce("d", { type: "session.status", data: { sessionID: "d", status: { type: "busy" } } });
    expect(busy?.view.kind).toBe("running");
    const idle = m.reduce("d", { type: "session.status", data: { sessionID: "d", status: { type: "idle" } } });
    expect(idle?.view.kind).toBe("done");
  });

  test("markTerminal 显式写入失败态", () => {
    const m = new TopicStatusMachine();
    m.reduce("s", { type: "session.execution.started", data: { sessionID: "s" } });
    const change = m.markTerminal("s", "failed");
    expect(change?.view.kind).toBe("failed");
    expect(change?.changed).toBe(true);
  });

  test("未识别事件不改状态", () => {
    const m = new TopicStatusMachine();
    expect(m.reduce("s", { type: "no.such.event", data: { sessionID: "s" } })).toBeUndefined();
    expect(m.view("s")).toBeUndefined();
  });
});

describe("状态渲染", () => {
  test("footer 文案", () => {
    expect(topicStatusFooter({ kind: "running" }, NOW)).toBe("🧠 运行中 · 12:03");
    expect(topicStatusFooter({ kind: "review", reviewAction: "shell" }, NOW)).toBe("🟡 待审核：shell");
    expect(topicStatusFooter({ kind: "review" }, NOW)).toBe("🟡 待审核");
    expect(topicStatusFooter({ kind: "pending", queued: 2 }, NOW)).toBe("⏳ 待回复（排队 2）");
    expect(topicStatusFooter({ kind: "done" }, NOW)).toBe("✅ 完成");
    expect(topicStatusFooter({ kind: "failed" }, NOW)).toBe("🔴 失败");
    expect(topicStatusFooter({ kind: "interrupted" }, NOW)).toBe("⏹ 已中断");
  });

  test("档位 → 颜色", () => {
    expect(topicStatusMeta("running").color).toBe("blue");
    expect(topicStatusMeta("review").color).toBe("orange");
    expect(topicStatusMeta("pending").color).toBe("grey");
    expect(topicStatusMeta("done").color).toBe("green");
    expect(topicStatusMeta("failed").color).toBe("red");
    expect(topicStatusMeta("interrupted").color).toBe("grey");
  });

  test("formatClock 补零", () => {
    expect(formatClock(new Date(2024, 0, 1, 9, 5).getTime())).toBe("09:05");
  });

  test("topicStatusTitle：默认不变；开关开启时加 emoji 前缀", () => {
    const view: TopicStatusView = { kind: "review" };
    expect(topicStatusTitle("🔄 会话", view, false)).toBe("🔄 会话");
    expect(topicStatusTitle("🔄 会话", view, true)).toBe("🟡 🔄 会话");
  });
});

describe("buildSessionRootCard（统一构建器 + 状态）", () => {
  test("颜色 + 页脚随状态变化；标题默认不变", () => {
    const card = buildSessionRootCard(base(), { kind: "running" }, { now: NOW }) as {
      header: { title: { content: string }; template: string };
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.header.template).toBe("blue");
    expect(card.header.title.content).toBe("🔄 我的项目");
    const text = JSON.stringify(card);
    expect(text).toContain("🧠 运行中 · 12:03");
  });

  test("topicStatusInTitle=true 时标题加状态前缀", () => {
    const card = buildSessionRootCard(base(), { kind: "failed" }, { now: NOW, statusInTitle: true }) as {
      header: { title: { content: string }; template: string };
    };
    expect(card.header.title.content).toBe("🔴 🔄 我的项目");
    expect(card.header.template).toBe("red");
  });

  test("摘要保留：用 base 重渲染后摘要仍在（状态刷新不丢摘要）", () => {
    const withSummary = base({ summary: "1. 目标\n2. 完成", summaryLabel: "会话摘要" });
    const card = buildSessionRootCard(withSummary, { kind: "done" }, { now: NOW });
    const text = JSON.stringify(card);
    expect(text).toContain("**会话摘要**");
    expect(text).toContain("1. 目标");
    expect(text).toContain("✅ 完成");
  });

  test("无 status：不渲染状态页脚、header 绿色（创建/旧卡片兼容）", () => {
    const card = buildSessionRootCard(base()) as {
      header: { template: string };
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.header.template).toBe("green");
    expect(card.body.elements).toHaveLength(1);
    expect(JSON.stringify(card)).not.toContain("运行中");
  });

  test("created 风格：标题 `✅ 已创建 · <主题>` + 状态页脚", () => {
    const card = buildSessionRootCard(
      base({ style: "created", title: "我的项目", perm: "可编辑" }),
      { kind: "done" },
      { now: NOW },
    ) as { header: { title: { content: string }; template: string } };
    expect(card.header.title.content).toBe("✅ 已创建 · 我的项目");
    expect(JSON.stringify(card)).toContain("✅ 完成");
    expect(JSON.stringify(card)).toContain("可编辑");
  });

  test("resumed 风格装配 compactButton 时状态刷新重签按钮", () => {
    const card = buildSessionRootCard(
      base({ compactButton: true }),
      { kind: "pending", queued: 1 },
      { now: NOW, compactToken: "tok" },
    );
    const text = JSON.stringify(card);
    expect(text).toContain("🗜 压缩并总结");
    expect(text).toContain("⏳ 待回复（排队 1）");
  });
});
