/**
 * 表单中继（P7.2）：把 opencode 的 pending form（含 `question` 工具）转发到飞书。
 *
 * 生命周期：
 *   form.created ──▶ 发飞书表单卡（话题内 reply）
 *        点击选项 ──▶ 记录答案；填满 → session.form.reply
 *        ✍️ 直接回复 ──▶ 下一条话题文本作为该字段答案
 *   form.replied / form.cancelled ──▶ 卡片收敛为结果态
 *
 * 安全：只处理有飞书会话映射的 form（TUI/其它来源不碰），点击者需在白名单内。
 * 跨 location：reply 需带 `x-opencode-directory`（会话目录），由注入的 reply 实现负责。
 */
import { errorMessage } from "../logger.js";
import type { CardAction, Logger, SessionLink } from "../types.js";
import { TtlMap } from "../utils/ttl-map.js";
import type { FeishuSender } from "./sender.js";
import {
  buildFormCard,
  buildFormResolvedCard,
  isComplete,
  parseFormAction,
  parseFormSubmit,
  normalizeForm,
  type FormField,
  type FormLike,
  type FormOutcome,
  type FormSubmitAction,
  type FormValue,
} from "./forms.js";

export interface FormReplyInput {
  readonly sessionID: string;
  readonly formID: string;
  readonly answer: Record<string, FormValue>;
  readonly directory?: string;
}

export interface FormReplyCancelInput {
  readonly sessionID: string;
  readonly formID: string;
  readonly directory?: string;
}

export interface FormRelayDeps {
  readonly sender: FeishuSender;
  readonly log: Logger;
  readonly getLink: (sessionID: string) => Promise<SessionLink | undefined>;
  readonly isAllowed: (openId: string) => boolean;
  readonly reply: (input: FormReplyInput) => Promise<void>;
  /**
   * 取消 pending form（选项题收到非选项文本时，先解除阻塞再把消息当普通 prompt）。
   * 缺省时退化为「仍按答案提交」以保持旧行为。
   */
  readonly cancel?: (input: FormReplyCancelInput) => Promise<void>;
  readonly now?: () => number;
}

interface PendingForm {
  readonly form: FormLike;
  readonly sessionID: string;
  readonly chatId: string;
  messageId: string;
  readonly directory?: string;
  answers: Record<string, FormValue>;
  /** 正在等待用户用文本填充的字段 key。 */
  awaitingField?: string;
  settled: boolean;
}

const TOAST = (type: "success" | "error" | "warning" | "info", content: string): object => ({
  toast: { type, content },
});

export class FormRelay {
  private readonly forms: TtlMap<PendingForm>;
  /** sessionID → formID：用于把下一条话题文本当作待填字段答案。 */
  private readonly awaiting = new Map<string, string>();
  private disposed = false;

  constructor(private readonly deps: FormRelayDeps) {
    this.forms = new TtlMap<PendingForm>(60 * 60 * 1000, deps.now ?? (() => Date.now()));
  }

  /** 处理 `form.created`：发卡（仅飞书会话）。 */
  async onCreated(data: unknown): Promise<void> {
    if (this.disposed) return;
    const raw = (data as { form?: unknown } | undefined)?.form;
    const form = normalizeForm(raw);
    if (!form) return;

    const link = await this.deps.getLink(form.sessionID);
    if (!link) {
      this.deps.log.debug("form 无飞书映射，跳过转发", { formID: form.id, sessionID: form.sessionID });
      return;
    }

    const card = buildFormCard(form, {});
    const res = link.replyMessageId
      ? await this.deps.sender.replyCard(link.replyMessageId, card)
      : await this.deps.sender.sendCard(link.chatId, card);
    if (!res.ok || !res.messageId) {
      this.deps.log.warn("表单卡发送失败", { formID: form.id, error: res.error ?? "unknown" });
      return;
    }

    const firstVisible = form.fields.find((f) => f.hidden !== true);
    const pending: PendingForm = {
      form,
      sessionID: form.sessionID,
      chatId: link.chatId,
      messageId: res.messageId,
      ...(link.dir ? { directory: link.dir } : {}),
      answers: {},
      settled: false,
      // 自动进入「等待文字回答」状态：用户直接发文字即可作为答案，
      // 无需先点「直接回复答案」按钮。第一个可见字段作为默认答案字段。
      ...(firstVisible ? { awaitingField: firstVisible.key } : {}),
    };
    this.forms.set(form.id, pending);
    // 自动设置 awaiting，让 consumeText 能捕获用户直接发送的文字。
    if (firstVisible) {
      this.awaiting.set(form.sessionID, form.id);
    }
    this.deps.log.info("表单卡已发送", {
      formID: form.id,
      sessionID: form.sessionID,
      fieldCount: form.fields.length,
      isQuestion: form.metadata?.kind === "question",
      awaitingField: firstVisible?.key,
    });
  }

  /**
   * 处理表单卡点击。命中返回飞书回调响应对象；非表单按钮返回 undefined。
   * 同步返回 toast，reply/patch 在后台完成（电商回调 3s 窗口）。
   */
  handleCardAction(action: CardAction): object | undefined {
    // 卡片内输入框的「✅ 提交」：内容走 action.formValue。
    const submit = parseFormSubmit(action.rawValue);
    if (submit) return this.handleSubmit(action, submit);

    const parsed = parseFormAction(action.rawValue);
    if (!parsed) return undefined;

    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的表单点击", { operator: action.operatorOpenId.slice(0, 8) });
      return TOAST("error", "无操作权限");
    }

    const pending = this.forms.get(parsed.f);
    if (!pending) return TOAST("warning", "该表单已失效或已提交");
    if (pending.settled) return TOAST("info", "正在提交，请稍候");

    const field = pending.form.fields.find((f) => f.key === parsed.k);

    if (parsed.free) {
      pending.awaitingField = parsed.k;
      this.awaiting.set(pending.sessionID, pending.form.id);
      void this.patch(
        pending,
        buildFormCard(pending.form, pending.answers, { notice: "✍️ 请直接在本话题发送你的回答。" }),
      );
      return TOAST("info", "请直接发送你的回答");
    }

    if (parsed.v === undefined) return TOAST("error", "无法识别的操作");
    const value: FormValue =
      field?.type === "multiselect" && !Array.isArray(parsed.v) ? [String(parsed.v)] : parsed.v;
    pending.answers[parsed.k] = value;
    // 自动更新 awaitingField 为下一个未填字段，让用户可以继续用文字回答。
    const nextField = pending.form.fields.find((f) => f.hidden !== true && pending.answers[f.key] === undefined);
    pending.awaitingField = nextField?.key;
    if (pending.awaitingField) {
      this.awaiting.set(pending.sessionID, pending.form.id);
    } else {
      this.awaiting.delete(pending.sessionID);
    }

    if (isComplete(pending.form, pending.answers)) {
      pending.settled = true;
      void this.submit(pending);
      return TOAST("success", "已提交");
    }
    void this.patch(pending, buildFormCard(pending.form, pending.answers));
    return TOAST("success", "已记录");
  }

  /**
   * 处理卡片内输入框「✅ 提交」：把 `action.formValue`（键 = 输入框 name = 字段 key）
   * 归一化后写入答案；填满即 `session.form.reply`，否则回存并重渲染。
   */
  private handleSubmit(action: CardAction, submit: FormSubmitAction): object {
    if (!this.deps.isAllowed(action.operatorOpenId)) {
      this.deps.log.warn("拒绝非白名单用户的表单提交", { operator: action.operatorOpenId.slice(0, 8) });
      return TOAST("error", "无操作权限");
    }
    const pending = this.forms.get(submit.f);
    if (!pending) return TOAST("warning", "该表单已失效或已提交");
    if (pending.settled) return TOAST("info", "正在提交，请稍候");

    const values: Record<string, unknown> = action.formValue ?? {};
    let recorded = false;
    for (const field of pending.form.fields) {
      if (field.hidden === true) continue;
      const rawValue = values[field.key];
      if (rawValue === undefined || rawValue === null) continue;
      if (typeof rawValue === "string") {
        if (rawValue.trim() === "") continue;
        pending.answers[field.key] = coerceAnswer(field, rawValue);
        recorded = true;
      } else if (Array.isArray(rawValue) && rawValue.length > 0) {
        pending.answers[field.key] = rawValue.map((v) => String(v));
        recorded = true;
      }
    }
    if (!recorded) return TOAST("info", "请先填写内容再提交");

    // 更新「等待文字回答」字段为下一个未填项（兼容话题内直接发文字作答）。
    const nextField = pending.form.fields.find((f) => f.hidden !== true && pending.answers[f.key] === undefined);
    pending.awaitingField = nextField?.key;
    if (nextField) {
      this.awaiting.set(pending.sessionID, pending.form.id);
    } else {
      this.awaiting.delete(pending.sessionID);
    }

    if (isComplete(pending.form, pending.answers)) {
      pending.settled = true;
      void this.submit(pending);
      return TOAST("success", "已提交");
    }
    void this.patch(pending, buildFormCard(pending.form, pending.answers));
    return TOAST("success", "已记录");
  }

  /**
   * 把话题内文本当作「待填字段」的答案（自由文本）。
   * 命中并消费返回 true（调用方不再当 prompt 发给模型）。
   */
  consumeText(sessionID: string, text: string): boolean {
    const formID = this.awaiting.get(sessionID);
    if (!formID) return false;
    const pending = this.forms.get(formID);
    const fieldKey = pending?.awaitingField;
    if (!pending || !fieldKey) {
      this.awaiting.delete(sessionID);
      return false;
    }

    const field = pending.form.fields.find((f) => f.key === fieldKey);
    // 选项题（有选项且不允许自填）收到「不是选项」的文本 → 用户其实是在说别的：
    // 取消该表单（解除 agent 阻塞）并把这条文本当普通消息交给 agent 处理。
    if (!fieldAcceptsText(field, text)) {
      this.deps.log.info("选项题收到非选项文本，跳过表单并按普通消息处理", {
        sessionID,
        formID: pending.form.id,
        fieldKey,
      });
      this.awaiting.delete(sessionID);
      this.forms.delete(pending.form.id);
      void this.cancelPending(pending);
      return false;
    }

    // 直接回复=手动作答：能对上选项就用选项值，否则用原文（服务端校验）。
    pending.answers[fieldKey] = coerceAnswer(field, text);
    pending.awaitingField = undefined;
    this.awaiting.delete(sessionID);

    if (isComplete(pending.form, pending.answers)) {
      pending.settled = true;
      void this.submit(pending);
    } else {
      void this.patch(pending, buildFormCard(pending.form, pending.answers));
    }
    return true;
  }

  /** 处理 `form.replied`：卡片收敛（若尚未由本端提交更新）。 */
  onReplied(data: unknown): void {
    const { id, sessionID, answer } = (data ?? {}) as {
      id?: string;
      sessionID?: string;
      answer?: Record<string, unknown>;
    };
    if (!id) return;
    const pending = this.forms.get(id);
    if (!pending) return;
    if (answer) {
      for (const [k, v] of Object.entries(answer)) {
        if (isFormValue(v)) pending.answers[k] = v;
      }
    }
    this.awaiting.delete(sessionID ?? pending.sessionID);
    this.forms.delete(id);
    void this.finish(pending, "answered");
  }

  /** 处理 `form.cancelled`。 */
  onCancelled(data: unknown): void {
    const { id, sessionID } = (data ?? {}) as { id?: string; sessionID?: string };
    if (!id) return;
    const pending = this.forms.get(id);
    if (!pending) return;
    this.awaiting.delete(sessionID ?? pending.sessionID);
    this.forms.delete(id);
    void this.finish(pending, "cancelled");
  }

  /** 是否有尚未提交/取消的待答表单（看门狗判活：等表单属合法等待，不应判 stale）。 */
  hasPendingFor(sessionID: string): boolean {
    for (const [, pending] of this.forms.entries()) {
      if (pending.sessionID === sessionID && !pending.settled) return true;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.forms.clear();
    this.awaiting.clear();
  }

  private async submit(pending: PendingForm): Promise<void> {
    try {
      await this.deps.reply({
        sessionID: pending.sessionID,
        formID: pending.form.id,
        answer: { ...pending.answers },
        ...(pending.directory ? { directory: pending.directory } : {}),
      });
    } catch (err) {
      this.deps.log.error("form.reply 失败", {
        formID: pending.form.id,
        error: errorMessage(err),
      });
      // 失败：保留卡片 + 重新进入「等待文字回答」状态，允许用户直接重答。
      pending.settled = false;
      const missing = pending.form.fields.find(
        (f) => f.hidden !== true && pending.answers[f.key] === undefined,
      );
      if (missing) {
        pending.awaitingField = missing.key;
        this.awaiting.set(pending.sessionID, pending.form.id);
      }
      this.forms.set(pending.form.id, pending);
      await this.patch(
        pending,
        buildFormResolvedCard(pending.form, pending.answers, "error", errorMessage(err)),
      );
      return;
    }
    // 成功：优先撤回表单卡（用户要求作答后不再残留待填卡）；撤回失败降级为结果卡。
    this.forms.delete(pending.form.id);
    await this.finish(pending, "answered");
  }

  /** 取消 pending form（best-effort），随后撤回卡片。 */
  private async cancelPending(pending: PendingForm): Promise<void> {
    if (this.deps.cancel) {
      try {
        await this.deps.cancel({
          sessionID: pending.sessionID,
          formID: pending.form.id,
          ...(pending.directory ? { directory: pending.directory } : {}),
        });
      } catch (err) {
        this.deps.log.warn("form.cancel 失败（该消息可能仍排队）", {
          formID: pending.form.id,
          error: errorMessage(err),
        });
      }
    }
    await this.finish(pending, "cancelled");
  }

  /**
   * 表单收敛：**优先撤回卡片**（作答/取消后不再残留待填卡），撤回失败（超时限/无权限）
   * 才降级 patch 成结果卡，避免卡片永久停在待填态。
   */
  private async finish(pending: PendingForm, outcome: FormOutcome): Promise<void> {
    if (this.disposed) return;
    const res = await this.deps.sender.deleteMessage(pending.messageId);
    if (res.ok) {
      this.deps.log.debug("表单卡已撤回", { formID: pending.form.id, outcome });
      return;
    }
    await this.patch(pending, buildFormResolvedCard(pending.form, pending.answers, outcome));
  }

  private async patch(pending: PendingForm, card: object): Promise<void> {
    if (this.disposed) return;
    const res = await this.deps.sender.patchCard(pending.messageId, card);
    if (!res.ok) {
      this.deps.log.warn("表单卡片更新失败", { formID: pending.form.id, error: res.error ?? "unknown" });
    }
  }
}

function isFormValue(value: unknown): value is FormValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

/**
 * 文本作答归一化（直接回复 = 手动作答）：
 * - 能对上既有选项（value 或 label）→ 用选项 value；
 * - boolean 支持中英文常见说法（是/否/yes/no/1/0…）；
 * - number/integer 做数值转换（非法则保留原文，交由服务端校验）；
 * - multiselect 按顿号/逗号/分号拆分为数组；
 * - 其余原样作为**手动输入的选项**（服务端校验）。
 */
function coerceAnswer(field: FormField | undefined, text: string): FormValue {
  const trimmed = text.trim();
  if (!field) return trimmed;
  switch (field.type) {
    case "number": {
      const n = Number(trimmed);
      return trimmed !== "" && Number.isFinite(n) ? n : trimmed;
    }
    case "integer": {
      const n = Number.parseInt(trimmed, 10);
      return Number.isFinite(n) && String(n) === trimmed ? n : trimmed;
    }
    case "boolean": {
      const parsed = parseBooleanText(trimmed);
      return parsed === undefined ? trimmed : parsed;
    }
    case "multiselect": {
      const parts = trimmed
        .split(/[、,，;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length === 0) return trimmed;
      return parts.map((p) => matchOption(field, p) ?? p);
    }
    default:
      return matchOption(field, trimmed) ?? trimmed;
  }
}

/**
 * 该字段能否接受这条文本？
 * - 无选项 → 可以（自由文本）；
 * - 允许自填（`custom`）→ 可以；
 * - 纯选项题 → 仅当文本命中某个选项（含序号/字母）才算作答，否则视为「用户在说别的」。
 */
function fieldAcceptsText(field: FormField | undefined, text: string): boolean {
  if (!field) return true;
  const hasOptions = (field.options?.length ?? 0) > 0;
  if (!hasOptions) return true;
  if (field.custom === true) return true;
  return matchOption(field, text) !== undefined;
}

/** 文本命中选项（value / label / 序号 / 字母，忽略大小写）→ 返回选项 value。 */
function matchOption(field: FormField, text: string): string | undefined {
  if (!field.options?.length) return undefined;
  const trimmed = text.trim();
  // 序号（1 / 1. / 1、/ 1)）与字母（A / a / B.）
  const byNumber = /^(\d{1,2})[.、)）]?$/.exec(trimmed);
  if (byNumber) {
    const index = Number(byNumber[1]) - 1;
    const option = field.options[index];
    if (option) return option.value;
  }
  const byLetter = /^([A-Za-z])[.、)）]?$/.exec(trimmed);
  if (byLetter) {
    const index = byLetter[1]!.toUpperCase().charCodeAt(0) - 65;
    const option = field.options[index];
    if (option) return option.value;
  }
  const lower = trimmed.toLowerCase();
  const hit = field.options.find(
    (o) => o.value === trimmed || o.label.trim() === trimmed || o.label.trim().toLowerCase() === lower,
  );
  return hit?.value;
}

const TRUE_WORDS = new Set(["是", "对", "好", "可以", "允许", "确认", "同意", "yes", "y", "true", "1"]);
const FALSE_WORDS = new Set(["否", "不", "不行", "拒绝", "取消", "不要", "no", "n", "false", "0"]);

function parseBooleanText(text: string): boolean | undefined {
  const lower = text.trim().toLowerCase();
  if (TRUE_WORDS.has(lower)) return true;
  if (FALSE_WORDS.has(lower)) return false;
  return undefined;
}
