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
  normalizeForm,
  type FormLike,
  type FormValue,
} from "./forms.js";

export interface FormReplyInput {
  readonly sessionID: string;
  readonly formID: string;
  readonly answer: Record<string, FormValue>;
  readonly directory?: string;
}

export interface FormRelayDeps {
  readonly sender: FeishuSender;
  readonly log: Logger;
  readonly getLink: (sessionID: string) => Promise<SessionLink | undefined>;
  readonly isAllowed: (openId: string) => boolean;
  readonly reply: (input: FormReplyInput) => Promise<void>;
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

    this.forms.set(form.id, {
      form,
      sessionID: form.sessionID,
      chatId: link.chatId,
      messageId: res.messageId,
      ...(link.dir ? { directory: link.dir } : {}),
      answers: {},
      settled: false,
    });
    this.deps.log.info("表单卡已发送", {
      formID: form.id,
      sessionID: form.sessionID,
      fieldCount: form.fields.length,
      isQuestion: form.metadata?.kind === "question",
    });
  }

  /**
   * 处理表单卡点击。命中返回飞书回调响应对象；非表单按钮返回 undefined。
   * 同步返回 toast，reply/patch 在后台完成（电商回调 3s 窗口）。
   */
  handleCardAction(action: CardAction): object | undefined {
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
    pending.awaitingField = undefined;
    this.awaiting.delete(pending.sessionID);

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
    pending.answers[fieldKey] = coerceText(field?.type, text);
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
    void this.patch(pending, buildFormResolvedCard(pending.form, pending.answers, "answered"));
  }

  /** 处理 `form.cancelled`。 */
  onCancelled(data: unknown): void {
    const { id, sessionID } = (data ?? {}) as { id?: string; sessionID?: string };
    if (!id) return;
    const pending = this.forms.get(id);
    if (!pending) return;
    this.awaiting.delete(sessionID ?? pending.sessionID);
    this.forms.delete(id);
    void this.patch(pending, buildFormResolvedCard(pending.form, pending.answers, "cancelled"));
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
      pending.settled = false;
      this.forms.set(pending.form.id, pending);
      await this.patch(
        pending,
        buildFormResolvedCard(pending.form, pending.answers, "error", errorMessage(err)),
      );
      return;
    }
    // 成功：form.replied 事件会做最终收敛；这里先乐观更新，避免卡片停在待填态。
    this.forms.delete(pending.form.id);
    await this.patch(pending, buildFormResolvedCard(pending.form, pending.answers, "answered"));
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

/** number/integer 字段的自由文本答案做数值转换（非法则保留原文，交由服务端校验）。 */
function coerceText(type: string | undefined, text: string): FormValue {
  const trimmed = text.trim();
  if (type === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : text;
  }
  if (type === "integer") {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) && String(n) === trimmed ? n : text;
  }
  return text;
}
