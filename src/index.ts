/**
 * opencode-feishu-v2 — OpenCode V2 飞书插件入口。
 *
 * 能力（P0）：
 * 1. 飞书**长连接**（WSClient）接收单聊文本 → 映射/新建 opencode session → prompt；
 * 2. 订阅服务器事件，把 assistant 文本增量以飞书**流式卡片**回填；
 * 3. `permission.evaluate` hook + `permission.asked` 事件 + 卡片按钮 → `permission.reply` 审批闭环。
 *
 * 边界：只处理 p2p + 单人白名单；只申请 p2p 读 + send_as_bot；不监听端口。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { Plugin } from "@opencode/plugin";
import { hasSecret, resolveConfig, shouldHandlePermissionEvents, shouldRegisterEvaluate } from "./config.js";
import { createLogger, errorMessage, maskId } from "./logger.js";
import { OwnerPolicy } from "./security/allowlist.js";
import { ReplayGuard, signApproval, verifyApproval } from "./security/token.js";
import { startGateway } from "./feishu/gateway.js";
import { createFeishuSender } from "./feishu/sender.js";
import { SessionMap } from "./feishu/session-map.js";
import { createStreamingController } from "./feishu/streaming.js";
import { isP2PChat } from "./feishu/events.js";
import { ApprovalManager, decideEffect, type ReplyInput } from "./permission.js";
import type { IncomingMessage, PermissionRepliedLike, PermissionRequestLike, StorageLike } from "./types.js";

export default Plugin.define({
  id: "feishu",
  async setup(ctx) {
    const config = resolveConfig(ctx.options);
    const log = createLogger({ level: config.logLevel });
    for (const warning of config.warnings) log.warn(warning);

    if (!config.enabled) {
      // 配置缺失只禁用插件，不抛异常，绝不把用户的 opencode 弄挂。
      log.warn("飞书插件未启用", {
        reason: config.disabledReason ?? "unknown",
        hasAppId: hasSecret(config.appId),
        hasAppSecret: hasSecret(config.appSecret),
      });
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

      let sessionID = sessionMap.getSessionIdForChat(message.chatId);
      if (!sessionID) {
        const existing = await sessionMap.resolveByChat(message.chatId);
        sessionID = existing?.sessionID;
      }
      if (!sessionID) {
        const created = await ctx.session.create({ title: `feishu:${message.chatId}` });
        sessionID = created.id;
        log.info("新建 opencode 会话", { sessionID, chatId: message.chatId });
      }

      await sessionMap.link(message.chatId, sessionID, message.senderOpenId);
      await ctx.session.prompt({ sessionID, text: message.text });
    }

    const gateway = startGateway({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      log,
      logLevel: config.logLevel,
      onMessage: (message) => handleMessage(message),
      onCardAction: (action) => (approvals ? approvals.handleCardAction(action) : {}),
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

    return async () => {
      log.info("飞书插件卸载中");
      abort.abort();
      await subscription.catch(() => undefined);
      streaming.dispose();
      approvals?.dispose();
      if (evaluateRegistration) {
        await evaluateRegistration.dispose().catch((err) => log.warn("evaluate hook 释放失败", { error: errorMessage(err) }));
      }
      gateway.stop();
    };
  },
});

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
