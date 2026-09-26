/**
 * 权限预设四档 → (ruleset, gateMode)（P6，纯函数，可单测）。
 *
 * | 预设 | ruleset | gate | 说明 |
 * | --- | --- | --- | --- |
 * | readonly 🔒 | 禁 `edit`/`shell`/`write` | off | 最安全，不弹审批 |
 * | edit ✏️ | allow `edit`，`shell`→ask | gate | 可改文件，执行命令需审批 |
 * | askHigh ⚠️ | 空（继承） | gate，对 `shell`/`edit`/`external_directory` 置 ask | 高风险动作逐次审批 |
 * | trust 🔓 | allow all | off | 完全放行 |
 *
 * 说明：OpenCode 实测的 shell 工具 action id 为 `bash`（见 OPENCODE_PERMISSION_API.md），
 * 设计稿写作 `shell`；这里两者都覆盖，确保规则真正生效。
 */
import type { PermissionPreset, PermissionRule, SessionGateMode } from "../types.js";

/** shell 相关的 action 名（`bash` 为实测工具 id，`shell` 为设计稿命名）。 */
export const SHELL_ACTIONS: readonly string[] = ["shell", "bash"];

/** 权限预设元信息（卡片文案与校验共用）。 */
export interface PresetInfo {
  readonly id: PermissionPreset;
  readonly icon: string;
  readonly label: string;
  readonly description: string;
}

export const PERMISSION_PRESETS: readonly PresetInfo[] = [
  { id: "readonly", icon: "🔒", label: "只读", description: "禁止编辑 / 执行 / 写入，最安全。" },
  { id: "edit", icon: "✏️", label: "可编辑", description: "允许改文件；执行命令需你审批。" },
  {
    id: "askHigh",
    icon: "⚠️",
    label: "高风险审批",
    description: "继承默认规则，对 shell / 编辑 / 外部目录逐次审批。",
  },
  { id: "trust", icon: "🔓", label: "完全信任", description: "放行全部操作，请谨慎使用。" },
];

const ASK_ACTIONS: Readonly<Record<PermissionPreset, readonly string[]>> = {
  readonly: [],
  edit: ["shell", "bash"],
  askHigh: ["shell", "bash", "edit", "external_directory"],
  trust: [],
};

/** 全部预设 id 的有序列表（卡片按钮顺序）。 */
export const PRESET_IDS: readonly PermissionPreset[] = PERMISSION_PRESETS.map((p) => p.id);

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

export function presetInfo(preset: PermissionPreset): PresetInfo {
  return PERMISSION_PRESETS.find((p) => p.id === preset) ?? PERMISSION_PRESETS[1]!;
}

/** 卡片/回执用的短标签，如 `✏️ 可编辑`。 */
export function presetLabel(preset: PermissionPreset): string {
  const info = presetInfo(preset);
  return `${info.icon} ${info.label}`;
}

/** 预设 → 会话级权限规则集（`{action,resource,effect}`，最后匹配优先）。 */
export function presetToRuleset(preset: PermissionPreset): PermissionRule[] {
  switch (preset) {
    case "readonly": {
      const actions = ["edit", "write", ...SHELL_ACTIONS];
      return actions.map((action) => ({ action, resource: "*", effect: "deny" as const }));
    }
    case "edit": {
      return [
        { action: "edit", resource: "*", effect: "allow" },
        ...SHELL_ACTIONS.map((action) => ({ action, resource: "*", effect: "ask" as const })),
      ];
    }
    case "askHigh":
      return [];
    case "trust":
      return [{ action: "*", resource: "*", effect: "allow" }];
    default:
      return [];
  }
}

/** 预设 → gate 模式。 */
export function presetGateMode(preset: PermissionPreset): SessionGateMode {
  return preset === "readonly" || preset === "trust" ? "off" : "gate";
}

/** 预设 → gate 模式下需强制升级为 ask 的动作。 */
export function presetAskActions(preset: PermissionPreset): readonly string[] {
  return ASK_ACTIONS[preset] ?? [];
}
