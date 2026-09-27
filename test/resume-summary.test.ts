import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import {
  RESUME_SUMMARY_PROMPT,
  buildTranscript,
  extractGeneratedText,
  extractLatestSummary,
  summarizeSession,
  SummaryTimeoutError,
  withTimeout,
} from "../src/session/resume-summary.js";

const log = createLogger({ level: "error", sink: () => undefined });

const compaction = (summary: string) => ({ type: "compaction", status: "completed", summary });

describe("extractLatestSummary", () => {
  test("取最近一条 compaction 的 summary（数组）", () => {
    expect(
      extractLatestSummary([
        compaction("旧的摘要"),
        { type: "assistant", content: [{ type: "text", text: "hi" }] },
        compaction("最新的摘要"),
      ]),
    ).toBe("最新的摘要");
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

  test("空/非法返回 undefined", () => {
    expect(buildTranscript([])).toBeUndefined();
    expect(buildTranscript(undefined)).toBeUndefined();
    expect(buildTranscript([{ type: "user", text: "" }])).toBeUndefined();
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

  test("复用已有 compaction 摘要：不调用生成", async () => {
    const generate = vi.fn(async () => ({ text: "不该被调用" }));
    const outcome = await summarizeSession(
      { log, readContext: async () => [compaction("已有摘要")], generate },
      input,
    );
    expect(outcome).toEqual({ summary: "已有摘要", source: "reused" });
    expect(generate).not.toHaveBeenCalled();
  });

  test("无已有摘要 → 走生成", async () => {
    const outcome = await summarizeSession(
      { log, readContext: async () => [{ type: "user", text: "x" }], generate: async (sid, prompt) => {
        expect(sid).toBe("ses_1");
        expect(prompt).toBe(RESUME_SUMMARY_PROMPT);
        return { text: "生成的摘要" };
      } },
      input,
    );
    expect(outcome).toEqual({ summary: "生成的摘要", source: "generated" });
  });

  test("无 readContext 直接生成", async () => {
    const outcome = await summarizeSession({ log, generate: async () => "纯文本摘要" }, input);
    expect(outcome).toEqual({ summary: "纯文本摘要", source: "generated" });
  });

  test("生成抛错 → source none + error", async () => {
    const outcome = await summarizeSession(
      { log, generate: async () => { throw new Error("boom"); } },
      input,
    );
    expect(outcome.source).toBe("none");
    expect(outcome.summary).toBeUndefined();
    expect(outcome.error).toContain("boom");
  });

  test("生成超时 → source none（不抛异常）", async () => {
    const outcome = await summarizeSession(
      {
        log,
        generate: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late" }), 200)),
      },
      { sessionID: "ses_1", timeoutMs: 10 },
    );
    expect(outcome.source).toBe("none");
    expect(outcome.summary).toBeUndefined();
  });

  test("读上下文抛错不阻断生成", async () => {
    const outcome = await summarizeSession(
      {
        log,
        readContext: async () => { throw new Error("read fail"); },
        generate: async () => ({ text: "仍然生成" }),
      },
      input,
    );
    expect(outcome).toEqual({ summary: "仍然生成", source: "generated" });
  });

  test("都没有可用依赖 → none", async () => {
    expect(await summarizeSession({ log }, input)).toEqual({ source: "none" });
  });
});

describe("withTimeout", () => {
  test("超时 reject SummaryTimeoutError；按时 resolve", async () => {
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toBeInstanceOf(SummaryTimeoutError);
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });
});
