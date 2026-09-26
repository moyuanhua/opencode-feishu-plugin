/**
 * 建会话向导状态机 + 共享 storage 持久化（P6）。
 *
 * key：`feishu:v2:setup:<chatId>` = `{step, dir?, model?, perm?, title?, page?, anchorMessageId?}`。
 * 纯 reducer（`reduceWizard`）便于单测；`WizardStore` 负责读写与容错。
 */
import { errorMessage } from "../logger.js";
import type { Logger, ModelRef, PermissionPreset, StorageLike, WizardState, WizardStep } from "../types.js";
import { isPermissionPreset } from "./perm-presets.js";

export const WIZARD_KEY_PREFIX = "feishu:v2:setup:";

const STEPS: readonly WizardStep[] = ["dir", "model", "perm", "confirm"];

export type WizardAction =
  | { readonly type: "start"; readonly title?: string; readonly anchorMessageId?: string }
  | { readonly type: "setDir"; readonly dir: string }
  | { readonly type: "setModel"; readonly model: ModelRef }
  | { readonly type: "setPerm"; readonly perm: PermissionPreset }
  | { readonly type: "setPage"; readonly page: number }
  | { readonly type: "cancel" };

/** 起始状态：选择目录。 */
export function wizardStart(title?: string, anchorMessageId?: string): WizardState {
  return {
    step: "dir",
    ...(title && title.trim() ? { title: title.trim() } : {}),
    ...(anchorMessageId ? { anchorMessageId } : {}),
  };
}

/**
 * 纯状态机：所有非法输入（缺前置步骤/取消）返回 `undefined`（调用方据此提示）。
 * - start 可覆盖已有状态（重新开始）
 * - setDir → model 步；setModel → perm 步；setPerm → confirm 步
 * - setPage 只更新分页，不改步骤
 * - cancel → undefined
 */
export function reduceWizard(state: WizardState | undefined, action: WizardAction): WizardState | undefined {
  switch (action.type) {
    case "start":
      return wizardStart(action.title, action.anchorMessageId);
    case "setDir":
      return state ? { ...state, dir: action.dir, step: "model" } : undefined;
    case "setModel":
      return state ? { ...state, model: action.model, step: "perm" } : undefined;
    case "setPerm":
      return state ? { ...state, perm: action.perm, step: "confirm" } : undefined;
    case "setPage":
      return state ? { ...state, page: Math.max(0, Math.floor(action.page)) } : undefined;
    case "cancel":
      return undefined;
    default:
      return state;
  }
}

/** 下一步提示（步骤不合法时给引导）。 */
export function wizardStepHint(step: WizardStep | undefined): string {
  switch (step) {
    case "dir":
      return "请选择工作目录：点击下方最近目录，或发送 `/dir <绝对路径>`。";
    case "model":
      return "请选择模型：点击下方按钮，或发送 `/model <关键词>`。";
    case "perm":
      return "请选择权限档位：点击下方按钮。";
    case "confirm":
      return "确认后发送 `/new` 重新开始，或点击「✅ 创建」。";
    default:
      return "发送 `/new [标题]` 开始建会话向导。";
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseModel(value: unknown): ModelRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const providerID = asString(rec.providerID);
  const id = asString(rec.id);
  if (!providerID || !id) return undefined;
  const name = asString(rec.name);
  return { providerID, id, ...(name ? { name } : {}) };
}

/** 解析持久化状态；非法返回 undefined。 */
export function parseWizardState(value: unknown): WizardState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const step = asString(rec.step) as WizardStep;
  if (!(STEPS as readonly string[]).includes(step)) return undefined;
  const dir = asString(rec.dir);
  const title = asString(rec.title);
  const anchorMessageId = asString(rec.anchorMessageId);
  const model = parseModel(rec.model);
  const perm = isPermissionPreset(rec.perm) ? rec.perm : undefined;
  const page = typeof rec.page === "number" && Number.isFinite(rec.page) ? Math.max(0, Math.floor(rec.page)) : undefined;
  return {
    step,
    ...(dir ? { dir } : {}),
    ...(model ? { model } : {}),
    ...(perm ? { perm } : {}),
    ...(title ? { title } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(anchorMessageId ? { anchorMessageId } : {}),
  };
}

/** 向导读写（ctx.storage，跨实例共享）。所有 storage 异常都降级为 undefined / no-op。 */
export class WizardStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly log: Logger,
  ) {}

  private key(chatId: string): string {
    return `${WIZARD_KEY_PREFIX}${chatId}`;
  }

  async get(chatId: string): Promise<WizardState | undefined> {
    if (!chatId) return undefined;
    try {
      return parseWizardState(await this.storage.get(this.key(chatId)));
    } catch (err) {
      this.log.warn("向导状态读取失败", { chatId, error: errorMessage(err) });
      return undefined;
    }
  }

  async set(chatId: string, state: WizardState | undefined): Promise<void> {
    if (!chatId) return;
    try {
      if (!state) {
        await this.storage.remove(this.key(chatId));
        return;
      }
      await this.storage.set(this.key(chatId), state);
    } catch (err) {
      this.log.warn("向导状态写入失败", { chatId, error: errorMessage(err) });
    }
  }

  /** 应用一个动作并持久化；返回新状态（取消后为 undefined）。 */
  async apply(chatId: string, action: WizardAction): Promise<WizardState | undefined> {
    const current = action.type === "start" ? undefined : await this.get(chatId);
    const next = reduceWizard(current, action);
    await this.set(chatId, next);
    return next;
  }

  async start(chatId: string, title?: string, anchorMessageId?: string): Promise<WizardState> {
    const state = wizardStart(title, anchorMessageId);
    await this.set(chatId, state);
    return state;
  }

  async cancel(chatId: string): Promise<void> {
    await this.set(chatId, undefined);
  }
}
