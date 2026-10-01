/**
 * 插件配置解析与校验。
 *
 * 设计原则：
 * - 永不抛异常（配置错误只导致插件禁用 + warn），不能把用户的 opencode 弄挂。
 * - 只记录 secret 的「存在性」，绝不记录值。
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { LogLevel, PermissionGate, RawOptions } from "./types.js";

/** 默认日志文件（相对 configDir）：`<configDir>/plugins/feishu.log`。 */
const LOG_FILE_RELATIVE = ["plugins", "feishu.log"] as const;

export interface ResolvedConfig {
  readonly enabled: boolean;
  /** enabled=false 时说明原因（不含敏感值）。 */
  readonly disabledReason?: string;
  /** 配置解析中的非致命告警（绝不含 secret），由调用方决定是否 warn。 */
  readonly warnings: readonly string[];
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
  /**
   * 话题路由总开关（P5）。默认 true。
   * - true：主聊天流只做管理（普通文本回提示卡），话题 = 会话，出站走 reply。
   * - false：完全回到 P3 行为（主聊天流普通文本进当前会话，忽略 thread_id），出问题一键回退。
   */
  readonly threadRouting: boolean;
  /**
   * 主题软引导（P5.3）。默认 true。
   *
   * 开启时对**从飞书发起的会话**（sessionMap 有映射）在 system 注入一句主题说明：
   * 提示用户明显离题时可用 `/new` 开新会话，但**不拦截**消息、也不说教。
   * 非飞书会话（本地 TUI 等）绝不注入，避免污染用户自己的会话。
   */
  readonly topicGuidance: boolean;
  readonly logLevel: LogLevel;
  /**
   * 日志同时追加写入的文件全路径；`undefined` = 只写 stderr。
   * 因为 opencode 以服务方式运行时插件 stderr 会被丢弃，调试必须落文件。
   * 配置为 `true` 时默认 `<configDir>/plugins/feishu.log`。secret 始终脱敏。
   */
  readonly logFile: string | undefined;
  /**
   * 只在该 location 启动飞书网关与事件订阅；`undefined` = 所有 location 都启动。
   *
   * 背景：opencode 按 location 加载全局插件，每个 location 是独立 VM context，
   * 会各起一份 WS 客户端与事件订阅 → 同一事件被多个实例重复渲染成多张卡片。
   * 指定本机工作目录（如 `/home/you/projects`）即可收敛为唯一实例。
   */
  readonly gatewayLocation: string | undefined;
  /**
   * 网关「精确匹配」宽限窗口（毫秒，默认 3000，夹取 0–10000）。
   *
   * `gatewayLocation` 允许子目录兜底（修「填父目录不生效」），但精确匹配应优先：
   * 子目录候选先等该窗口，窗口内出现 `here === gatewayLocation` 的实例就让位。
   * 设为 0 = 不等待（子目录立即兜底，等价旧行为）。
   */
  readonly gatewayMatchGraceMs: number;
  /** 审批 token / 卡片有效期。 */
  readonly approvalTtlMs: number;
  /**
   * 看门狗阈值：执行态超过该时长无任何事件即视为卡死，主动中断并收尾。
   * 默认 5 分钟；夹取 0–60 分钟，**0 = 关闭看门狗**。排队超过该时长仍无 `execution.started` 也会提示。
   */
  readonly staleExecutionMs: number;
  /** HMAC 密钥；未显式配置时从 appSecret 派生（不落盘、不打印）。 */
  readonly signSecret: string;
  /** 审批卡最多展示的 resource 行数。 */
  readonly maxResourcesShown: number;
  /**
   * 允许作为会话工作目录的根目录白名单（P6）。默认 = 当前用户家目录（`os.homedir()`）。
   * 目录必须位于其中之一之下；`/`、家目录根、系统目录会被单独拒绝。
   */
  readonly allowedRoots: readonly string[];
  /** 「最近使用目录」列表长度（P6，默认 5）。 */
  readonly recentDirsLimit: number;
  /** 「最近使用模型」列表长度（P6，默认 5）。 */
  readonly recentModelsLimit: number;
  /** `/sessions` 每页会话数（P7，默认 8，夹取 5–20）。 */
  readonly sessionPageSize: number;
  /**
   * 审批卡是否显示「✅ 本会话内允许该工具」按钮（任务 A，默认 true）。
   * 关闭后审批卡回到「允许一次 / 始终允许 / 拒绝」三按钮。
   */
  readonly sessionAllowButton: boolean;
  /**
   * 恢复卡是否展示会话摘要（任务 B，默认 true）。
   *
   * 三条路径（成本从低到高）：① 复用会话已有 compaction 摘要（零模型调用）；
   * ② 快摘要：读最近消息构造精简转写 + 临时生成（**不喂整个会话**，秒级）；
   * ③ 原生压缩：**必须用户主动点「🗜 压缩并总结」**，插件绝不隐式触发。
   */
  readonly resumeSummary: boolean;
  /**
   * 恢复卡**快摘要**生成超时（任务 B，默认 15000ms，夹取 3000–60000）。
   *
   * 快摘要只喂精简转写（≤6K 字符）+ 无会话上下文的临时生成，正常远快于此；
   * 超时即降级为「生成失败」，绝不阻塞恢复卡。
   */
  readonly resumeSummaryTimeoutMs: number;
  /**
   * 恢复卡**用户主动压缩**（`session.compact`）后的轮询超时
   * （任务 B，默认 120000ms，夹取 30000–300000）。
   *
   * 压缩是显式操作、会**修改会话历史**，因此允许更长的等待窗口；
   * 超时只 patch 说明，不影响用户继续在该话题/卡片下干活。
   */
  readonly resumeCompactTimeoutMs: number;
  /**
   * 话题根卡工作状态总开关（默认 true）。关闭则完全不刷新根卡状态。
   *
   * 状态来源：execution.* / session.status / permission.asked|replied / inbox.* 与运行卡终态。
   * 只更新该会话最近一次根卡（`SessionLink.replyMessageId`）的 header 颜色 + 正文页脚，
   * **标题默认不变**（见 `topicStatusInTitle`），且刷新时用持久化的基础内容重渲染，**不丢摘要/元信息**。
   */
  readonly topicStatus: boolean;
  /**
   * 是否在根卡标题里加状态 emoji 前缀（默认 false）。
   *
   * 默认关闭：话题名会显示在侧栏，随状态频繁变动会很乱——状态只通过 header 颜色 + 正文页脚表达。
   */
  readonly topicStatusInTitle: boolean;
  /**
   * 话题根卡状态刷新的最小间隔（默认 1000ms，夹取 500–10000）。
   * 仅在状态档位发生变化时才 patch，且两次 patch 至少间隔该时长。
   */
  readonly topicStatusThrottleMs: number;
  /**
   * 单张卡片最多保留的 markdown 表格数（默认 4，夹取 1–5）。
   *
   * 飞书**单卡最多 5 个表格组件**，超限时 `im.message.patch` 直接 400
   * （`code=230099 card table number over limit`）。一次回复里出现 5 个以上对照表时，
   * 每一次 patch 都失败 → 卡片停在旧内容 → 用户以为机器人「卡死」。
   * 超过本额度（按**整卡累计**）的表格会被**降级为围栏代码块**（内容不丢），默认留 1 个余量。
   */
  readonly cardMaxTables: number;
  /**
   * 位置保活（P8，默认 true）：周期性发一次带 location 的活动事件，
   * 阻止 opencode 在 60 分钟空闲后回收 location 服务（会卸载插件、关闭飞书长连接）。
   * 关闭后长时间空闲会导致机器人沉默，需外部保活兜底。
   */
  readonly keepalive: boolean;
  /** 运行卡最多保留的工具块数（默认 12，夹取 1–50）；更早的块合并为省略提示。 */
  readonly runnerCardMaxTools: number;
  /** 运行卡单个文本块字符上限（默认 2048，夹取 512–8192）。 */
  readonly runnerCardTextMax: number;
  /**
   * 最终答案阈值（默认 600 字符，夹取 0–20000）：一轮结束时末尾文本 ≥ 该值就
   * **单独成卡/成文件**发送，运行卡内只留提示。设 0 = 关闭拆分。
   */
  readonly finalAnswerMinChars: number;
  /** 最终答案转 `.md` 文件的字节阈值（默认 20480，夹取 8192–102400）。 */
  readonly finalAnswerFileMinBytes: number;
  /** 保活心跳间隔（默认 20 分钟，夹取 5–45 分钟；必须显著小于 opencode 的 60 分钟 TTL）。 */
  readonly keepaliveIntervalMs: number;
  /**
   * 接收图片/文件（默认 true）：下载到 `attachmentsDir` 后作为会话附件挂进 prompt。
   * 需要应用开通 `im:message:readonly` 权限；未开通/失败时降级为占位文本。
   */
  readonly acceptAttachments: boolean;
  /** 单附件大小上限（默认 20MB，夹取 1–100MB）；超限拒绝并提示。 */
  readonly attachmentMaxBytes: number;
  /** 附件下载超时（默认 30s，夹取 5–120s）。 */
  readonly attachmentTimeoutMs: number;
  /**
   * 附件落盘目录；**不配置时**默认落在**会话工作目录**下：
   * `<会话工作目录>/.opencode/temp/opencode-feishu-plugin/`（无法确定会话目录时回退
   * `<系统临时目录>/opencode-feishu-plugin`）。显式配置则完全覆盖（精确目录）。
   */
  readonly attachmentsDir?: string;
}

const DEFAULT_ALLOW_TOOLS = ["read", "glob", "grep", "webfetch"];
/** 默认可作为会话工作目录的根：当前用户家目录（对外发布不能写死某个人的目录）。 */
const DEFAULT_ALLOWED_ROOTS = [homedir()];
const GENESIS_SECRET_SALT = "opencode-feishu-v2/approval/v1";
const VALID_GATES: readonly PermissionGate[] = ["off", "notify", "gate", "lockdown"];
const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** 配置文件相对 configDir 的位置：`<configDir>/plugins/feishu.json`。 */
const CONFIG_FILE_RELATIVE = ["plugins", "feishu.json"] as const;

/** 读取配置文件的依赖注入点（测试可注入 configDir / readFile）。 */
export interface ResolveConfigDeps {
  /** 显式覆盖 configDir；默认取 `OPENCODE_CONFIG_DIR` 或 `~/.config/opencode`。 */
  readonly configDir?: string;
  /** 读取文本文件；默认 `fs.readFileSync(path, "utf8")`。 */
  readonly readFile?: (path: string) => string;
}

/**
 * 解析插件配置。
 *
 * 优先级（字段级）：`options` > `<configDir>/plugins/feishu.json` > 环境变量
 * （`FEISHU_APP_ID` / `FEISHU_APP_SECRET`，仅这两个字段兜底）。
 *
 * 红线：**永不抛异常**。文件缺失/非法 JSON/不可读只产生 warning 并退回下一优先级；
 * 最终缺少 appId/appSecret 时禁用插件，绝不把用户的 opencode 弄挂。
 * warning / disabledReason 中**永不包含 secret 明文**。
 */
export function resolveConfig(
  raw: RawOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveConfigDeps = {},
): ResolvedConfig {
  const warnings: string[] = [];
  const options = raw ?? {};

  // options 优先，配置文件补足缺失字段。
  const fileConfig = loadConfigFile(env, deps, warnings);
  const merged = mergeRaw(fileConfig, options);

  const appId = expandEnv(asString(merged.appId), env) || asString(env.FEISHU_APP_ID).trim();
  const appSecret =
    expandEnv(asString(merged.appSecret), env) || asString(env.FEISHU_APP_SECRET).trim();
  const allowUsers = asStringArray(merged.allowUsers);
  const allowTools = normalizeToolList(merged.allowTools, DEFAULT_ALLOW_TOOLS);
  const denyTools = normalizeToolList(merged.denyTools, []);
  const gate = asGate(merged.permissionGate);
  const logLevel = asLogLevel(merged.logLevel);
  const stream = asBoolean(merged.stream, true);
  const threadRouting = asBoolean(merged.threadRouting, true);
  const topicGuidance = asBoolean(merged.topicGuidance, true);
  const throttle = clamp(asNumber(merged.streamThrottleMs, 400), 400, 60_000);
  const approvalTtlMs = clamp(asNumber(merged.approvalTtlMs, 10 * 60 * 1000), 30_000, 24 * 60 * 60 * 1000);
  const staleExecutionMs = clamp(asNumber(merged.staleExecutionMs, 5 * 60 * 1000), 0, 60 * 60 * 1000);
  const maxResourcesShown = clamp(asNumber(merged.maxResourcesShown, 8), 1, 50);
  const allowedRootsRaw = asStringArray(merged.allowedRoots);
  const allowedRootsCandidates = (allowedRootsRaw.length > 0 ? allowedRootsRaw : [...DEFAULT_ALLOWED_ROOTS]).filter(isAbsolute);
  const allowedRoots = allowedRootsCandidates.length > 0 ? allowedRootsCandidates : [...DEFAULT_ALLOWED_ROOTS];
  const recentDirsLimit = clamp(asNumber(merged.recentDirsLimit, 5), 1, 20);
  const recentModelsLimit = clamp(asNumber(merged.recentModelsLimit, 5), 1, 20);
  const sessionPageSize = clamp(asNumber(merged.sessionPageSize, 8), 5, 20);
  const sessionAllowButton = asBoolean(merged.sessionAllowButton, true);
  const resumeSummary = asBoolean(merged.resumeSummary, true);
  const resumeSummaryTimeoutMs = clamp(asNumber(merged.resumeSummaryTimeoutMs, 15_000), 3_000, 60_000);
  const resumeCompactTimeoutMs = clamp(asNumber(merged.resumeCompactTimeoutMs, 120_000), 30_000, 300_000);
  const topicStatus = asBoolean(merged.topicStatus, true);
  const topicStatusInTitle = asBoolean(merged.topicStatusInTitle, false);
  const topicStatusThrottleMs = clamp(asNumber(merged.topicStatusThrottleMs, 1_000), 500, 10_000);
  const cardMaxTables = clamp(asNumber(merged.cardMaxTables, 4), 1, 5);
  const keepalive = asBoolean(merged.keepalive, true);
  const runnerCardMaxTools = clamp(asNumber(merged.runnerCardMaxTools, 12), 1, 50);
  const runnerCardTextMax = clamp(asNumber(merged.runnerCardTextMax, 2048), 512, 8192);
  const finalAnswerMinChars = clamp(asNumber(merged.finalAnswerMinChars, 600), 0, 20_000);
  const finalAnswerFileMinBytes = clamp(asNumber(merged.finalAnswerFileMinBytes, 20 * 1024), 8192, 102_400);
  const acceptAttachments = asBoolean(merged.acceptAttachments, true);
  const attachmentMaxBytes = clamp(
    asNumber(merged.attachmentMaxBytes, 20 * 1024 * 1024),
    1024 * 1024,
    100 * 1024 * 1024,
  );
  const attachmentTimeoutMs = clamp(asNumber(merged.attachmentTimeoutMs, 30_000), 5_000, 120_000);
  const attachmentsDirRaw = asString(merged.attachmentsDir).trim();
  const keepaliveIntervalMs = clamp(
    asNumber(merged.keepaliveIntervalMs, 20 * 60 * 1000),
    5 * 60 * 1000,
    45 * 60 * 1000,
  );
  const domain = merged.domain === "lark" ? "lark" : "feishu";
  const logFile = resolveLogFile(merged.logFile, env, deps);
  const gatewayLocation = normalizeGatewayLocation(asString(merged.gatewayLocation));
  const gatewayMatchGraceMs = clamp(asNumber(merged.gatewayMatchGraceMs, 3000), 0, 10_000);

  const signSecretRaw = expandEnv(asString(merged.signSecret), env);
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
    warnings,
    appId,
    appSecret,
    domain,
    allowUsers,
    permissionGate: gate,
    allowTools,
    denyTools,
    stream,
    streamThrottleMs: throttle,
    threadRouting,
    topicGuidance,
    logLevel,
    logFile,
    gatewayLocation,
    gatewayMatchGraceMs,
    approvalTtlMs,
    staleExecutionMs,
    signSecret,
    maxResourcesShown,
    allowedRoots,
    recentDirsLimit,
    recentModelsLimit,
    sessionPageSize,
    sessionAllowButton,
    resumeSummary,
    resumeSummaryTimeoutMs,
    resumeCompactTimeoutMs,
    topicStatus,
    topicStatusInTitle,
    topicStatusThrottleMs,
    cardMaxTables,
    keepalive,
    keepaliveIntervalMs,
    runnerCardMaxTools,
    runnerCardTextMax,
    finalAnswerMinChars,
    finalAnswerFileMinBytes,
    acceptAttachments,
    attachmentMaxBytes,
    attachmentTimeoutMs,
    ...(attachmentsDirRaw ? { attachmentsDir: attachmentsDirRaw } : {}),
  };
}

/**
 * 读取 `<configDir>/plugins/feishu.json`。
 *
 * - 文件缺失（ENOENT）是正常路径：静默返回 `{}`。
 * - 不可读 / 非法 JSON / 非对象：只 warning 并返回 `{}`（退回环境变量/默认值），绝不抛异常。
 * - warning 文案不包含文件内容，避免 secret 泄漏到日志。
 */
function loadConfigFile(env: NodeJS.ProcessEnv, deps: ResolveConfigDeps, warnings: string[]): RawOptions {
  const configDir = resolveConfigDir(env, deps.configDir);
  const filePath = join(configDir, ...CONFIG_FILE_RELATIVE);
  const read = deps.readFile ?? ((path: string): string => readFileSync(path, "utf8"));

  let text: string;
  try {
    text = read(filePath);
  } catch (err) {
    if (!isNotFound(err)) {
      warnings.push(`读取 ${CONFIG_FILE_RELATIVE.join("/")} 失败，已忽略：${errorCode(err) ?? "unknown"}`);
    }
    return {};
  }

  if (!text.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 刻意不回显 JSON.parse 的报错（可能内嵌原文，存在泄漏 secret 的风险）。
    warnings.push(`${CONFIG_FILE_RELATIVE.join("/")} 不是合法 JSON，已忽略`);
    return {};
  }

  if (!isPlainObject(parsed)) {
    warnings.push(`${CONFIG_FILE_RELATIVE.join("/")} 顶层必须是 JSON 对象，已忽略`);
    return {};
  }
  return parsed;
}

/** options 覆盖 base（配置文件）；未显式提供的字段不覆盖。 */
function mergeRaw(base: RawOptions, override: RawOptions): RawOptions {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** configDir：显式依赖 > `OPENCODE_CONFIG_DIR` > `~/.config/opencode`。 */
function resolveConfigDir(env: NodeJS.ProcessEnv, explicit: string | undefined): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const fromEnv = asString(env.OPENCODE_CONFIG_DIR).trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".config", "opencode");
}

/**
 * 归一化 `gatewayLocation`：展开 `~`、转绝对路径、去尾斜杠，并尽力解析软链。
 *
 * 根因（issue：gatewayLocation 静默失败）：运行时 `here` 是解析后的**绝对真实路径**
 * （macOS 上 `/tmp` → `/private/tmp`），而配置侧原先只 `trim`，导致 `~/work`、相对路径、
 * 尾斜杠、软链路径都无法命中 → 网关静默不启动、机器人无响应。这里与 `allowedRoots`
 * 对齐口径（同样用 `resolve`，并额外 realpath）。
 */
export function normalizeGatewayLocation(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const expanded =
    trimmed === "~"
      ? homedir()
      : trimmed.startsWith("~/")
        ? join(homedir(), trimmed.slice(2))
        : trimmed;
  const resolved = resolve(expanded);
  // 目录可能尚不存在：realpath 失败就退回 resolve 结果（仍比原值可用）。
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * 解析日志文件路径。
 * - `false` / 未设置 → undefined（只写 stderr）
 * - `true` → `<configDir>/plugins/feishu.log`
 * - 字符串 → 展开 `~` 与 `${ENV}`；相对路径按 configDir 解析
 */
export function resolveLogFile(
  raw: unknown,
  env: NodeJS.ProcessEnv,
  deps: ResolveConfigDeps,
): string | undefined {
  if (raw === true) return join(resolveConfigDir(env, deps.configDir), ...LOG_FILE_RELATIVE);
  if (typeof raw !== "string") return undefined;
  const expanded = expandEnv(raw.trim(), env);
  if (!expanded) return undefined;
  if (expanded === "true") return join(resolveConfigDir(env, deps.configDir), ...LOG_FILE_RELATIVE);
  if (expanded.startsWith("~/")) return join(homedir(), expanded.slice(2));
  return isAbsolute(expanded) ? expanded : join(resolveConfigDir(env, deps.configDir), expanded);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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
