/**
 * 网关 leader 选举（跨 location / 跨进程）。
 *
 * 背景（实测）：opencode 按 location 加载全局插件，**每个 location 是独立 VM context**——
 * 进程内的 `globalThis` 单例（`acquireProcessGuard`）**跨 location 不生效**，于是每个
 * location 各起一条飞书长连接 + 一份事件订阅。而事件是**服务端全局**的（同一事件被各
 * 实例重复渲染成多张卡片），卡片回调（`card.action.trigger`）会落到**任意一条**长连接 →
 * 落到非持有该 pending 表单/审批的实例就报「表单失效 / Permission request not found」。
 *
 * `gatewayLocation` 能收敛正是因为「一个实例即可服务所有 location」。这里把它做成**自动**：
 * 在 `stateDir`（所有 location/进程共享）下用 **`mkdir` 原子建目录**做机器级互斥锁，
 * 只有一个实例成为 leader（起网关 + 事件订阅），其余实例直接跳过。
 *
 * 锁续期与接管：
 * - leader 周期性更新 owner 文件（心跳，mtime/内容）；
 * - owner 超过 `ttlMs` 未更新视为**过期**（进程被驱逐/崩溃且来不及清理）→ 其他实例接管；
 * - 接管用「删目录 + 重新 mkdir」，`mkdir` 原子性保证只有一个赢家；
 * - leader 发现自己已丢失所有权（owner 文件被删/换人）→ 停止心跳。
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { errorMessage } from "./logger.js";
import type { Logger } from "./types.js";

/** 锁目录（所有 location / 进程共享）：`<stateDir>/opencode/opencode-feishu-plugin.gateway.lock`。 */
export function gatewayLeaderLockDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "opencode", "opencode-feishu-plugin.gateway.lock");
}

export interface GatewayLeaderDeps {
  /** 锁目录；默认 `gatewayLeaderLockDir()`。 */
  readonly lockDir?: string;
  readonly log: Logger;
  /** owner 过期阈值（默认 90s；须显著大于心跳间隔）。 */
  readonly ttlMs?: number;
  /** 心跳间隔（默认 25s）。 */
  readonly heartbeatMs?: number;
  /** 可注入时钟（测试用）。 */
  readonly now?: () => number;
  /** 可注入实例 id（测试用）。 */
  readonly instanceId?: string;
}

export interface GatewayLeadership {
  /** true = 本实例当选（应启动网关）。false = 让位（不应启动网关）。 */
  readonly isLeader: boolean;
  /** 释放领导权（仅当仍持有）；非 leader 时为 no-op。 */
  release(): Promise<void>;
}

interface OwnerInfo {
  readonly id: string;
  readonly pid: number;
  readonly at: number;
}

/** 进程是否存活（`process.kill(pid, 0)`；EPERM 视为存活，ESRCH=已死）。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

/** 获取网关领导权（best-effort；任何异常都降级为「非 leader」，绝不阻塞插件加载）。 */
export async function acquireGatewayLeader(deps: GatewayLeaderDeps): Promise<GatewayLeadership> {
  const lockDir = deps.lockDir ?? gatewayLeaderLockDir();
  const ownerFile = join(lockDir, "owner.json");
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.ttlMs ?? 90_000;
  const heartbeat = Math.max(1_000, deps.heartbeatMs ?? 25_000);
  const id = deps.instanceId ?? randomUUID();
  const log = deps.log;

  const writeOwner = async (): Promise<void> => {
    const info: OwnerInfo = { id, pid: process.pid, at: now() };
    await writeFile(ownerFile, JSON.stringify(info), "utf8");
  };

  /** 尝试新建锁目录（mkdir 原子）；成功即当选。 */
  const claim = async (): Promise<boolean> => {
    try {
      await mkdir(dirname(lockDir), { recursive: true });
    } catch {
      /* 父目录创建失败也会在下面 mkdir 时报错 */
    }
    try {
      await mkdir(lockDir);
    } catch (err) {
      if ((err as { code?: string }).code === "EEXIST") return false;
      throw err;
    }
    await writeOwner();
    return true;
  };

  /** 读取 owner（缺失/损坏返回 undefined）。 */
  const readOwner = async (): Promise<Partial<OwnerInfo> | undefined> => {
    try {
      return JSON.parse(await readFile(ownerFile, "utf8")) as Partial<OwnerInfo>;
    } catch {
      return undefined;
    }
  };

  /**
   * 现有锁是否仍然「新鲜」。
   *
   * **owner 进程已死 → 立即视为过期**（不等 TTL）：`opencode service restart` / 崩溃会杀掉
   * 持有者但把锁文件留在磁盘上；只按 mtime 判断会让新进程在 TTL 内一直让位，叠加看门狗
   * 20 分钟间隔 → 出现十几分钟的空窗（实测 17 分钟）。
   */
  const isFresh = async (): Promise<boolean> => {
    const owner = await readOwner();
    if (typeof owner?.pid === "number" && !pidAlive(owner.pid)) return false;
    const t = now();
    for (const p of [ownerFile, lockDir]) {
      try {
        const st = await stat(p);
        if (t - st.mtimeMs <= ttl) return true;
      } catch {
        /* 继续看下一个 */
      }
    }
    return false;
  };

  let leader = false;
  try {
    leader = await claim();
    if (!leader && !(await isFresh())) {
      // 过期：清掉后重试（mkdir 原子性保证只有一个赢家）。
      try {
        await rm(lockDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      leader = await claim();
    }
  } catch (err) {
    log.warn("网关 leader 选举异常，降级为非 leader", { error: errorMessage(err) });
    leader = false;
  }

  if (!leader) {
    return { isLeader: false, release: async () => undefined };
  }

  let lost = false;
  const timer = setInterval(() => {
    void (async () => {
      if (lost) return;
      try {
        const txt = await readFile(ownerFile, "utf8");
        const owner = JSON.parse(txt) as Partial<OwnerInfo>;
        if (owner.id !== id) {
          // 已被接管：停止心跳（本实例已不是 leader）。
          lost = true;
          clearInterval(timer);
          log.warn("网关领导权被其他实例接管", { instanceId: id });
          return;
        }
        await writeOwner();
      } catch {
        // owner 文件被删（接管/清理）→ 认领丢失，停止心跳。
        lost = true;
        clearInterval(timer);
      }
    })();
  }, heartbeat);
  timer.unref?.();

  log.info("已当选网关 leader（本实例负责飞书长连接）", { instanceId: id, ttlMs: ttl });

  return {
    isLeader: true,
    release: async () => {
      clearInterval(timer);
      try {
        const txt = await readFile(ownerFile, "utf8");
        const owner = JSON.parse(txt) as Partial<OwnerInfo>;
        if (owner.id === id) await rm(lockDir, { recursive: true, force: true });
      } catch {
        /* 已不属于本实例或已被清理 */
      }
    },
  };
}
