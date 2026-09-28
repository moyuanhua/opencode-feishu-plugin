/**
 * 进程级 setup 单例守卫。
 *
 * opencode 会按 location 加载插件（全局插件随不同 location 各起一份），
 * 导致同一进程内 `setup` 被调用多次，从而起两个飞书 WS 客户端 → 重复回复/重复发卡。
 *
 * 用法：
 * ```ts
 * if (!guard.acquire()) { warn("重复 setup，跳过"); return async () => {}; }
 * ...
 * return async () => { if (!released) { released = true; guard.release(); ... } };
 * ```
 *
 * 关键约束：
 * - 第二次 setup 返回 **no-op cleanup**，绝不能影响第一次的资源；
 * - 第一次 cleanup 正常释放，释放后允许（如 opencode reload）再次 setup。
 */
export class SetupGuard {
  private active = false;

  /** 尝试占用；返回 true = 本次为首次，调用方负责真正启动。同步、无 await，避免竞态。 */
  acquire(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  /** 首次 cleanup 完成后释放。 */
  release(): void {
    this.active = false;
  }

  get running(): boolean {
    return this.active;
  }
}

/**
 * 进程级共享槽位。
 *
 * opencode 按 location 加载插件时，同一进程内会出现**多个模块实例**，
 * 模块级 `new SetupGuard()` 各持一份状态、挡不住重复 setup。用 `Symbol.for`
 * 把状态挂到 `globalThis`（同一 realm 内共享），跨模块实例生效。
 *
 * 若运行环境没有 `globalThis`（极老运行时），退化为模块级实例。
 */
const GUARD_SLOT = Symbol.for("opencode-feishu-v2/setup-guard");

interface GuardSlot {
  active: boolean;
}

export function acquireProcessGuard(): boolean {
  const g = globalThis as unknown as Record<symbol, GuardSlot | undefined>;
  let slot = g[GUARD_SLOT];
  if (!slot) {
    slot = { active: false };
    g[GUARD_SLOT] = slot;
  }
  if (slot.active) return false;
  slot.active = true;
  return true;
}

export function releaseProcessGuard(): void {
  const g = globalThis as unknown as Record<symbol, GuardSlot | undefined>;
  const slot = g[GUARD_SLOT];
  if (slot) slot.active = false;
}

/** 仅供诊断日志：当前 realm 是否已被占用。 */
export function isProcessGuardActive(): boolean {
  const g = globalThis as unknown as Record<symbol, GuardSlot | undefined>;
  return g[GUARD_SLOT]?.active === true;
}

/**
 * 兜底告警：配置了 `gatewayLocation` 但已加载的 location 无一命中时，用 `warn` 明确提示。
 *
 * 背景：`gatewayLocation` 匹配失败时网关静默不启动，用户只看到「机器人无响应」，
 * 默认 `info` 级别下没有任何日志，排查成本很高（见 issue：gatewayLocation 静默失败）。
 *
 * 各 location 的 `setup` 分别调用，这里用 `globalThis` 汇总已见 location（同进程 / 同 realm
 * 共享，与 `acquireProcessGuard` 同套路）：微延迟后若仍无一命中则告警一次。
 */
const GATEWAY_SEEN_SLOT = Symbol.for("opencode-feishu-v2/gateway-seen");

interface GatewaySeenSlot {
  /** 已配置的目标 gatewayLocation（归一化后）。 */
  expected: string;
  /** 已加载的 location 列表。 */
  seen: readonly string[];
  /** 是否已有 location 命中（命中即不再告警）。 */
  matched: boolean;
  /** 是否已告警（批次结束，之后不再告警）。 */
  warned: boolean;
  /** 待结算回调（关闭未命中实例的日志流等）。 */
  readonly onSettled: Array<() => void>;
  /** 延迟告警定时器。 */
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface GatewayLocationSeenInput {
  readonly here: string;
  readonly expected: string;
  /** `isUnder(here, expected)` 的结果。 */
  readonly matched: boolean;
  /** 未命中时延迟告警（进程内每个目标至多一次）。 */
  readonly warn: (message: string) => void;
  /** 该实例确定不会启动时调用；用于关闭它的日志流。 */
  readonly onSettled?: () => void;
  /** 告警延迟，默认 2000ms。 */
  readonly delayMs?: number;
}

/**
 * 记录一次 location setup，实现「配置了 gatewayLocation 但无一命中」的延迟告警。
 *
 * - 命中：标记 `matched`，立刻关闭此前未命中实例的日志流，**绝不告警**；
 * - 未命中：保留日志流，延迟后在仍无命中时用 `warn` 打出**一次**诊断；
 * - 目标变化（reload / 重新配置）：重置聚合状态。
 */
export function trackGatewayLocationSeen(input: GatewayLocationSeenInput): void {
  const g = globalThis as unknown as Record<symbol, GatewaySeenSlot | undefined>;
  let slot = g[GATEWAY_SEEN_SLOT];
  if (!slot || slot.expected !== input.expected) {
    // 目标变化：结算旧的（不告警），避免残留状态串场。
    if (slot) settle(slot);
    slot = { expected: input.expected, seen: [], matched: false, warned: false, onSettled: [], timer: undefined };
    g[GATEWAY_SEEN_SLOT] = slot;
  }
  const current = slot;
  if (!current.seen.includes(input.here)) current.seen = [...current.seen, input.here];

  if (input.matched) {
    current.matched = true;
    settle(current); // 关闭未命中实例的日志流；不告警
    return;
  }

  // 已有网关启动、或本批次已告警：本实例确定不启动，直接关闭日志流，不再告警。
  if (current.matched || current.warned) {
    runOnSettled(input.onSettled);
    return;
  }

  if (input.onSettled) current.onSettled.push(input.onSettled);
  // 每次未命中都重置定时器：等「所有 location 都加载完」再判定。
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    const live = g[GATEWAY_SEEN_SLOT];
    if (live !== current) return;
    current.timer = undefined;
    if (current.matched || current.warned) return;
    current.warned = true;
    input.warn(
      `已配置 gatewayLocation="${current.expected}"，但已加载的 location 均未命中：` +
        `[${current.seen.join(", ") || "(无)"}]。飞书长连接不会启动（机器人无响应）。` +
        `请确认 gatewayLocation 是实际打开 opencode 的目录或其父目录；留空则任意 location 生效。`,
    );
    runOnSettled(...current.onSettled.splice(0));
  }, input.delayMs ?? 2000);
}

/** 结算：清定时器、执行待结算回调；保留槽位（避免后续未命中实例误报）。 */
function settle(slot: GatewaySeenSlot): void {
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = undefined;
  }
  runOnSettled(...slot.onSettled.splice(0));
}

function runOnSettled(...callbacks: Array<(() => void) | undefined>): void {
  for (const cb of callbacks) {
    if (!cb) continue;
    try {
      cb();
    } catch {
      /* best-effort：关闭日志流失败不影响插件 */
    }
  }
}
