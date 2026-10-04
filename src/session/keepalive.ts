/**
 * 位置保活（P8）：阻止 opencode 在长期空闲后回收 location 服务；即便被回收也能自愈。
 *
 * 背景（源码反编译 + 本机实测取证）：
 * - opencode 对每个 location 有**两条**独立的 60 分钟空闲回收路径：
 *   ① `LayerMap(idleTimeToLive: "60 minutes")`：由**带 location 的 base 路由请求**续期
 *      （`locations.get()`）；若已回收，这类请求还会**重建 location**
 *      （日志 `location services booted`，插件重新加载、飞书长连接重连）。
 *   ② `@opencode/LocationActivity`（同为 60 分钟）：由**带该 location 的事件**续期；
 *      到期（且无活动会话）→ `invalidate(location)`（日志 `location services evicted`）→
 *      插件被卸载。
 *
 * **本机实测（v2.0.16）关键结论：**
 * - 会话路由（`GET/POST /api/session*`）**不**调用 `locations.get()` → 既不能续期 LayerMap，
 *   也不能重建已回收的 location（旧实现"会话级 GET 重建 location"的假设不成立）；
 * - `GET /api/plugin` 会调用 `locations.get()`：**续期 LayerMap；location 已回收时直接重建**
 *   （用 `location[directory]` 查询参数或 `x-opencode-directory` 头绑定 location，二者均实测有效）。
 *
 * 因此：
 * 1. `touchLocationOverHttp` 以 **`GET /api/plugin` 为主力**（续期 + 重建），探针会话仅作辅助；
 * 2. `ensureGatewayWatchdog` 是**进程级**定时器：`globalThis` 槽位在本进程内跨 location 共享
 *    （实测：另一个 location 的实例能看到首个实例的进程守卫），所以 **location 被回收、插件实例
 *    被卸载后，看门狗定时器仍然存活**；下一拍用 `/api/plugin` 把 location 拉起来 → 自愈。
 *    看门狗持有**独立的日志 sink**（不随实例 cleanup 关闭、也不会被后续实例的 logger 覆盖），
 *    保证被回收后的心跳日志仍能落盘。
 *
 * 注意：`LocationActivity` 的 60 分钟回收无法从插件侧完全阻止（会话事件不保证续期），
 * 本模块的保证是"被回收后一个心跳间隔内自愈"（默认 20 分钟），无需任何外部 cron。
 */
import { createLogger, createLogSink, errorMessage, type LogSink } from "../logger.js";
import { authHeaders, discoverLocalService, type LocalService } from "../feishu/form-reply.js";
import type { Logger, LogLevel } from "../types.js";

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
 * 产生一次保活活动：
 *
 * 1. **主力：`GET /api/plugin`**（base location 路由，实测唯一能触发 `locations.get()` 的通道）：
 *    - location 仍存活 → 续期 LayerMap idle TTL；
 *    - location 已被回收 → **重建**（`location services booted`，插件重新加载、长连接重连）。
 *    location 通过 `location[directory]` 查询参数 + `x-opencode-directory` 头**双重绑定**。
 * 2. **辅助：探针会话**（创建 + 立即删除）：尽力让 `LocationActivity` 收到一次带 location
 *    的 durable 事件；即使不生效也不影响主力通道。
 *
 * 返回 `true` = 至少一个通道成功。
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
  const timeout = deps.timeoutMs ?? 8000;
  const signal = () => AbortSignal.timeout(timeout);
  const dirHeader: Record<string, string> = directory
    ? { "x-opencode-directory": encodeURIComponent(directory) }
    : {};
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(service),
    ...dirHeader,
  };

  // ── 主力：`GET /api/plugin`（续期 LayerMap；已回收则重建 location）─────────
  let touched = false;
  try {
    const params = new URLSearchParams();
    if (directory) params.set("location[directory]", directory);
    const query = params.toString();
    const res = await doFetch(`${service.url}/api/plugin${query ? `?${query}` : ""}`, {
      method: "GET",
      headers: baseHeaders,
      signal: signal(),
    });
    if (res.ok) {
      touched = true;
    } else {
      deps.log.debug("保活位置探针失败", { directory, status: res.status });
    }
  } catch (err) {
    deps.log.debug("保活位置探针异常", { directory, error: errorMessage(err) });
  }

  // ── 辅助：探针会话（尝试让 LocationActivity 收到一次带 location 的事件）──
  let sessionID: string | undefined;
  try {
    const response = await doFetch(`${service.url}/api/session`, {
      method: "POST",
      headers: baseHeaders,
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

  // 探针用完即删（best-effort；删除失败只留一条空会话，不影响保活）。
  if (sessionID) {
    try {
      await doFetch(`${service.url}/api/session/${encodeURIComponent(sessionID)}`, {
        method: "DELETE",
        headers: baseHeaders,
        signal: signal(),
      });
    } catch {
      /* ignore */
    }
  }

  if (touched) deps.log.debug("保活心跳已发送", { directory, probe: sessionID ?? "(plugin)" });
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
 * 进程级网关看门狗（P8.1）：**任何** location 的插件实例都会登记，整个进程只保留一个定时器，
 * 周期性地对「网关 location」发一次 `GET /api/plugin`（base location 路由）：
 *
 * - 网关仍存活 → `locations.get()` 续期（LayerMap TTL），零副作用；
 * - 网关已被回收 → 该请求**重建 location** → 网关插件重新加载、飞书长连接重连。
 *
 * 槽位在 `globalThis` 上（本进程内跨 location 共享），因此**定时器与进程同寿**：
 * 即使唯一实例已随 location 被销毁，看门狗仍会把它救回来——无需外部 cron。
 *
 * 日志使用**独立 sink**（`logFile`）：不随实例 cleanup 关闭，也不会被后续热重载实例的
 * logger 覆盖；实例被卸载后的心跳记录仍能落盘，便于事后诊断。
 */
const WATCHDOG_SLOT = Symbol.for("opencode-feishu-v2/gateway-watchdog");

interface WatchdogState {
  probe: (directory: string) => Promise<boolean>;
  /** 看门狗独立 logger（创建后不再替换）。 */
  readonly log: Logger;
  /** 独立 sink 的关闭函数：仅测试 reset 调用；生产与进程同寿。 */
  readonly closeSink?: () => void;
  /** 创建时的默认探针依赖注入（重复登记未提供时沿用，避免热重载后探针落到真实网络）。 */
  readonly touchDeps?: GatewayWatchdogInput["touchDeps"];
}

interface WatchdogSlot {
  /** 目标 location（网关实例可权威更新）。 */
  target: string;
  /** 可变状态：热重载只刷新 probe 实现；log/sink 一经创建不再替换。 */
  readonly state: WatchdogState;
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
  /** 看门狗独立日志文件（生产强烈建议配置：实例卸载后心跳仍能落盘）。 */
  readonly logFile?: string;
  /** 独立日志级别（建议传配置值；缺省 info）。 */
  readonly logLevel?: LogLevel;
  /** 测试注入：独立 sink 工厂（默认 `createLogSink`）。 */
  readonly makeSink?: (file: string) => LogSink | undefined;
  /** 默认探针的依赖注入（discover / fetchImpl / timeoutMs；测试用）。 */
  readonly touchDeps?: Pick<TouchLocationDeps, "discover" | "fetchImpl" | "timeoutMs">;
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
}

/** 默认探针：绑定看门狗**自己的** logger（与实例生命周期解耦）。 */
function defaultProbe(
  log: Logger,
  touchDeps: GatewayWatchdogInput["touchDeps"],
): (directory: string) => Promise<boolean> {
  return (dir) => touchLocationOverHttp(dir, { log, ...(touchDeps ?? {}) });
}

/** 创建看门狗独立 logger（一次性，随后由槽位持有）。 */
function createWatchdogLogger(input: GatewayWatchdogInput): { log: Logger; closeSink?: () => void } {
  if (!input.logFile) return { log: input.log };
  const make = input.makeSink ?? createLogSink;
  const sink = make(input.logFile);
  if (!sink) return { log: input.log };
  return {
    log: createLogger({ level: input.logLevel ?? "info", sink: sink.sink }),
    closeSink: sink.close,
  };
}

/** 登记进程级看门狗。返回 true = 本次调用真正启动了定时器。 */
export function ensureGatewayWatchdog(input: GatewayWatchdogInput): boolean {
  const g = globalThis as unknown as Record<symbol, WatchdogSlot | undefined>;
  let existing = g[WATCHDOG_SLOT];
  // 兼容旧版本（≤ v0.2.2）遗留的槽位：结构不同（无 state），直接清掉重建，
  // 既避免 TypeError，也确保新行为生效。
  if (existing && !existing.state) {
    clearWatchdogSlot(existing);
    existing = undefined;
  }
  if (existing) {
    if (input.authoritative && existing.target !== input.directory) {
      existing.target = input.directory;
      input.log.debug("网关看门狗目标更新为网关 location", { directory: input.directory });
    }
    // 热重载：只刷新探测实现，并让它绑定**看门狗自己的** logger；
    // **绝不**替换 state.log / 关闭独立 sink——实例 logger 会随实例 cleanup 关闭，
    // 一旦被劫持，location 回收后的心跳日志就会全部丢失（真实故障）。
    existing.state.probe =
      input.probe ?? defaultProbe(existing.state.log, input.touchDeps ?? existing.state.touchDeps);
    return false;
  }

  const setIntervalImpl = input.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = input.clearIntervalImpl ?? clearInterval;
  const setTimeoutImpl = input.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = input.clearTimeoutImpl ?? clearTimeout;

  const dedicated = createWatchdogLogger(input);
  const slot: WatchdogSlot = {
    target: input.directory,
    state: {
      probe: input.probe ?? defaultProbe(dedicated.log, input.touchDeps),
      log: dedicated.log,
      ...(dedicated.closeSink ? { closeSink: dedicated.closeSink } : {}),
      ...(input.touchDeps ? { touchDeps: input.touchDeps } : {}),
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

  slot.state.log.info("网关看门狗已启动（进程级，随进程存活）", {
    directory: input.directory,
    intervalMs: input.intervalMs,
    independentLog: Boolean(dedicated.closeSink),
  });
  return true;
}

/** 清掉进程级看门狗槽位（对旧版本结构也能安全处理）。 */
function clearWatchdogSlot(slot: unknown): void {
  const s = (slot ?? {}) as {
    timer?: unknown;
    initial?: unknown;
    state?: { closeSink?: () => void };
  };
  if (s.timer) clearInterval(s.timer as ReturnType<typeof setInterval>);
  if (s.initial) clearTimeout(s.initial as ReturnType<typeof setTimeout>);
  try {
    s.state?.closeSink?.();
  } catch {
    /* ignore */
  }
  const g = globalThis as unknown as Record<symbol, WatchdogSlot | undefined>;
  if (g[WATCHDOG_SLOT] === slot) delete g[WATCHDOG_SLOT];
}

/** 仅供测试：清空进程级看门狗状态。 */
export function resetGatewayWatchdogForTest(): void {
  const g = globalThis as unknown as Record<symbol, WatchdogSlot | undefined>;
  clearWatchdogSlot(g[WATCHDOG_SLOT]);
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
