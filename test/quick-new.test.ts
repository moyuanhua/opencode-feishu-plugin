import { describe, expect, test } from "vitest";
import {
  QUICK_NEW_DIR_SOURCES,
  QUICK_NEW_INSTRUCTION,
  QUICK_NEW_PERMS,
  buildQuickNewPrompt,
  matchCandidateDirectory,
  matchModelOption,
  parseQuickNewDecision,
  slugifyTitle,
} from "../src/session/quick-new.js";

describe("buildQuickNewPrompt", () => {
  test("包含允许根目录、候选目录（含标题线索）、候选模型与用户消息", () => {
    const prompt = buildQuickNewPrompt({
      text: "帮我修 zlib 的 bug，用 glm",
      candidates: [
        { path: "/Users/code/zlib", label: "zlib 下载任务" },
        { path: "/Users/code/wps/opencode-feishu-plugin" },
      ],
      models: [{ providerID: "zhipu", id: "glm-5.2", name: "GLM 5.2" }],
      allowedRoots: ["/Users/code"],
    });
    expect(prompt).toContain(QUICK_NEW_INSTRUCTION);
    expect(prompt).toContain("允许根目录");
    expect(prompt).toContain("- /Users/code");
    expect(prompt).toContain("- /Users/code/zlib（zlib 下载任务）");
    expect(prompt).toContain("- /Users/code/wps/opencode-feishu-plugin");
    expect(prompt).toContain("- zhipu/glm-5.2（GLM 5.2）");
    expect(prompt).toContain("帮我修 zlib 的 bug，用 glm");
    // 权限档位在指令中有枚举
    for (const perm of QUICK_NEW_PERMS) expect(prompt).toContain(perm);
    // 目录规则：三级来源 + dir 不可为空
    for (const src of QUICK_NEW_DIR_SOURCES) expect(prompt).toContain(src);
    expect(prompt).toContain("dir 绝不允许为空");
  });

  test("无候选回退（无）；超长消息被截断", () => {
    const prompt = buildQuickNewPrompt({ text: "x", candidates: [] });
    expect(prompt).toContain("（无）");
    const long = "啊".repeat(5000);
    expect(buildQuickNewPrompt({ text: long, candidates: [] }).length).toBeLessThan(
      QUICK_NEW_INSTRUCTION.length + 2600,
    );
  });
});

describe("parseQuickNewDecision", () => {
  test("create + 全字段（目录/来源/标题/权限/模型）", () => {
    const decision = parseQuickNewDecision(
      JSON.stringify({
        intent: "create",
        dir: "/Users/code/zlib",
        dir_source: "existing",
        title: "修下载 bug",
        perm: "askHigh",
        model: "zhipu/glm-5.2",
        reason: "消息提到下载与模型",
      }),
    );
    expect(decision).toEqual({
      intent: "create",
      directory: "/Users/code/zlib",
      dirSource: "existing",
      title: "修下载 bug",
      perm: "askHigh",
      model: "zhipu/glm-5.2",
      reason: "消息提到下载与模型",
    });
  });

  test("dir_source 白名单：仅 given/existing/new；容忍 camelCase", () => {
    expect(parseQuickNewDecision('{"intent":"create","dir":"/a","dir_source":"given"}')).toEqual({
      intent: "create",
      directory: "/a",
      dirSource: "given",
    });
    expect(parseQuickNewDecision('{"intent":"create","dir":"/a","dirSource":"new"}')).toEqual({
      intent: "create",
      directory: "/a",
      dirSource: "new",
    });
    expect(parseQuickNewDecision('{"intent":"create","dir":"/a","dir_source":"weird"}')).toEqual({
      intent: "create",
      directory: "/a",
    });
  });

  test("list / chat / 非法输入", () => {
    expect(parseQuickNewDecision('{"intent":"list"}')).toEqual({ intent: "list" });
    expect(parseQuickNewDecision('{"intent":"chat"}')).toEqual({ intent: "chat" });
    expect(parseQuickNewDecision('{"intent":"unknown"}')).toBeUndefined();
    expect(parseQuickNewDecision("没有任何 JSON")).toBeUndefined();
    expect(parseQuickNewDecision("{坏 json}")).toBeUndefined();
    expect(parseQuickNewDecision(undefined)).toBeUndefined();
  });

  test("```json 围栏 + 前后杂讯也能解析", () => {
    const raw = ["结果如下：", "```json", '{"intent":"create","dir":"/a/b","perm":"trust"}', "```"].join("\n");
    expect(parseQuickNewDecision(raw)).toEqual({ intent: "create", directory: "/a/b", perm: "trust" });
  });

  test("perm 白名单校验；title/reason 裁剪", () => {
    expect(parseQuickNewDecision('{"intent":"create","perm":"hacker"}')).toEqual({ intent: "create" });
    const decision = parseQuickNewDecision(
      JSON.stringify({ intent: "create", title: "字".repeat(50), reason: "r".repeat(400) }),
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
    expect(matchCandidateDirectory(undefined, candidates)).toBeUndefined();
  });
});

describe("matchModelOption", () => {
  const models = [
    { providerID: "zhipu", id: "glm-5.2", name: "GLM 5.2" },
    { providerID: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4.1 Flash" },
  ];
  test("精确 providerID/id / 按 id / 按名称兜底", () => {
    expect(matchModelOption("zhipu/glm-5.2", models)).toEqual(models[0]);
    expect(matchModelOption("GLM-5.2", models)).toEqual(models[0]);
    expect(matchModelOption("deepseek-v4-flash", models)).toEqual(models[1]);
    expect(matchModelOption("DeepSeek V4.1 Flash", models)).toEqual(models[1]);
  });
  test("未命中（防幻觉）与空输入", () => {
    expect(matchModelOption("evil/model", models)).toBeUndefined();
    expect(matchModelOption(undefined, models)).toBeUndefined();
  });
});

describe("slugifyTitle（标题 → 新建目录 slug）", () => {
  test("英文标题 → 小写短横线；多余符号折叠；截断 40", () => {
    expect(slugifyTitle("Stock Research")).toBe("stock-research");
    expect(slugifyTitle("  Fix   the   BUG!! ")).toBe("fix-the-bug");
    expect(slugifyTitle("-a-b-")).toBe("a-b");
    expect(slugifyTitle("a".repeat(60)).length).toBe(40);
  });

  test("纯中文 / 纯符号 → 空串（调用方改用允许根目录兜底）", () => {
    expect(slugifyTitle("股票研究")).toBe("");
    expect(slugifyTitle("！！！")).toBe("");
    expect(slugifyTitle("")).toBe("");
  });
});
