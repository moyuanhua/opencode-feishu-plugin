/**
 * 话题路由决策（纯函数，无 IO，可单测）。
 *
 * 依据 P5 计划「三、入站路由」：
 *
 *   thread/root 命中 ?
 *   ├─ thread 命中 → 用该会话
 *   ├─ 否则 root 命中 → 用该会话（上层补写 thread 映射）
 *   │     ※ root 命中即使**没有 threadId** 也算（飞书"话题第一条消息"事件可能只带
 *   │       root_id；恢复卡就是靠"用户回复卡片"这条路进入会话的）
 *   └─ 都未命中
 *       ├─ 有 threadId（话题内第一条消息）→ 新建会话（标题=首条消息摘要）
 *       └─ 无 threadId（主聊天流 = 管理台）→ 回提示卡，不进入任何会话
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
  // thread 命中优先；root 命中次之（即使没有 threadId，见文件头注释）。
  if (facts.threadKnown) return { kind: "use-session", source: "thread" };
  if (facts.rootKnown) return { kind: "use-session", source: "root" };
  // 都未命中：有 threadId = 话题内第一条消息 → 新建；否则主聊天流 → 提示卡。
  if (!facts.hasThread) return { kind: "main-hint" };
  return { kind: "create-in-thread" };
}

/** 会话范围：主聊天流（管理台）或话题内。 */
export type CommandScope = "main" | "thread";

export function commandScope(hasThread: boolean): CommandScope {
  return hasThread ? "thread" : "main";
}
