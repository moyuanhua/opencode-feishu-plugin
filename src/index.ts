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
import { ReplayGuard, signApproval, verifyApproval } from "./security/token.js";
import { startGateway } from "./feishu/gateway.js";
import { createFeishuSender } from "./feishu/sender.js";
import { SessionMap } from "./feishu/session-map.js";
import { MessageDedup } from "./feishu/dedup.js";
import { decideDelivery, ExecutionTracker, type Delivery } from "./feishu/delivery.js";
import { createRunController } from "./feishu/run-controller.js";
import type { RunEvent } from "./feishu/run-state.js";
import { isP2PChat } from "./feishu/events.js";
import { defaultSessionTitle, isCommand, topicTitle } from "./feishu/commands.js";
import { decideRoute } from "./feishu/routing.js";
import { buildConsoleHintCard } from "./feishu/cards.js";
import { parseSessionCardValue } from "./feishu/session-cards.js";
import { isSetupFormAction, parseSetupCardValue } from "./feishu/setup-cards.js";
import { validateDirectory } from "./feishu/dirs.js";
import { WizardStore } from "./feishu/wizard.js";
import { RecentStore } from "./feishu/recent.js";
import { modelLabel, normalizeModelList } from "./feishu/models.js";
import { presetAskActions, presetGateMode, presetToRuleset } from "./feishu/perm-presets.js";
import { ApprovalManager, decideEffectForSession, type ReplyInput } from "./permission.js";
import { SessionCommands } from "./session-commands.js";
import type {
  IncomingMessage,
  ModelRef,
  PermissionRepliedLike,
  PermissionRequestLike,
  PermissionPreset,
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

  async function switchSessionModel(sessionID: string, model: ModelRef): Promise<void> {
    await ctx.session.switchModel({ sessionID, model: { id: model.id, providerID: model.providerID } });
    await sessionMap.setSessionMeta(sessionID, { model });
    runs.setModel(sessionID, modelLabel(model));
  }

  async function applyPermissionPreset(sessionID: string, preset: PermissionPreset): Promise<void> {
    const permissions = presetToRuleset(preset);
    // 即使是空 ruleset（askHigh「继承」）也要显式写入，以清掉上一次预设残留的规则。
    await ctx.session.update({ sessionID, permissions });
    await sessionMap.setSessionMeta(sessionID, { perm: preset, gateMode: presetGateMode(preset) });
  }

  async function moveSessionDir(sessionID: string, directory: string): Promise<void> {
    await ctx.session.move({ sessionID, directory });
    await sessionMap.setSessionMeta(sessionID, { dir: directory });
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
      // V2 的字段是 `resume`（缺省 false 即中断后不续跑）；兼容文档中曾提到的 `continue`。
      await ctx.session.interrupt({ sessionID, resume: false });
    },
    listModels,
    switchSessionModel,
    applyPermissionPreset,
    moveSessionDir,
    validateDir,
    allowedRoots: config.allowedRoots,
    modelPageSize: 8,
    recentModelsLimit: config.recentModelsLimit,
    threadRouting: config.threadRouting,
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
  });

  const evaluateRegistration = await ctx.permission.hook("evaluate", async (event) => {
    const link = await sessionMap.resolveBySession(event.sessionID);
    const sessionGate =
      link && link.gateMode
        ? { gateMode: link.gateMode, ...(link.perm ? { askActions: presetAskActions(link.perm) } : {}) }
        : undefined;
    const decision = decideEffectForSession(event.action, config, sessionGate);
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
  ): Promise<void> {
    // 原生排队：该 session 正在跑 execution 就 queue，否则 steer。
    const delivery: Delivery = decideDelivery(executions.isRunning(sessionID));
    // P6：运行卡页脚展示当前模型（会话元数据里记录的）。
    const link = await sessionMap.resolveBySession(sessionID);
    const model = link?.model ? modelLabel(link.model) : undefined;

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
    onCardAction: (action) => {
      // 会话卡 / 向导卡 / 表单提交优先；其余交给审批卡（value 里带 `cmd` / `wizard` 的才是管理操作）。
      const value = action.rawValue;
      if (
        action.formValue !== undefined ||
        isSetupFormAction(value) ||
        parseSessionCardValue(value) ||
        parseSetupCardValue(value)
      ) {
        return commands.handleCardAction(action);
      }
      return approvals.handleCardAction(action);
    },
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

  async function handleEvent(event: { type: string; data: unknown }): Promise<void> {
    switch (event.type) {
      case "permission.asked":
        // 发卡是网络 IO，不能阻塞事件流（否则会拖慢后续 text.delta）。
        void approvals
          .onAsked(event.data as PermissionRequestLike)
          .catch((err) => log.warn("处理 permission.asked 失败", { error: errorMessage(err) }));
        break;
      case "permission.replied":
        approvals.onReplied(event.data as PermissionRepliedLike);
        break;
      case "session.text.started": {
        const data = event.data as { sessionID: string; assistantMessageID?: string };
        runs.apply(data.sessionID, {
          type: "text.started",
          ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
        });
        break;
      }
      case "session.text.delta": {
        const data = event.data as { sessionID: string; delta: string; assistantMessageID?: string };
        runs.apply(data.sessionID, {
          type: "text.delta",
          delta: data.delta,
          ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
        });
        break;
      }
      case "session.text.ended": {
        const data = event.data as { sessionID: string; text?: string; assistantMessageID?: string };
        runs.apply(data.sessionID, {
          type: "text.ended",
          ...(data.text ? { text: data.text } : {}),
          ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
        });
        break;
      }
      case "session.tool.input.started": {
        const data = event.data as { sessionID: string; id: string; name: string; assistantMessageID?: string };
        runs.apply(data.sessionID, {
          type: "tool.input.started",
          id: data.id,
          name: data.name,
          ...(data.assistantMessageID ? { assistantMessageID: data.assistantMessageID } : {}),
        });
        break;
      }
      case "session.tool.input.ended": {
        const data = event.data as { sessionID: string; id: string; input?: unknown };
        runs.apply(data.sessionID, { type: "tool.input.ended", id: data.id, input: data.input });
        break;
      }
      case "session.tool.success": {
        const data = event.data as { sessionID: string; id: string; content?: unknown };
        runs.apply(data.sessionID, {
          type: "tool.success",
          id: data.id,
          output: contentToText(data.content),
        });
        break;
      }
      case "session.tool.error": {
        const data = event.data as { sessionID: string; id: string; content?: unknown; error?: unknown };
        runs.apply(data.sessionID, {
          type: "tool.error",
          id: data.id,
          output: extractErrorText(data.error ?? data.content),
        });
        break;
      }
      case "session.execution.started": {
        const data = event.data as { sessionID: string };
        executions.markStarted(data.sessionID);
        runs.apply(data.sessionID, { type: "execution.started" });
        break;
      }
      case "session.execution.succeeded": {
        const data = event.data as { sessionID: string };
        executions.markEnded(data.sessionID);
        runs.apply(data.sessionID, { type: "execution.succeeded" });
        break;
      }
      case "session.execution.failed": {
        const data = event.data as { sessionID: string; error: unknown };
        executions.markEnded(data.sessionID);
        runs.apply(data.sessionID, { type: "execution.failed", error: extractErrorText(data.error) });
        void notifyFailure(data.sessionID, data.error);
        break;
      }
      case "session.idle": {
        // 兜底收尾：某些路径可能没有 execution.succeeded，避免页脚悬挂。
        const data = event.data as { sessionID: string };
        executions.markEnded(data.sessionID);
        runs.apply(data.sessionID, { type: "execution.succeeded" });
        break;
      }
      default:
        break;
    }
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

  log.info("飞书插件已就绪");

  let cleanedUp = false;
  return async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    log.info("飞书插件卸载中");
    abort.abort();
    await subscription.catch(() => undefined);
    runs.dispose();
    executions.clear();
    approvals.dispose();
    await evaluateRegistration.dispose().catch((err) => log.warn("evaluate hook 释放失败", { error: errorMessage(err) }));
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
async function replyPermission(ctx: Plugin.Context, input: ReplyInput): Promise<void> {
  const api = ctx.permission.reply as unknown as (arg: Record<string, unknown>) => Promise<void>;
  const base = {
    sessionID: input.sessionID,
    requestID: input.requestID,
    ...(input.message ? { message: input.message } : {}),
  };
  try {
    await api({ ...base, reply: input.reply });
  } catch (err) {
    const text = errorMessage(err);
    if (/decision|missing key|invalid|validation/i.test(text)) {
      await api({ ...base, decision: input.reply });
      return;
    }
    throw err;
  }
}

function extractErrorText(error: unknown): string {
  if (!error) return "unknown";
  if (typeof error === "string") return error.slice(0, 300);
  if (Array.isArray(error)) return contentToText(error).slice(0, 300) || "unknown";
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message.slice(0, 300);
    if (typeof record.type === "string") return record.type;
  }
  return "unknown";
}

/** 工具事件里的 `content` 可能是字符串 / 对象 / `[{type:"text",text}]` 数组。 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
          return (item as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
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
