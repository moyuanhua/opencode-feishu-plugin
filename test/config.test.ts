import { describe, expect, test } from "vitest";
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
    expect(cfg.warnings).toEqual([]);
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
  const base = { appId: "a", appSecret: "b" };
  test("缺省为 undefined（所有 location 启动）", () => {
    const cfg = resolveConfig(base, {}, { configDir: "/nonexistent", readFile: () => "" });
    expect(cfg.gatewayLocation).toBeUndefined();
  });
  test("显式配置时保留并 trim", () => {
    const cfg = resolveConfig({ ...base, gatewayLocation: "  /home/ubuntu  " }, {}, { configDir: "/nonexistent", readFile: () => "" });
    expect(cfg.gatewayLocation).toBe("/home/ubuntu");
  });
});
