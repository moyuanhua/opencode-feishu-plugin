import { describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { ReplayGuard, signStop, verifyStop } from "../src/security/token.js";
import type { CardAction } from "../src/types.js";
import {
  buildCompactValue,
  compactFailureText,
  CompactController,
  parseCompactActionValue,
} from "../src/session/compact.js";

const SECRET = "test-secret";
const log = createLogger({ level: "error", sink: () => undefined });

const compaction = (summary: string, status = "completed") => ({ type: "compaction", status, summary });

function tokenFor(sessionID: string, ttlMs = 60_000, now = Date.now()): string {
  return signStop({ sessionID, ttlMs, now }, SECRET);
}

interface SetupOptions {
  readonly allowed?: boolean;
  readonly now?: number;
  /** 每次 readMessages 返回的内容序列；用完后重复最后一项。 */
  readonly reads?: readonly unknown[];
  readonly compactThrows?: Error;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

function setup(opts: SetupOptions = {}) {
  const reads = opts.reads ?? [[]];
  let readIndex = 0;
  const readMessages = vi.fn(async () => {
    const value = reads[Math.min(readIndex, reads.length - 1)];
    readIndex += 1;
    return value;
  });
  const compact = opts.compactThrows
    ? vi.fn(async (_sessionID: string) => { throw opts.compactThrows; })
    : vi.fn(async (_sessionID: string) => undefined);
  const patch = vi.fn(async (_sessionID: string, _text: string, _kind: "completed" | "failed", _messageId: string) => undefined);
  const controller = new CompactController({
    log,
    isAllowed: () => opts.allowed ?? true,
    verify: (token, sessionID) =>
      verifyStop(token, SECRET, { expectSessionID: sessionID, ...(opts.now ? { now: opts.now } : {}) }),
    replay: new ReplayGuard(60_000),
    compact,
    readMessages,
    patch,
    pollIntervalMs: opts.pollIntervalMs ?? 1,
    timeoutMs: opts.timeoutMs ?? 1000,
  });
  return { controller, compact, patch, readMessages };
}

function action(value: unknown, operatorOpenId = "ou_1"): CardAction {
  return { rawValue: value, messageId: "om_card", chatId: "oc_1", operatorOpenId };
}

describe("parseCompactActionValue / buildCompactValue", () => {
  test("合法 value 解析", () => {
    expect(parseCompactActionValue({ cmd: "compact", s: "ses_1", t: "tok" })).toEqual({
      cmd: "compact",
      s: "ses_1",
      t: "tok",
    });
  });

  test("非本类 / 缺字段返回 undefined", () => {
    expect(parseCompactActionValue({ cmd: "open", s: "x" })).toBeUndefined();
    expect(parseCompactActionValue({ cmd: "compact", s: "", t: "tok" })).toBeUndefined();
    expect(parseCompactActionValue({ cmd: "compact", s: "ses_1", t: "" })).toBeUndefined();
    expect(parseCompactActionValue("compact")).toBeUndefined();
    expect(parseCompactActionValue(null)).toBeUndefined();
  });

  test("buildCompactValue 带上 token", () => {
    expect(buildCompactValue("ses_1", "tok")).toEqual({ cmd: "compact", s: "ses_1", t: "tok" });
  });
});

describe("CompactController.handleCardAction（校验边界）", () => {
  test("合法点击：3 秒内同步回 toast，后台调用 compact", async () => {
    const { controller, compact } = setup({ reads: [[], [compaction("新摘要")]] });
    const res = controller.handleCardAction(
      action({ cmd: "compact", s: "ses_1", t: tokenFor("ses_1") }),
    ) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("success");
    expect(res.toast.content).toContain("正在压缩");
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
    expect(compact).toHaveBeenCalledWith("ses_1");
  });

  test("伪造 token 拒绝，不触发 compact", () => {
    const { controller, compact } = setup();
    const res = controller.handleCardAction(
      action({ cmd: "compact", s: "ses_1", t: `${tokenFor("ses_1")}x` }),
    ) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
    expect(res.toast.content).toContain("操作凭证无效");
    expect(compact).not.toHaveBeenCalled();
  });

  test("非白名单 operator 拒绝（即使 token 合法）", () => {
    const { controller, compact } = setup({ allowed: false });
    const res = controller.handleCardAction(
      action({ cmd: "compact", s: "ses_1", t: tokenFor("ses_1") }, "ou_evil"),
    ) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
    expect(res.toast.content).toContain("无操作权限");
    expect(compact).not.toHaveBeenCalled();
  });

  test("sessionID 不匹配拒绝", () => {
    const { controller, compact } = setup();
    const res = controller.handleCardAction(
      action({ cmd: "compact", s: "ses_1", t: tokenFor("ses_other") }),
    ) as { toast: { type: string; content: string } };
    expect(res.toast.type).toBe("error");
    expect(res.toast.content).toContain("session-mismatch");
    expect(compact).not.toHaveBeenCalled();
  });

  test("重复点击只回 toast，不重复压缩", async () => {
    const { controller, compact } = setup({ reads: [[], [compaction("新摘要")]] });
    const value = { cmd: "compact", s: "ses_1", t: tokenFor("ses_1") };
    const first = controller.handleCardAction(action(value)) as { toast: { type: string } };
    const second = controller.handleCardAction(action(value)) as { toast: { type: string; content: string } };
    expect(first.toast.type).toBe("success");
    expect(second.toast.type).toBe("warning");
    expect(second.toast.content).toContain("已处理");
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
  });

  test("无法识别的 value", () => {
    const { controller } = setup();
    const res = controller.handleCardAction(action({ cmd: "nope" })) as { toast: { type: string } };
    expect(res.toast.type).toBe("error");
  });
});

describe("CompactController.run（触发 + 轮询 + patch）", () => {
  test("轮询到新 completed 摘要 → patch「已压缩 · 会话摘要」", async () => {
    const reads: unknown[] = [[], [], [compaction("压缩后的摘要")]];
    const { controller, compact, patch } = setup({ reads });
    const result = await controller.run("ses_1");
    expect(compact).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe("压缩后的摘要");
    expect(patch).toHaveBeenCalledTimes(1);
    const [, text, kind] = patch.mock.calls[0]!;
    expect(text).toContain("已压缩 · 会话摘要");
    expect(text).toContain("压缩后的摘要");
    expect(kind).toBe("completed");
  });

  test("baseline 已有摘要：轮询到同一摘要不算完成（必须出现**新的**）", async () => {
    const reads: unknown[] = [[compaction("旧摘要")], [compaction("旧摘要")], [compaction("新摘要")]];
    const { controller, patch } = setup({ reads });
    const result = await controller.run("ses_1");
    expect(result.summary).toBe("新摘要");
    expect(patch.mock.calls[0]![1]).toContain("新摘要");
  });

  test("触发压缩抛错 → patch 失败说明，不轮询", async () => {
    const { controller, patch, readMessages } = setup({ compactThrows: new Error("boom") });
    const result = await controller.run("ses_1");
    expect(result.error).toContain("boom");
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]![1]).toContain("压缩会话失败");
    expect(patch.mock.calls[0]![2]).toBe("failed");
    expect(readMessages).toHaveBeenCalledTimes(1); // 只读了一次 baseline，未进入轮询
  });

  test("超时（轮询内始终无新摘要）→ patch 超时说明", async () => {
    let clock = 0;
    const { controller, patch } = setup({ reads: [[], []], timeoutMs: 5, pollIntervalMs: 1 });
    // 用注入时钟推进：这里直接调 run（sleep 用真实 setTimeout，很快）。
    const result = await controller.run("ses_1");
    expect(result.error).toBe("timeout");
    expect(patch.mock.calls[0]![1]).toContain("压缩会话超时");
    expect(patch.mock.calls[0]![2]).toBe("failed");
    void clock;
  });

  test("读消息抛错不影响轮询继续（读到新摘要即可）", async () => {
    let calls = 0;
    const readMessages = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return []; // baseline
      if (calls === 2) throw new Error("transient");
      return [compaction("最终摘要")];
    });
    const patch = vi.fn(async (_s: string, _t: string, _k: "completed" | "failed", _m: string) => undefined);
    const controller = new CompactController({
      log,
      isAllowed: () => true,
      verify: (t, s) => verifyStop(t, SECRET, { expectSessionID: s }),
      replay: new ReplayGuard(60_000),
      compact: async () => undefined,
      readMessages,
      patch,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });
    const result = await controller.run("ses_1");
    expect(result.summary).toBe("最终摘要");
  });

  test("patch 抛错只 log，不外抛", async () => {
    const reads: unknown[] = [[compaction("摘要")]];
    const patch = vi.fn(async (_s: string, _t: string, _k: "completed" | "failed", _m: string) => { throw new Error("patch boom"); });
    const controller = new CompactController({
      log,
      isAllowed: () => true,
      verify: (t, s) => verifyStop(t, SECRET, { expectSessionID: s }),
      replay: new ReplayGuard(60_000),
      compact: async () => undefined,
      readMessages: async () => reads[0],
      patch,
      pollIntervalMs: 1,
      timeoutMs: 50,
    });
    await expect(controller.run("ses_1")).resolves.toBeDefined();
  });
});

describe("compactFailureText", () => {
  test("超时 / 失败文案均提示可继续干活", () => {
    expect(compactFailureText("timeout")).toContain("超时");
    expect(compactFailureText("timeout")).toContain("继续");
    expect(compactFailureText("oauth error")).toContain("oauth error");
    expect(compactFailureText("oauth error")).toContain("继续");
  });
});
