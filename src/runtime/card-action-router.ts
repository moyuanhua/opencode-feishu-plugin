/**
 * 卡片回调分流（纯重构：从 `index.ts` 抽出）。
 *
 * 约定：飞书要求卡片回调 **3 秒内**返回 toast；真正的重活由各 handler 内部
 * fire-and-forget 完成。本模块只做「谁处理」的分流判定，保持原顺序：
 * 表单中继 → 强停按钮 → 会话卡/向导卡/表单提交（commands）→ 审批卡（approvals）。
 */
import type { CardAction, Logger } from "../types.js";
import { parseStopActionValue } from "../feishu/run-stop.js";
import { parseSessionCardValue } from "../feishu/session-cards.js";
import { parseCompactActionValue } from "../session/compact.js";
import { parseQuickNewActionValue } from "../feishu/quick-new-cards.js";
import { isSetupFormAction, parseSetupCardValue } from "../feishu/setup-cards.js";

export interface CardActionRouterDeps {
  readonly log: Logger;
  /** opencode 表单卡（含 question 工具）中继；命中返回响应，否则 undefined。 */
  readonly handleForm: (action: CardAction) => object | undefined;
  /** 运行卡「强制停止」按钮（独立校验路径）。 */
  readonly handleStop: (action: CardAction) => object;
  /** 恢复卡「🗜 压缩并总结」按钮（独立校验路径：白名单 → 验签 → 防重放）。 */
  readonly handleCompact: (action: CardAction) => object;
  /** 会话卡 / 向导卡 / 表单提交。 */
  readonly handleCommands: (action: CardAction) => object | Promise<object>;
  /** 审批卡。 */
  readonly handleApprovals: (action: CardAction) => object | Promise<object>;
}

export function routeCardAction(
  action: CardAction,
  deps: CardActionRouterDeps,
): object | Promise<object> {
  // opencode 表单卡（含 question 工具）优先：value 形如 `{f,k,...}`。
  const formResponse = deps.handleForm(action);
  if (formResponse) return formResponse;

  // 会话卡 / 向导卡 / 表单提交优先；其余交给审批卡（value 里带 `cmd` / `wizard` 的才是管理操作）。
  const value = action.rawValue;

  // 运行卡「强制停止」按钮（与审批卡/会话卡并列，独立校验路径）。
  if (parseStopActionValue(value)) {
    return deps.handleStop(action);
  }

  // 恢复卡「🗜 压缩并总结」按钮（独立校验路径，**用户主动**触发，绝不隐式）。
  if (parseCompactActionValue(value)) {
    return deps.handleCompact(action);
  }

  const hasForm = action.formValue !== undefined;
  const routed =
    hasForm ||
    isSetupFormAction(value) ||
    Boolean(parseSessionCardValue(value)) ||
    Boolean(parseSetupCardValue(value)) ||
    // 「一句话建会话」建议卡按钮（issue #2）。
    Boolean(parseQuickNewActionValue(value));
  deps.log.debug("卡片回调路由", {
    hasForm,
    hasValue: value !== undefined,
    valueKeys: value && typeof value === "object" ? Object.keys(value as Record<string, unknown>) : [],
    routedTo: routed ? "commands" : "approvals",
  });
  if (routed) {
    return deps.handleCommands(action);
  }
  return deps.handleApprovals(action);
}
