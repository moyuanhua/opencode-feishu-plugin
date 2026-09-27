import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import {
  RESUME_SUMMARY_PROMPT,
  TRANSCRIPT_LINE_LIMIT,
  buildSummaryPrompt,
  buildTranscript,
  extractGeneratedText,
  extractLatestSummary,
  summarizeSession,
  SummaryTimeoutError,
  withTimeout,
} from "../src/session/resume-summary.js";

const log = createLogger({ level: "error", sink: () => undefined });

const compaction = (summary: string, status = "completed") => ({ type: "compaction", status, summary });
const user = (text: string) => ({ type: "user", text });

describe("extractLatestSummary", () => {
  test("取最近一条 completed compaction 的 summary（数组）", () => {
    expect(
      extractLatestSummary([
        compaction("旧的摘要"),
        { type: "assistant", content: [{ type: "text", text: "hi" }] },
        compaction("最新的摘要"),
      ]),
    ).toBe("最新的摘要");
  });

  test("跳过 status != completed（running/failed 不作为摘要）", () => {
    expect(extractLatestSummary([compaction("完成的", "completed")])).toBe("完成的");
    expect(extractLatestSummary([compaction("进行中的", "running")])).toBeUndefined();
    expect(extractLatestSummary([compaction("失败的", "failed")])).toBeUndefined();
    // 最新的 running 被跳过，继续往前取最近的 completed。
    expect(extractLatestSummary([compaction("早先完成", "completed"), compaction("进行中", "running")])).toBe(
      "早先完成",
    );
  });

  test("缺 status 的旧形状视为不可用（只认 completed）", () => {
    expect(extractLatestSummary([{ type: "compaction", summary: "无状态" }])).toBeUndefined();
  });

  test("兼容 {data}/{messages}/{items} 包裹", () => {
    expect(extractLatestSummary({ data: [compaction("D")] })).toBe("D");
    expect(extractLatestSummary({ messages: [compaction("M")] })).toBe("M");
    expect(extractLatestSummary({ items: [compaction("I")] })).toBe("I");
  });

  test("无 compaction / 空 summary / 非法形状 → undefined", () => {
    expect(extractLatestSummary([{ type: "assistant" }])).toBeUndefined();
    expect(extractLatestSummary([compaction("   ")])).toBeUndefined();
    expect(extractLatestSummary(undefined)).toBeUndefined();
    expect(extractLatestSummary("x")).toBeUndefined();
  });
});

describe("buildTranscript", () => {
  test("拼接 user/assistant 文本，忽略 reasoning/tool", () => {
    const out = buildTranscript([
      { type: "user", text: "帮我改 bug" },
      { type: "assistant", content: [{ type: "reasoning", text: "想" }, { type: "text", text: "好的" }] },
      { type: "assistant", content: [{ type: "tool", name: "bash" }] },
    ]);
    expect(out).toContain("用户：帮我改 bug");
    expect(out).toContain("助手：好的");
    expect(out).not.toContain("想");
  });

  test("单条消息截断到 lineLimit（防止一条超大文本吃满预算）", () => {
    const out = buildTranscript([user("x".repeat(1000))], 6000, 50);
    expect(out).toBe(`用户：${"x".repeat(50)}`);
    expect(out!.length).toBeLessThanOrEqual(TRANSCRIPT_LINE_LIMIT + 3);
  });

  test("总量 ≤ limit，优先保留最近的记录", () => {
    const out = buildTranscript([user("旧的" + "a".repeat(200)), user("最新")], 30, 600);
    expect(Buffer.byteLength(out!, "utf8")).toBeLessThanOrEqual(30);
    expect(out).toContain("最新");
  });

  test("空/非法返回 undefined", () => {
    expect(buildTranscript([])).toBeUndefined();
    expect(buildTranscript(undefined)).toBeUndefined();
    expect(buildTranscript([{ type: "user", text: "" }])).toBeUndefined();
  });
});

describe("buildSummaryPrompt", () => {
  test("有转写 → 指令 + 会话最近记录；无转写 → 仅指令", () => {
    expect(buildSummaryPrompt(undefined)).toBe(RESUME_SUMMARY_PROMPT);
    expect(buildSummaryPrompt("用户：hi")).toContain(RESUME_SUMMARY_PROMPT);
    expect(buildSummaryPrompt("用户：hi")).toContain("用户：hi");
  });
});

describe("extractGeneratedText", () => {
  test("字符串 / {text} / {data:{text}}", () => {
    expect(extractGeneratedText("  摘要  ")).toBe("摘要");
    expect(extractGeneratedText({ text: "T" })).toBe("T");
    expect(extractGeneratedText({ data: { text: "D" } })).toBe("D");
    expect(extractGeneratedText({ foo: 1 })).toBeUndefined();
  });
});

describe("summarizeSession", () => {
  const input = { sessionID: "ses_1", timeoutMs: 1000 };

  test("复用已有 completed compaction 摘要：不调用生成", async () => {
    const generateText = vi.fn(async () => ({ text: "不该被调用" }));
    const outcome = await summarizeSession(
      { log, readMessages: async () => [compaction("已有摘要")], generateText },
      input,
    );
    expect(outcome).toEqual({ summary: "已有摘要", source: "reused" });
    expect(generateText).not.toHaveBeenCalled();
  });

  test("只有 running/failed compaction → 不复用，走快摘要", async () => {
    const generateText = vi.fn(async () => ({ text: "快摘要结果" }));
    const outcome = await summarizeSession(
      { log, readMessages: async () => [compaction("进行中", "running")], generateText },
      input,
    );
    expect(outcome).toEqual({ summary: "快摘要结果", source: "generated" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("快摘要：不喂整个会话，只喂精简转写；走临时生成（无会话上下文）", async () => {
    const big = [
      { type: "user", text: "帮我改 bug" },
      { type: "assistant", content: [{ type: "reasoning", text: "很长很长的思考" }, { type: "text", text: "好的" }] },
      { type: "user", text: "x".repeat(5000) },
    ];
    const generateText = vi.fn(async (prompt: string) => {
      // prompt 必须包含转写，且绝不含 reasoning。
      expect(prompt).toContain(RESUME_SUMMARY_PROMPT);
      expect(prompt).toContain("用户：帮我改 bug");
      expect(prompt).not.toContain("很长很长的思考");
      return { text: "生成的摘要" };
    });
    const outcome = await summarizeSession({ log, readMessages: async () => big, generateText }, input);
    expect(outcome).toEqual({ summary: "生成的摘要", source: "generated" });
    expect(generateText).toHaveBeenCalledTimes(1);
    // 第 3 条被截断，prompt 总量远小于整个会话。
    expect(generateText.mock.calls[0]![0].length).toBeLessThan(7000);
  });

  test("无 readMessages 直接走快摘要（只有指令）", async () => {
    const outcome = await summarizeSession(
      { log, generateText: async (prompt) => {
        expect(prompt).toBe(RESUME_SUMMARY_PROMPT);
        return "纯文本摘要";
      } },
      input,
    );
    expect(outcome).toEqual({ summary: "纯文本摘要", source: "generated" });
  });

  test("快摘要抛错 → source none + error", async () => {
    const outcome = await summarizeSession(
      { log, generateText: async () => { throw new Error("boom"); } },
      input,
    );
    expect(outcome.source).toBe("none");
    expect(outcome.summary).toBeUndefined();
    expect(outcome.error).toContain("boom");
  });

  test("快摘要超时 → source none（不抛异常）", async () => {
    const outcome = await summarizeSession(
      {
        log,
        generateText: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late" }), 200)),
      },
      { sessionID: "ses_1", timeoutMs: 10 },
    );
    expect(outcome.source).toBe("none");
    expect(outcome.summary).toBeUndefined();
  });

  test("读消息抛错不阻断快摘要", async () => {
    const outcome = await summarizeSession(
      {
        log,
        readMessages: async () => { throw new Error("read fail"); },
        generateText: async () => ({ text: "仍然生成" }),
      },
      input,
    );
    expect(outcome).toEqual({ summary: "仍然生成", source: "generated" });
  });

  test("都没有可用依赖 → none", async () => {
    expect(await summarizeSession({ log }, input)).toEqual({ source: "none" });
  });

  test("没有 session 级生成依赖：只会调用临时生成（deps 结构上不可能喂整个会话）", async () => {
    // SummarizeSessionDeps 刻意不暴露 session.generate —— 这里断言函数签名里没有该能力。
    const deps = { log, generateText: async () => "ok" };
    expect("generate" in deps).toBe(false);
    const outcome = await summarizeSession(deps, input);
    expect(outcome.source).toBe("generated");
  });
});

describe("withTimeout", () => {
  test("超时 reject SummaryTimeoutError；按时 resolve", async () => {
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toBeInstanceOf(SummaryTimeoutError);
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });
});
