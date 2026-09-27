/**
 * opencode-feishu-v2 — OpenCode V2 飞书插件入口。
 *
 * 能力（P0/P2/P3）：
 * 1. 飞书**长连接**（WSClient）接收单聊文本 → 映射/新建 opencode session → prompt；
 * 2. 每条消息**先**发一张运行卡片，把工具调用与 assistant 文本增量以飞书**流式卡片**回填；
 * 3. `delivery:"steer"|"queue"` 原生排队（按 session execution 态决策）；
 * 4. `permission.evaluate` hook + `permission.asked` 事件 + 卡片按钮 → `permission.reply` 审批闭环；
 * 5. 会话管理：`/new`、`/sessions`、`/use`、`/current`、`/stop`、`/help` + 会话卡片切换；
 * 6. 按 messageId 经 `ctx.storage` 跨实例去重。
 *
 * 边界：只处理 p2p + 单人白名单；只申请 p2p 读 + send_as_bot；不监听端口。
 * 进程级幂等：opencode 会随不同 location 多次 setup，这里用 `SetupGuard` 保证只启动一份。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Plugin } from "@opencode/plugin";
import { hasSecret, resolveConfig } from "./config.js";
import { createLogger, errorMessage, maskId } from "./logger.js";
import { acquireProcessGuard, releaseProcessGuard } from "./lifecycle.js";
import { OwnerPolicy } from "./security/allowlist.js";
import { ReplayGuard, signApproval, signAllowSession, signStop, verifyApproval, verifyAllowSession, verifyStop } from "./security/token.js";
import { startGateway } from "./feishu/gateway.js";
import { createFeishuSender } from "./feishu/sender.js";
import { SessionMap } from "./feishu/session-map.js";
import { MessageDedup } from "./feishu/dedup.js";
import { decideDelivery, ExecutionTracker, type Delivery } from "./feishu/delivery.js";
import { createRunController } from "./feishu/run-controller.js";
import { createSessionRecovery, type CancelQueuedResult } from "./feishu/session-recovery.js";
import { StopController } from "./feishu/run-stop.js";
import { startWatchdog } from "./feishu/watchdog.js";
import { FormRelay, type FormReplyInput } from "./feishu/form-relay.js";
import { replyFormOverHttp } from "./feishu/form-reply.js";
import { isP2PChat } from "./feishu/events.js";
import { defaultSessionTitle, isCommand, topicTitle } from "./feishu/commands.js";
import { decideRoute } from "./feishu/routing.js";
import { buildConsoleHintCard, buildStopNoticeCard } from "./feishu/cards.js";
import { validateDirectory } from "./feishu/dirs.js";
import { WizardStore } from "./feishu/wizard.js";
import { RecentStore } from "./feishu/recent.js";
import {
  extractSessionModel,
  modelLabel,
  normalizeModelList,
  sameModel,
  type ModelSwitchOutcome,
} from "./feishu/models.js";
import { extractSessionPermissions, extractSessionTitle } from "./feishu/session-list.js";
import { injectTopicGuidance } from "./feishu/topic-guidance.js";
import { allowActionsForGrant, appendAllowRules, presetAskActions, presetGateMode, presetToRuleset } from "./feishu/perm-presets.js";
import { ApprovalManager, decideEffectForSession, type ReplyInput } from "./permission.js";
import { SessionCommands } from "./session-commands.js";
import { routeEvent, extractErrorText, type EventRouterDeps } from "./runtime/event-router.js";
import { routeCardAction } from "./runtime/card-action-router.js";
import {
  buildTranscript,
  summarizeSession as summarizeSessionImpl,
  type SessionSummaryOutcome,
  type SummarizeSessionInput,
} from "./session/resume-summary.js";
import type {
  IncomingMessage,
  ModelRef,
  PermissionPreset,
  PermissionRule,
  SessionLink,
  StorageLike,
} from "./types.js";

export default Plugin.define({
  id: "feishu",
  async setup(ctx) {
    const config = resolveConfig(ctx.options);
    const logSink = createLogSink(config.logFile);
    const log = createLogger({ level: config.logLevel, ...(logSink ? { sink: logSink.sink } : {}) });
    for (const warning of config.warnings) log.warn(warning);

    if (!config.enabled) {
      // 配置缺失只禁用插件，不抛异常，绝不把用户的 opencode 弄挂。
      log.warn("飞书插件未启用", {
        reason: config.disabledReason ?? "unknown",
        hasAppId: hasSecret(config.appId),
        hasAppSecret: hasSecret(config.appSecret),
      });
      logSink?.close();
      return;
    }

    log.info("飞书插件初始化", {
      domain: config.domain,
      permissionGate: config.permissionGate,
      allowUserCount: config.allowUsers.length,
      stream: config.stream,
      streamThrottleMs: config.streamThrottleMs,
      threadRouting: config.threadRouting,
      topicGuidance: config.topicGuidance,
      hasAppSecret: hasSecret(config.appSecret),
    });

    // 网关门控：只让指定 location 的实例启动（跨 location 是独立 VM context，无法用进程内单例收敛）。
    const here = (ctx.location as { directory?: string } | undefined)?.directory;
    if (config.gatewayLocation && here !== config.gatewayLocation) {
      log.debug("跳过非网关 location", { here, expected: config.gatewayLocation });
      logSink?.close();
      return async () => {};
    }

    if (!acquireProcessGuard()) {
      // 同进程重复 setup（opencode 按 location 加载全局插件）：只跳过，绝不能碰第一份的资源。
      log.debug("检测到同进程重复 setup，跳过启动（仅首个实例生效）");
      logSink?.close();
      return async () => {};
    }

    try {
      return await start(ctx, config, log, logSink);
    } catch (err) {
      // 启动失败时释放占用，允许后续重试。
      releaseProcessGuard();
      logSink?.close();
      throw err;
    }
  },
});

async function start(
  ctx: Plugin.Context,
  config: ReturnType<typeof resolveConfig>,
  log: ReturnType<typeof createLogger>,
  logSink: ReturnType<typeof createLogSink>,
): Promise<() => Promise<void>> {
  const storage: StorageLike = {
    get: (key) => ctx.storage.get(key),
    set: (key, value) => ctx.storage.set(key, value as Parameters<typeof ctx.storage.set>[1]),
    remove: (key) => ctx.storage.remove(key),
  };

  const owner = new OwnerPolicy(storage, config.allowUsers);
  const sessionMap = new SessionMap(storage, log);
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
  });
  const sender = createFeishuSender(client, log);

  await owner.load().catch((err) => log.warn("owner 读取失败", { error: errorMessage(err) }));

  // 跨实例共享的去重（messageId）；同实例内存快路径在 MessageDedup 内部。
  const dedup = new MessageDedup(storage, log);
  // per-session 执行态，用于原生排队决策。
  const executions = new ExecutionTracker();

  const runs = createRunController({
    sender,
    log,
    enabled: config.stream,
    throttleMs: config.streamThrottleMs,
    // 每次 patch 重签强停 token（`stop` 在下方定义，闭包运行时才求值）。
    buildStopValue: (sessionID) => stop.buildStopValue(sessionID),
  });

  /**
   * 会话恢复例程：任务 A（卡片强停按钮）与任务 B（看门狗）共用同一中断路径。
   * 中断 + 取消排队消息 + 清执行态 + 运行卡收尾；失败时 log.warn 并在卡片注明。
   */
  const recovery = createSessionRecovery({
    log,
    resolveLink: (sessionID) => sessionMap.resolveBySession(sessionID),
    interrupt: async (sessionID, directory) => {
      const api = ctx.session.interrupt as unknown as (
        input: { sessionID: string; resume?: boolean },
        options?: { headers?: Record<string, string> },
      ) => Promise<unknown>;
      // resume:false = 中断后不续跑；带目录头以便跨 location 命中。
      await api({ sessionID, resume: false }, directory ? { headers: { "x-opencode-directory": directory } } : undefined);
    },
    cancelQueued: (sessionID, directory) => cancelQueuedPrompts(ctx, sessionID, directory),
    markEnded: (sessionID) => executions.markEnded(sessionID),
    finalizeCard: (sessionID, error) => {
      runs.apply(sessionID, { type: "execution.failed", error });
      runs.finalizeQueued(sessionID, error);
    },
    notify: (sessionID, reason, ok) => notifyStuck(sessionID, reason, ok),
  });

  /** 运行卡「强制停止」按钮：白名单 → 验签 → 绑定 sessionID → 防重放。 */
  const stop = new StopController({
    log,
    isAllowed: (openId) => owner.isAllowed(openId),
    verify: (token, sessionID) => verifyStop(token, config.signSecret, { expectSessionID: sessionID }),
    replay: new ReplayGuard(config.approvalTtlMs),
    sign: (sessionID) => signStop({ sessionID, ttlMs: config.approvalTtlMs }, config.signSecret),
    isRunning: (sessionID) => executions.isRunning(sessionID) || runs.hasActive(sessionID),
    interrupt: (sessionID, reason) => recovery.interrupt(sessionID, reason),
  });

  // 表单（含 question 工具）中继：避免 agent 反问时执行永久挂起。
  const formRelay = new FormRelay({
    sender,
    log,
    getLink: (sessionID) => sessionMap.resolveBySession(sessionID),
    isAllowed: (openId) => owner.isAllowed(openId),
    reply: (input) => replyForm(ctx, input, log),
  });

  // ── 会话管理 / 建会话向导（P6） ───────────────────────────────────────
  const wizard = new WizardStore(storage, log);
  const recent = new RecentStore(storage, log, {
    dirs: config.recentDirsLimit,
    models: config.recentModelsLimit,
  });

  /** 目录校验闭包：绑定 config.allowedRoots。 */
  const validateDir = (path: string) => validateDirectory(path, config.allowedRoots);

  /**
   * 建会话统一入口：ctx.session.create（title/model/location/permissions）→ 会话映射 + 元数据。
   * 供向导、话题自动建会话、会话卡「新建」共用。
   */
  async function createSessionInternal(input: {
    title: string;
    chatId: string;
    openId: string;
    setActive?: boolean;
    model?: ModelRef;
    directory?: string;
    permissions?: readonly { action: string; resource: string; effect: "allow" | "ask" | "deny" }[];
    perm?: PermissionPreset;
    gateMode?: "off" | "gate";
  }): Promise<{ id: string }> {
    const created = await ctx.session.create({
      title: input.title,
      ...(input.model ? { model: { id: input.model.id, providerID: input.model.providerID } } : {}),
      ...(input.directory ? { location: { directory: input.directory } } : {}),
      ...(input.permissions && input.permissions.length > 0 ? { permissions: [...input.permissions] } : {}),
    });
    await sessionMap.addSession(input.chatId, created.id, input.title, input.openId, {
      setActive: input.setActive ?? true,
    });
    await sessionMap.setSessionMeta(created.id, {
      ...(input.perm ? { perm: input.perm } : {}),
      ...(input.gateMode ? { gateMode: input.gateMode } : {}),
      ...(input.directory ? { dir: input.directory } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    return { id: created.id };
  }

  async function listModels(): Promise<readonly import("./feishu/models.js").ModelEntry[]> {
    try {
      const raw = await (ctx.model.list as unknown as () => Promise<unknown>)();
      return normalizeModelList(raw);
    } catch (err) {
      log.warn("模型列表获取失败", { error: errorMessage(err) });
      return [];
    }
  }

  /**
   * 运行卡页脚 / `/current` 用：静默读回会话真实模型（`ctx.session.get`）。
   * 读回失败只 debug，返回 undefined 由调用方降级到插件记录值。
   */
  async function readSessionModelQuiet(sessionID: string, directory?: string): Promise<ModelRef | undefined> {
    const api = (ctx.session as unknown as {
      get?: (input: { sessionID: string }, options?: { headers?: Record<string, string> }) => Promise<unknown>;
    }).get;
    if (typeof api !== "function") return undefined;
    try {
      // 跨 location 会话必须带目录头，否则服务端在网关 location 找不到会话。
      const options = directory ? { headers: { "x-opencode-directory": directory } } : undefined;
      return extractSessionModel(await api({ sessionID }, options));
    } catch (err) {
      log.debug("读回会话模型失败，回退记录值", { sessionID, error: errorMessage(err) });
      return undefined;
    }
  }

  /**
   * `/model` 切换 + **读回校验**。
   *
   * 取证结论：`switchModel` 只影响**后续** provider turn，历史消息仍保留旧模型；
   * `Session.Info.model` 才是权威的「下一轮」模型。因此切换后读回 `ctx.session.get`
   * 并以读回值写入记录 / 运行卡页脚：
   * - 读回一致 → verified；
   * - 读回不一致 → mismatch（log.warn + 回执明确告知，不假装成功）；
   * - 读回失败 → 降级为请求值并 warn。
   */
  async function switchSessionModel(sessionID: string, model: ModelRef): Promise<ModelSwitchOutcome> {
    // 跨 location 会话（网关在 A、会话在 B）必须带目录头，否则服务端找不到会话。
    const link = await sessionMap.resolveBySession(sessionID);
    const options = link?.dir ? { headers: { "x-opencode-directory": link.dir } } : undefined;
    const api = ctx.session.switchModel as unknown as (
      input: { sessionID: string; model: { id: string; providerID: string } },
      requestOptions?: { headers?: Record<string, string> },
    ) => Promise<void>;
    await api({ sessionID, model: { id: model.id, providerID: model.providerID } }, options);
    const actual = extractSessionModel(await getSessionInfoRaw(sessionID, link?.dir));
    let effective = model;
    let verified = false;
    let mismatch: boolean | undefined;
    let warning: string | undefined;
    if (actual) {
      effective = actual;
      verified = true;
      mismatch = !sameModel(actual, model);
      if (mismatch) {
        log.warn("模型切换后读回不一致", {
          sessionID,
          requested: `${model.providerID}/${model.id}`,
          actual: `${actual.providerID}/${actual.id}`,
        });
        warning = `请求 ${modelLabel(model)}，实际读到 ${modelLabel(actual)}`;
      }
    } else {
      log.warn("模型切换后读回失败，降级为请求值", {
        sessionID,
        requested: `${model.providerID}/${model.id}`,
      });
      warning = "切换后未能读回校验模型";
    }
    await sessionMap.setSessionMeta(sessionID, { model: effective });
    runs.setModel(sessionID, modelLabel(effective));
    return {
      requested: model,
      effective,
      verified,
      ...(mismatch ? { mismatch } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  async function applyPermissionPreset(sessionID: string, preset: PermissionPreset): Promise<void> {
    const permissions = presetToRuleset(preset);
    // 即使是空 ruleset（askHigh「继承」）也要显式写入，以清掉上一次预设残留的规则。
    await ctx.session.update({ sessionID, permissions });
    // 换档是显式权限变更：同时清除会话内「允许该工具」的放行集合，避免旧授权压过新档位。
    await sessionMap.setSessionMeta(sessionID, {
      perm: preset,
      gateMode: presetGateMode(preset),
      allowActions: undefined,
    });
  }

  async function moveSessionDir(sessionID: string, directory: string): Promise<void> {
    await ctx.session.move({ sessionID, directory });
    await sessionMap.setSessionMeta(sessionID, { dir: directory });
  }

  /**
   * 任务 A：把某 action **本会话内**放行。
   *
   * 1. `SessionMap` 记录 `allowActions`（gate 命中即不降级为 ask，是可靠兜底）；
   * 2. 追加会话级 ruleset（`ctx.session.update`，在**现有规则**基础上追加 allow；
   *    读不到服务端现有规则时用会话预设推导）——即使 ruleset 更新失败，第 1 步仍生效。
   *
   * shell 相关动作（`shell`/`bash`）一起放行（见 `allowActionsForGrant`）。
   */
  async function grantSessionAllow(input: { sessionID: string; action: string }): Promise<void> {
    const link = await sessionMap.resolveBySession(input.sessionID);
    const granted = allowActionsForGrant(input.action);
    const next = [...(link?.allowActions ?? [])];
    for (const action of granted) if (!next.includes(action)) next.push(action);
    await sessionMap.setSessionMeta(input.sessionID, { allowActions: next });

    const serverRules = extractSessionPermissions(await getSessionInfoRaw(input.sessionID, link?.dir));
    const base = serverRules ?? (link?.perm ? presetToRuleset(link.perm) : []);
    const permissions: PermissionRule[] = appendAllowRules(base, granted);
    try {
      const update = ctx.session.update as unknown as (
        arg: { sessionID: string; permissions: PermissionRule[] },
        options?: { headers?: Record<string, string> },
      ) => Promise<void>;
      await update(
        { sessionID: input.sessionID, permissions },
        link?.dir ? { headers: { "x-opencode-directory": link.dir } } : undefined,
      );
    } catch (err) {
      // allowActions 已写入 SessionMap，gate 仍会放行；ruleset 只是双保险。
      log.warn("会话级权限规则集更新失败（allowActions 仍生效）", {
        sessionID: input.sessionID,
        action: input.action,
        error: errorMessage(err),
      });
    }
    log.info("已在本会话内放行工具", { sessionID: input.sessionID, action: input.action, granted });
  }

  /**
   * 任务 B：获取会话摘要（复用已有 compaction 摘要 → 缺失才生成）。
   *
   * 优先 `ctx.session.context`（零模型调用）；无摘要则 `ctx.session.generate`；
   * 运行时未暴露 `session.generate` 时，退化为 `ctx.generate.text` + 上下文精简转写
   * （等价兜底，会消耗一次模型调用）。
   */
  async function summarizeSessionForResume(input: SummarizeSessionInput): Promise<SessionSummaryOutcome> {
    const readContext = async (sessionID: string, directory: string | undefined): Promise<unknown> => {
      const api = (ctx.session as unknown as {
        context?: (
          arg: { sessionID: string },
          options?: { headers?: Record<string, string> },
        ) => Promise<unknown>;
      }).context;
      if (typeof api !== "function") return undefined;
      return api({ sessionID }, directory ? { headers: { "x-opencode-directory": directory } } : undefined);
    };

    const generate = async (
      sessionID: string,
      prompt: string,
      directory: string | undefined,
    ): Promise<unknown> => {
      const api = (ctx.session as unknown as {
        generate?: (
          arg: { sessionID: string; prompt: string },
          options?: { headers?: Record<string, string> },
        ) => Promise<unknown>;
      }).generate;
      if (typeof api === "function") {
        return api({ sessionID, prompt }, directory ? { headers: { "x-opencode-directory": directory } } : undefined);
      }
      // 等价兜底：session.generate 不在运行时暴露时，用 generate.text + 上下文转写。
      const generateText = (ctx.generate as unknown as {
        text?: (arg: { prompt: string }) => Promise<unknown>;
      } | undefined)?.text;
      if (typeof generateText !== "function") return undefined;
      const transcript = buildTranscript(await readContext(sessionID, directory));
      const fullPrompt = transcript ? `${prompt}\n\n会话最近记录：\n${transcript}` : prompt;
      return generateText({ prompt: fullPrompt });
    };

    return summarizeSessionImpl({ log, readContext, generate }, input);
  }

  /**
   * 全量会话列表（P7）：`ctx.session.list()` 不在插件 SessionDomain 的公开 Pick 内，
   * 运行时可能缺失 → 返回 undefined 由 SessionCommands 回退 SessionMap。
   * 形状不稳（数组 / `{data}`）由 `normalizeSessionList` 兜。
   */
  async function listAllSessionsRaw(): Promise<unknown> {
    const api = (ctx.session as unknown as { list?: (input?: unknown) => Promise<unknown> }).list;
    if (typeof api !== "function") {
      log.debug("运行时未暴露 session.list");
      return undefined;
    }
    return api({ order: "desc" });
  }

  /**
   * 按 id 查会话是否存在（P7）：`ctx.session.get` 抛错（不存在）时返回 undefined。
   * `directory` 有值时带目录头，保证跨 location 会话也能查到。
   */
  async function getSessionInfoRaw(sessionID: string, directory?: string): Promise<unknown> {
    const api = (ctx.session as unknown as {
      get?: (input: { sessionID: string }, options?: { headers?: Record<string, string> }) => Promise<unknown>;
    }).get;
    if (typeof api !== "function") return undefined;
    try {
      const options = directory ? { headers: { "x-opencode-directory": directory } } : undefined;
      return await api({ sessionID }, options);
    } catch (err) {
      log.warn("会话查询失败（可能不存在）", { sessionID, error: errorMessage(err) });
      return undefined;
    }
  }

  /**
   * 主题软引导（P5.3）：仅对**从飞书发起**的会话注入一句 system 说明。
   * - 用 `sessionMap.resolveBySession` 判定是否飞书会话（非飞书会话绝不注入）；
   * - 标题先取 SessionMap，再 `ctx.session.get` 兜底；取不到就跳过注入；
   * - `topicGuidance=false` 时不注册；
   * - 运行时未暴露 `session.hook` 时只 warn 跳过；注入失败只 warn，不影响执行。
   */
  let topicGuidanceRegistration: { dispose: () => Promise<void> } | undefined;
  if (config.topicGuidance) {
    const hook = (ctx.session as unknown as {
      hook?: (
        name: "context",
        cb: (input: { sessionID: string; system: unknown }) => unknown,
      ) => Promise<{ dispose: () => Promise<void> }>;
    }).hook;
    if (typeof hook === "function") {
      try {
        topicGuidanceRegistration = await hook("context", (input) =>
          injectTopicGuidance(input, {
            log,
            resolveSession: (sessionID) => sessionMap.resolveBySession(sessionID),
            resolveTitle: async (sessionID, chatId) => {
              const entry = await sessionMap.getSession(chatId, sessionID);
              if (entry?.title.trim()) return entry.title;
              return extractSessionTitle(await getSessionInfoRaw(sessionID));
            },
          }),
        );
      } catch (err) {
        log.warn("主题软引导 hook 注册失败", { error: errorMessage(err) });
      }
    } else {
      log.warn("运行时未暴露 session.hook，主题软引导已跳过");
    }
  }

  const commands = new SessionCommands({
    log,
    sessionMap,
    sender,
    wizard,
    recent,
    isAllowed: (openId) => owner.isAllowed(openId),
    createSession: (input) => createSessionInternal(input),
    interruptSession: async (sessionID) => {
      // 与卡片强停共用同一恢复例程：中断 + 取消排队 + 清执行态 + 卡片收尾。
      await recovery.interrupt(sessionID, "/stop");
    },
    steerPrompt: async (message, sessionID, text) => {
      // 强制 steer：打断当前步骤，把这条消息插入执行。
      await runInSession({ ...message, text }, sessionID, message.messageId, "steer");
    },
    promoteQueued: async (sessionID) =>
      promoteQueuedInbox(ctx, sessionID, await sessionMap.resolveBySession(sessionID), log),
    listModels,
    switchSessionModel,
    getSessionModel: readSessionModelQuiet,
    applyPermissionPreset,
    moveSessionDir,
    validateDir,
    allowedRoots: config.allowedRoots,
    modelPageSize: 8,
    recentModelsLimit: config.recentModelsLimit,
    sessionPageSize: config.sessionPageSize,
    threadRouting: config.threadRouting,
    listAllSessions: listAllSessionsRaw,
    getSessionInfo: getSessionInfoRaw,
    resumeSummary: config.resumeSummary,
    resumeSummaryTimeoutMs: config.resumeSummaryTimeoutMs,
    summarizeSession: summarizeSessionForResume,
  });

  // ── 审批门 ────────────────────────────────────────────────────────────
  // P6 起 gate 按会话生效（会话预设可产生 ask），因此即使全局 permissionGate=off
  // 也要挂 evaluate hook + 订阅审批事件；无预设的会话仍走全局判定（off → 不改写，零行为变化）。
  const approvals = new ApprovalManager({
    config,
    log,
    sign: ({ requestID, sessionID, openId }) =>
      signApproval({ r: requestID, s: sessionID, u: openId, ttlMs: config.approvalTtlMs }, config.signSecret),
    verify: (token, expect) => verifyApproval(token, config.signSecret, { expect }),
    replay: new ReplayGuard(config.approvalTtlMs),
    sender,
    getLink: (sessionID) => sessionMap.resolveBySession(sessionID),
    isAllowed: (openId) => owner.isAllowed(openId),
    reply: (input) => replyPermission(ctx, input),
    // 任务 A：审批卡「✅ 本会话内允许该工具」。
    sessionAllowButton: config.sessionAllowButton,
    signAllowSession: ({ requestID, sessionID, action }) =>
      signAllowSession(
        { requestID, sessionID, action, ttlMs: config.approvalTtlMs },
        config.signSecret,
      ),
    verifyAllowSession: (token, expect) =>
      verifyAllowSession(token, config.signSecret, {
        ...(expect?.sessionID ? { expectSessionID: expect.sessionID } : {}),
        ...(expect?.action ? { expectAction: expect.action } : {}),
      }),
    allowSession: (input) => grantSessionAllow(input),
    hasSessionAllow: ({ sessionID, action }) => {
      const link = sessionMap.getLink(sessionID);
      const allowed = link?.allowActions ?? [];
      return allowActionsForGrant(action).every((a) => allowed.includes(a));
    },
  });

  const evaluateRegistration = await ctx.permission.hook("evaluate", async (event) => {
    const link = await sessionMap.resolveBySession(event.sessionID);
    const sessionGate =
      link && link.gateMode
        ? { gateMode: link.gateMode, ...(link.perm ? { askActions: presetAskActions(link.perm) } : {}) }
        : undefined;
    // 任务 A：会话内显式放行的 action 命中时不再降级为 ask（denyTools 仍优先）。
    const allowActions = link?.allowActions && link.allowActions.length > 0 ? link.allowActions : undefined;
    const decision = decideEffectForSession(event.action, config, sessionGate, allowActions);
    if (decision.effect === undefined) return;
    // 关键安全边界：只有「能投递到飞书」的会话才允许置为 ask，
    // 否则 TUI/其他来源的会话会因为没有审批出口而永久挂起。
    if (decision.effect === "ask" && !link) {
      log.debug("跳过 ask：会话无飞书映射", { sessionID: event.sessionID, action: event.action });
      return;
    }
    event.effect = decision.effect;
    if (decision.message) event.message = decision.message;
  });

  // ── 入站消息 ──────────────────────────────────────────────────────────
  async function handleMessage(message: IncomingMessage): Promise<void> {
    if (!isP2PChat(message.chatType)) {
      log.debug("忽略非 p2p 消息", { chatType: message.chatType });
      return;
    }
    if (!(await owner.admit(message.senderOpenId))) {
      log.debug("忽略非白名单用户", { sender: maskId(message.senderOpenId) });
      return;
    }
    if (!message.text) return;

    // 跨实例去重兜底：命中则直接丢弃（get-then-set 非原子，见 dedup.ts 注释）。
    if (!(await dedup.claim(message.messageId))) {
      log.debug("忽略重复消息", { messageId: message.messageId });
      return;
    }

    // 回退开关：threadRouting=false 时完全回到 P3 行为（忽略 thread_id，普通文本进当前会话）。
    if (!config.threadRouting) {
      // 回退模式下把消息当作主聊天流处理：剥掉 threadId，避免话题命令矩阵误判。
      const flat: IncomingMessage = { ...message, threadId: undefined, rootId: undefined, parentId: undefined };
      if (isCommand(flat.text)) {
        const handled = await commands.handleText(flat);
        if (handled) return;
      }
      await runInActiveSession(flat);
      return;
    }

    // 命令优先拦截：绝不把 `/xxx` 当 prompt 发给模型。
    // 话题内被禁命令（/new /sessions /use）由 SessionCommands 按 scope 回提示。
    if (isCommand(message.text)) {
      const handled = await commands.handleText(message);
      if (handled) return;
    }

    // ── 普通文本 ────────────────────────────────────────────────────────
    const hasThread = Boolean(message.threadId);
    let threadLink = hasThread ? await sessionMap.resolveByThread(message.threadId!) : undefined;
    const rootLink =
      hasThread && !threadLink && message.rootId ? await sessionMap.resolveByRoot(message.rootId) : undefined;

    const decision = decideRoute({
      hasThread,
      isCommand: false,
      threadKnown: Boolean(threadLink),
      rootKnown: Boolean(rootLink),
    });

    if (decision.kind === "main-hint") {
      // 主聊天流 = 管理台：普通文本不进入任何会话（决策 1）。
      const res = await sender.sendCard(message.chatId, buildConsoleHintCard());
      if (!res.ok) log.warn("管理台提示卡发送失败", { error: res.error ?? "unknown" });
      return;
    }

    if (decision.kind === "use-session") {
      const sessionID = threadLink?.sessionID ?? rootLink?.sessionID;
      if (!sessionID) return; // 理论不可达
      const anchor = message.rootId ?? message.messageId;
      // root 命中：补写 thread 映射；thread 命中但缺锚点时补齐锚点（审批卡出站需要）。
      if (decision.source === "root" || (threadLink && !threadLink.anchorMessageId)) {
        await sessionMap.bindThread(message.threadId!, sessionID, message.chatId, message.senderOpenId, anchor);
      }
      log.debug("话题路由命中会话", { source: decision.source, sessionID, threadId: message.threadId });
      // 若该会话有「等待自由文本」的表单字段，这条文本作为答案消费，不再当 prompt。
      if (formRelay.consumeText(sessionID, message.text)) {
        log.debug("表单自由文本已作为答案消费", { sessionID });
        return;
      }
      await runInSession(message, sessionID, message.messageId);
      return;
    }

    // create-in-thread：话题内第一条消息 → 新建会话并绑定 thread/root。
    const title = topicTitle(message.text);
    const created = await createSessionInternal({
      title,
      chatId: message.chatId,
      openId: message.senderOpenId,
      setActive: false,
    });
    const anchor = message.rootId ?? message.messageId;
    await sessionMap.bindThread(message.threadId!, created.id, message.chatId, message.senderOpenId, anchor);
    await sessionMap.bindRoot(anchor, created.id);
    log.info("话题新建 opencode 会话", { sessionID: created.id, threadId: message.threadId, chatId: message.chatId });
    await runInSession(message, created.id, message.messageId);
  }

  /**
   * 回退路径（threadRouting=false）：沿用 P3 行为，普通文本进当前会话（无则自动建）。
   * 刻意不传 replyToMessageId —— 回退模式下即使消息带 thread_id 也不落话题。
   */
  async function runInActiveSession(message: IncomingMessage): Promise<void> {
    let active = await sessionMap.getActive(message.chatId);
    if (!active) {
      const title = defaultSessionTitle(Date.now());
      const created = await createSessionInternal({
        title,
        chatId: message.chatId,
        openId: message.senderOpenId,
        setActive: true,
      });
      active = { sessionID: created.id, title, updatedAt: Date.now() };
      log.info("新建 opencode 会话", { sessionID: created.id, chatId: message.chatId });
    }
    await runInSession(message, active.sessionID);
  }

  /**
   * 在指定会话里跑一条消息：先发回执卡，再 prompt。
   * `replyToMessageId` 有值时回执卡引用该消息（话题内 → 回复留在话题）。
   */
  async function runInSession(
    message: IncomingMessage,
    sessionID: string,
    replyToMessageId?: string,
    forceDelivery?: Delivery,
  ): Promise<void> {
    // 原生排队：该 session 正在跑 execution 就 queue，否则 steer。`/steer` 强制 steer。
    const delivery: Delivery = forceDelivery ?? decideDelivery(executions.isRunning(sessionID));
    // P6：运行卡页脚展示当前模型。以**读回的真实值**为准（读回失败才回退记录值）。
    const link = await sessionMap.resolveBySession(sessionID);
    const modelRef = (await readSessionModelQuiet(sessionID, link?.dir)) ?? link?.model;
    const model = modelRef ? modelLabel(modelRef) : undefined;

    // 关键顺序：**先**发回执卡（含状态页脚），再发起 prompt。
    const receipt = await runs.beginRun({
      sessionID,
      chatId: message.chatId,
      delivery,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(model ? { model } : {}),
    });
    if (!receipt.ok) log.warn("回执卡未发送，仍继续 prompt", { sessionID, delivery });

    try {
      await promptSession(ctx, sessionID, message.text, delivery);
    } catch (err) {
      log.warn("prompt 发送失败", { sessionID, error: errorMessage(err) });
      // 卡片收尾为失败态，避免页脚永久停在「思考中」。
      runs.apply(sessionID, { type: "execution.failed", error: errorMessage(err) });
    }
  }

  const gateway = startGateway({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    log,
    logLevel: config.logLevel,
    onMessage: (message) => handleMessage(message),
    onCardAction: (action) =>
      routeCardAction(action, {
        log,
        handleForm: (a) => formRelay.handleCardAction(a),
        handleStop: (a) => stop.handleCardAction(a),
        handleCommands: (a) => commands.handleCardAction(a),
        handleApprovals: (a) => approvals.handleCardAction(a),
      }),
  });

  // ── 服务器事件订阅 ────────────────────────────────────────────────────
  const abort = new AbortController();
  const subscription = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        await handleEvent(event);
      }
    } catch (err) {
      if (!abort.signal.aborted) log.error("事件订阅异常退出", { error: errorMessage(err) });
    }
  })();

  const eventDeps: EventRouterDeps = {
    log,
    touch: (sessionID) => executions.touch(sessionID),
    markStarted: (sessionID) => executions.markStarted(sessionID),
    markEnded: (sessionID) => executions.markEnded(sessionID),
    applyRun: (sessionID, event) => runs.apply(sessionID, event),
    onPermissionAsked: (data) => approvals.onAsked(data),
    onPermissionReplied: (data) => approvals.onReplied(data),
    onFormCreated: (data) => formRelay.onCreated(data),
    onFormReplied: (data) => formRelay.onReplied(data),
    onFormCancelled: (data) => formRelay.onCancelled(data),
    notifyFailure: (sessionID, error) => notifyFailure(sessionID, error),
  };

  async function handleEvent(event: { type: string; data: unknown }): Promise<void> {
    await routeEvent(event, eventDeps);
  }

  async function notifyFailure(sessionID: string, error: unknown): Promise<void> {
    const link = await sessionMap.resolveBySession(sessionID);
    if (!link) return;
    const text = `❌ OpenCode 运行失败：${extractErrorText(error)}`;
    if (link.replyMessageId) {
      await sender.replyText(link.replyMessageId, text);
      return;
    }
    await sender.sendText(link.chatId, text);
  }

  /**
   * 看门狗（任务 B）：真正「救会话」，不再只是放开插件侧排队判定。
   * - 陈旧执行（长时间无事件）→ 走共享恢复例程主动中断 + 取消排队 + 卡片收尾；
   * - 排队超时（排队超过阈值仍无 execution.started）→ 同样中断 + 提示卡。
   * 阈值可配置（`staleExecutionMs`，默认 5 分钟，夹取 1–60 分钟）。
   */
  const stopWatchdog = startWatchdog({
    log,
    staleExecutionMs: config.staleExecutionMs,
    staleExecutions: () => executions.stale(config.staleExecutionMs),
    staleQueued: () => runs.staleQueued(config.staleExecutionMs),
    recover: (sessionID, reason) => recovery.recover(sessionID, reason),
  });

  /** 卡死 / 排队超时提示卡：带「强制停止」按钮，自动恢复失败时可手动重试。 */
  async function notifyStuck(sessionID: string, reason: string, ok: boolean): Promise<void> {
    const link = await sessionMap.resolveBySession(sessionID);
    if (!link) return;
    const lines = ok
      ? [
          `该会话**${reason}**，已自动中断并收尾，后续消息不再排队。`,
          "",
          "若仍无响应，可点下方「⏹ 强制停止」重试，或直接发新消息。",
        ]
      : [
          `该会话**${reason}**，自动中断可能未完全成功。`,
          "",
          "可点下方「⏹ 强制停止」重试，或直接发新消息。",
        ];
    const card = buildStopNoticeCard({
      title: ok ? "⏹ 已自动中断卡死会话" : "⚠️ 卡死会话自动恢复失败",
      lines,
      stopValue: stop.buildStopValue(sessionID),
      template: ok ? "orange" : "red",
    });
    const res = link.replyMessageId
      ? await sender.replyCard(link.replyMessageId, card)
      : await sender.sendCard(link.chatId, card);
    if (!res.ok) log.warn("卡死提示卡发送失败", { sessionID, error: res.error ?? "unknown" });
  }

  log.info("飞书插件已就绪");

  let cleanedUp = false;
  return async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    log.info("飞书插件卸载中");
    abort.abort();
    stopWatchdog();
    await subscription.catch(() => undefined);
    runs.dispose();
    executions.clear();
    approvals.dispose();
    formRelay.dispose();
    await evaluateRegistration.dispose().catch((err) => log.warn("evaluate hook 释放失败", { error: errorMessage(err) }));
    await topicGuidanceRegistration?.dispose().catch((err) => log.warn("主题软引导 hook 释放失败", { error: errorMessage(err) }));
    gateway.stop();
    logSink?.close();
    releaseProcessGuard();
  };
}

/**
 * opencode 以服务方式运行时，插件 stderr 会被丢弃（fd 2 是 socket，fd 1 是 /dev/null），
 * 所以 `logFile` 配置时把日志同时追加写入文件。写入失败只回退 stderr，绝不影响插件。
 */
function createLogSink(logFile: string | undefined): { sink: (line: string) => void; close: () => void } | undefined {
  if (!logFile) return undefined;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const stream = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    stream.on("error", () => {});
    return {
      sink: (line: string) => {
        stream.write(line);
      },
      close: () => {
        try {
          stream.end();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * 插件层字段名是 `reply`，HTTP 层是 `decision`（见 OPENCODE_PERMISSION_API.md §3.3）。
 * V2 的 .d.ts 由 HTTP client 生成，字段名写成 decision；运行时以 reply 为准。
 * 这里做一次防御式回退：reply 失败且疑似字段名错误时用 decision 重试（校验失败不会产生副作用）。
 */
/**
 * 尽力取消该会话尚未投递的队列消息（`/stop` 收尾 / 强停 / 看门狗）。
 *
 * `session.interrupt({resume:false})` 只中断当前执行，**队列里的 prompt 会被 park**
 * （见 openapi：queued prompts remain parked），所以卡死恢复必须显式取消它们。
 * `session.inbox` 不在插件 SessionDomain 的公开 Pick 内，运行时可能缺失 → 全程 best-effort，
 * 不抛异常，失败信息放在返回值里由调用方 log.warn。
 */
async function cancelQueuedPrompts(
  ctx: Plugin.Context,
  sessionID: string,
  directory: string | undefined,
): Promise<CancelQueuedResult> {
  const inbox = (ctx.session as unknown as {
    inbox?: {
      list?: (input: { sessionID: string }, options?: unknown) => Promise<unknown>;
      cancel?: (input: { sessionID: string; inboxID: string }, options?: unknown) => Promise<unknown>;
    };
  }).inbox;
  if (!inbox?.list || !inbox.cancel) return { cancelled: 0 };
  const options = directory ? { headers: { "x-opencode-directory": directory } } : undefined;
  let cancelled = 0;
  try {
    const items = (await inbox.list({ sessionID }, options)) as Array<{ id?: string }>;
    for (const item of items ?? []) {
      if (item?.id) {
        await inbox.cancel({ sessionID, inboxID: item.id }, options);
        cancelled += 1;
      }
    }
    return { cancelled };
  } catch (err) {
    // 部分取消成功后失败：报出已取消条数 + 错误，由调用方决定是否在卡片注明。
    return { cancelled, error: errorMessage(err) };
  }
}

/**
 * 提交 opencode 表单答复，带目录头跨 location 路由。
 *
 * `ctx.session.form` 在 2.0.16–2.0.18 的运行时不暴露（见 `feishu/form-reply.ts`），
 * 所以优先用原生域，缺失时回退到本机 HTTP API——否则表单会永久卡在待回答态。
 */
async function replyForm(
  ctx: Plugin.Context,
  input: FormReplyInput,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const form = (ctx.session as unknown as {
    form?: {
      reply?: (
        arg: Record<string, unknown>,
        options?: { headers?: Record<string, string> },
      ) => Promise<void>;
    };
  }).form;
  if (form?.reply) {
    const options = input.directory
      ? { headers: { "x-opencode-directory": input.directory } }
      : undefined;
    await form.reply(
      { sessionID: input.sessionID, formID: input.formID, answer: input.answer },
      options,
    );
    return;
  }
  await replyFormOverHttp(input, { log });
}

/**
 * 把会话内**尚未投递**的排队消息提升为 `steer`（立即插队执行）。
 * 返回提升条数；运行时未暴露 inbox 时返回 -1（`/now` 据此提示不支持）。
 */
async function promoteQueuedInbox(
  ctx: Plugin.Context,
  sessionID: string,
  link: SessionLink | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<number> {
  const inbox = (ctx.session as unknown as {
    inbox?: {
      list?: (input: { sessionID: string }, options?: unknown) => Promise<unknown>;
      update?: (
        input: { sessionID: string; inboxID: string; delivery: "steer" | "queue" },
        options?: unknown,
      ) => Promise<unknown>;
    };
  }).inbox;
  if (!inbox?.list || !inbox.update) return -1;
  const options = link?.dir ? { headers: { "x-opencode-directory": link.dir } } : undefined;
  try {
    const items = (await inbox.list({ sessionID }, options)) as Array<{ id?: string; delivery?: string }>;
    let promoted = 0;
    for (const item of items ?? []) {
      if (!item?.id || item.delivery === "steer") continue;
      await inbox.update({ sessionID, inboxID: item.id, delivery: "steer" }, options);
      promoted++;
    }
    return promoted;
  } catch (err) {
    log.warn("提升排队消息为 steer 失败", { sessionID, error: errorMessage(err) });
    return 0;
  }
}

async function replyPermission(ctx: Plugin.Context, input: ReplyInput): Promise<void> {
  const api = ctx.permission.reply as unknown as (
    arg: Record<string, unknown>,
    requestOptions?: { headers?: Record<string, string> },
  ) => Promise<void>;
  // 权限请求按 location 存储：跨 location 会话（网关在 A、会话在 B）必须带上目录头，
  // 否则服务端在网关 location 找不到请求 → Permission request not found → 执行永久卡死。
  const requestOptions = input.directory
    ? { headers: { "x-opencode-directory": input.directory } }
    : undefined;
  const base = {
    sessionID: input.sessionID,
    requestID: input.requestID,
    ...(input.message ? { message: input.message } : {}),
  };
  try {
    await api({ ...base, reply: input.reply }, requestOptions);
  } catch (err) {
    const text = errorMessage(err);
    if (/decision|missing key|invalid|validation/i.test(text)) {
      await api({ ...base, decision: input.reply }, requestOptions);
      return;
    }
    throw err;
  }
}

/**
 * 发起 prompt，带原生排队 `delivery`。
 * V2 的 promise 客户端类型对 `delivery` 的声明不稳定，这里做一次收敛的形状转换。
 */
async function promptSession(
  ctx: Plugin.Context,
  sessionID: string,
  text: string,
  delivery: Delivery,
): Promise<void> {
  const api = ctx.session.prompt as unknown as (input: {
    sessionID: string;
    text: string;
    delivery: Delivery;
  }) => Promise<unknown>;
  await api({ sessionID, text, delivery });
}
