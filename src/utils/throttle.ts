/**
 * 节流器：保证回调至少间隔 `intervalMs` 执行一次，并合并中间的调用（leading + trailing）。
 *
 * 用于飞书流式卡片更新（SPEC 要求节流 ≥400ms，同时飞书单条消息更新频控为 5 QPS）。
 */
export interface Throttler {
  /** 请求一次执行；返回 true 表示本次同步触发，false 表示已排队到尾部。 */
  schedule(): boolean;
  /** 立即执行挂起的 trailing 调用（若有）。 */
  flush(): void;
  /** 取消挂起的 trailing 调用并释放定时器。 */
  cancel(): void;
  readonly pending: boolean;
}

export interface ThrottlerOptions {
  readonly intervalMs: number;
  readonly onFire: () => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createThrottler(options: ThrottlerOptions): Throttler {
  const intervalMs = Math.max(0, options.intervalMs);
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trailing = false;

  const fire = (): void => {
    last = now();
    trailing = false;
    options.onFire();
  };

  const scheduleTrailing = (delay: number): void => {
    trailing = true;
    if (timer) return;
    timer = setTimer(() => {
      timer = undefined;
      if (trailing) fire();
    }, Math.max(0, delay));
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    schedule(): boolean {
      const elapsed = now() - last;
      if (elapsed >= intervalMs) {
        if (timer) {
          clearTimer(timer);
          timer = undefined;
        }
        fire();
        return true;
      }
      scheduleTrailing(intervalMs - elapsed);
      return false;
    },
    flush(): void {
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      if (trailing) fire();
    },
    cancel(): void {
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      trailing = false;
    },
    get pending(): boolean {
      return trailing;
    },
  };
}
