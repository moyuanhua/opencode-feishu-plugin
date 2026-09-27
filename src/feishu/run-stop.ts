/**
 * 运行卡「强制停止」按钮：value 解析/构建 + 点击校验 + 触发共享中断例程。
 *
 * 安全边界与审批卡一致：先白名单 → 验签 → 绑定 sessionID → 防重放。
 * token 复用 `src/security/token.ts`，绑定 sessionID + 用途标签 + 过期时间 + nonce；
 * 卡片每次 patch 都会重签（见 RunController），长任务不会因 token 过期而点不动。
 *
 * 纯逻辑 + 注入 IO：本模块不 import 飞书 SDK / opencode API，便于单测。
 */
import { errorMessage } from "../logger.js";
import type { CardAction, Logger } from "../types.js";
import type { ReplayGuard, StopClaims, VerifyResult } from "../security/token.js";

export const STOP_CMD = "stop" as const;

/** 按钮 value：`{ cmd: "stop", sid: <sessionID>, t: <token> }`。 */
export type StopActionValue = {
  readonly cmd: typeof STOP_CMD;
  readonly sid: string;
  readonly t: string;
};

/** 解析按钮 value；非本类卡片返回 undefined。 */
export function parseStopActionValue(raw: unknown): StopActionValue | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.cmd !== STOP_CMD) return undefined;
  const sid = typeof record.sid === "string" ? record.sid : "";
  const t = typeof record.t === "string" ? record.t : "";
  if (!sid || !t) return undefined;
  return { cmd: STOP_CMD, sid, t };
}

/** 构建按钮 value（token 由调用方签名）。 */
export function buildStopValue(sessionID: string, token: string): StopActionValue {
  return { cmd: STOP_CMD, sid: sessionID, t: token };
}

export interface StopInterruptResult {
  readonly ok: boolean;
}

export interface StopDeps {
  readonly log: Logger;
  readonly isAllowed: (openId: string) => boolean;
  readonly verify: (token: string, expectSessionID: string) => VerifyResult<StopClaims>;
  readonly replay: ReplayGuard;
  /** 运行卡签名（渲染时调用；每次 patch 重签）。 */
  readonly sign: (sessionID: string) => string;
  /** 该会话当前是否仍在运行（用于判定「该任务已结束」）。 */
  readonly isRunning: (sessionID: string) => boolean;
  /** 共享中断例程（中断 + 取消排队 + markEnded + 卡片收尾）。 */
  readonly interrupt: (sessionID: string, reason: string) => Promise<StopInterruptResult>;
  readonly now?: () => number;
}

export class StopController {
  private readonly now: () => number;

  constructor(private readonly deps: StopDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 渲染用按钮 value（含当次签名）。 */
  buildStopValue(sessionID: string): StopActionValue {
    return buildStopValue(sessionID, this.deps.sign(sessionID));
  }

  /**
   * 处理卡片点击：同步返回飞书回调响应（toast），中断在后台完成（<3s 窗口）。
   * 校验顺序：白名单 → 验签 → 绑定 sessionID → 防重放。
   */
  handleCardAction(action: CardAction): object {
    const parsed = parseStopActionValue(action.rawValue);
    if (!parsed) return toast("error", "无法识别的操作");

    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的强停点击", { operator: action.operatorOpenId.slice(0, 8) });
      return toast("error", "无操作权限");
    }

    const verified = this.deps.verify(parsed.t, parsed.sid);
    if (!verified.ok) {
      // 终态卡也渲染按钮：token 过期但任务已结束时只回 toast，不报错。
      if (verified.reason === "expired" && !this.deps.isRunning(parsed.sid)) {
        return toast("info", "该任务已结束");
      }
      this.deps.log.warn("强停 token 校验失败", { reason: verified.reason, sessionID: parsed.sid });
      return toast("error", `操作凭证无效（${verified.reason}）`);
    }

    // 已结束（或从未在本插件侧运行）：只回 toast，不消费 nonce、不触发中断。
    if (!this.deps.isRunning(parsed.sid)) {
      return toast("info", "该任务已结束");
    }

    const ttl = Math.max(1000, verified.claims.e - this.now());
    if (!this.deps.replay.consume(verified.claims.n, ttl)) {
      return toast("warning", "该操作已处理，请勿重复点击");
    }

    // 后台执行中断，绝不阻塞回调 3 秒窗口。
    void this.deps
      .interrupt(parsed.sid, "强制停止")
      .then((res) => {
        if (!res.ok) this.deps.log.warn("强制停止未完全成功", { sessionID: parsed.sid });
      })
      .catch((err) => this.deps.log.warn("强制停止失败", { sessionID: parsed.sid, error: errorMessage(err) }));

    return toast("success", "正在停止…");
  }
}

type ToastType = "success" | "error" | "warning" | "info";

function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}
