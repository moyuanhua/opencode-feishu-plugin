import { describe, expect, test } from "vitest";
import { homedir } from "node:os";
import {
  deriveSignSecret,
  expandEnv,
  hasSecret,
  resolveConfig,
  shouldHandlePermissionEvents,
  shouldRegisterEvaluate,
  type ResolveConfigDeps,
} from "../src/config.js";

/** 构造一个带 code 的 ENOENT。 */
function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

/** 屏蔽真实配置文件，保证单测不受 `~/.config/opencode/plugins/feishu.json` 影响。 */
function noFile(): ResolveConfigDeps {
  return {
    configDir: "/tmp/opencode-feishu-v2-tests/no-config",
    readFile: () => {
      throw enoent();
    },
  };
}

/** 用虚拟文件内容解析配置。 */
function withFile(content: string): ResolveConfigDeps {
  return { configDir: "/virtual/config", readFile: () => content };
}

/** 默认：无配置文件。 */
function resolve(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  return resolveConfig(options, env, noFile());
}

describe("expandEnv", () => {
  test("支持 {env:NAME} 与 ${NAME}", () => {
    const env = { A: "1", B: "2" };
    expect(expandEnv("{env:A}", env)).toBe("1");
    expect(expandEnv("${B}", env)).toBe("2");
    expect(expandEnv("  x  ", env)).toBe("x");
  });

  test("缺失变量展开为空串", () => {
    expect(expandEnv("{env:MISSING}", {})).toBe("");
  });
});

describe("resolveConfig", () => {
  test("缺 appId / appSecret 时禁用但不抛异常", () => {
    const cfg = resolve({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.disabledReason).toBeTruthy();
  });

  test("appSecret 只存在性可用，不进日志字段", () => {
    const cfg = resolve({ appId: "cli_x", appSecret: "s3cret" }, {});
    expect(cfg.enabled).toBe(true);
    expect(hasSecret(cfg.appSecret)).toBe(true);
    expect(cfg.signSecret).toBe(deriveSignSecret("s3cret"));
    expect(cfg.signSecret).not.toBe("s3cret");
  });

  test("环境变量占位符解析", () => {
    const cfg = resolve(
      { appId: "{env:FEISHU_APP_ID}", appSecret: "${FEISHU_APP_SECRET}" },
      { FEISHU_APP_ID: "cli_1", FEISHU_APP_SECRET: "sec" },
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.appId).toBe("cli_1");
  });

  test("默认值：gate / 白名单工具 / 400ms 节流", () => {
    const cfg = resolve({ appId: "cli_x", appSecret: "s" }, {});
    expect(cfg.permissionGate).toBe("gate");
    expect(cfg.allowTools).toEqual(["read", "glob", "grep", "webfetch"]);
    expect(cfg.stream).toBe(true);
    expect(cfg.streamThrottleMs).toBe(400);
    expect(cfg.domain).toBe("feishu");
    expect(cfg.threadRouting).toBe(true);
    expect(cfg.allowedRoots).toEqual([homedir()]);
    expect(cfg.recentDirsLimit).toBe(5);
    expect(cfg.recentModelsLimit).toBe(5);
    expect(cfg.sessionPageSize).toBe(8);
    expect(cfg.warnings).toEqual([]);
  });

  test("P6：allowedRoots / recent 限制可配置并夹取", () => {
    const cfg = resolve(
      { appId: "a", appSecret: "s", allowedRoots: ["/home/ubuntu/work", "/data"], recentDirsLimit: 2, recentModelsLimit: 30 },
      {},
    );
    expect(cfg.allowedRoots).toEqual(["/home/ubuntu/work", "/data"]);
    expect(cfg.recentDirsLimit).toBe(2);
    expect(cfg.recentModelsLimit).toBe(20); // 夹到上限
    // 非法（非绝对路径）根被过滤，全部非法则回退默认。
    const bad = resolve({ appId: "a", appSecret: "s", allowedRoots: ["relative/path"] }, {});
    expect(bad.allowedRoots).toEqual([homedir()]);
    const lower = resolve({ appId: "a", appSecret: "s", recentDirsLimit: 0 }, {});
    expect(lower.recentDirsLimit).toBe(1); // 夹到下限
  });

  test("P7：sessionPageSize 默认 8，夹取 5–20", () => {
    expect(resolve({ appId: "a", appSecret: "s" }, {}).sessionPageSize).toBe(8);
    expect(resolve({ appId: "a", appSecret: "s", sessionPageSize: 3 }, {}).sessionPageSize).toBe(5); // 下限
    expect(resolve({ appId: "a", appSecret: "s", sessionPageSize: 99 }, {}).sessionPageSize).toBe(20); // 上限
    expect(resolve({ appId: "a", appSecret: "s", sessionPageSize: 12 }, {}).sessionPageSize).toBe(12);
  });

  test("threadRouting 默认 true，显式 false 可回退；字符串 'false' 也识别", () => {
    expect(resolve({ appId: "a", appSecret: "s" }, {}).threadRouting).toBe(true);
    expect(resolve({ appId: "a", appSecret: "s", threadRouting: false }, {}).threadRouting).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", threadRouting: "false" }, {}).threadRouting).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", threadRouting: "true" }, {}).threadRouting).toBe(true);
  });

  test("P5.3：topicGuidance 默认 true，显式 false / 字符串 'false' 可关闭", () => {
    expect(resolve({ appId: "a", appSecret: "s" }, {}).topicGuidance).toBe(true);
    expect(resolve({ appId: "a", appSecret: "s", topicGuidance: false }, {}).topicGuidance).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", topicGuidance: "false" }, {}).topicGuidance).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", topicGuidance: "true" }, {}).topicGuidance).toBe(true);
  });

  test("节流下限被夹到 400ms", () => {
    const cfg = resolve({ appId: "a", appSecret: "s", streamThrottleMs: 50 }, {});
    expect(cfg.streamThrottleMs).toBe(400);
  });

  test("非法 gate 回退到 gate", () => {
    const cfg = resolve({ appId: "a", appSecret: "s", permissionGate: "bogus" }, {});
    expect(cfg.permissionGate).toBe("gate");
  });

  test("allowUsers 支持逗号分隔字符串", () => {
    const cfg = resolve({ appId: "a", appSecret: "s", allowUsers: "ou_1, ou_2" }, {});
    expect(cfg.allowUsers).toEqual(["ou_1", "ou_2"]);
  });

  test("staleExecutionMs：默认 5 分钟，夹取 1–60 分钟", () => {
    expect(resolve({ appId: "a", appSecret: "s" }, {}).staleExecutionMs).toBe(5 * 60_000);
    expect(resolve({ appId: "a", appSecret: "s", staleExecutionMs: 10 * 60_000 }, {}).staleExecutionMs).toBe(10 * 60_000);
    expect(resolve({ appId: "a", appSecret: "s", staleExecutionMs: 1000 }, {}).staleExecutionMs).toBe(60_000);
    expect(resolve({ appId: "a", appSecret: "s", staleExecutionMs: 99_999_999 }, {}).staleExecutionMs).toBe(60 * 60_000);
  });

  test("任务 A：sessionAllowButton 默认 true，可显式关闭", () => {
    expect(resolve({ appId: "a", appSecret: "s" }, {}).sessionAllowButton).toBe(true);
    expect(resolve({ appId: "a", appSecret: "s", sessionAllowButton: false }, {}).sessionAllowButton).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", sessionAllowButton: "false" }, {}).sessionAllowButton).toBe(false);
  });

  test("任务 B：resumeSummary 默认 true；resumeSummaryTimeoutMs 默认 15000，夹取 3000–60000", () => {
    const base = resolve({ appId: "a", appSecret: "s" }, {});
    expect(base.resumeSummary).toBe(true);
    expect(base.resumeSummaryTimeoutMs).toBe(15_000);
    expect(resolve({ appId: "a", appSecret: "s", resumeSummary: false }, {}).resumeSummary).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", resumeSummaryTimeoutMs: 1000 }, {}).resumeSummaryTimeoutMs).toBe(3_000);
    expect(resolve({ appId: "a", appSecret: "s", resumeSummaryTimeoutMs: 99_999 }, {}).resumeSummaryTimeoutMs).toBe(60_000);
    expect(resolve({ appId: "a", appSecret: "s", resumeSummaryTimeoutMs: 12_345 }, {}).resumeSummaryTimeoutMs).toBe(12_345);
  });

  test("任务 B：resumeCompactTimeoutMs 默认 120000，夹取 30000–300000", () => {
    const base = resolve({ appId: "a", appSecret: "s" }, {});
    expect(base.resumeCompactTimeoutMs).toBe(120_000);
    expect(resolve({ appId: "a", appSecret: "s", resumeCompactTimeoutMs: 1000 }, {}).resumeCompactTimeoutMs).toBe(30_000);
    expect(resolve({ appId: "a", appSecret: "s", resumeCompactTimeoutMs: 999_999 }, {}).resumeCompactTimeoutMs).toBe(300_000);
    expect(resolve({ appId: "a", appSecret: "s", resumeCompactTimeoutMs: 60_000 }, {}).resumeCompactTimeoutMs).toBe(60_000);
  });

  test("话题根卡状态：topicStatus 默认 true、topicStatusInTitle 默认 false", () => {
    const base = resolve({ appId: "a", appSecret: "s" }, {});
    expect(base.topicStatus).toBe(true);
    expect(base.topicStatusInTitle).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", topicStatus: false }, {}).topicStatus).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", topicStatus: "false" }, {}).topicStatus).toBe(false);
    expect(resolve({ appId: "a", appSecret: "s", topicStatusInTitle: true }, {}).topicStatusInTitle).toBe(true);
  });

  test("卡片表格守卫：cardMaxTables 默认 4，夹取 1–5", () => {
    expect(resolve({ appId: "a", appSecret: "s" }, {}).cardMaxTables).toBe(4);
    expect(resolve({ appId: "a", appSecret: "s", cardMaxTables: 0 }, {}).cardMaxTables).toBe(1);
    expect(resolve({ appId: "a", appSecret: "s", cardMaxTables: 99 }, {}).cardMaxTables).toBe(5);
    expect(resolve({ appId: "a", appSecret: "s", cardMaxTables: 5 }, {}).cardMaxTables).toBe(5);
    expect(resolve({ appId: "a", appSecret: "s", cardMaxTables: 2 }, {}).cardMaxTables).toBe(2);
  });

  test("话题根卡状态：topicStatusThrottleMs 默认 1000，夹取 500–10000", () => {
    expect(resolve({ appId: "a", appSecret: "s" }, {}).topicStatusThrottleMs).toBe(1_000);
    expect(resolve({ appId: "a", appSecret: "s", topicStatusThrottleMs: 1 }, {}).topicStatusThrottleMs).toBe(500);
    expect(resolve({ appId: "a", appSecret: "s", topicStatusThrottleMs: 99_999 }, {}).topicStatusThrottleMs).toBe(10_000);
    expect(resolve({ appId: "a", appSecret: "s", topicStatusThrottleMs: 2_500 }, {}).topicStatusThrottleMs).toBe(2_500);
  });
});

describe("resolveConfig 配置文件回退", () => {
  test("options 为空时从 feishu.json 读取，字段与 options 同构", () => {
    const cfg = resolveConfig(
      {},
      {},
      withFile(
        JSON.stringify({
          appId: "cli_file",
          appSecret: "file-secret",
          allowUsers: ["ou_file"],
          permissionGate: "lockdown",
          domain: "lark",
          streamThrottleMs: 50,
          maxResourcesShown: 1,
          logLevel: "debug",
        }),
      ),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.appId).toBe("cli_file");
    expect(cfg.appSecret).toBe("file-secret");
    expect(cfg.allowUsers).toEqual(["ou_file"]);
    expect(cfg.permissionGate).toBe("lockdown");
    expect(cfg.domain).toBe("lark");
    expect(cfg.streamThrottleMs).toBe(400); // 夹到下限
    expect(cfg.maxResourcesShown).toBe(1);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.warnings).toEqual([]);
  });

  test("优先级 options > 配置文件 > 环境变量（字段级）", () => {
    const cfg = resolveConfig(
      { appId: "cli_opt" },
      { FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "env-secret" },
      withFile(JSON.stringify({ appId: "cli_file", appSecret: "file-secret", stream: false })),
    );
    expect(cfg.appId).toBe("cli_opt"); // options 赢
    expect(cfg.appSecret).toBe("file-secret"); // 文件赢环境变量
    expect(cfg.stream).toBe(false); // 仅文件提供的字段生效
  });

  test("环境变量仅作为 appId/appSecret 的最低优先级兜底", () => {
    const cfg = resolveConfig(
      {},
      { FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "env-secret" },
      withFile(JSON.stringify({ allowUsers: ["ou_file"] })),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.appId).toBe("cli_env");
    expect(cfg.appSecret).toBe("env-secret");
    expect(cfg.allowUsers).toEqual(["ou_file"]);
  });

  test("配置文件里的 {env:} / ${} 占位符可展开", () => {
    const cfg = resolveConfig(
      {},
      { FEISHU_APP_ID: "cli_from_env", FEISHU_APP_SECRET: "sec_from_env" },
      withFile(JSON.stringify({ appId: "{env:FEISHU_APP_ID}", appSecret: "${FEISHU_APP_SECRET}" })),
    );
    expect(cfg.appId).toBe("cli_from_env");
    expect(cfg.appSecret).toBe("sec_from_env");
    expect(cfg.enabled).toBe(true);
  });

  test("文件缺失时静默回退（不产生 warning）", () => {
    const cfg = resolveConfig({}, { FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "s" }, noFile());
    expect(cfg.enabled).toBe(true);
    expect(cfg.appId).toBe("cli_env");
    expect(cfg.warnings).toEqual([]);

    const disabled = resolveConfig({}, {}, noFile());
    expect(disabled.enabled).toBe(false);
    expect(disabled.warnings).toEqual([]);
  });

  test("空白文件视为未配置，静默回退", () => {
    const cfg = resolveConfig({}, {}, withFile("   \n\t "));
    expect(cfg.enabled).toBe(false);
    expect(cfg.warnings).toEqual([]);
  });

  test("非法 JSON：warn 且不抛异常，退回环境变量，warning 不含 secret", () => {
    const secret = "super-secret-value";
    const cfg = resolveConfig(
      {},
      { FEISHU_APP_ID: "cli_env", FEISHU_APP_SECRET: "env-secret" },
      withFile(`{"appSecret": "${secret}", oops}`),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.appId).toBe("cli_env");
    expect(cfg.warnings.some((w) => w.includes("不是合法 JSON"))).toBe(true);
    expect(cfg.warnings.join(" ")).not.toContain(secret);

    const noEnv = resolveConfig({}, {}, withFile("{ not json"));
    expect(noEnv.enabled).toBe(false);
    expect(noEnv.disabledReason).toBeTruthy();
  });

  test("顶层不是对象：warn 并忽略", () => {
    for (const content of ['"just a string"', "[]", "42", "null"]) {
      const cfg = resolveConfig({}, {}, withFile(content));
      expect(cfg.enabled).toBe(false);
      expect(cfg.warnings.some((w) => w.includes("顶层必须是 JSON 对象"))).toBe(true);
    }
  });

  test("读取失败（非 ENOENT）只 warn，不抛异常", () => {
    const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const cfg = resolveConfig({}, {}, { configDir: "/virtual", readFile: () => { throw eacces; } });
    expect(cfg.enabled).toBe(false);
    expect(cfg.warnings.some((w) => w.includes("读取") && w.includes("EACCES"))).toBe(true);
  });

  test("未知读取错误也绝不抛出", () => {
    const cfg = resolveConfig({}, {}, {
      configDir: "/virtual",
      readFile: () => {
        throw new Error("boom");
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.warnings.some((w) => w.includes("读取") && w.includes("unknown"))).toBe(true);
  });

  test("配置路径：OPENCODE_CONFIG_DIR 优先于默认 ~/.config/opencode", () => {
    let seen = "";
    resolveConfig({}, { OPENCODE_CONFIG_DIR: "/custom/oc" }, {
      readFile: (path) => {
        seen = path;
        throw enoent();
      },
    });
    expect(seen).toBe("/custom/oc/plugins/feishu.json");

    let seenDefault = "";
    resolveConfig({}, {}, {
      readFile: (path) => {
        seenDefault = path;
        throw enoent();
      },
    });
    expect(seenDefault.endsWith("/.config/opencode/plugins/feishu.json")).toBe(true);
  });

  test("显式 configDir 依赖优先于 OPENCODE_CONFIG_DIR", () => {
    let seen = "";
    resolveConfig({}, { OPENCODE_CONFIG_DIR: "/from/env" }, {
      configDir: "/explicit",
      readFile: (path) => {
        seen = path;
        throw enoent();
      },
    });
    expect(seen).toBe("/explicit/plugins/feishu.json");
  });
});

describe("gate helpers", () => {
  test("off 不注册 hook / 不处理事件", () => {
    expect(shouldRegisterEvaluate("off")).toBe(false);
    expect(shouldHandlePermissionEvents("off")).toBe(false);
  });

  test("notify 只订阅事件不改判定", () => {
    expect(shouldRegisterEvaluate("notify")).toBe(false);
    expect(shouldHandlePermissionEvents("notify")).toBe(true);
  });

  test("gate / lockdown 注册 hook", () => {
    expect(shouldRegisterEvaluate("gate")).toBe(true);
    expect(shouldRegisterEvaluate("lockdown")).toBe(true);
  });
});

describe("gatewayLocation", () => {
  const base = { appId: "a", appSecret: "b", logFile: false };
  test("缺省为 undefined（所有 location 启动）", () => {
    const cfg = resolveConfig(base, {}, { configDir: "/nonexistent", readFile: () => "" });
    expect(cfg.gatewayLocation).toBeUndefined();
  });
  test("空白配置视为未设置", () => {
    const cfg = resolveConfig({ ...base, gatewayLocation: "   " }, {}, noFile());
    expect(cfg.gatewayLocation).toBeUndefined();
  });
  test("归一化为绝对路径（去尾斜杠 / 相对路径）", () => {
    // 使用必然存在的 homedir，保证 realpath 成功且结果稳定。
    const home = homedir();
    const cfg = resolveConfig({ ...base, gatewayLocation: `  ${home}/  ` }, {}, noFile());
    expect(cfg.gatewayLocation).toBe(home);
  });
  test("展开 ~ 前缀", () => {
    const cfg = resolveConfig({ ...base, gatewayLocation: "~" }, {}, noFile());
    expect(cfg.gatewayLocation).toBe(homedir());
  });
  test("不存在的目录退回 resolve 结果（不抛错）", () => {
    const cfg = resolveConfig(
      { ...base, gatewayLocation: "/tmp/opencode-feishu-v2/__definitely_missing__" },
      {},
      noFile(),
    );
    expect(cfg.gatewayLocation).toBe("/tmp/opencode-feishu-v2/__definitely_missing__");
  });
});

describe("keepalive", () => {
  const base = { appId: "a", appSecret: "b", logFile: false };
  test("默认开启、间隔 20 分钟", () => {
    const cfg = resolveConfig(base, {}, noFile());
    expect(cfg.keepalive).toBe(true);
    expect(cfg.keepaliveIntervalMs).toBe(20 * 60 * 1000);
  });
  test("可关闭", () => {
    const cfg = resolveConfig({ ...base, keepalive: false }, {}, noFile());
    expect(cfg.keepalive).toBe(false);
  });
  test("间隔夹取到 5–45 分钟", () => {
    expect(resolveConfig({ ...base, keepaliveIntervalMs: 1000 }, {}, noFile()).keepaliveIntervalMs).toBe(5 * 60 * 1000);
    expect(resolveConfig({ ...base, keepaliveIntervalMs: 99 * 60 * 1000 }, {}, noFile()).keepaliveIntervalMs).toBe(45 * 60 * 1000);
    expect(resolveConfig({ ...base, keepaliveIntervalMs: 30 * 60 * 1000 }, {}, noFile()).keepaliveIntervalMs).toBe(30 * 60 * 1000);
  });
});

describe("gatewayMatchGraceMs（精确匹配宽限）", () => {
  const base = { appId: "a", appSecret: "b", logFile: false };
  test("默认 3000ms", () => {
    expect(resolveConfig(base, {}, noFile()).gatewayMatchGraceMs).toBe(3000);
  });
  test("可设为 0（子目录立即兜底）并夹取到 0–10000", () => {
    expect(resolveConfig({ ...base, gatewayMatchGraceMs: 0 }, {}, noFile()).gatewayMatchGraceMs).toBe(0);
    expect(resolveConfig({ ...base, gatewayMatchGraceMs: -5 }, {}, noFile()).gatewayMatchGraceMs).toBe(0);
    expect(resolveConfig({ ...base, gatewayMatchGraceMs: 999999 }, {}, noFile()).gatewayMatchGraceMs).toBe(10_000);
  });
});

describe("运行卡瘦身 / 最终答案拆分（P8.3）", () => {
  const base = { appId: "a", appSecret: "b", logFile: false };
  test("默认值", () => {
    const cfg = resolveConfig(base, {}, noFile());
    expect(cfg.runnerCardMaxTools).toBe(12);
    expect(cfg.runnerCardTextMax).toBe(2048);
    expect(cfg.finalAnswerMinChars).toBe(600);
    expect(cfg.finalAnswerFileMinBytes).toBe(20 * 1024);
  });
  test("夹取范围", () => {
    expect(resolveConfig({ ...base, runnerCardMaxTools: 999 }, {}, noFile()).runnerCardMaxTools).toBe(50);
    expect(resolveConfig({ ...base, runnerCardMaxTools: 0 }, {}, noFile()).runnerCardMaxTools).toBe(1);
    expect(resolveConfig({ ...base, runnerCardTextMax: 10 }, {}, noFile()).runnerCardTextMax).toBe(512);
    expect(resolveConfig({ ...base, finalAnswerMinChars: 0 }, {}, noFile()).finalAnswerMinChars).toBe(0);
    expect(resolveConfig({ ...base, finalAnswerFileMinBytes: 1 }, {}, noFile()).finalAnswerFileMinBytes).toBe(8192);
  });
});
