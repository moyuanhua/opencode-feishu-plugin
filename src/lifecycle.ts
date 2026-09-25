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
