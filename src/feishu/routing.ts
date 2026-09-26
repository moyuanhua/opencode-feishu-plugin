/**
 * 话题路由决策（纯函数，无 IO，可单测）。
 *
 * 依据 P5 计划「三、入站路由」：
 *
 *   有 threadId ?
 *   ├─ 是
 *   │   ├─ thread 命中 → 用该会话
 *   │   ├─ 否则 root 命中 → 用该会话（上层补写 thread 映射）
 *   │   └─ 都未命中 → 新建会话（标题=首条消息摘要）
 *   └─ 否（主聊天流 = 管理台）
 *       ├─ 以 / 开头 → 管理命令
 *       └─ 普通文本 → 回提示卡，不进入任何会话
 *
 * 这里只做判定，命中信息由上层异步解析后传入，保证决策可测试。
 */

/** 路由判定所需的事实（均已由上层解析）。 */
export interface RouteFacts {
  readonly hasThread: boolean;
  readonly isCommand: boolean;
  /** `feishu:v2:thread:<tid>` 命中。 */
  readonly threadKnown: boolean;
  /** `feishu:v2:root:<rootId>` 命中（thread 未命中时的兜底）。 */
  readonly rootKnown: boolean;
}

export type RouteDecision =
  /** 命令：由命令矩阵按 scope（主聊天流 / 话题）处理。 */
  | { readonly kind: "command" }
  /** 命中已有会话：`source` 指示来自 thread 还是 root（root 需补写 thread 映射）。 */
  | { readonly kind: "use-session"; readonly source: "thread" | "root" }
  /** 话题里第一条消息：新建会话并绑定 thread/root。 */
  | { readonly kind: "create-in-thread" }
  /** 主聊天流普通文本：回管理台提示卡，不进入任何会话。 */
  | { readonly kind: "main-hint" };

export function decideRoute(facts: RouteFacts): RouteDecision {
  if (facts.isCommand) return { kind: "command" };
  if (!facts.hasThread) return { kind: "main-hint" };
  if (facts.threadKnown) return { kind: "use-session", source: "thread" };
  if (facts.rootKnown) return { kind: "use-session", source: "root" };
  return { kind: "create-in-thread" };
}

/** 会话范围：主聊天流（管理台）或话题内。 */
export type CommandScope = "main" | "thread";

export function commandScope(hasThread: boolean): CommandScope {
  return hasThread ? "thread" : "main";
}
