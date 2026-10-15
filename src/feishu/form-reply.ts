/**
 * 表单答复的 HTTP 兜底通道。
 *
 * 现状（opencode 2.0.16–2.0.18）：V2 插件的 `ctx.session` 域**不暴露** `form`
 * （`@opencode/plugin` 的 promise adapter 只接了 create/get/prompt/… 未接 form），
 * 因此 `ctx.session.form.reply` 在运行时恒为 `undefined`（旧实现会抛
 * “session.form.reply 不可用”，让表单永久卡在待回答态）。
 *
 * 但服务端本身提供 `POST /api/session/{sessionID}/form/{formID}/reply`，且插件与
 * 服务端同机：读取 opencode 的服务注册文件 `service.json` 发现本机 endpoint
 * （含 Basic 口令）即可提交答复，无需公网、无需额外配置。
 *
 * 与飞书 SDK 解耦，纯 IO + 可注入依赖，便于单测。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.js";
import type { FormValue } from "./forms.js";

/** 本机 opencode 服务 endpoint（来自 `service.json`）。 */
export interface LocalService {
  readonly url: string;
  readonly password?: string;
}

export interface HttpFormReplyInput {
  readonly sessionID: string;
  readonly formID: string;
  readonly answer: Readonly<Record<string, FormValue>>;
  readonly directory?: string;
}

export interface FormReplyDeps {
  readonly log: Logger;
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次提交超时，默认 8s。 */
  readonly timeoutMs?: number;
}

/** opencode 后台服务**运行态**注册文件路径：`$XDG_STATE_HOME/opencode/service.json`。 */
export function serviceStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "opencode", "service.json");
}

/**
 * opencode **配置**目录里的服务信息：`<configDir>/service.json`
 * （`OPENCODE_CONFIG_DIR` 或 `$XDG_CONFIG_HOME/opencode` 或 `~/.config/opencode`）。
 *
 * 为什么需要它：运行态注册文件只在 opencode **以 service 方式注册运行**时生成；
 * `opencode serve --hostname 0.0.0.0 --port 4096` 这类**直跑**（Docker 常见）不生成，
 * 于是服务发现恒失败 → 会话枚举为空 → 主聊天流 AI 静默回退成「管理台」卡。
 * 配置里通常仍有 `{ hostname, port, password }`，可组合出同样的 endpoint。
 */
export function serviceConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env["OPENCODE_CONFIG_DIR"] ?? "").trim();
  if (fromEnv) return join(fromEnv, "service.json");
  const base = env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "opencode", "service.json");
}

/** 监听地址 → 可连接地址：`0.0.0.0` / `::` / `*` 这类通配地址改写成 `127.0.0.1`。 */
function normaliseHost(hostname: string): string {
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (bare === "0.0.0.0" || bare === "::" || bare === "*") return "127.0.0.1";
  return bare.includes(":") ? `[${bare}]` : bare;
}

/**
 * 解析服务信息文本，支持两种形态；缺关键字段返回 `undefined`：
 * - 运行态注册：`{ url, password? }`（`url` 已含协议与端口）；
 * - 配置态：`{ hostname, port, password? }` → 组合成 `http://<host>:<port>`。
 *   要求 **hostname 与 port 同时存在**：只有 port 无法确定可达地址，宁可放弃。
 */
export function parseLocalService(text: string): LocalService | undefined {
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof info !== "object" || info === null) return undefined;
  const record = info as Record<string, unknown>;
  const password = record["password"];
  const withPassword = (url: string): LocalService => ({
    url: url.replace(/\/+$/, ""),
    ...(typeof password === "string" && password.length > 0 ? { password } : {}),
  });

  const url = record["url"];
  if (typeof url === "string" && url.length > 0) return withPassword(url);

  const hostname = record["hostname"];
  const port = record["port"];
  if (typeof hostname !== "string" || hostname.trim().length === 0) return undefined;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return withPassword(`http://${normaliseHost(hostname.trim())}:${port}`);
}

/** `discoverLocalService` 选项。 */
export interface DiscoverLocalServiceOptions {
  /** 覆盖环境变量（默认 `process.env`）。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 覆盖读文件（测试用）。 */
  readonly readFile?: (path: string) => Promise<string>;
  /**
   * 是否在「运行态注册」之后回退「配置态服务信息」。
   * 默认：**未显式传 `file` 时 `true`**；显式传 `file` 时 `false`（定向读取 / 单测隔离）。
   */
  readonly fallback?: boolean;
}

/**
 * 读取本机服务 endpoint（best-effort，缺失/损坏不抛错）。
 *
 * 来源按序尝试、命中即返回：显式 `file` 或 `serviceStatePath()` → `serviceConfigPath()`。
 * 第二来源保证**非 service 部署**（`opencode serve` 直跑）也能发现本机服务。
 */
export async function discoverLocalService(
  file?: string,
  opts: DiscoverLocalServiceOptions = {},
): Promise<LocalService | undefined> {
  const read = opts.readFile ?? ((path: string) => readFile(path, "utf8"));
  const candidates: string[] = file
    ? opts.fallback === true
      ? [file, serviceConfigPath(opts.env)]
      : [file]
    : opts.fallback === false
      ? [serviceStatePath(opts.env)]
      : [serviceStatePath(opts.env), serviceConfigPath(opts.env)];

  for (const candidate of candidates) {
    let text: string;
    try {
      text = await read(candidate);
    } catch {
      continue;
    }
    const service = parseLocalService(text);
    if (service) return service;
  }
  return undefined;
}

/** 构造本机服务的 Basic 认证头（无口令时返回空）。供其它本机 HTTP 兜底模块复用。 */
export function authHeaders(service: LocalService): Record<string, string> {
  if (!service.password) return {};
  const token = Buffer.from(`opencode:${service.password}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

/**
 * 经本机 HTTP API 提交表单答复。
 * 与 TUI 行为对齐：`x-opencode-directory` 用 URL 编码（跨 location 会话必需）。
 */
/**
 * 取消（跳过）一个 pending form：用户用普通消息回复了选项题时，
 * 需要先解除阻塞，再让这条消息作为普通 prompt 进入会话。
 */
export async function cancelFormOverHttp(
  input: { readonly sessionID: string; readonly formID: string; readonly directory?: string },
  deps: FormReplyDeps,
): Promise<void> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) throw new Error("未发现本机 opencode 服务注册（service.json 缺失或损坏）");

  const path = `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}`;
  const headers: Record<string, string> = { ...authHeaders(service) };
  if (input.directory) headers["x-opencode-directory"] = encodeURIComponent(input.directory);

  const response = await doFetch(`${service.url}${path}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    deps.log.debug("表单 HTTP 取消失败", { status: response.status, formID: input.formID });
    throw new Error(
      `表单取消失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
}

export async function replyFormOverHttp(
  input: HttpFormReplyInput,
  deps: FormReplyDeps,
): Promise<void> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) throw new Error("未发现本机 opencode 服务注册（service.json 缺失或损坏）");

  const path = `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/reply`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(service),
  };
  if (input.directory) headers["x-opencode-directory"] = encodeURIComponent(input.directory);

  const response = await doFetch(`${service.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ answer: input.answer }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    deps.log.debug("表单 HTTP 提交失败", { status: response.status, formID: input.formID });
    throw new Error(
      `表单提交失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
}
