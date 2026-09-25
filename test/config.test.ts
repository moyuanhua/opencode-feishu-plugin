import { describe, expect, test } from "vitest";
import {
  deriveSignSecret,
  expandEnv,
  hasSecret,
  resolveConfig,
  shouldHandlePermissionEvents,
  shouldRegisterEvaluate,
} from "../src/config.js";

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
    const cfg = resolveConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.disabledReason).toBeTruthy();
  });

  test("appSecret 只存在性可用，不进日志字段", () => {
    const cfg = resolveConfig({ appId: "cli_x", appSecret: "s3cret" }, {});
    expect(cfg.enabled).toBe(true);
    expect(hasSecret(cfg.appSecret)).toBe(true);
    expect(cfg.signSecret).toBe(deriveSignSecret("s3cret"));
    expect(cfg.signSecret).not.toBe("s3cret");
  });

  test("环境变量占位符解析", () => {
    const cfg = resolveConfig(
      { appId: "{env:FEISHU_APP_ID}", appSecret: "${FEISHU_APP_SECRET}" },
      { FEISHU_APP_ID: "cli_1", FEISHU_APP_SECRET: "sec" },
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.appId).toBe("cli_1");
  });

  test("默认值：gate / 白名单工具 / 400ms 节流", () => {
    const cfg = resolveConfig({ appId: "cli_x", appSecret: "s" }, {});
    expect(cfg.permissionGate).toBe("gate");
    expect(cfg.allowTools).toEqual(["read", "glob", "grep", "webfetch"]);
    expect(cfg.stream).toBe(true);
    expect(cfg.streamThrottleMs).toBe(400);
    expect(cfg.domain).toBe("feishu");
  });

  test("节流下限被夹到 400ms", () => {
    const cfg = resolveConfig({ appId: "a", appSecret: "s", streamThrottleMs: 50 }, {});
    expect(cfg.streamThrottleMs).toBe(400);
  });

  test("非法 gate 回退到 gate", () => {
    const cfg = resolveConfig({ appId: "a", appSecret: "s", permissionGate: "bogus" }, {});
    expect(cfg.permissionGate).toBe("gate");
  });

  test("allowUsers 支持逗号分隔字符串", () => {
    const cfg = resolveConfig({ appId: "a", appSecret: "s", allowUsers: "ou_1, ou_2" }, {});
    expect(cfg.allowUsers).toEqual(["ou_1", "ou_2"]);
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
