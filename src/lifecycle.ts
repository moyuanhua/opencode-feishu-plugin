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
