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

  // 探针本身也走一次会话级 GET（会话级 middleware 必调 locations.get()，
  // 是「location 被回收后重建」的可靠触发点），再删除。
  if (sessionID) {
    try {
      const getRes = await doFetch(`${service.url}/api/session/${encodeURIComponent(sessionID)}`, {
        method: "GET",
        headers,
        signal: signal(),
      });
      touched = touched || getRes.ok;
    } catch {
      /* best-effort */
    }
    try {
      await doFetch(`${service.url}/api/session/${encodeURIComponent(sessionID)}`, {
        method: "DELETE",
        headers,
        signal: signal(),
      });
    } catch {
      /* best-effort：删除失败也只留一条空会话，不影响保活 */
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
 * 进程级网关看门狗（P8.1）：**任何** location 的插件实例都会登记，
 * 但整个进程只保留一个定时器，周期性对「网关 location」做一次**会话级 GET**：
 *
 * - 网关仍存活 → `locations.get()` 续期（LayerMap TTL），零副作用；
 * - 网关已被回收 → 该请求**重建 location** → 网关插件重新加载、飞书长连接重连。
 *
 * 这样即使网关实例已随 location 被销毁，只要进程里还有**任何** location 的插件
 * 实例（例如用户在别的项目里开了 TUI/Web），网关就会被自动救活；
 * 服务重启后用户第一次使用任意 location 也会触发（无需外部 cron）。
 */
const WATCHDOG_SLOT = Symbol.for("opencode-feishu-v2/gateway-watchdog");

interface WatchdogSlot {
  /** 目标 location（网关实例可权威更新）。 */
  target: string;
  /** 可变状态：热重载后刷新为最新实例的探测实现与日志，避免持有已关闭的日志流。 */
  readonly state: {
    probe: (directory: string) => Promise<boolean>;
    log: Logger;
  };
  timer: ReturnType<typeof setInterval>;
  /** 首次立即探测（服务重启后尽快唤起）。 */
  initial?: ReturnType<typeof setTimeout>;
}

export interface GatewayWatchdogInput {
  readonly log: Logger;
  /** 目标 location：配了 gatewayLocation 用配置值，否则用当前实例目录。 */
  readonly directory: string;
  readonly intervalMs: number;
  /** 网关实例：允许把 target 更新为自己的实际目录。 */
  readonly authoritative?: boolean;
  /** 首次探测延迟（默认 3000ms；0 = 不立即探测）。 */
  readonly immediateDelayMs?: number;
  /** 覆盖探测实现（测试用）。 */
  readonly probe?: (directory: string) => Promise<boolean>;
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

/** 登记进程级看门狗。返回 true = 本次调用真正启动了定时器。 */
export function ensureGatewayWatchdog(input: GatewayWatchdogInput): boolean {
  const g = globalThis as unknown as Record<symbol, WatchdogSlot | undefined>;
  const existing = g[WATCHDOG_SLOT];
  if (existing) {
    if (input.authoritative && existing.target !== input.directory) {
      existing.target = input.directory;
      input.log.debug("网关看门狗目标更新为网关 location", { directory: input.directory });
    }
    // 热重载：刷新探测实现与日志，避免定时器一直持有旧实例（日志流可能已关闭）。
    existing.state.probe = input.probe ?? ((dir: string) => touchLocationOverHttp(dir, { log: input.log }));
    existing.state.log = input.log;
    return false;
  }

  const setIntervalImpl = input.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = input.clearIntervalImpl ?? clearInterval;
  const setTimeoutImpl = input.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = input.clearTimeoutImpl ?? clearTimeout;

  const slot: WatchdogSlot = {
    target: input.directory,
    state: {
      probe: input.probe ?? ((dir: string) => touchLocationOverHttp(dir, { log: input.log })),
      log: input.log,
    },
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    initial: undefined,
  };
  const run = (): void => {
    void slot.state.probe(slot.target).catch((err) => {
      slot.state.log.debug("网关看门狗探测异常", { error: errorMessage(err) });
    });
  };
  const delay = input.immediateDelayMs ?? 3000;
  if (delay > 0) slot.initial = setTimeoutImpl(run, delay);
  slot.timer = setIntervalImpl(run, input.intervalMs);
  (slot.timer as unknown as { unref?: () => void }).unref?.();
  (slot.initial as unknown as { unref?: () => void } | undefined)?.unref?.();
  g[WATCHDOG_SLOT] = slot;

  input.log.info("网关看门狗已启动（进程级）", {
    directory: input.directory,
    intervalMs: input.intervalMs,
  });
  return true;
}

/** 仅供测试：清空进程级看门狗状态。 */
export function resetGatewayWatchdogForTest(): void {
  const g = globalThis as unknown as Record<symbol, WatchdogSlot | undefined>;
  const slot = g[WATCHDOG_SLOT];
  if (!slot) return;
  clearInterval(slot.timer);
  if (slot.initial) clearTimeout(slot.initial);
  delete g[WATCHDOG_SLOT];
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
