/**
 * 快摘要 / AI 会话管理的「临时生成」通道（**不喂整个会话**）。
 *
 * 背景（两次真实线上 BUG）：
 * 1. 恢复卡的快摘要最初用 `ctx.generate.text`（一次性、不喂整个会话）生成，
 *    但该请求**缺少 `x-opencode-session`**，被 opencode-go 端按路由要求拒绝：
 *    `Request is missing x-opencode-session and cannot be routed efficiently`。
 * 2. 即使显式补上 `x-opencode-session` 请求头，`/api/experimental/generate` 也在
 *    服务端**无会话上下文**，opencode-go 要求的会话头只有**会话管线**
 *    （SessionModelRequest）会自动附加 → 本机 opencode-go 环境下该端点必 503/400。
 *
 * 因此实现三条通道，**优先 C**、逐级回退：
 * - C：**临时会话**——建会话 → `POST /api/session/{id}/generate`（走会话管线，自动带
 *   `x-opencode-session` 等路由头）→ 删除会话。兼容任何 provider；临时会话仅瞬时存在，
 *   失败也会尽力删除。测试环境默认关闭（见 `QuickGenerateDeps.sessionChannel`）。
 * - A：`ctx.generate.text(input, { headers })`——把 `x-opencode-session` 作为请求头传入。
 *   注意：当前运行时（`@opencode/plugin` promise adapter）**不转发** requestOptions，
 *   故该头实际可能不生效；A 仅作次选尝试，失败即回退。
 * - B：本机 HTTP `POST /api/experimental/generate`，沿用 `service.json` 的 Basic 认证与
 *   `x-opencode-directory` 做法（与 `compact-http.ts` 同源），显式带 `x-opencode-session`。
 *
 * 三通道都**显式携带模型**（`input.model`）：未指定模型时，服务端要求基础配置里存在
 * "受支持的默认模型"，实际环境常见 400 `No model specified and no supported model is available`
 * （调用方用 `resolveGenerateModel` 解析：会话模型优先、模型列表兜底）。
 *
 * 红线：**绝不**回退到会话级全量生成（`ctx.session.generate` 喂整个会话）——大会话必超时。
 * C 通道使用**临时空会话**，上下文只有本次 prompt，与本红线不冲突。
 *
 * 与飞书 SDK 解耦，纯 IO + 可注入依赖，便于单测。
 */
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";
import { discoverLocalService, type LocalService } from "../feishu/form-reply.js";

export type QuickGenerateRoute = "generate" | "http" | "session";

/** 临时会话标题（瞬时存在，便于日志排查与误入列表时辨认）。 */
export const TEMP_SESSION_TITLE = "⚙️ 内部生成（临时，可忽略）";

export interface QuickGenerateInput {
  readonly prompt: string;
  readonly sessionID: string;
  readonly directory?: string;
  /**
   * 显式模型引用。**必须尽量提供**：本机 generate 接口在未指定模型时要求
   * 服务器基础配置存在"受支持的默认模型"，实际环境常见 400
   * （`No model specified and no supported model is available`）。
   */
  readonly model?: { readonly providerID: string; readonly id: string };
}

export interface QuickGenerateOutcome {
  /** 实际走通的通道：C=`session`，A=`generate`，B=`http`。 */
  readonly route: QuickGenerateRoute;
  /** 原始生成结果（形状由 `extractGeneratedText` 归一化）。 */
  readonly result: unknown;
}

export interface QuickGenerateDeps {
  readonly log: Logger;
  /**
   * A 通道：`ctx.generate.text`。缺省 = A 不可用，直接走 B。
   * 第二个参数是请求选项（含 `x-opencode-session` 头），是否生效取决于运行时是否转发；
   * 第三个参数是显式模型（服务端不接受"无模型"时必填，见 `QuickGenerateInput.model`）。
   */
  readonly generateText?: (
    prompt: string,
    requestOptions: { headers: Record<string, string> },
    model?: { readonly providerID: string; readonly id: string },
  ) => Promise<unknown>;
  /**
   * C 通道（临时会话）开关：
   * - `"auto"`（默认）：生产启用；**测试环境自动关闭**（单测直连本机服务会产生真实
   *   会话副作用）；
   * - `"on"` / `"off"`：显式启用 / 关闭。
   */
  readonly sessionChannel?: "auto" | "on" | "off";
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** B/C 通道单次请求超时，默认 15s。 */
  readonly timeoutMs?: number;
  /** A 通道尝试超时，默认 8s；超时即回退 B，避免 A 挂死拖垮整体。 */
  readonly attemptTimeoutMs?: number;
}

/** 路由头：会话标识 +（可选）URL 编码的工作目录。 */
export function sessionRoutingHeaders(sessionID: string, directory?: string): Record<string, string> {
  const headers: Record<string, string> = { "x-opencode-session": sessionID };
  if (directory) headers["x-opencode-directory"] = encodeURIComponent(directory);
  return headers;
}

function authHeaders(service: LocalService): Record<string, string> {
  if (!service.password) return {};
  const token = Buffer.from(`opencode:${service.password}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

/** C 通道是否启用（`auto` 在测试环境关闭，避免真实副作用）。 */
function sessionChannelEnabled(value: QuickGenerateDeps["sessionChannel"]): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  const env = process.env;
  return env["VITEST"] === undefined && env["NODE_ENV"] !== "test";
}

/**
 * 是否允许走**本机 HTTP**（服务发现 + fetch）：显式注入 `discover`/`fetchImpl` = 允许；
 * 否则测试环境默认禁止——集成测试直接复用真实依赖时，绝不能打到本机服务上产生真实副作用。
 */
function httpChannelAllowed(deps: QuickGenerateDeps): boolean {
  if (deps.discover || deps.fetchImpl) return true;
  const env = process.env;
  return env["VITEST"] === undefined && env["NODE_ENV"] !== "test";
}

/**
 * 临时生成：优先 C（临时会话），失败回退 A（ctx.generate.text）→ B（本机 HTTP）。
 * 三条都不通时抛错，由上层收敛为降级文案。
 */
export async function quickGenerateWithSession(
  deps: QuickGenerateDeps,
  input: QuickGenerateInput,
): Promise<QuickGenerateOutcome> {
  // 测试环境（未显式注入 discover/fetchImpl）不允许打本机服务：跳过 C/B，只留 A。
  const httpAllowed = httpChannelAllowed(deps);
  const discover = deps.discover ?? (() => discoverLocalService());
  const service = httpAllowed ? await discover().catch(() => undefined) : undefined;

  // C：首选。临时会话（建 → 会话内生成 → 删）：走会话管线，自动带 opencode-go 要求的
  // `x-opencode-session` 等路由头；无会话的 generate 端点拿不到这些头，实际环境必失败。
  if (service && sessionChannelEnabled(deps.sessionChannel)) {
    try {
      const result = await generateViaTemporarySession(deps, input, service);
      deps.log.info("快摘要生成走临时会话", { sessionID: input.sessionID, route: "session" });
      return { route: "session", result };
    } catch (err) {
      deps.log.debug("临时会话生成失败，回退生成 API / 本机 HTTP", {
        sessionID: input.sessionID,
        error: errorMessage(err),
      });
    }
  }

  const headers = sessionRoutingHeaders(input.sessionID, input.directory);

  // A：次选。带 x-opencode-session 请求头（运行时若不转发，通常会 reject → 回退 B）。
  if (deps.generateText) {
    try {
      const result = await withAttemptTimeout(
        deps.generateText(input.prompt, { headers }, input.model),
        deps.attemptTimeoutMs ?? 8_000,
      );
      if (result !== undefined && result !== null) {
        deps.log.info("快摘要生成走生成 API", { sessionID: input.sessionID, route: "generate" });
        return { route: "generate", result };
      }
      deps.log.debug("生成 API 返回空结果，回退本机 HTTP 生成", { sessionID: input.sessionID });
    } catch (err) {
      deps.log.debug("生成 API 失败，回退本机 HTTP 生成", {
        sessionID: input.sessionID,
        error: errorMessage(err),
      });
    }
  }

  // B：本机 HTTP `POST /api/experimental/generate`，显式带 x-opencode-session。
  const doFetch = deps.fetchImpl ?? fetch;
  if (!service) {
    throw new Error(
      httpAllowed
        ? "生成 API 与 HTTP 通道均不可用（未发现本机 opencode 服务注册）"
        : "测试环境已禁用本机 HTTP 生成通道（未显式注入 discover/fetchImpl）",
    );
  }

  const response = await doFetch(`${service.url}/api/experimental/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(service), ...headers },
    body: JSON.stringify({
      prompt: input.prompt,
      // 显式模型：未指定时服务端依赖"受支持的默认模型"，实际环境常见 400。
      ...(input.model ? { model: input.model } : {}),
    }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    deps.log.debug("HTTP 生成失败", { status: response.status, sessionID: input.sessionID });
    throw new Error(
      `HTTP 生成失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const result: unknown = await response.json();
  deps.log.info("快摘要生成走本机 HTTP 生成", { sessionID: input.sessionID, route: "http" });
  return { route: "http", result };
}

/**
 * C 通道：临时空会话一次性生成（建 → `session.generate` → 删）。
 *
 * 使用 `input.model` / `input.directory` 显式建会话，避免依赖服务器默认模型；
 * 删除在 `finally` 中**尽力而为**，绝不因删除失败影响生成结果，也尽量不留下临时会话。
 */
async function generateViaTemporarySession(
  deps: QuickGenerateDeps,
  input: QuickGenerateInput,
  service: LocalService,
): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = service.url.replace(/\/+$/, "");
  const auth = authHeaders(service);
  const dirHeader: Record<string, string> = input.directory
    ? { "x-opencode-directory": encodeURIComponent(input.directory) }
    : {};
  const timeout = deps.timeoutMs ?? 15_000;

  // 1) 建临时会话（显式模型 + 位置）。
  const created = await doFetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth, ...dirHeader },
    body: JSON.stringify({
      title: TEMP_SESSION_TITLE,
      ...(input.model ? { model: input.model } : {}),
      ...(input.directory ? { location: { directory: input.directory } } : {}),
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!created.ok) {
    const detail = await created.text().catch(() => "");
    throw new Error(`临时会话创建失败 HTTP ${created.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
  const tempID = extractSessionID(await created.json());
  if (!tempID) throw new Error("临时会话创建响应缺少会话 id");

  try {
    // 2) 会话内一次性生成（会话管线自动附加路由头）。
    const generated = await doFetch(`${base}/api/session/${encodeURIComponent(tempID)}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth, ...dirHeader },
      body: JSON.stringify({ prompt: input.prompt }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!generated.ok) {
      const detail = await generated.text().catch(() => "");
      throw new Error(`临时会话生成失败 HTTP ${generated.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    return (await generated.json()) as unknown;
  } finally {
    // 3) 删除临时会话（尽力而为）。
    await doFetch(`${base}/api/session/${encodeURIComponent(tempID)}`, {
      method: "DELETE",
      headers: { ...auth, ...dirHeader },
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}

/** 从会话创建响应中提取会话 id（容忍 `{data:{id}}` / `{id}` 两种形状）。 */
function extractSessionID(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const data = record["data"];
  const fromData =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)["id"]
      : undefined;
  const id = typeof record["id"] === "string" ? record["id"] : fromData;
  return typeof id === "string" && id.startsWith("ses") ? id : undefined;
}

/** 给 A 通道加超时；超时 reject，底层 promise 继续跑但被丢弃（附 catch 防 unhandled）。 */
function withAttemptTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("generate-attempt-timeout")), Math.max(1, ms));
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
