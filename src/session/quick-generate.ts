/**
 * 快摘要的「临时生成」通道：**显式携带 `x-opencode-session`**。
 *
 * 背景（真实线上 BUG）：恢复卡的快摘要用 `ctx.generate.text`（一次性、不喂整个会话）生成，
 * 但该请求**缺少 `x-opencode-session`**，被 opencode-go 端按路由要求拒绝：
 * `Request is missing x-opencode-session and cannot be routed efficiently`。
 *
 * 因此这里实现两条通道并**优先 A、失败回退 B**：
 * - A：`ctx.generate.text(input, { headers })`——把 `x-opencode-session` 作为请求头传入。
 *   注意：当前运行时（`@opencode/plugin` promise adapter）**不转发** requestOptions，
 *   故该头实际可能不生效；A 仅作首选尝试，失败即回退 B。
 * - B：本机 HTTP `POST /api/experimental/generate`，沿用 `service.json` 的 Basic 认证与
 *   `x-opencode-directory` 做法（与 `compact-http.ts` 同源），**显式带 `x-opencode-session`**。
 *
 * 红线：**绝不**回退到 `ctx.session.generate`——那会把整个会话喂给模型，大会话必超时
 * （这也是之前已修的坑）。本模块只做一次性生成。
 *
 * 与飞书 SDK 解耦，纯 IO + 可注入依赖，便于单测。
 */
import { errorMessage } from "../logger.js";
import type { Logger } from "../types.js";
import { discoverLocalService, type LocalService } from "../feishu/form-reply.js";

export type QuickGenerateRoute = "generate" | "http";

export interface QuickGenerateInput {
  readonly prompt: string;
  readonly sessionID: string;
  readonly directory?: string;
}

export interface QuickGenerateOutcome {
  /** 实际走通的通道：A=`generate`，B=`http`。 */
  readonly route: QuickGenerateRoute;
  /** 原始生成结果（形状由 `extractGeneratedText` 归一化）。 */
  readonly result: unknown;
}

export interface QuickGenerateDeps {
  readonly log: Logger;
  /**
   * A 通道：`ctx.generate.text`。缺省 = A 不可用，直接走 B。
   * 第二个参数是请求选项（含 `x-opencode-session` 头），是否生效取决于运行时是否转发。
   */
  readonly generateText?: (
    prompt: string,
    requestOptions: { headers: Record<string, string> },
  ) => Promise<unknown>;
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** B 通道单次请求超时，默认 15s。 */
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

/**
 * 快摘要临时生成：优先 A（ctx.generate.text + 请求头），失败/空结果回退 B（本机 HTTP）。
 * 两条都不通时抛错，由上层（`summarizeSession`）收敛为「摘要生成失败」降级文案。
 */
export async function quickGenerateWithSession(
  deps: QuickGenerateDeps,
  input: QuickGenerateInput,
): Promise<QuickGenerateOutcome> {
  const headers = sessionRoutingHeaders(input.sessionID, input.directory);

  // A：首选。带 x-opencode-session 请求头（运行时若不转发，通常会 reject → 回退 B）。
  if (deps.generateText) {
    try {
      const result = await withAttemptTimeout(
        deps.generateText(input.prompt, { headers }),
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
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) throw new Error("生成 API 与 HTTP 通道均不可用（未发现本机 opencode 服务注册）");

  const response = await doFetch(`${service.url}/api/experimental/generate`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(service), ...headers },
    body: JSON.stringify({ prompt: input.prompt }),
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
