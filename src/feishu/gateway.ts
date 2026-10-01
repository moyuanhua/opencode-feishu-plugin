/**
 * 飞书长连接网关：WSClient + EventDispatcher。
 *
 * 注册三个 handler：
 * - `im.message.receive_v1`      → 归一化后交给 onMessage；
 * - `card.action.trigger`        → 归一化后交给 onCardAction，并同步返回回调响应（<3s）；
 * - `application.bot.menu_v6`    → 机器人自定义菜单点击，归一化后交给 onBotMenu。
 *
 * 不监听端口、不暴露公网地址。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { errorMessage, maskId } from "../logger.js";
import type { BotMenuClick, CardAction, IncomingMessage, LogLevel, Logger } from "../types.js";
import { parseBotMenuEvent, parseCardAction, parseIncomingMessage, describeCardActionEvent } from "./events.js";

export interface GatewayOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: "feishu" | "lark";
  readonly log: Logger;
  readonly logLevel: LogLevel;
  readonly onMessage: (message: IncomingMessage) => void | Promise<void>;
  /**
   * 卡片回调：必须同步（或极快）返回飞书要求的响应体（如 toast）。
   * 真正的异步工作请 fire-and-forget，不要阻塞这里。
   *
   * 允许返回 Promise（如「进入话题」需先校验会话存在）：SDK 会 `await` 该 Promise
   * 作为回调响应，因此仍应在 3s 内 resolve。
   */
  readonly onCardAction: (action: CardAction) => object | void | Promise<object | void>;
  /** 机器人自定义菜单点击（`application.bot.menu_v6`）；缺省忽略。 */
  readonly onBotMenu?: (click: BotMenuClick) => void | Promise<void>;
}

export interface Gateway {
  stop(): void;
}

export function startGateway(options: GatewayOptions): Gateway {
  const { log } = options;

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: unknown) => {
      try {
        const message = parseIncomingMessage(data);
        if (!message) return;
        log.debug("收到飞书消息", {
          chatId: message.chatId,
          chatType: message.chatType,
          messageType: message.messageType,
          textPreview: message.text.slice(0, 60),
          messageId: message.messageId,
          threadId: message.threadId,
          parentId: message.parentId,
          rootId: message.rootId,
        });
        void Promise.resolve(options.onMessage(message)).catch((err) => {
          log.error("消息处理失败", { error: errorMessage(err) });
        });
      } catch (err) {
        log.error("消息 handler 异常", { error: errorMessage(err) });
      }
    },

    "card.action.trigger": async (data: unknown) => {
      try {
        // P5.2 诊断：只记录键名与布尔，确认回调是否带 thread_id（不记录 token/value/open_id 值）。
        log.info("卡片回调诊断", { ...describeCardActionEvent(data) } as Record<string, unknown>);
        const action = parseCardAction(data);
        if (!action) return {};
        // 必须 3 秒内返回；onCardAction 内部只做同步校验 + 后台 reply（少数动作先做一次快速查询）。
        return (await options.onCardAction(action)) ?? {};
      } catch (err) {
        log.error("卡片回调处理异常", { error: errorMessage(err) });
        return { toast: { type: "error", content: "处理失败，请重试" } };
      }
    },

    "application.bot.menu_v6": (data: unknown) => {
      try {
        const click = parseBotMenuEvent(data);
        if (!click) return;
        log.debug("收到机器人菜单点击", {
          eventKey: click.eventKey,
          operator: maskId(click.operatorOpenId),
        });
        if (!options.onBotMenu) return;
        void Promise.resolve(options.onBotMenu(click)).catch((err) => {
          log.error("菜单点击处理失败", { eventKey: click.eventKey, error: errorMessage(err) });
        });
      } catch (err) {
        log.error("菜单 handler 异常", { error: errorMessage(err) });
      }
    },
  });

  const loggerLevel = options.logLevel === "debug" ? Lark.LoggerLevel.debug : Lark.LoggerLevel.warn;
  const wsClient = new Lark.WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: options.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel,
    logger: {
      error: (...msg: unknown[]) => log.error("lark.ws", { msg: safeArgs(msg) }),
      warn: (...msg: unknown[]) => log.warn("lark.ws", { msg: safeArgs(msg) }),
      info: (...msg: unknown[]) => log.debug("lark.ws", { msg: safeArgs(msg) }),
      debug: (...msg: unknown[]) => log.debug("lark.ws", { msg: safeArgs(msg) }),
      trace: (...msg: unknown[]) => log.debug("lark.ws", { msg: safeArgs(msg) }),
    },
  });

  void wsClient.start({ eventDispatcher: dispatcher }).catch((err) => {
    log.error("飞书长连接启动失败", { error: errorMessage(err) });
  });
  log.info("飞书长连接已启动（WSClient）", { appIdHash: appIdFingerprint(options.appId) });

  return {
    stop() {
      try {
        wsClient.close({ force: true });
        log.info("飞书长连接已停止");
      } catch (err) {
        log.warn("飞书长连接停止异常", { error: errorMessage(err) });
      }
    },
  };
}

/** 只保留 appId 的不可逆指纹，避免把 appId 完整写日志。 */
function appIdFingerprint(appId: string): string {
  let hash = 0;
  for (let i = 0; i < appId.length; i += 1) hash = (hash * 31 + appId.charCodeAt(i)) | 0;
  return `#${(hash >>> 0).toString(16)}`;
}

function safeArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, 500);
}
