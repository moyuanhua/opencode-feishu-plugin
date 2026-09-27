/**
 * 原生会话压缩的 HTTP 兜底通道。
 *
 * 与 `form-reply.ts` 同理：`ctx.session.compact` **不在** `@opencode/plugin`
 * 的 `SessionDomain` 公开 Pick 内（见 promise/session.d.ts），运行时可能为 `undefined`。
 * 服务端本身提供 `POST /api/session/{sessionID}/compact`，且插件与服务端同机：
 * 读 `service.json` 拿到本机 endpoint（含 Basic 口令）即可触发，无需公网。
 *
 * 注意：压缩**会修改会话历史**，本模块只在用户主动点「🗜 压缩并总结」时被调用。
 * 与飞书 SDK 解耦，纯 IO + 可注入依赖，便于单测。
 */
import type { Logger } from "../types.js";
import { discoverLocalService, type LocalService } from "../feishu/form-reply.js";

export interface CompactHttpDeps {
  readonly log: Logger;
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次请求超时，默认 30s。 */
  readonly timeoutMs?: number;
}

function authHeaders(service: LocalService): Record<string, string> {
  if (!service.password) return {};
  const token = Buffer.from(`opencode:${service.password}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

/**
 * 经本机 HTTP API 读取会话**完整消息** `GET /api/session/{id}/message`。
 *
 * `session.message.list` 不在插件 `SessionDomain` 公开 Pick 内，运行时可能缺失；
 * 返回 `{data:[...]}`，compaction 消息带 `type:"compaction"` + `status` + `summary`。
 * `x-opencode-directory` 用 URL 编码（跨 location 会话必需）。
 */
export async function fetchSessionMessagesHttp(
  sessionID: string,
  directory: string | undefined,
  deps: CompactHttpDeps,
): Promise<unknown> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) throw new Error("未发现本机 opencode 服务注册（service.json 缺失或损坏）");

  const path = `/api/session/${encodeURIComponent(sessionID)}/message?limit=200`;
  const headers: Record<string, string> = { ...authHeaders(service) };
  if (directory) headers["x-opencode-directory"] = encodeURIComponent(directory);

  const response = await doFetch(`${service.url}${path}`, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    deps.log.debug("会话消息 HTTP 读取失败", { status: response.status, sessionID });
    throw new Error(
      `会话消息读取失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  return response.json();
}

/**
 * 经本机 HTTP API 触发会话压缩。
 * `x-opencode-directory` 用 URL 编码（跨 location 会话必需，与 TUI 行为对齐）。
 */
export async function compactSessionHttp(
  sessionID: string,
  directory: string | undefined,
  deps: CompactHttpDeps,
): Promise<void> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) throw new Error("未发现本机 opencode 服务注册（service.json 缺失或损坏）");

  const path = `/api/session/${encodeURIComponent(sessionID)}/compact`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(service),
  };
  if (directory) headers["x-opencode-directory"] = encodeURIComponent(directory);

  const response = await doFetch(`${service.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    deps.log.debug("会话压缩 HTTP 触发失败", { status: response.status, sessionID });
    throw new Error(
      `会话压缩触发失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
}
