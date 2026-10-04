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
import { pathToFileURL } from "node:url";
import { Plugin } from "@opencode/plugin";
import { hasSecret, resolveConfig } from "./config.js";
import { createLogger, createLogSink, errorMessage, maskId } from "./logger.js";
import {
  acquireProcessGuard,
  markExactGateway,
  releaseProcessGuard,
  trackGatewayLocationSeen,
  waitForExactGateway,
} from "./lifecycle.js";
import { OwnerPolicy } from "./security/allowlist.js";
import { ReplayGuard, signApproval, signAllowSession, signStop, verifyApproval, verifyAllowSession, verifyStop } from "./security/token.js";
import { startGateway } from "./feishu/gateway.js";
import { createFeishuSender } from "./feishu/sender.js";
import { downloadAttachment, downloadedAttachmentPrompt, resolveAttachmentDir } from "./feishu/attachments.js";
import { SessionMap } from "./feishu/session-map.js";
import { MessageDedup } from "./feishu/dedup.js";
import { decideDelivery, ExecutionTracker, SessionParentLinks, type Delivery } from "./feishu/delivery.js";
import { createRunController } from "./feishu/run-controller.js";
import { createSessionRecovery, type CancelQueuedResult } from "./feishu/session-recovery.js";
import { StopController } from "./feishu/run-stop.js";
import { startWatchdog } from "./feishu/watchdog.js";
import { FormRelay, type FormReplyInput } from "./feishu/form-relay.js";
import { cancelFormOverHttp, replyFormOverHttp } from "./feishu/form-reply.js";
import { listSessionsOverHttp } from "./session/session-list-http.js";
import { ensureGatewayWatchdog, startKeepalive } from "./session/keepalive.js";
import { isP2PChat } from "./feishu/events.js";
import { defaultSessionTitle, isCommand, topicTitle } from "./feishu/commands.js";
import { decideRoute } from "./feishu/routing.js";
import { buildConsoleHintCard, buildFinalAnswerCard, buildStopNoticeCard } from "./feishu/cards.js";
import {
  buildSessionOpenedCard,
  buildResumeCompactPendingCard,
} from "./feishu/session-cards.js";
import { buildQuickNewThinkingCard } from "./feishu/quick-new-cards.js";
import {
  buildQuickNewPrompt,
  matchCandidateDirectory,
  matchModelOption,
  parseQuickNewDecision,
  slugifyTitle,
  type QuickNewCandidate,
  type QuickNewDecision,
  type QuickNewModelOption,
} from "./session/quick-new.js";
import { isUnder, validateDirectory } from "./feishu/dirs.js";
import { scanRootSubdirs } from "./feishu/root-scan.js";
import { WizardStore } from "./feishu/wizard.js";
import { RecentStore } from "./feishu/recent.js";
import {
  extractSessionModel,
  modelLabel,
  normalizeModelList,
  sameModel,
  type ModelSwitchOutcome,
} from "./feishu/models.js";
import { extractSessionPermissions, extractSessionTitle, normalizeSessionList, type SessionListEntry } from "./feishu/session-list.js";
import { injectTopicGuidance } from "./feishu/topic-guidance.js";
import { allowActionsForGrant, appendAllowRules, presetAskActions, presetGateMode, presetToRuleset } from "./feishu/perm-presets.js";
import { ApprovalManager, decideEffectForSession, type ReplyInput } from "./permission.js";
import { SessionCommands } from "./session-commands.js";
import { routeEvent, extractErrorText, type EventRouterDeps } from "./runtime/event-router.js";
import { routeCardAction } from "./runtime/card-action-router.js";
import { createTopicStatusController } from "./runtime/topic-status.js";
import {
  extractGeneratedText,
  summarizeSession as summarizeSessionImpl,
  type SessionSummaryOutcome,
  type SummarizeSessionInput,
} from "./session/resume-summary.js";
import { CompactController } from "./session/compact.js";
import { compactSessionHttp, fetchSessionMessagesHttp } from "./session/compact-http.js";
import { quickGenerateWithSession } from "./session/quick-generate.js";
import type {
  BotMenuClick,
  CardAction,
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

    // 进程级网关看门狗（P8.1）：**每个** location 的实例都登记，但整个进程只跑一个定时器，
    // 周期性对网关 location 发一次 `GET /api/plugin`（base location 路由，实测唯一能触发
    // `locations.get()` 的通道）：续期 LayerMap；若已被回收则**重建 location**。
    // 定时器挂在进程级 globalThis 上（跨 location 共享），**与进程同寿**——即使唯一实例
    // 随 location 被销毁，看门狗仍会把它救回来（无需外部 cron）。独立日志 sink 保证
    // 实例卸载后的心跳日志仍能落盘。
    const here = (ctx.location as { directory?: string } | undefined)?.directory;
    let startedWatchdog = false;
    if (config.keepalive) {
      const watchdogTarget = config.gatewayLocation ?? here;
      if (watchdogTarget) {
        try {
          startedWatchdog = ensureGatewayWatchdog({
            log,
            directory: watchdogTarget,
            intervalMs: config.keepaliveIntervalMs,
            logFile: config.logFile,
            logLevel: config.logLevel,
          });
        } catch (err) {
          // 保活是**辅助能力**：任何异常都绝不能影响插件加载（飞书长连接）。
          log.warn("网关看门狗启动失败（已忽略）", { error: errorMessage(err) });
        }
      }
    }

    // 网关门控：只让指定 location 的实例启动（跨 location 是独立 VM context，无法用进程内单例收敛）。
    // 匹配语义：here 等于 gatewayLocation **或位于其下**（填仓库根目录即可覆盖子目录）。
    if (config.gatewayLocation) {
      // 精确匹配优先：`here === gatewayLocation` 立即就任；
      // 子目录（`isUnder`）仅作兜底，先等一个宽限窗口（`gatewayMatchGraceMs`），
      // 窗口内出现精确匹配就让位——避免 `~/.config/opencode` 之类的子目录抢跑。
      const exact = Boolean(here) && here === config.gatewayLocation;
      const sub = Boolean(here) && !exact && isUnder(here!, config.gatewayLocation);
      const matched = exact || sub;
      // 本实例启动了进程级看门狗 → 保留日志流，让看门狗后续日志仍能落盘。
      const keepSink = matched || startedWatchdog;
      // 兜底告警：配了 gatewayLocation 但已加载的 location 均未命中时，延迟 warn（仅一次）。
      // 未命中的实例把日志流保留到判定结束，保证告警能写进日志文件。
      try {
        trackGatewayLocationSeen({
          here: here ?? "(unknown)",
          expected: config.gatewayLocation,
          matched,
          warn: (message) => log.warn(message),
          ...(keepSink ? {} : { onSettled: () => logSink?.close() }),
        });
      } catch (err) {
        log.warn("网关位置跟踪失败（已忽略）", { error: errorMessage(err) });
      }
      if (!matched) {
        log.debug("跳过非网关 location", { here, expected: config.gatewayLocation });
        if (!keepSink) logSink?.close();
        return async () => {};
      }
      if (exact) {
        markExactGateway();
      } else {
        // 子目录兜底：先给精确匹配一个宽限窗口。
        const exactSeen = await waitForExactGateway(config.gatewayMatchGraceMs);
        if (exactSeen) {
          log.debug("精确匹配 location 已就绪，子目录候选让位", {
            here,
            expected: config.gatewayLocation,
          });
          if (!keepSink) logSink?.close();
          return async () => {};
        }
        log.info("精确匹配 location 未出现，子目录候选接管网关", {
          here,
          expected: config.gatewayLocation,
        });
      }
    }

    if (!acquireProcessGuard()) {
      // 同进程重复 setup（opencode 按 location 加载全局插件）：只跳过，绝不能碰第一份的资源。
      // 注意：看门狗若由本实例启动，日志流要保留。
      log.debug("检测到同进程重复 setup，跳过启动（仅首个实例生效）");
      if (!startedWatchdog) logSink?.close();
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
  const sender = createFeishuSender(client, log, { cardMaxTables: config.cardMaxTables });

  await owner.load().catch((err) => log.warn("owner 读取失败", { error: errorMessage(err) }));

  // 跨实例共享的去重（messageId）；同实例内存快路径在 MessageDedup 内部。
  const dedup = new MessageDedup(storage, log);
  // per-session 执行态，用于原生排队决策。
  const executions = new ExecutionTracker();
  // 子会话（task 子代理）→ 父会话链路：子会话事件沿父链刷新看门狗活动时间（issue #1）。
  const sessionLinks = new SessionParentLinks();

  const runs = createRunController({
    sender,
    log,
    enabled: config.stream,
    throttleMs: config.streamThrottleMs,
    cardMaxTables: config.cardMaxTables,
    runnerCardMaxTools: config.runnerCardMaxTools,
    runnerCardTextMax: config.runnerCardTextMax,
    finalAnswer: { minChars: config.finalAnswerMinChars },
    // 长回答单独成卡/成文件：运行卡只留「完整回答已单独发送」提示。
    sendFinalAnswer: (input) => sendFinalAnswer(input),
    // 每次 patch 重签强停 token（`stop` 在下方定义，闭包运行时才求值）。
    buildStopValue: (sessionID) => stop.buildStopValue(sessionID),
  });

  /**
   * 发送「最终答案」（P8.3）：超过文件阈值 → `.md` 文件；否则单独一张卡。
   * 回复用户消息（有 replyToMessageId 时）以留在话题内。
   */
  async function sendFinalAnswer(input: {
    readonly sessionID: string;
    readonly chatId: string;
    readonly replyToMessageId?: string;
    readonly text: string;
  }): Promise<void> {
    const bytes = Buffer.byteLength(input.text, "utf8");
    if (bytes > config.finalAnswerFileMinBytes) {
      const fileName = `opencode-${input.sessionID.slice(-6)}.md`;
      const res = await sender.sendFile(
        input.chatId,
        fileName,
        Buffer.from(input.text, "utf8"),
        input.replyToMessageId,
      );
      if (res.ok) {
        log.info("最终答案已转为文件发送", { sessionID: input.sessionID, bytes, fileName });
        return;
      }
      log.warn("最终答案转文件失败，降级为卡片", { sessionID: input.sessionID, error: res.error ?? "unknown" });
    }
    const card = buildFinalAnswerCard(input.text);
    const res = input.replyToMessageId
      ? await sender.replyCard(input.replyToMessageId, card)
      : await sender.sendCard(input.chatId, card);
    if (!res.ok) {
      log.warn("最终答案卡片发送失败", { sessionID: input.sessionID, error: res.error ?? "unknown" });
      return;
    }
    log.info("最终答案已单独成卡", { sessionID: input.sessionID, bytes });
  }

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

  /**
   * 话题根卡工作状态（`topicStatus`，默认开）：header 颜色 + 正文页脚，**标题默认不变**。
   *
   * 与运行卡完全独立：只更新会话**最近一次**根卡（`SessionLink.replyMessageId`），
   * 并用 `SessionMap` 持久化的 `rootCard` 基础内容重渲染 —— 状态刷新**不丢摘要/元信息**。
   * 无 `rootCard`（旧会话）或无 `replyMessageId`（非飞书会话）时控制器内部跳过。
   */
  const topicStatus = createTopicStatusController({
    log,
    enabled: config.topicStatus,
    statusInTitle: config.topicStatusInTitle,
    throttleMs: config.topicStatusThrottleMs,
    getRoot: async (sessionID) => {
      const link = await sessionMap.resolveBySession(sessionID);
      if (!link?.rootCard || !link.replyMessageId) return undefined;
      return { base: link.rootCard, messageId: link.replyMessageId };
    },
    patch: (messageId, card) => sender.patchCard(messageId, card),
    ...(config.resumeSummary
      ? { compactToken: (sessionID: string) => signCompactToken(sessionID, config.signSecret) }
      : {}),
  });

  // 表单（含 question 工具）中继：避免 agent 反问时执行永久挂起。
  const formRelay = new FormRelay({
    sender,
    log,
    getLink: (sessionID) => sessionMap.resolveBySession(sessionID),
    isAllowed: (openId) => owner.isAllowed(openId),
    reply: (input) => replyForm(ctx, input, log),
    // 选项题收到非选项文本 → 取消表单（解除阻塞），让该消息按普通 prompt 处理。
    cancel: (input) => cancelFormOverHttp(input, { log }),
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
   * 生成通道（快摘要 / AI 会话管理）的显式模型解析：
   * 会话真实模型（`ctx.session.get` 读回）优先；读不到时兜底模型列表首个。
   *
   * 背景：`/api/experimental/generate` 未指定模型时依赖服务器基础配置的默认模型，
   * 实际环境常见 400 `No model specified and no supported model is available`。
   */
  async function resolveGenerateModel(
    sessionID: string,
    directory?: string,
  ): Promise<{ providerID: string; id: string } | undefined> {
    const sessionModel = await readSessionModelQuiet(sessionID, directory);
    if (sessionModel) return { providerID: sessionModel.providerID, id: sessionModel.id };
    const first = (await listModels())[0];
    return first ? { providerID: first.providerID, id: first.id } : undefined;
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
   * 任务 B：恢复卡「🗜 压缩并总结」控制器（**用户主动**触发原生压缩）。
   *
   * 压缩会**修改会话历史**，因此只挂在按钮回调上；`enterSessionThread` 绝不调用它。
   * 轮询读取该会话消息（`session.message.list`），拿到新的 completed 摘要后 patch 回卡片。
   */
  const compact = new CompactController({
    log,
    isAllowed: (openId) => owner.isAllowed(openId),
    // 与强停同族校验：绑定 sessionID + 用途标签("compact") + TTL + nonce。
    verify: (token, sessionID) =>
      verifyStop(token, config.signSecret, { expectSessionID: sessionID }),
    replay: new ReplayGuard(config.approvalTtlMs),
    compact: (sessionID) => compactSession(ctx, sessionID, sessionMap, log),
    readMessages: (sessionID) =>
      readSessionMessages(ctx, sessionID, undefined, log),
    patchPending: (sessionID, messageId, token) =>
      patchResumeCompactPendingCard(sessionID, messageId, token, sessionMap, sender, log),
    patch: (sessionID, summary, kind, messageId) =>
      patchResumeCompactCard(sessionID, summary, kind, messageId, sessionMap, sender, log, (sid) =>
        signCompactToken(sid, config.signSecret),
      ),
    pollIntervalMs: 2000,
    timeoutMs: config.resumeCompactTimeoutMs,
  });

  /**
   * 任务 B：获取恢复卡摘要（三条路径的 ①复用 + ②快摘要）。
   *
   * - 复用：读**完整消息**（`session.message.list`，**不是** `/context` 精简形状）找 completed
   *   compaction 摘要，零模型调用；
   * - 快摘要：无原生摘要时，只喂**精简转写**（`buildTranscript`）给**无会话上下文**的
   *   `ctx.generate.text`——绝不喂整个会话（大会话必超时）；
   * - ③ 原生压缩不在本函数内（必须用户主动点按钮，见 `compact` 控制器）。
   */
  async function summarizeSessionForResume(input: SummarizeSessionInput): Promise<SessionSummaryOutcome> {
    const readMessages = async (sessionID: string, directory: string | undefined): Promise<unknown> =>
      readSessionMessages(ctx, sessionID, directory, log);

    // 快摘要临时生成：优先 A（`ctx.generate.text` + `x-opencode-session` 请求头），
    // 失败/空结果回退 B（本机 HTTP `POST /api/experimental/generate`，显式带头）。
    // **绝不**回退 `ctx.session.generate`——那会把整个会话喂给模型，大会话必超时。
    const generateText = async (prompt: string, directory: string | undefined): Promise<unknown> => {
      const api = (ctx.generate as unknown as {
        text?: (
          arg: { prompt: string; model?: { providerID: string; id: string } },
          options?: { headers?: Record<string, string> },
        ) => Promise<unknown>;
      }).text;
      // 显式模型（会话模型优先）——服务端不支持"无模型"生成。
      const model = await resolveGenerateModel(input.sessionID, directory);
      const outcome = await quickGenerateWithSession(
        {
          log,
          ...(typeof api === "function"
            ? {
                generateText: (
                  p: string,
                  requestOptions: { headers: Record<string, string> },
                  modelRef?: { providerID: string; id: string },
                ) => api({ prompt: p, ...(modelRef ? { model: modelRef } : {}) }, requestOptions),
              }
            : {}),
        },
        {
          prompt,
          sessionID: input.sessionID,
          ...(directory ? { directory } : {}),
          ...(model ? { model } : {}),
        },
      );
      return outcome.result;
    };

    return summarizeSessionImpl({ log, readMessages, generateText }, input);
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
    // `ctx.session.list` 在 V2 运行时未暴露 → 本机 HTTP `GET /api/session`
    // 兜底列出全量会话（含 TUI/Web 来源）。
    listAllSessionsHttp: () => listSessionsOverHttp({}, { log }),
    getSessionInfo: getSessionInfoRaw,
    resumeSummary: config.resumeSummary,
    resumeSummaryTimeoutMs: config.resumeSummaryTimeoutMs,
    resumeCompactTimeoutMs: config.resumeCompactTimeoutMs,
    cardMaxTables: config.cardMaxTables,
    summarizeSession: summarizeSessionForResume,
    signCompact: (sessionID) => signCompactToken(sessionID, config.signSecret),
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
    // 记住最近单聊 chatId：菜单点击事件不带 chat_id，需要靠它回推卡片（失败只降级日志）。
    void rememberMenuChat(message.senderOpenId, message.chatId);
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
    // root 兜底**不限于**有 threadId：飞书"话题的第一条消息"事件可能不带 thread_id，
    // 只带 root_id（= 被回复的消息）。恢复卡就是靠"用户回复卡片"这条路进入会话的。
    const rootLink =
      !threadLink && message.rootId ? await sessionMap.resolveByRoot(message.rootId) : undefined;

    const decision = decideRoute({
      hasThread,
      isCommand: false,
      threadKnown: Boolean(threadLink),
      rootKnown: Boolean(rootLink),
    });

    if (decision.kind === "main-hint") {
      // 主聊天流 = 管理台：普通文本不进入任何会话（决策 1）。
      // quickNew（默认开启）先做「一句话建会话」AI 识别；识别失败/闲聊回退提示卡。
      if (config.quickNew) {
        await handleQuickNew(message);
        return;
      }
      const res = await sender.sendCard(message.chatId, buildConsoleHintCard());
      if (!res.ok) log.warn("管理台提示卡发送失败", { error: res.error ?? "unknown" });
      return;
    }

    if (decision.kind === "use-session") {
      const sessionID = threadLink?.sessionID ?? rootLink?.sessionID;
      if (!sessionID) return; // 理论不可达
      const anchor = message.rootId ?? message.messageId;
      // root 命中：补写 thread 映射；thread 命中但缺锚点时补齐锚点（审批卡出站需要）。
      // 话题首条消息可能只带 root_id（无 thread_id）→ 读回消息元数据取 thread_id 再补写；
      // 读不到也不影响本次路由（下一次带 thread_id 的消息会经 root 兜底再补写）。
      if (decision.source === "root" || (threadLink && !threadLink.anchorMessageId)) {
        const threadId =
          message.threadId ?? (rootLink ? (await sender.getMessageMeta(message.messageId))?.threadId : undefined);
        if (threadId) {
          await sessionMap.bindThread(threadId, sessionID, message.chatId, message.senderOpenId, anchor);
        }
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

  // ── 机器人自定义菜单（application.bot.menu_v6）─────────────────────────
  /** 菜单 event_key → 等价命令（在开发者后台为菜单项配置这些 Key）。 */
  const MENU_COMMANDS: Record<string, { cmd: string; label: string }> = {
    new: { cmd: "/new", label: "新建会话" },
    sessions: { cmd: "/sessions", label: "会话列表" },
    // 容忍把命令原文直接当 event_key 配置。
    "/new": { cmd: "/new", label: "新建会话" },
    "/sessions": { cmd: "/sessions", label: "会话列表" },
  };
  /** openId → 最近单聊 chatId（菜单事件不带 chat_id，需记住消息来源）。 */
  const menuChatCache = new Map<string, string>();
  const menuChatKey = (openId: string): string => `feishu:v2:menu-chat:${openId}`;

  async function rememberMenuChat(openId: string, chatId: string): Promise<void> {
    if (!openId || !chatId || menuChatCache.get(openId) === chatId) return;
    menuChatCache.set(openId, chatId);
    try {
      await ctx.storage.set(menuChatKey(openId), chatId);
    } catch (err) {
      log.debug("菜单 chatId 持久化失败", { error: errorMessage(err) });
    }
  }

  async function resolveMenuChat(openId: string): Promise<string | undefined> {
    const cached = menuChatCache.get(openId);
    if (cached) return cached;
    try {
      const stored = await ctx.storage.get(menuChatKey(openId));
      if (typeof stored === "string" && stored) {
        menuChatCache.set(openId, stored);
        return stored;
      }
    } catch {
      // 读失败按未找到处理（点击会被忽略并记日志）。
    }
    return undefined;
  }

  /**
   * 菜单点击 → 合成为等价命令消息，复用既有 `handleMessage` 路由
   * （命令拦截 / 白名单 / 去重 / 主聊天流决策全部一致）。
   */
  async function handleBotMenu(click: BotMenuClick): Promise<void> {
    if (!(await owner.admit(click.operatorOpenId))) {
      log.debug("忽略非白名单用户的菜单点击", { operator: maskId(click.operatorOpenId) });
      return;
    }
    const entry = MENU_COMMANDS[click.eventKey.trim()];
    if (!entry) {
      log.debug("未知菜单 event_key，忽略", { eventKey: click.eventKey });
      return;
    }
    const chatId = await resolveMenuChat(click.operatorOpenId);
    if (!chatId) {
      log.warn("菜单点击缺少单聊上下文：请先给机器人发一条消息后再使用菜单", {
        eventKey: click.eventKey,
      });
      return;
    }
    const synthetic: IncomingMessage = {
      eventId: click.eventId,
      messageId: `menu_${click.eventId || Date.now()}`,
      chatId,
      chatType: "p2p",
      messageType: "text",
      text: entry.cmd,
      senderOpenId: click.operatorOpenId,
    };
    log.info("机器人菜单点击 → 执行命令", { eventKey: click.eventKey, cmd: entry.cmd, label: entry.label });
    await handleMessage(synthetic);
  }

  // ── 主聊天流「AI 会话管理」（issue #2 演进）────────────────────────────
  /**
   * 建会话的**目录决策**（「目录优先」：目录必须先定下来，表单永不空目录）。
   *
   * - `given`：用户明确给的路径 → 干校验（不落盘）；不可用则不预填 + 警示（不静默替换）；
   * - `existing`：命中候选（最近使用 / 历史会话目录）→ 直接用；
   * - `new`：AI 提议的新路径（允许根目录之下）→ 干校验；缺失/不可用 → 标题 slug 兜底 → 允许根目录兜底。
   */
  function resolveConsoleDir(
    decision: QuickNewDecision,
    candidates: readonly QuickNewCandidate[],
  ): {
    readonly dir?: string;
    readonly notice: string;
    readonly source: "given" | "existing" | "new" | "invalid";
  } {
    const dry = (path: string) => validateDirectory(path, config.allowedRoots, {}, { create: false });
    const root = config.allowedRoots[0];
    const newNotice = "➕ **AI 新建目录**（不存在时会在创建时自动创建；可在下方修改）";
    const fallbackNew = (): { dir?: string; notice: string; source: "new" | "invalid" } => {
      if (!root) return { notice: "⚠️ 未配置允许的根目录，请在下方填写目录。", source: "invalid" };
      const slug = slugifyTitle(decision.title ?? "");
      const candidate = slug ? `${root.replace(/\/+$/, "")}/${slug}` : root;
      const check = dry(candidate);
      if (check.ok) {
        return {
          dir: check.path,
          notice: slug ? newNotice : "🏠 使用**允许根目录**（可在下方修改）",
          source: "new",
        };
      }
      return { dir: root, notice: "🏠 使用**允许根目录**（可在下方修改）", source: "new" };
    };

    if (decision.dirSource === "given" && decision.directory) {
      const check = dry(decision.directory);
      return check.ok
        ? { dir: check.path, notice: "✍️ 目录由**你指定**（可在下方修改）", source: "given" }
        : {
            notice: `⚠️ 你指定的目录 \`${decision.directory}\` 不可用：${check.message}`,
            source: "invalid",
          };
    }
    const matched = matchCandidateDirectory(decision.directory, candidates);
    if (matched) {
      return { dir: matched, notice: "✓ 已匹配**历史 / 最近目录**（可在下方修改）", source: "existing" };
    }
    const proposed = decision.directory?.trim();
    if (proposed) {
      const check = dry(proposed);
      if (check.ok) return { dir: check.path, notice: newNotice, source: "new" };
    }
    return fallbackNew();
  }

  /**
   * 主聊天流普通文本 → AI 会话管理：
   * - `create`：AI 解析 目录/标题/权限/模型 → 把「识别中」卡**就地变成 AI 预填表单卡**，
   *   用户确认/修改后提交（表单提交后建会话并开话题，锚点 = 表单消息本身）；
   * - `list`：就地变成会话列表卡（等同 `/sessions`）；
   * - `chat` / 解析失败 / 异常：回管理台提示卡。
   * 防幻觉：目录走「目录优先」三级决策（given/existing/new）并经 allowedRoots 干校验（预填不落盘）；
   * 模型必须命中可选列表。
   */
  async function handleQuickNew(message: IncomingMessage): Promise<void> {
    const hint = async (): Promise<void> => {
      const res = await sender.sendCard(message.chatId, buildConsoleHintCard());
      if (!res.ok) log.warn("管理台提示卡发送失败", { error: res.error ?? "unknown" });
    };
    try {
      // 1) 候选目录（最近使用 + 允许根目录一级子目录 + 本机会话目录）与候选模型。
      //    「一级子目录」让 AI 先看一眼根目录下现成的目录（含从未用过的新项目），避免一律新建。
      const candidates: QuickNewCandidate[] = [];
      const seen = new Set<string>();
      const pushCandidate = (path: string, label?: string): void => {
        const trimmed = path.trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        candidates.push({ path: trimmed, ...(label ? { label } : {}) });
      };
      let entries: SessionListEntry[] = [];
      try {
        const raw = (await listAllSessionsRaw()) ?? (await listSessionsOverHttp({}, { log }));
        entries = normalizeSessionList(raw) ?? [];
      } catch (err) {
        log.debug("quick-new 会话列表读取失败", { error: errorMessage(err) });
      }
      const sessionLabelByDir = new Map<string, string>();
      for (const entry of entries) {
        if (entry.directory && entry.title) sessionLabelByDir.set(entry.directory, entry.title);
      }
      for (const dir of await recent.listDirs()) pushCandidate(dir);
      for (const root of config.allowedRoots.slice(0, 3)) {
        try {
          const subdirs = await scanRootSubdirs(root, { limit: 50 });
          for (const sub of subdirs) {
            pushCandidate(sub.path, sessionLabelByDir.get(sub.path) ?? (sub.isRepo ? "git 仓库" : undefined));
          }
        } catch (err) {
          log.debug("quick-new 一级目录扫描失败", { root, error: errorMessage(err) });
        }
      }
      for (const entry of entries) {
        if (entry.directory) pushCandidate(entry.directory, entry.title);
      }
      const routingSessionID = entries[0]?.sessionID;
      if (!routingSessionID) {
        log.debug("quick-new 无可用会话（生成通道缺少路由 sessionID），回退提示卡");
        await hint();
        return;
      }
      let models: QuickNewModelOption[] = [];
      try {
        models = (await listModels()).map((m) => ({
          providerID: m.providerID,
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
        }));
      } catch (err) {
        log.debug("quick-new 模型列表读取失败", { error: errorMessage(err) });
      }

      // 2) 就地反馈：先发「识别中」占位卡，随后 patch 为最终卡片。
      const ack = await sender.sendCard(message.chatId, buildQuickNewThinkingCard());
      if (!ack.ok || !ack.messageId) {
        await hint();
        return;
      }

      // 3) 识别（无会话上下文的一次性生成；显式模型，服务端不支持"无模型"生成）。
      const genModel = await resolveGenerateModel(routingSessionID, entries[0]?.directory);
      const generateText = async (
        prompt: string,
        requestOptions: { headers: Record<string, string> },
        model?: { providerID: string; id: string },
      ): Promise<unknown> => {
        const api = (ctx.generate as unknown as {
          text?: (
            arg: { prompt: string; model?: { providerID: string; id: string } },
            options?: { headers?: Record<string, string> },
          ) => Promise<unknown>;
        }).text;
        if (typeof api !== "function") throw new Error("generate.text unavailable");
        return api({ prompt, ...(model ? { model } : {}) }, requestOptions);
      };
      const outcome = await quickGenerateWithSession(
        { log, generateText },
        {
          prompt: buildQuickNewPrompt({
            text: message.text,
            candidates,
            models,
            allowedRoots: config.allowedRoots,
          }),
          sessionID: routingSessionID,
          ...(genModel ? { model: genModel } : {}),
        },
      );
      const decision = parseQuickNewDecision(extractGeneratedText(outcome.result));
      log.debug("quick-new 识别结果", {
        intent: decision?.intent,
        dir: decision?.directory,
        perm: decision?.perm,
        model: decision?.model,
        reason: decision?.reason,
      });

      // 4) 分流：list → 会话列表卡；create → AI 预填表单；其余/失败 → 提示卡。
      if (!decision || decision.intent === "chat") {
        await sender.patchCard(ack.messageId, buildConsoleHintCard());
        return;
      }
      if (decision.intent === "list") {
        const card = await commands.buildSessionListCard(message.chatId);
        await sender.patchCard(ack.messageId, card);
        log.info("quick-new：识别卡已就地切换为会话列表卡", { chatId: message.chatId });
        return;
      }

      // create：**先定目录**（given/existing/new，表单永不空目录），再就地变成 AI 预填表单。
      const resolution = resolveConsoleDir(decision, candidates);
      const model = matchModelOption(decision.model, models);
      const prefill = {
        title: decision.title || topicTitle(message.text),
        ...(resolution.dir ? { dir: resolution.dir } : {}),
        ...(model
          ? {
              model: {
                providerID: model.providerID,
                id: model.id,
                ...(model.name ? { name: model.name } : {}),
              },
            }
          : {}),
        ...(decision.perm ? { perm: decision.perm } : {}),
        notice: resolution.notice,
      };
      const form = await commands.buildPrefilledSetupForm(message.chatId, ack.messageId, prefill);
      await sender.patchCard(ack.messageId, form);
      log.info("quick-new：AI 预填建会话表单已发送（就地）", {
        title: prefill.title,
        dir: resolution.dir,
        dirSource: resolution.source,
        perm: decision.perm,
        model: model ? `${model.providerID}/${model.id}` : undefined,
      });
    } catch (err) {
      log.warn("quick-new 处理失败，回退管理台提示", { error: errorMessage(err) });
      await hint();
    }
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
    // 原生投递：空闲 → steer；忙时按 `busyDelivery` 偏好（默认 steer = 立即插队）。`/steer` 强制 steer。
    const delivery: Delivery = forceDelivery ?? decideDelivery(executions.isRunning(sessionID), config.busyDelivery);
    // P6：运行卡页脚展示当前模型。以**读回的真实值**为准（读回失败才回退记录值）。
    const link = await sessionMap.resolveBySession(sessionID);
    const modelRef = (await readSessionModelQuiet(sessionID, link?.dir)) ?? link?.model;
    const model = modelRef ? modelLabel(modelRef) : undefined;

    // 关键顺序：**先**发回执卡（含状态页脚），再下载附件、发起 prompt。
    const receipt = await runs.beginRun({
      sessionID,
      chatId: message.chatId,
      delivery,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(model ? { model } : {}),
    });
    if (!receipt.ok) log.warn("回执卡未发送，仍继续 prompt", { sessionID, delivery });

    // 图片/文件：先下载到本地（默认落在**会话工作目录**：`<dir>/.opencode/temp/opencode-feishu-plugin/`），
    // 作为会话附件挂进 prompt；失败降级为占位文本 + 原因。
    let promptText = message.text;
    const files: Array<{ uri: string }> = [];
    if (config.acceptAttachments && message.attachment) {
      const outcome = await downloadAttachment({
        client,
        messageId: message.messageId,
        attachment: message.attachment,
        dir: resolveAttachmentDir(config.attachmentsDir, link?.dir),
        maxBytes: config.attachmentMaxBytes,
        timeoutMs: config.attachmentTimeoutMs,
        log,
        // 显式配置的目录不动；默认的会话内目录顺手放 `.gitignore`，避免污染 git status。
        ...(config.attachmentsDir ? {} : { gitIgnore: true }),
      });
      if (outcome.ok) {
        files.push({ uri: pathToFileURL(outcome.path).href });
        promptText = `${promptText}\n\n${downloadedAttachmentPrompt(message.attachment, outcome)}`;
      } else {
        promptText = `${promptText}\n\n[附件] 下载失败：${outcome.reason}`;
      }
    }

    try {
      await promptSession(ctx, sessionID, promptText, delivery, files);
    } catch (err) {
      log.warn("prompt 发送失败", { sessionID, error: errorMessage(err) });
      // 卡片收尾为失败态，避免页脚永久停在「思考中」。
      runs.apply(sessionID, { type: "execution.failed", error: errorMessage(err) });
      // 话题根卡同样收尾为失败态（运行卡自身的终态来源之一）。
      topicStatus.markTerminal(sessionID, "failed");
    }
  }

  const gateway = startGateway({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    log,
    logLevel: config.logLevel,
    onMessage: (message) => handleMessage(message),
    onBotMenu: (click) => handleBotMenu(click),
    onCardAction: (action) =>
      routeCardAction(action, {
        log,
        handleForm: (a) => formRelay.handleCardAction(a),
        handleStop: (a) => stop.handleCardAction(a),
        handleCompact: (a) => compact.handleCardAction(a),
        handleCommands: (a) => commands.handleCardAction(a),
        handleApprovals: (a) => approvals.handleCardAction(a),
      }),
  });

  // ── 服务器事件订阅（带自动重连）───────────────────────────────────────
  // 教训：SSE 流可能被服务端在中途"正常结束"（HTTP 200 + InterruptError），
  // 早期版本只用一次性 `for await`，流一断插件就永久收不到事件（审批卡不生成、
  // 运行状态不更新），会话会停在"等一个没人能批的权限"直到看门狗强杀。
  // 现在断流后按指数退避自动重连，并把每次断/连都打日志。
  const abort = new AbortController();
  const EVENT_RETRY_BASE_MS = 1_000;
  const EVENT_RETRY_MAX_MS = 30_000;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const subscription = (async () => {
    let attempt = 0;
    while (!abort.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (attempt > 0) {
            log.info("事件订阅已重连", { attempt });
          }
          attempt = 0; // 收到过事件 = 流可用，重置退避
          await handleEvent(event);
        }
        if (abort.signal.aborted) break;
        // 流"正常结束"：不抛异常但连接没了 —— 必须重连。
        attempt += 1;
        const delay = Math.min(EVENT_RETRY_MAX_MS, EVENT_RETRY_BASE_MS * 2 ** Math.min(attempt, 5));
        log.warn("事件订阅流已结束，准备重连", { attempt, delayMs: delay });
        await sleep(delay);
      } catch (err) {
        if (abort.signal.aborted) break;
        attempt += 1;
        const delay = Math.min(EVENT_RETRY_MAX_MS, EVENT_RETRY_BASE_MS * 2 ** Math.min(attempt, 5));
        log.error("事件订阅异常，准备重连", { attempt, delayMs: delay, error: errorMessage(err) });
        await sleep(delay);
      }
    }
  })();

  const eventDeps: EventRouterDeps = {
    log,
    touch: (sessionID) => sessionLinks.walk(sessionID, (id) => executions.touch(id)),
    markStarted: (sessionID) => executions.markStarted(sessionID),
    markEnded: (sessionID) => executions.markEnded(sessionID),
    onSessionCreated: (sessionID, parentID) => {
      sessionLinks.remember(sessionID, parentID);
      log.debug("session.created 父子登记", { sessionID, parentID: parentID ?? null });
    },
    applyRun: (sessionID, event) => runs.apply(sessionID, event),
    onPermissionAsked: (data) => approvals.onAsked(data),
    onPermissionReplied: (data) => approvals.onReplied(data),
    onFormCreated: (data) => formRelay.onCreated(data),
    onFormReplied: (data) => formRelay.onReplied(data),
    onFormCancelled: (data) => formRelay.onCancelled(data),
    notifyFailure: (sessionID, error) => notifyFailure(sessionID, error),
    onTopicStatus: (event) => topicStatus.onEvent(event),
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
   * 阈值可配置（`staleExecutionMs`，默认 5 分钟，夹取 0–60 分钟；**0 = 关闭看门狗**）。
   *
   * 判活规则（issue #1）：
   * - 子会话（task 子代理）事件沿父链刷新父会话活动（`sessionLinks`）；
   * - **合法等待**（待答表单 / 未决审批）的会话不判 stale——等用户操作不算卡死。
   */
  const hasPendingInteraction = (sessionID: string): boolean =>
    approvals.hasPendingFor(sessionID) || formRelay.hasPendingFor(sessionID);

  const stopWatchdog =
    config.staleExecutionMs > 0
      ? startWatchdog({
          log,
          staleExecutionMs: config.staleExecutionMs,
          staleExecutions: () =>
            executions.stale(config.staleExecutionMs, Date.now(), hasPendingInteraction),
          staleQueued: () =>
            runs.staleQueued(config.staleExecutionMs, Date.now(), hasPendingInteraction),
          recover: (sessionID, reason) => recovery.recover(sessionID, reason),
        })
      : () => {
          log.info("看门狗已关闭（staleExecutionMs=0）");
        };

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

  /**
   * 位置保活（P8）：opencode 对每个 location 有两条 60 分钟空闲回收路径（LayerMap /
   * LocationActivity），到期会卸载插件（飞书长连接被关闭）。周期性 `GET /api/plugin`
   * 续期；已被回收时该请求直接重建 location（看门狗随进程存活，装卸后仍能自愈）。
   */
  const here = (ctx.location as { directory?: string } | undefined)?.directory;
  const keepaliveDirectory = here ?? config.gatewayLocation;
  // 网关实例「权威」更新看门狗目标为自身实际目录。
  if (config.keepalive && keepaliveDirectory) {
    try {
      ensureGatewayWatchdog({
        log,
        directory: keepaliveDirectory,
        intervalMs: config.keepaliveIntervalMs,
        authoritative: true,
        immediateDelayMs: 0,
        logFile: config.logFile,
        logLevel: config.logLevel,
      });
    } catch (err) {
      log.warn("网关看门狗登记失败（已忽略）", { error: errorMessage(err) });
    }
  }
  const stopKeepalive =
    config.keepalive && keepaliveDirectory
      ? startKeepalive({
          log,
          directory: keepaliveDirectory,
          intervalMs: config.keepaliveIntervalMs,
        })
      : undefined;

  log.info("飞书插件已就绪");

  let cleanedUp = false;
  return async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    log.info("飞书插件卸载中");
    abort.abort();
    stopWatchdog();
    stopKeepalive?.();
    await subscription.catch(() => undefined);
    runs.dispose();
    executions.clear();
    topicStatus.dispose();
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
 * （实现在 `logger.ts`：进程级看门狗也用它创建**独立于实例**的 sink。）
 */

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
 * 发起 prompt，带原生排队 `delivery` 与可选附件 `files`（file:// URI）。
 * V2 的 promise 客户端类型对 `delivery` / `files` 的声明不稳定，这里做一次收敛的形状转换。
 */
async function promptSession(
  ctx: Plugin.Context,
  sessionID: string,
  text: string,
  delivery: Delivery,
  files?: ReadonlyArray<{ uri: string }>,
): Promise<void> {
  const api = ctx.session.prompt as unknown as (input: {
    sessionID: string;
    text: string;
    delivery: Delivery;
    files?: ReadonlyArray<{ uri: string }>;
  }) => Promise<unknown>;
  await api({
    sessionID,
    text,
    delivery,
    ...(files && files.length > 0 ? { files } : {}),
  });
}

/**
 * 读会话**完整消息**（`session.message.list` 优先，回退 `session.context`）。
 *
 * 关键：恢复卡"复用摘要"必须拿到完整消息（compaction 消息带 `summary`）；
 * `/api/session/{id}/context` 返回**精简形状**（无 summary 字段），只能兜底作转写来源。
 * `directory` 有值时带 `x-opencode-directory` 头，保证跨 location 会话也能读到。
 */
async function readSessionMessages(
  ctx: Plugin.Context,
  sessionID: string,
  directory: string | undefined,
  log: ReturnType<typeof createLogger>,
): Promise<unknown> {
  const options = directory ? { headers: { "x-opencode-directory": directory } } : undefined;
  const session = ctx.session as unknown as {
    context?: (arg: { sessionID: string }, options?: unknown) => Promise<unknown>;
  };
  const messageApi = (ctx as unknown as {
    message?: { list?: (arg: { sessionID: string; limit?: number }, options?: unknown) => Promise<unknown> };
  }).message;
  const sessionMessageApi = (session as unknown as {
    message?: { list?: (arg: { sessionID: string; limit?: number }, options?: unknown) => Promise<unknown> };
  }).message;
  // 1) 插件运行时若装配了 message.list，优先用它（完整消息，含 compaction summary）。
  for (const api of [sessionMessageApi, messageApi]) {
    if (typeof api?.list === "function") {
      try {
        const raw = await api.list({ sessionID, limit: 200 }, options);
        if (raw !== undefined) return raw;
      } catch (err) {
        log.debug("session.message.list 读取失败，继续回退", { sessionID, error: errorMessage(err) });
      }
    }
  }
  // 2) 本机 HTTP `GET /api/session/{id}/message`（完整消息，含 compaction summary）。
  try {
    return await fetchSessionMessagesHttp(sessionID, directory, { log });
  } catch (err) {
    log.debug("HTTP 读取会话消息失败，回退 session.context", { sessionID, error: errorMessage(err) });
  }
  // 3) `session.context`（**精简形状**，无 summary，仅作转写兜底）。
  if (typeof session.context === "function") {
    return session.context({ sessionID }, options);
  }
  return undefined;
}

/**
 * 触发原生会话压缩：`ctx.session.compact` 优先，运行时未暴露时回退本机 HTTP API
 * （`POST /api/session/{id}/compact`，见 form-reply.ts 的同类兜底）。
 */
async function compactSession(
  ctx: Plugin.Context,
  sessionID: string,
  sessionMap: SessionMap,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const api = (ctx.session as unknown as {
    compact?: (arg: { sessionID: string }, options?: { headers?: Record<string, string> }) => Promise<unknown>;
  }).compact;
  const link = await sessionMap.resolveBySession(sessionID);
  const options = link?.dir ? { headers: { "x-opencode-directory": link.dir } } : undefined;
  if (typeof api === "function") {
    await api({ sessionID }, options);
    return;
  }
  // 运行时未暴露 session.compact：回退本机 HTTP API（`POST /api/session/{id}/compact`）。
  await compactSessionHttp(sessionID, link?.dir, { log });
}

/**
 * 把卡片 patch 成「🗜 正在压缩会话…」（用户点击后立刻反馈）。
 * 恢复卡所在消息 id = card action 的 messageId；标题从 SessionMap 取（取不到用空标题）。
 */
async function patchResumeCompactPendingCard(
  sessionID: string,
  messageId: string,
  token: string,
  sessionMap: SessionMap,
  sender: import("./feishu/sender.js").FeishuSender,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  const link = await sessionMap.resolveBySession(sessionID);
  const entry = link ? await sessionMap.getSession(link.chatId, sessionID) : undefined;
  // 根卡基础内容同步进入「压缩中」态，后续状态刷新不会把压缩占位/摘要冲掉。
  const base = await sessionMap.getRootCard(sessionID);
  if (base) await sessionMap.setRootCard(sessionID, { ...base, compactPending: true, compactError: undefined });
  const card = buildResumeCompactPendingCard(entry?.title ?? "", sessionID, token, Date.now());
  const res = await sender.patchCard(messageId, card);
  if (!res.ok) log.warn("压缩中卡片更新失败", { sessionID, error: res.error ?? "unknown" });
}

/**
 * 把压缩结果 patch 回恢复卡（成功显示「已压缩 · 会话摘要」，失败/超时显示说明）。
 * 卡片信息尽量从 SessionMap 取；取不到时用最小卡片（仍保证可读 + 按钮）。
 */
async function patchResumeCompactCard(
  sessionID: string,
  summary: string,
  kind: "completed" | "failed",
  messageId: string,
  sessionMap: SessionMap,
  sender: import("./feishu/sender.js").FeishuSender,
  log: ReturnType<typeof createLogger>,
  signCompact: (sessionID: string) => string,
): Promise<void> {
  const link = await sessionMap.resolveBySession(sessionID);
  const entry = link ? await sessionMap.getSession(link.chatId, sessionID) : undefined;
  const base = await sessionMap.getRootCard(sessionID);
  if (base) {
    await sessionMap.setRootCard(
      sessionID,
      kind === "completed"
        ? { ...base, compactPending: false, compactError: undefined, summary, summaryLabel: "已压缩 · 会话摘要" }
        : { ...base, compactPending: false, compactError: summary },
    );
  }
  const card =
    kind === "completed"
      ? buildSessionOpenedCard({
          title: entry?.title ?? "",
          sessionID,
          ...(link?.dir ? { dir: link.dir } : {}),
          summary,
          summaryLabel: "已压缩 · 会话摘要",
          compactButton: { sessionID, token: signCompact(sessionID) },
        })
      : buildSessionOpenedCard({
          title: entry?.title ?? "",
          sessionID,
          ...(link?.dir ? { dir: link.dir } : {}),
          compactError: summary,
          compactButton: { sessionID, token: signCompact(sessionID) },
        });
  // 优先 patch 用户点击的那张恢复卡（messageId）；否则回退到话题锚点消息。
  const target = messageId || link?.replyMessageId;
  if (!target) {
    log.warn("压缩结果 patch 跳过：无卡片消息 id", { sessionID });
    return;
  }
  const res = await sender.patchCard(target, card);
  if (!res.ok) log.warn("压缩结果卡片更新失败", { sessionID, error: res.error ?? "unknown" });
}

function signCompactToken(sessionID: string, secret: string): string {
  return signStop({ sessionID, ttlMs: 24 * 60 * 60 * 1000 }, secret);
}
