/**
 * 插件配置解析与校验。
 *
 * 设计原则：
 * - 永不抛异常（配置错误只导致插件禁用 + warn），不能把用户的 opencode 弄挂。
 * - 只记录 secret 的「存在性」，绝不记录值。
 */
import { createHash } from "node:crypto";
import type { LogLevel, PermissionGate, RawOptions } from "./types.js";

export interface ResolvedConfig {
  readonly enabled: boolean;
  /** enabled=false 时说明原因（不含敏感值）。 */
  readonly disabledReason?: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: "feishu" | "lark";
  /** open_id 白名单。空数组 = 仅应用 owner（首个发消息者绑定后持久化）。 */
  readonly allowUsers: readonly string[];
  readonly permissionGate: PermissionGate;
  /** 免打扰白名单：命中则直接 allow，不弹审批卡。 */
  readonly allowTools: readonly string[];
  /** 强制拒绝名单（可选，优先于 allowTools）。 */
  readonly denyTools: readonly string[];
  readonly stream: boolean;
  readonly streamThrottleMs: number;
  readonly logLevel: LogLevel;
  /** 审批 token / 卡片有效期。 */
  readonly approvalTtlMs: number;
  /** HMAC 密钥；未显式配置时从 appSecret 派生（不落盘、不打印）。 */
  readonly signSecret: string;
  /** 审批卡最多展示的 resource 行数。 */
  readonly maxResourcesShown: number;
}

const DEFAULT_ALLOW_TOOLS = ["read", "glob", "grep", "webfetch"];
const GENESIS_SECRET_SALT = "opencode-feishu-v2/approval/v1";
const VALID_GATES: readonly PermissionGate[] = ["off", "notify", "gate", "lockdown"];
const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export function resolveConfig(raw: RawOptions | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const options = raw ?? {};

  const appId = expandEnv(asString(options.appId), env);
  const appSecret = expandEnv(asString(options.appSecret), env);
  const allowUsers = asStringArray(options.allowUsers);
  const allowTools = normalizeToolList(options.allowTools, DEFAULT_ALLOW_TOOLS);
  const denyTools = normalizeToolList(options.denyTools, []);
  const gate = asGate(options.permissionGate);
  const logLevel = asLogLevel(options.logLevel);
  const stream = asBoolean(options.stream, true);
  const throttle = clamp(asNumber(options.streamThrottleMs, 400), 400, 60_000);
  const approvalTtlMs = clamp(asNumber(options.approvalTtlMs, 10 * 60 * 1000), 30_000, 24 * 60 * 60 * 1000);
  const maxResourcesShown = clamp(asNumber(options.maxResourcesShown, 8), 1, 50);
  const domain = options.domain === "lark" ? "lark" : "feishu";

  const signSecretRaw = expandEnv(asString(options.signSecret), env);
  const signSecret =
    signSecretRaw && signSecretRaw.length > 0 ? signSecretRaw : deriveSignSecret(appSecret);

  let enabled = true;
  let disabledReason: string | undefined;
  if (!appId) {
    enabled = false;
    disabledReason = "缺少 appId（或 {env:...} 未解析）";
  } else if (!appSecret) {
    enabled = false;
    disabledReason = "缺少 appSecret（或 {env:...} 未解析）";
  }

  return {
    enabled,
    ...(disabledReason ? { disabledReason } : {}),
    appId,
    appSecret,
    domain,
    allowUsers,
    permissionGate: gate,
    allowTools,
    denyTools,
    stream,
    streamThrottleMs: throttle,
    logLevel,
    approvalTtlMs,
    signSecret,
    maxResourcesShown,
  };
}

/**
 * 支持 opencode 的 `{env:NAME}` 以及常见 `${NAME}` / `$NAME` 占位符。
 * opencode 会在下发 options 前替换 `{env:...}`；这里再兜底一次，便于独立部署与单测。
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  if (!value) return "";
  return value
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "")
    .trim();
}

/** 从 appSecret 确定性派生 HMAC 密钥（appSecret 本身永不打印）。 */
export function deriveSignSecret(appSecret: string): string {
  return createHash("sha256").update(`${GENESIS_SECRET_SALT}:${appSecret}`).digest("hex");
}

/** 仅用于日志：表达 secret 是否存在。 */
export function hasSecret(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * 通知模式是否应注册 evaluate hook。
 * `off` = 完全不介入；`notify` 只转发「本来就存在」的 permission.asked。
 */
export function shouldRegisterEvaluate(gate: PermissionGate): boolean {
  return gate === "gate" || gate === "lockdown";
}

/** 是否应订阅 permission.asked / replied 并渲染卡片。 */
export function shouldHandlePermissionEvents(gate: PermissionGate): boolean {
  return gate !== "off";
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(asString(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (typeof value === "string" && value.trim()) {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }
  return value.map((v) => asString(v).trim()).filter(Boolean);
}

function normalizeToolList(value: unknown, fallback: readonly string[]): string[] {
  const list = asStringArray(value);
  if (list.length > 0) return list;
  return [...fallback];
}

function asGate(value: unknown): PermissionGate {
  const gate = asString(value) as PermissionGate;
  return VALID_GATES.includes(gate) ? gate : "gate";
}

function asLogLevel(value: unknown): LogLevel {
  const level = asString(value) as LogLevel;
  return VALID_LOG_LEVELS.includes(level) ? level : "info";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
