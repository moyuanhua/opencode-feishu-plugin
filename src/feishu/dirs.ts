/**
 * 工作目录校验（P6，纯逻辑 + 可注入 fs，便于单测）。
 *
 * 规则（用户已批准，2026-09-26 调整目录容错）：
 * - 输入为空 → 使用**允许根目录** `allowedRoots[0]`（默认用户家目录），不视为错误；
 * - 必须是**绝对路径**；
 * - 目录**不存在时自动创建**（`mkdir -p`），但仍必须落在 `allowedRoots` 之下；
 * - 拒绝 `/`、文件系统根与常见系统目录（`/etc` `/usr` `/bin` …）；
 * - `realpath` 校验放在**创建之后**，避免符号链接逃逸出 allowedRoots。
 *
 * 安全：`allowedRoots` 是唯一目录边界。空值与不存在目录都不会绕过它；
 * 本模块不做任何 IO 之外的动作，也不打印路径内容；调用方负责日志脱敏。
 */
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/** 常见系统目录：命中（含其子目录）即拒绝。 */
export const SYSTEM_DIRS: readonly string[] = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/run",
  "/root",
  "/var",
];

export type DirInvalidReason =
  | "empty"
  | "not_absolute"
  | "forbidden"
  | "system"
  | "outside_allowed"
  | "not_found"
  | "not_dir"
  | "create_failed";

export interface DirValidationOk {
  readonly ok: true;
  /** 规范化（并尽可能 realpath）后的绝对路径。 */
  readonly path: string;
}

export interface DirValidationErr {
  readonly ok: false;
  readonly reason: DirInvalidReason;
  readonly message: string;
}

export type DirValidation = DirValidationOk | DirValidationErr;

/** 可注入依赖（单测用 fake；生产默认 node:fs / node:os）。 */
export interface DirValidationDeps {
  readonly statSync?: (path: string) => { isDirectory(): boolean };
  readonly realpathSync?: (path: string) => string;
  readonly mkdirSync?: (path: string, opts: { recursive: true }) => unknown;
  readonly homedir?: () => string;
}

/** 判断 `child` 是否等于 `root` 或位于其下（按路径段，避免 /a/bc 匹配 /a/b）。 */
export function isUnder(child: string, root: string): boolean {
  if (!root || root === "/") return true;
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
  return child === normalizedRoot || child.startsWith(`${normalizedRoot}${sep}`);
}

function isSystemPath(path: string): boolean {
  return SYSTEM_DIRS.some((dir) => isUnder(path, dir));
}

/** `validateDirectory` 选项。 */
export interface ValidateDirectoryOptions {
  /**
   * 不存在时是否创建目录（默认 `true`）。
   * 表单预填前的“干校验”传 `false`：只做绝对路径 / 禁区 / 白名单判定，不落盘
   * （用户若取消也不留下空目录；提交表单时仍会真正创建）。
   */
  readonly create?: boolean;
}

/**
 * 校验路径是否可作工作目录。
 *
 * - `rawPath` 为空/空白 → 回退到 `allowedRoots[0]`；
 * - 不存在的绝对路径会在 allowedRoots 之下 `mkdir -p` 后继续校验（创建失败 → `create_failed`）；
 * - 逻辑路径与创建后的 `realpath` 都要通过禁区 + allowedRoots 校验；
 * - `opts.create=false` 时跳过创建（干校验），其余判定不变。
 */
export function validateDirectory(
  rawPath: string,
  allowedRoots: readonly string[],
  deps: DirValidationDeps = {},
  opts: ValidateDirectoryOptions = {},
): DirValidation {
  const raw = rawPath.trim();
  const roots = allowedRoots.map((r) => resolve(r)).filter((r) => r && r !== "");
  if (roots.length === 0) {
    return err("empty", "未配置允许的工作目录根（`allowedRoots`），无法确定默认目录。");
  }

  let target: string;
  if (!raw) {
    // 目录留空 = 使用允许根目录（默认 allowedRoots[0]，通常为用户家目录），不是错误。
    target = roots[0]!;
  } else {
    if (!isAbsolute(raw)) return err("not_absolute", "目录必须是**绝对路径**（以 `/` 开头）。");
    target = resolve(raw);
  }

  const stat = deps.statSync ?? statSync;
  const realpath = deps.realpathSync ?? realpathSync;
  const mkdir = deps.mkdirSync ?? mkdirSync;

  // 先对逻辑路径做禁区 + 白名单判定，给出更明确的提示（创建前不得越界）。
  const blocked = forbiddenReason(target);
  if (blocked) return blocked;
  if (!roots.some((root) => isUnder(target, root))) {
    return err("outside_allowed", outsideMessage(roots));
  }

  // 不存在则创建（mkdir -p）；存在但不是目录 → 拒绝。
  let exists = true;
  try {
    if (!stat(target).isDirectory()) return err("not_dir", `不是目录：\`${target}\``);
  } catch {
    exists = false;
  }
  if (!exists) {
    if (opts.create ?? true) {
      try {
        mkdir(target, { recursive: true });
      } catch {
        return err("create_failed", `目录不存在且无法创建：\`${target}\`。请检查路径与权限。`);
      }
    }
    // 干校验（create=false）：不落盘，仅按逻辑路径继续校验。
  }

  // realpath 校验放在创建之后：真实路径可能经符号链接逃逸，需再次做禁区 + 白名单校验。
  let real = target;
  try {
    real = realpath(target);
  } catch {
    real = target;
  }
  const blockedReal = forbiddenReason(real);
  if (blockedReal) return blockedReal;
  if (!roots.some((root) => isUnder(real, root))) {
    return err("outside_allowed", outsideMessage(roots));
  }
  return { ok: true, path: real };
}

function outsideMessage(roots: readonly string[]): string {
  return `目录不在允许范围内。允许的根目录：${roots.map((r) => `\`${r}\``).join("、")}。`;
}

/** `/`、文件系统根、系统目录 → 拒绝原因；其它返回 undefined。 */
function forbiddenReason(path: string): DirValidationErr | undefined {
  if (path === sep) return err("forbidden", "不能使用根目录 `/`，请选择具体的项目子目录。");
  if (isSystemPath(path)) return err("system", `系统目录不可作为工作目录：\`${path}\`。`);
  return undefined;
}

function err(reason: DirInvalidReason, message: string): DirValidationErr {
  return { ok: false, reason, message };
}
