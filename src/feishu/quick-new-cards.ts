/**
 * 「AI 会话管理」占位卡：识别期间显示，分析完成后被**就地 patch** 成
 * 预填表单卡 / 会话列表卡 / 管理台提示卡（不再单独发送第二张卡）。
 */
export function buildQuickNewThinkingCard(): object {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: "🤔 正在识别意图…" }, template: "blue" },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "正在判断这条消息的意图，并解析目录 / 权限 / 模型等信息…",
        },
      ],
    },
  };
}
