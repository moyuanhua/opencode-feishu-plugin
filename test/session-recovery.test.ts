import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { createSessionRecovery } from "../src/feishu/session-recovery.js";
import type { SessionLink } from "../src/types.js";

function captureLog() {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (line) => lines.push(line) });
  return { log, lines };
}

interface Calls {
  readonly interrupt: Array<{ sessionID: string; directory: string | undefined }>;
  readonly cancel: Array<{ sessionID: string; directory: string | undefined }>;
  readonly markEnded: string[];
  readonly finalize: Array<{ sessionID: string; error: string }>;
  readonly notify: Array<{ sessionID: string; reason: string; ok: boolean }>;
}

function setup(over: {
  link?: SessionLink | undefined;
  interruptThrows?: boolean;
  cancel?: { cancelled: number; error?: string };
} = {}) {
  const calls: Calls = { interrupt: [], cancel: [], markEnded: [], finalize: [], notify: [] };
  const { log, lines } = captureLog();
  const link = "link" in over ? over.link : { chatId: "oc_1", openId: "ou_1", dir: "/work" };
  const recovery = createSessionRecovery({
    log,
    resolveLink: async () => link,
    interrupt: async (sessionID, directory) => {
      calls.interrupt.push({ sessionID, directory });
      if (over.interruptThrows) throw new Error("boom");
    },
    cancelQueued: async (sessionID, directory) => {
      calls.cancel.push({ sessionID, directory });
      return over.cancel ?? { cancelled: 2 };
    },
    markEnded: (sessionID) => calls.markEnded.push(sessionID),
    finalizeCard: (sessionID, error) => calls.finalize.push({ sessionID, error }),
    notify: async (sessionID, reason, ok) => {
      calls.notify.push({ sessionID, reason, ok });
    },
  });
  return { recovery, calls, lines };
}

describe("createSessionRecovery.interrupt", () => {
  test("成功：中断 + 取消排队 + markEnded + 卡片收尾", async () => {
    const { recovery, calls } = setup();
    const res = await recovery.interrupt("ses_1", "强制停止");
    expect(res).toEqual({ ok: true, cancelled: 2 });
    expect(calls.interrupt).toEqual([{ sessionID: "ses_1", directory: "/work" }]);
    expect(calls.cancel).toEqual([{ sessionID: "ses_1", directory: "/work" }]);
    expect(calls.markEnded).toEqual(["ses_1"]);
    expect(calls.finalize).toEqual([{ sessionID: "ses_1", error: "已中断（强制停止）" }]);
  });

  test("中断失败：log.warn + 卡片注明 + ok=false，仍清理执行态", async () => {
    const { recovery, calls, lines } = setup({ interruptThrows: true });
    const res = await recovery.interrupt("ses_1", "长时间无进展");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
    expect(lines.some((l) => l.includes("中断服务端执行失败"))).toBe(true);
    expect(calls.markEnded).toEqual(["ses_1"]);
    expect(calls.finalize[0]!.error).toContain("中断失败：boom");
  });

  test("取消排队失败：log.warn + 卡片注明 + ok=false", async () => {
    const { recovery, calls, lines } = setup({ cancel: { cancelled: 1, error: "inbox down" } });
    const res = await recovery.interrupt("ses_1", "排队超时");
    expect(res).toEqual({ ok: false, cancelled: 1, error: undefined });
    expect(lines.some((l) => l.includes("取消排队消息失败"))).toBe(true);
    expect(calls.finalize[0]!.error).toContain("取消排队失败：inbox down");
  });
});

describe("createSessionRecovery.recover", () => {
  test("有飞书映射：中断并发送提示卡", async () => {
    const { recovery, calls } = setup();
    const res = await recovery.recover("ses_1", "排队超时");
    expect(res.ok).toBe(true);
    expect(calls.interrupt).toHaveLength(1);
    expect(calls.notify).toEqual([{ sessionID: "ses_1", reason: "排队超时", ok: true }]);
  });

  test("无飞书映射：不中断、不发提示卡（避免误伤本地 TUI）", async () => {
    const { recovery, calls } = setup({ link: undefined });
    const res = await recovery.recover("ses_tui", "长时间无进展");
    expect(res).toEqual({ ok: false, cancelled: 0, error: "no-link" });
    expect(calls.interrupt).toHaveLength(0);
    expect(calls.notify).toHaveLength(0);
  });
});
