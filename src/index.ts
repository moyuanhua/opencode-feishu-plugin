/**
 * opencode-feishu-v2 — OpenCode V2 飞书插件入口。
 *
 * 能力（P0/P2）：
 * 1. 飞书**长连接**（WSClient）接收单聊文本 → 映射/新建 opencode session → prompt；
 * 2. 订阅服务器事件，把 assistant 文本增量以飞书**流式卡片**回填；
 * 3. `permission.evaluate` hook + `permission.asked` 事件 + 卡片按钮 → `permission.reply` 审批闭环；
 * 4. 会话管理：`/new`、`/sessions`、`/use`、`/current`、`/stop`、`/help` + 会话卡片切换。
 *
 * 边界：只处理 p2p + 单人白名单；只申请 p2p 读 + send_as_bot；不监听端口。
 * 进程级幂等：opencode 会随不同 location 多次 setup，这里用 `SetupGuard` 保证只启动一份。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Plugin } from "@opencode/plugin";
import { hasSecret, resolveConfig, shouldHandlePermissionEvents, shouldRegisterEvaluate } from "./config.js";
import { createLogger, errorMessage, maskId } from "./logger.js";
import { SetupGuard } from "./lifecycle.js";
import { OwnerPolicy } from "./security/allowlist.js";
import { ReplayGuard, signApproval, verifyApproval } from "./security/token.js";
import { startGateway } from "./feishu/gateway.js";
import { createFeishuSender } from "./feishu/sender.js";
import { SessionMap } from "./feishu/session-map.js";
import { createStreamingController } from "./feishu/streaming.js";
import { isP2PChat } from "./feishu/events.js";
import { defaultSessionTitle, isCommand } from "./feishu/commands.js";
import { parseSessionCardValue } from "./feishu/session-cards.js";
import { ApprovalManager, decideEffect, type ReplyInput } from "./permission.js";
import { SessionCommands } from "./session-commands.js";
import type { IncomingMessage, PermissionRepliedLike, PermissionRequestLike, StorageLike } from "./types.js";

/** 进程级单例：同一进程内只真正启动一次 gateway/订阅。 */
const setupGuard = new SetupGuard();

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
      hasAppSecret: hasSecret(config.appSecret),
    });

    if (!setupGuard.acquire()) {
      // 同进程重复 setup（opencode 按 location 加载全局插件）：只跳过，绝不能碰第一份的资源。
      log.debug("检测到同进程重复 setup，跳过启动（仅首个实例生效）");
      logSink?.close();
      return async () => {};
    }

    try {
      return await start(ctx, config, log, logSink);
    } catch (err) {
      // 启动失败时释放占用，允许后续重试。
      setupGuard.release();
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

  const streaming = createStreamingController({
    sender,
    log,
    enabled: config.stream,
    throttleMs: config.streamThrottleMs,
    getLink: (sessionID) => sessionMap.resolveBySession(sessionID),
  });

  // ── 会话管理（文本命令 + 会话卡片按钮） ──────────────────────────────
  const commands = new SessionCommands({
    log,
    sessionMap,
    sender,
    isAllowed: (openId) => owner.isAllowed(openId),
    createSession: async (title) => {
      const created = await ctx.session.create({ title });
      return { id: created.id };
    },
    interruptSession: async (sessionID) => {
      // V2 的字段是 `resume`（缺省 false 即中断后不续跑）；兼容文档中曾提到的 `continue`。
      await ctx.session.interrupt({ sessionID, resume: false });
    },
  });

  // ── 审批门 ────────────────────────────────────────────────────────────
  let approvals: ApprovalManager | undefined;
  if (shouldHandlePermissionEvents(config.permissionGate)) {
    approvals = new ApprovalManager({
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
  }

  let evaluateRegistration: { dispose(): Promise<void> } | undefined;
  if (shouldRegisterEvaluate(config.permissionGate)) {
    evaluateRegistration = await ctx.permission.hook("evaluate", async (event) => {
      const decision = decideEffect(event.action, config);
      if (decision.effect === undefined) return;
      // 关键安全边界：只有「能投递到飞书」的会话才允许置为 ask，
      // 否则 TUI/其他来源的会话会因为没有审批出口而永久挂起。
      if (decision.effect === "ask" && !(await sessionMap.resolveBySession(event.sessionID))) {
        log.debug("跳过 ask：会话无飞书映射", { sessionID: event.sessionID, action: event.action });
        return;
      }
      event.effect = decision.effect;
      if (decision.message) event.message = decision.message;
    });
  }

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

    // 命令优先拦截：绝不把 `/xxx` 当 prompt 发给模型。
    if (isCommand(message.text)) {
      const handled = await commands.handleText(message);
      if (handled) return;
    }

    // 兼容：没显式建过会话时，第一条普通消息自动建会话并绑定。
    let active = await sessionMap.getActive(message.chatId);
    if (!active) {
      const title = defaultSessionTitle(Date.now());
      const created = await ctx.session.create({ title });
      await sessionMap.addSession(message.chatId, created.id, title, message.senderOpenId);
      active = { sessionID: created.id, title, updatedAt: Date.now() };
      log.info("新建 opencode 会话", { sessionID: created.id, chatId: message.chatId });
    }

    await ctx.session.prompt({ sessionID: active.sessionID, text: message.text });
  }

  const gateway = startGateway({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    log,
    logLevel: config.logLevel,
    onMessage: (message) => handleMessage(message),
    onCardAction: (action) => {
      // 会话卡片优先；其余交给审批卡（value 里带 `cmd` 的才是会话操作）。
      if (parseSessionCardValue(action.rawValue)) return commands.handleCardAction(action);
      return approvals ? approvals.handleCardAction(action) : {};
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
        if (approvals) {
          void approvals
            .onAsked(event.data as PermissionRequestLike)
            .catch((err) => log.warn("处理 permission.asked 失败", { error: errorMessage(err) }));
        }
        break;
      case "permission.replied":
        approvals?.onReplied(event.data as PermissionRepliedLike);
        break;
      case "session.text.started": {
        const data = event.data as { sessionID: string; assistantMessageID?: string };
        streaming.onStarted(data.sessionID, data.assistantMessageID);
        break;
      }
      case "session.text.delta": {
        const data = event.data as { sessionID: string; delta: string };
        streaming.onDelta(data.sessionID, data.delta);
        break;
      }
      case "session.text.ended": {
        const data = event.data as { sessionID: string; text: string };
        streaming.onEnded(data.sessionID, data.text);
        break;
      }
      case "session.idle": {
        const data = event.data as { sessionID: string };
        streaming.onIdle(data.sessionID);
        break;
      }
      case "session.execution.failed": {
        const data = event.data as { sessionID: string; error: unknown };
        void notifyFailure(data.sessionID, data.error);
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
    streaming.dispose();
    approvals?.dispose();
    if (evaluateRegistration) {
      await evaluateRegistration.dispose().catch((err) => log.warn("evaluate hook 释放失败", { error: errorMessage(err) }));
    }
    gateway.stop();
    logSink?.close();
    setupGuard.release();
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
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message.slice(0, 300);
    if (typeof record.type === "string") return record.type;
  }
  return "unknown";
}
