/**
 * 位置保活（P8）：阻止 opencode 在**长期空闲**后回收 location 服务。
 *
 * 背景（实测 + 反编译取证）：
 * - opencode 的 `@opencode/LocationActivity` 对每个 location 维护一个
 *   **60 分钟** 的活动 TTL（`timeToLive ?? "60 minutes"`，仅当事件带
 *   `location` 时刷新；sweep 间隔 1 分钟）；
 * - TTL 到期即 `invalidate(location)` → **插件被卸载**（飞书长连接被关闭）；
 * - 该 location 之后若没有任何请求，插件永远不会重新 setup → **机器人永久沉默**。
 *
 * opencode 有**两条**独立的 60 分钟空闲回收路径（均已由源码/实测确认）：
 * 1. `LayerMap(idleTimeToLive: "60 minutes")`：由**会话级请求**续期
 *    （`sessionLocationLayer` 中间件必调 `locations.get()`）；若已回收，
 *    会话级请求还会**重建 location**（插件重新加载、长连接重连）。
 * 2. `@opencode/LocationActivity`（同为 60 分钟）：只由**带 location 的
 *    durable 事件**（如 `session.created`）续期；到期会 interrupt 活动会话后
 *    `invalidate(location)`（日志 `location services evicted`）。
 *
 * 本模块做两件事：
 * 1. `touchLocationOverHttp`：**双通道**续期——① 会话级 `GET /api/session/{id}`；
 *    ② 创建 + 立即删除探针会话（`session.created` 事件）；
 * 2. `startKeepalive`：按间隔周期性执行（默认 20 分钟 < 60 分钟 TTL）。
 *
 * 注意：插件自身被回收后无法自救（定时器随插件销毁）。要覆盖「服务重启 /
 * 长时间休眠 / 回收后」的场景，需**外部**保活（cron/systemd timer 调同一探针），
 * 见 README 的「保活」章节。
 */
import { errorMessage } from "../logger.js";
import { authHeaders, discoverLocalService, type LocalService } from "../feishu/form-reply.js";
import type { Logger } from "../types.js";

/** 探针会话标题（创建后立即删除，仅在极短窗口内可见）。 */
export const KEEPALIVE_SESSION_TITLE = "__opencode_feishu_keepalive__";

export interface TouchLocationDeps {
  readonly log: Logger;
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次请求超时，默认 8s。 */
  readonly timeoutMs?: number;
}

/**
 * 产生一次保活活动。opencode 有**两条**独立的 60 分钟空闲回收路径，需分别续期：
 *
 * 1. **LayerMap idle TTL**（`layer-services.ts` 里硬编码 `idleTimeToLive: "60 minutes"`）：
 *    只要有任何 `locations.get()`（即**会话级请求**）就会续期；若已被回收，
 *    会话级请求还会**重建 location**（插件重新加载、飞书长连接重连）。
 *    → 这里用 `GET /api/session/{id}`（会话级 middleware 必然 `locations.get()`）。
 * 2. **LocationActivity TTL**（`@opencode/LocationActivity`，同样 60 分钟）：
 *    只由**带 location 的 durable 事件**续期（`session.created` 等）。
 *    → 这里创建 + 立即删除一个探针会话，触发 `session.created`。
 *
 * 返回 `true` = 至少一条通道成功。
 */
export async function touchLocationOverHttp(
  directory: string,
  deps: TouchLocationDeps,
): Promise<boolean> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) {
    deps.log.debug("保活跳过：未发现本机 opencode 服务");
    return false;
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(service),
  };
  const timeout = deps.timeoutMs ?? 8000;
  const signal = () => AbortSignal.timeout(timeout);

  // ── 通道 1：会话级 GET（LayerMap 续期 / 必要时重建 location）─────────────
  let touched = false;
  try {
    const params = new URLSearchParams({ limit: "1", parentID: "null" });
    if (directory) params.set("directory", directory);
    const listRes = await doFetch(`${service.url}/api/session?${params.toString()}`, {
      method: "GET",
      headers,
      signal: signal(),
    });
    if (listRes.ok) {
      const list = (await listRes.json().catch(() => undefined)) as
        | { data?: Array<{ id?: string }> }
        | undefined;
      const target = list?.data?.[0]?.id;
      if (target) {
        const getRes = await doFetch(`${service.url}/api/session/${encodeURIComponent(target)}`, {
          method: "GET",
          headers,
          signal: signal(),
        });
        touched = getRes.ok;
      }
    }
  } catch (err) {
    deps.log.debug("保活会话级续期失败", { directory, error: errorMessage(err) });
  }

  // ── 通道 2：探针会话事件（LocationActivity 续期；location 已存在时才有效）──
  let sessionID: string | undefined;
  try {
    const response = await doFetch(`${service.url}/api/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: KEEPALIVE_SESSION_TITLE,
        ...(directory ? { location: { directory } } : {}),
      }),
      signal: signal(),
    });
    if (response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        | { data?: { id?: string } }
        | undefined;
      sessionID = body?.data?.id;
      touched = true;
    } else {
      deps.log.debug("保活探针创建失败", { status: response.status, directory });
    }
  } catch (err) {
    deps.log.debug("保活探针创建异常", { directory, error: errorMessage(err) });
  }

  // 立即删除探针会话（尽力而为：删除失败也只留一条空会话，不影响保活）。
  if (sessionID) {
    try {
      await doFetch(`${service.url}/api/session/${encodeURIComponent(sessionID)}`, {
        method: "DELETE",
        headers,
        signal: signal(),
      });
    } catch {
      /* best-effort */
    }
  }

  if (touched) deps.log.debug("保活心跳已发送", { directory, probe: sessionID ?? "(none)" });
  return touched;
}

export interface KeepaliveDeps {
  readonly log: Logger;
  /** 要保活的 location 目录（插件自身运行的目录）。 */
  readonly directory: string;
  /** 心跳间隔（默认 20 分钟；必须显著小于 opencode 的 60 分钟 TTL）。 */
  readonly intervalMs: number;
  /** 覆盖探针实现（测试用）。 */
  readonly touch?: (directory: string) => Promise<boolean>;
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

/**
 * 启动周期保活；返回停止函数。定时器 `unref()`，不阻止进程退出。
 * 首次心跳延迟一个间隔（启动当下已有活动，无需立即探针）。
 */
export function startKeepalive(deps: KeepaliveDeps): () => void {
  const setIntervalImpl = deps.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
  const touch = deps.touch ?? ((dir: string) => touchLocationOverHttp(dir, { log: deps.log }));

  const timer = setIntervalImpl(() => {
    void touch(deps.directory).catch((err) => {
      deps.log.debug("保活心跳异常", { error: errorMessage(err) });
    });
  }, deps.intervalMs);
  // Node 定时器：不因保活阻止进程退出。
  (timer as unknown as { unref?: () => void }).unref?.();

  deps.log.info("位置保活已启动", { directory: deps.directory, intervalMs: deps.intervalMs });
  return () => {
    clearIntervalImpl(timer);
  };
}
