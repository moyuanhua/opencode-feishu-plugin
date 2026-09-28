/**
 * `/sessions`（全量会话列表）的**本机 HTTP 兜底数据源**（P7.5）。
 *
 * 现状（opencode 2.0.16–2.0.18）：V2 插件的 `ctx.session` 域**不暴露** `list()`，
 * `/ls` 只能回退 `SessionMap`（仅含机器人自己登记过的会话），用户在 TUI/Web
 * 里开的会话看不到。本模块与 opencode 同机：读取服务注册文件 `service.json`
 * 发现本机 endpoint（含 Basic 口令），直接调 `GET /api/session` 拿全量列表。
 *
 * 与飞书 SDK 解耦，纯 IO + 可注入依赖，便于单测。
 */
import { errorMessage } from "../logger.js";
import { authHeaders, discoverLocalService, type LocalService } from "../feishu/form-reply.js";
import type { Logger } from "../types.js";

export interface ListSessionsHttpInput {
  /** 返回上限（默认 200）。 */
  readonly limit?: number;
  /** true（默认）= 只返回根会话，隐藏 subagent 子会话。 */
  readonly rootsOnly?: boolean;
  /** 按最近更新倒序（默认 desc）。 */
  readonly order?: "asc" | "desc";
}

export interface ListSessionsHttpDeps {
  readonly log: Logger;
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次请求超时，默认 8s。 */
  readonly timeoutMs?: number;
}

/**
 * 调 `GET /api/session` 拉全量会话列表，返回原始 JSON（形状交由
 * `normalizeSessionList` 归一化）。服务不可用/请求失败返回 `undefined`。
 */
export async function listSessionsOverHttp(
  input: ListSessionsHttpInput,
  deps: ListSessionsHttpDeps,
): Promise<unknown | undefined> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) {
    deps.log.debug("未发现本机 opencode 服务，HTTP 会话列表跳过");
    return undefined;
  }

  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? 200));
  params.set("order", input.order ?? "desc");
  if (input.rootsOnly ?? true) params.set("parentID", "null");

  try {
    const response = await doFetch(`${service.url}/api/session?${params.toString()}`, {
      method: "GET",
      headers: { ...authHeaders(service) },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
    });
    if (!response.ok) {
      deps.log.debug("HTTP 会话列表失败", { status: response.status });
      return undefined;
    }
    return await response.json();
  } catch (err) {
    deps.log.debug("HTTP 会话列表异常", { error: errorMessage(err) });
    return undefined;
  }
}
