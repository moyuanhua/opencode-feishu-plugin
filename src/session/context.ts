/**
 * 会话命令编排的**共享上下文**（纯重构：从 `session-commands.ts` 抽出）。
 *
 * 设计：
 * - `SessionCommandsDeps` / `CreateSessionInput` 是原有对外依赖契约，原样迁到这里并继续由门面导出；
 * - `SessionPrimitives` 是与业务无关的通用原语（回执、patch、读模型列表等），由本文件的工厂实现；
 * - 四个子模块（session-list / setup-wizard / session-ops / model-perm）只依赖本文件的类型，
 *   运行时各自把 API 装配到同一个 `SessionContext` 上，交叉调用一律走 `ctx.xxx(...)`；
 * - 不引入任何全局状态，依赖仍走构造时注入。
 */
import { errorMessage } from "../logger.js";
import type {
  CardAction,
  IncomingMessage,
  Logger,
  ModelRef,
  PermissionPreset,
  PermissionRule,
  SessionGateMode,
} from "../types.js";
import type { FeishuSender } from "../feishu/sender.js";
import type { SessionMap } from "../feishu/session-map.js";
import type { SessionListEntry } from "../feishu/session-list.js";
import type { SessionCardValue } from "../feishu/session-cards.js";
import type { SetupFormDirEntry, SetupCardValue } from "../feishu/setup-cards.js";
import type { ModelEntry, ModelSwitchOutcome } from "../feishu/models.js";
import type { CommandScope } from "../feishu/routing.js";
import type { DirValidation } from "../feishu/dirs.js";
import type { WizardStore } from "../feishu/wizard.js";
import type { RecentStore } from "../feishu/recent.js";
import type {
  SessionSummaryOutcome,
  SummarizeSessionInput,
} from "./resume-summary.js";

/** 建会话输入（P6）：标题 + 归属 + 目录/模型/权限。 */
export interface CreateSessionInput {
  readonly title: string;
  readonly chatId: string;
  readonly openId: string;
  /** 是否设为该 chat 的当前会话（话题内新建传 false）。 */
  readonly setActive?: boolean;
  readonly model?: ModelRef;
  readonly directory?: string;
  readonly permissions?: readonly PermissionRule[];
  readonly perm?: PermissionPreset;
  readonly gateMode?: SessionGateMode;
}

export interface SessionCommandsDeps {
  readonly log: Logger;
  readonly sessionMap: SessionMap;
  readonly sender: FeishuSender;
  readonly isAllowed: (openId: string) => boolean;
  /** 新建 opencode 会话并写入映射/元数据，返回至少含 id 的对象。 */
  readonly createSession: (input: CreateSessionInput) => Promise<{ id: string }>;
  /** 中断指定会话正在跑的任务。 */
  readonly interruptSession: (sessionID: string) => Promise<void>;
  /**
   * `/steer <文本>`：把文本以 `delivery:"steer"` 立即插入会话执行（打断当前步骤）。
   * 缺省时该命令提示不支持。
   */
  readonly steerPrompt?: (message: IncomingMessage, sessionID: string, text: string) => Promise<void>;
  /**
   * `/now`：把会话已排队的未投递消息改为 `steer`，返回提升条数。
   * 返回 -1 表示当前运行时未暴露 inbox（不支持）；缺省同。
   */
  readonly promoteQueued?: (sessionID: string) => Promise<number>;
  /** 话题路由开关（P5）。false = 完全回到 P3 行为（`/new` 只回执文本）。 */
  readonly threadRouting?: boolean;
  readonly now?: () => number;
  /** 建会话向导状态（P6）。 */
  readonly wizard: WizardStore;
  /** 最近使用目录/模型（P6）。 */
  readonly recent: RecentStore;
  /** 列出可用模型（P6，已归一化）。 */
  readonly listModels: () => Promise<readonly ModelEntry[]>;
  /**
   * 切换已存在会话的模型（含读回校验 + 记录 + 运行卡页脚）。
   * 返回 `undefined` 视为「无法校验」（兼容旧实现/测试替身），回执按成功处理。
   */
  readonly switchSessionModel: (sessionID: string, model: ModelRef) => Promise<ModelSwitchOutcome | undefined>;
  /**
   * 读回会话**真实**当前模型（`ctx.session.get`）。
   * 用于 `/current` 与模型卡展示，避免只显示插件记录的那份。读回失败返回 undefined。
   */
  readonly getSessionModel?: (sessionID: string, directory?: string) => Promise<ModelRef | undefined>;
  /** 应用权限预设（含 ruleset + gateMode 记录）。 */
  readonly applyPermissionPreset: (sessionID: string, preset: PermissionPreset) => Promise<void>;
  /** 移动会话工作目录（move + 记录）。 */
  readonly moveSessionDir: (sessionID: string, dir: string) => Promise<void>;
  /** 目录校验（与 config.allowedRoots 绑定）。 */
  readonly validateDir: (path: string) => DirValidation;
  readonly allowedRoots?: readonly string[];
  /** 模型卡片每页数量（默认 8）。 */
  readonly modelPageSize?: number;
  /** 模型卡片「最近」列表长度（默认 5，与 config.recentModelsLimit 一致）。 */
  readonly recentModelsLimit?: number;
  /** 扫描允许根目录的一级子目录（目录下拉选项来源，默认 `scanRootSubdirs`；测试可注入）。 */
  readonly scanRootSubdirs?: (root: string) => Promise<readonly SetupFormDirEntry[]>;
  /**
   * 列出 opencode **全部**会话（P7，`ctx.session.list()` 原始返回）。
   * 形状不稳，内部用 `normalizeSessionList` 兼容；缺失/异常/形状不可识别时
   * 回退到 `SessionMap.listSessions` 并 `log.warn`。
   */
  readonly listAllSessions?: () => Promise<unknown>;
  /**
   * 按 id 查询会话是否存在（P7，`ctx.session.get({sessionID})` 原始返回）。
   * 「进入话题」动作据此校验；缺失时视为无法校验（乐观放行）。
   */
  readonly getSessionInfo?: (sessionID: string) => Promise<unknown>;
  /** `/sessions` 每页数量（P7，默认 8，夹取 5–20）。 */
  readonly sessionPageSize?: number;
  /**
   * 任务 B：恢复卡摘要开关（默认 true）。关闭时不显示摘要区块、也不生成、也不显示压缩按钮。
   */
  readonly resumeSummary?: boolean;
  /** 任务 B：快摘要生成超时（默认 15000ms，夹取 3000–60000）。 */
  readonly resumeSummaryTimeoutMs?: number;
  /** 任务 B：用户主动压缩后的轮询超时（默认 120000ms，夹取 30000–300000）。 */
  readonly resumeCompactTimeoutMs?: number;
  /** 单卡最多保留的 markdown 表格数（默认 4，夹取 1–5）；见 `feishu/card-limits.ts`。 */
  readonly cardMaxTables?: number;
  /**
   * 任务 B：获取会话摘要（复用已有 compaction 摘要 → 缺失才走**快摘要**）。
   * 缺省 = 恢复卡不显示摘要（即使 `resumeSummary=true`），也不显示压缩按钮。
   */
  readonly summarizeSession?: (input: SummarizeSessionInput) => Promise<SessionSummaryOutcome>;
  /**
   * 任务 B：恢复卡「🗜 压缩并总结」按钮的 token 签名。
   * 缺省 = 不渲染该按钮（用户无法主动触发原生压缩）。
   */
  readonly signCompact?: (sessionID: string) => string;
}

/** 向导状态（结构化子集，避免与持久化类型强耦合）。 */
export interface WizardStateLike {
  readonly step?: string;
  readonly dir?: string;
  readonly model?: ModelRef;
  readonly perm?: PermissionPreset;
  readonly title?: string;
  readonly page?: number;
}

/** 「进入话题」输入（卡片动作 / `/resume` 共用）。 */
export interface EnterSessionThreadInput {
  readonly chatId: string;
  readonly sessionID: string;
  readonly anchorMessageId: string;
  readonly operatorOpenId: string;
  readonly info?: SessionListEntry;
  /** 失败时 patch 的卡片消息 id（列表卡）；`/resume` 不传则改用文本回复。 */
  readonly patchMessageId?: string;
  readonly source: "card" | "resume";
}

/** 与业务无关的通用原语；工厂实现后挂到 ctx 上。 */
export interface SessionPrimitives {
  readonly deps: SessionCommandsDeps;
  readonly now: () => number;
  readonly threadRouting: boolean;
  readonly modelPageSize: number;
  readonly sessionPageSize: number;
  /** 文本回执：话题内引用触发消息（留在话题），主聊天流直接发送。 */
  reply(message: IncomingMessage, text: string): Promise<void>;
  /** 主聊天流文本回执（不引用任何消息）。 */
  replyChat(chatId: string, text: string): Promise<void>;
  patchCard(messageId: string, card: object): Promise<void>;
  loadModels(): Promise<ModelEntry[]>;
  recentModelsLimit(): number;
  threadSessionID(message: IncomingMessage): Promise<string | undefined>;
  scopeSessionID(message: IncomingMessage, scope: CommandScope): Promise<string | undefined>;
}

/** 会话列表 / 进入话题（`session-list.ts`）。 */
export interface SessionListApi {
  cmdSessions(message: IncomingMessage, page?: number): Promise<void>;
  loadSessionEntries(chatId: string): Promise<SessionListEntry[]>;
  buildListCard(
    chatId: string,
    entries: readonly SessionListEntry[],
    page: number,
    activeID?: string,
  ): Promise<object>;
  enterSessionThread(input: EnterSessionThreadInput): Promise<{ ok: boolean; threadId?: string; error?: string }>;
  handleOpenCardAction(
    action: CardAction,
    value: Extract<SessionCardValue, { cmd: "open" }>,
  ): Promise<object>;
  patchMissingCard(messageId: string, sessionID: string): Promise<void>;
  applySessionCardAction(action: CardAction, value: SessionCardValue): Promise<void>;
  patchListCard(chatId: string, messageId: string, page?: number): Promise<void>;
}

/** 建会话向导 / 表单（`setup-wizard.ts`）。 */
export interface SetupWizardApi {
  cmdNew(message: IncomingMessage, args: string): Promise<void>;
  cmdForm(message: IncomingMessage, args: string): Promise<void>;
  cmdDir(message: IncomingMessage, args: string): Promise<void>;
  cmdModel(message: IncomingMessage, args: string, scope: CommandScope): Promise<void>;
  cmdPerm(message: IncomingMessage, args: string, scope: CommandScope): Promise<void>;
  cmdCancel(message: IncomingMessage): Promise<void>;
  applySetupCardAction(action: CardAction, value: SetupCardValue): Promise<void>;
  applySetupFormSubmit(action: CardAction): Promise<void>;
  sendSetupFormForChat(chatId: string, anchorMessageId: string, openId: string): Promise<void>;
}

/** 会话运维命令（`session-ops.ts`）。 */
export interface SessionOpsApi {
  cmdUse(message: IncomingMessage, args: string): Promise<void>;
  cmdCurrent(message: IncomingMessage, scope: CommandScope): Promise<void>;
  cmdStop(message: IncomingMessage, scope: CommandScope): Promise<void>;
  cmdCd(message: IncomingMessage, args: string): Promise<void>;
  cmdResume(message: IncomingMessage, args: string): Promise<void>;
  cmdNow(message: IncomingMessage, scope: CommandScope): Promise<void>;
  cmdSteer(message: IncomingMessage, args: string, scope: CommandScope): Promise<void>;
}

/** 模型切换 / 权限档位编排（`model-perm.ts`）。 */
export interface ModelPermApi {
  currentModel(sessionID: string): Promise<ModelRef | undefined>;
  renderModelCard(state: WizardStateLike, pageOverride?: number): Promise<object>;
  sendModelCardToThread(message: IncomingMessage, sessionID: string, page: number): Promise<void>;
  switchModelInThread(message: IncomingMessage, args: string): Promise<void>;
  sendPermCardToThread(message: IncomingMessage, sessionID: string): Promise<void>;
  setPermInThread(message: IncomingMessage, args: string): Promise<void>;
}

/** 门面装配后的完整上下文。 */
export interface SessionContext
  extends SessionPrimitives,
    SessionListApi,
    SetupWizardApi,
    SessionOpsApi,
    ModelPermApi {}

/** `/sessions` 每页数量夹取到 5–20（缺省 8）。 */
export function clampPageSize(value: number | undefined): number {
  const base = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 8;
  return Math.min(20, Math.max(5, base));
}

export type ToastType = "success" | "error" | "warning" | "info";

export function toast(type: ToastType, content: string): object {
  return { toast: { type, content } };
}

/** 构造通用原语（不含各业务模块 API，由门面 `Object.assign` 补齐）。 */
export function createSessionContext(deps: SessionCommandsDeps): SessionContext {
  const now = deps.now ?? (() => Date.now());
  const ctx = {
    deps,
    now,
    threadRouting: deps.threadRouting ?? true,
    modelPageSize: deps.modelPageSize ?? 8,
    sessionPageSize: clampPageSize(deps.sessionPageSize),

    async reply(message: IncomingMessage, text: string): Promise<void> {
      if (message.threadId) {
        await deps.sender.replyText(message.messageId, text);
        return;
      }
      await deps.sender.sendText(message.chatId, text);
    },

    async replyChat(chatId: string, text: string): Promise<void> {
      await deps.sender.sendText(chatId, text);
    },

    async patchCard(messageId: string, card: object): Promise<void> {
      if (!messageId) return;
      const res = await deps.sender.patchCard(messageId, card);
      if (!res.ok) deps.log.warn("向导卡片更新失败", { error: res.error ?? "unknown" });
    },

    async loadModels(): Promise<ModelEntry[]> {
      try {
        return [...(await deps.listModels())];
      } catch (err) {
        deps.log.warn("模型列表获取失败", { error: errorMessage(err) });
        return [];
      }
    },

    recentModelsLimit(): number {
      return deps.recentModelsLimit ?? 5;
    },

    async threadSessionID(message: IncomingMessage): Promise<string | undefined> {
      if (!message.threadId) return undefined;
      const link = await deps.sessionMap.resolveByThread(message.threadId);
      return link?.sessionID;
    },

    async scopeSessionID(message: IncomingMessage, scope: CommandScope): Promise<string | undefined> {
      if (scope === "thread") return ctx.threadSessionID(message);
      const active = await deps.sessionMap.getActive(message.chatId);
      return active?.sessionID;
    },
  } as SessionContext;
  return ctx;
}
