import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireGatewayLeader, gatewayLeaderLockDir } from "../src/gateway-leader.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });
const dirs: string[] = [];
async function tmpLock(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "gw-leader-"));
  dirs.push(d);
  return join(d, "lock");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("gatewayLeaderLockDir", () => {
  test("优先 XDG_STATE_HOME，落在 opencode/ 下", () => {
    expect(gatewayLeaderLockDir({ XDG_STATE_HOME: "/xdg" })).toBe(
      "/xdg/opencode/opencode-feishu-plugin.gateway.lock",
    );
  });
});

describe("acquireGatewayLeader", () => {
  test("首个当选；未过期的第二个让位；释放后可再接管", async () => {
    const lockDir = await tmpLock();
    const a = await acquireGatewayLeader({ lockDir, log, instanceId: "A", ttlMs: 60_000, heartbeatMs: 60_000 });
    expect(a.isLeader).toBe(true);

    const b = await acquireGatewayLeader({ lockDir, log, instanceId: "B", ttlMs: 60_000, heartbeatMs: 60_000 });
    expect(b.isLeader).toBe(false);
    // 非 leader 释放是 no-op，不影响 A
    await b.release();

    await a.release();
    const c = await acquireGatewayLeader({ lockDir, log, instanceId: "C", ttlMs: 60_000, heartbeatMs: 60_000 });
    expect(c.isLeader).toBe(true);
    await c.release();
  });

  test("过期锁可被接管；旧 leader 释放不误删新锁", async () => {
    const lockDir = await tmpLock();
    const a = await acquireGatewayLeader({ lockDir, log, instanceId: "A", ttlMs: 80, heartbeatMs: 100_000 });
    expect(a.isLeader).toBe(true);

    await sleep(220); // 超过 ttl → A 过期
    const b = await acquireGatewayLeader({ lockDir, log, instanceId: "B", ttlMs: 80, heartbeatMs: 100_000 });
    expect(b.isLeader).toBe(true);

    // 旧 leader（A）释放：owner 已是 B，不得删除
    await a.release();
    const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as { id: string };
    expect(owner.id).toBe("B");

    await b.release();
  });

  test("owner 进程已死 → 立即接管（不等 TTL）", async () => {
    const lockDir = await tmpLock();
    await mkdir(lockDir, { recursive: true });
    // 写入一个「刚更新过」但 pid 已死的 owner（模拟 service restart / 崩溃）
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({ id: "dead", pid: 999_999, at: Date.now() }),
      "utf8",
    );
    const a = await acquireGatewayLeader({ lockDir, log, instanceId: "A", ttlMs: 60_000, heartbeatMs: 60_000 });
    expect(a.isLeader).toBe(true);
    await a.release();
  });
});
