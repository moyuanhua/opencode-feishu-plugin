/**
 * 权限答复的 HTTP 兜底通道（跨实例 / 跨 location）。
 *
 * 背景：`ctx.permission.reply` 只在**持有该 pending 请求的实例**内有效。多 opencode
 * 进程（TUI 内嵌 server + `opencode serve`）时，卡片回调可能落到非持有实例 →
 * `Permission request not found`，且此前被静默吞掉（issue #4）。
 *
 * 服务端提供 `POST /api/session/{sessionID}/permission/{requestID}/reply`（body `{ reply }`），
 * 插件与服务端同机：读取 `service.json` 发现本机 endpoint（含 Basic 口令），带上
 * `x-opencode-directory` 即可把答复投递到**持有该请求的 location**，无需公网/额外配置。
 *
 * 与飞书 SDK 解耦，纯 IO + 可注入依赖，便于单测。
 */
import type { Logger } from "../types.js";
import { authHeaders, discoverLocalService, type LocalService } from "./form-reply.js";

export type PermissionReplyValue = "once" | "always" | "reject";

export interface PermissionReplyHttpInput {
  readonly sessionID: string;
  readonly requestID: string;
  readonly reply: PermissionReplyValue;
  readonly directory?: string;
}

export interface PermissionReplyHttpDeps {
  readonly log: Logger;
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次请求超时，默认 8s。 */
  readonly timeoutMs?: number;
}

/**
 * 经本机 HTTP API 答复权限请求。
 * 与表单 HTTP 兜底一致：`x-opencode-directory` 用 URL 编码（跨 location 会话必需）。
 */
export async function replyPermissionOverHttp(
  input: PermissionReplyHttpInput,
  deps: PermissionReplyHttpDeps,
): Promise<void> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) throw new Error("未发现本机 opencode 服务注册（service.json 缺失或损坏）");

  const path = `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(
    input.requestID,
  )}/reply`;
  const headers: Record<string, string> = { "content-type": "application/json", ...authHeaders(service) };
  if (input.directory) headers["x-opencode-directory"] = encodeURIComponent(input.directory);

  const response = await doFetch(`${service.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reply: input.reply }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    deps.log.debug("权限 HTTP 答复失败", {
      status: response.status,
      requestID: input.requestID,
      hasDir: Boolean(input.directory),
    });
    throw new Error(`权限答复失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
}
