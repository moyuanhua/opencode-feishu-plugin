import { describe, expect, test } from "vitest";
import {
  QUICK_NEW_INSTRUCTION,
  buildQuickNewPrompt,
  matchCandidateDirectory,
  parseQuickNewDecision,
} from "../src/session/quick-new.js";

describe("buildQuickNewPrompt", () => {
  test("包含候选目录（含标题线索）与用户消息", () => {
    const prompt = buildQuickNewPrompt("帮我修 zlib 的 bug", [
      { path: "/Users/code/zlib", label: "zlib 下载任务" },
      { path: "/Users/code/wps/opencode-feishu-plugin" },
    ]);
    expect(prompt).toContain(QUICK_NEW_INSTRUCTION);
    expect(prompt).toContain("- /Users/code/zlib（zlib 下载任务）");
    expect(prompt).toContain("- /Users/code/wps/opencode-feishu-plugin");
    expect(prompt).toContain("帮我修 zlib 的 bug");
  });

  test("无候选回退（无）；超长消息被截断到 2000 字", () => {
    expect(buildQuickNewPrompt("x", [])).toContain("（无）");
    const long = "啊".repeat(5000);
    const prompt = buildQuickNewPrompt(long, []);
    expect(prompt.length).toBeLessThan(QUICK_NEW_INSTRUCTION.length + 2500);
  });
});

describe("parseQuickNewDecision", () => {
  test("纯 JSON：task + 目录 + 标题 + 理由", () => {
    const decision = parseQuickNewDecision(
      '{"intent":"task","dir":"/Users/code/zlib","title":"修下载 bug","reason":"消息提到下载"}',
    );
    expect(decision).toEqual({
      intent: "task",
      directory: "/Users/code/zlib",
      title: "修下载 bug",
      reason: "消息提到下载",
    });
  });

  test("```json 围栏 + 前后杂讯也能解析", () => {
    const raw = [
      "好的，以下是结果：",
      "```json",
      '{"intent":"task","dir":"/a/b","title":"T"}',
      "```",
      "以上。",
    ].join("\n");
    expect(parseQuickNewDecision(raw)).toEqual({ intent: "task", directory: "/a/b", title: "T" });
  });

  test("chat 意图 / task 无目录 / 非法输入", () => {
    expect(parseQuickNewDecision('{"intent":"chat"}')).toEqual({ intent: "chat" });
    expect(parseQuickNewDecision('{"intent":"task"}')).toEqual({ intent: "task" });
    expect(parseQuickNewDecision('{"intent":"unknown"}')).toBeUndefined();
    expect(parseQuickNewDecision("没有任何 JSON")).toBeUndefined();
    expect(parseQuickNewDecision("{坏 json}")).toBeUndefined();
    expect(parseQuickNewDecision(undefined)).toBeUndefined();
  });

  test("title/reason 裁剪上限", () => {
    const decision = parseQuickNewDecision(
      JSON.stringify({ intent: "task", title: "字".repeat(50), reason: "r".repeat(400) }),
    );
    expect(decision?.title?.length).toBe(30);
    expect(decision?.reason?.length).toBe(200);
  });
});

describe("matchCandidateDirectory", () => {
  const candidates = [{ path: "/Users/code/zlib" }, { path: "/tmp/x/" }];
  test("精确命中 / 容忍尾部斜杠", () => {
    expect(matchCandidateDirectory("/Users/code/zlib", candidates)).toBe("/Users/code/zlib");
    expect(matchCandidateDirectory("/tmp/x", candidates)).toBe("/tmp/x/");
  });
  test("非候选路径（防幻觉）与空输入返回 undefined", () => {
    expect(matchCandidateDirectory("/etc/passwd", candidates)).toBeUndefined();
    expect(matchCandidateDirectory("/Users/code/zlib/../other", candidates)).toBeUndefined();
    expect(matchCandidateDirectory(undefined, candidates)).toBeUndefined();
  });
});
