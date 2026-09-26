/**
 * 工作目录校验（P6，纯逻辑 + 可注入 fs，便于单测）。
 *
 * 规则（用户已批准）：
 * - 必须是**绝对路径**；
 * - 必须存在且是**目录**；
 * - 必须在 `allowedRoots` 之下（默认 `["/home/ubuntu"]`）；
 * - 拒绝 `/`、家目录根、常见系统目录（`/etc` `/usr` `/bin` …）。
 *
 * 安全：若可获得 `realpath`，会以**真实路径**再校验一次，避免符号链接逃逸出 allowedRoots。
 * 本模块不做任何 IO 之外的动作，也不打印路径内容；调用方负责日志脱敏。
 */
import { realpathSync, statSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
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
  | "not_dir";

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

/** 校验路径是否可作工作目录。 */
export function validateDirectory(
  rawPath: string,
  allowedRoots: readonly string[],
  deps: DirValidationDeps = {},
): DirValidation {
  const raw = rawPath.trim();
  if (!raw) return err("empty", "请提供目录路径，例如 `/dir /home/ubuntu/work/my-project`。");
  if (!isAbsolute(raw)) return err("not_absolute", "目录必须是**绝对路径**（以 `/` 开头）。");

  const stat = deps.statSync ?? statSync;
  const realpath = deps.realpathSync ?? realpathSync;
  const homedir = deps.homedir ?? osHomedir;

  const resolved = resolve(raw);
  const home = resolve(homedir());

  // 先对逻辑路径做禁区判定，给出更明确的提示。
  const blocked = forbiddenReason(resolved, home);
  if (blocked) return blocked;

  let statResult: { isDirectory(): boolean };
  let real = resolved;
  try {
    statResult = stat(resolved);
  } catch {
    return err("not_found", `目录不存在或不可访问：\`${resolved}\``);
  }
  if (!statResult.isDirectory()) return err("not_dir", `不是目录：\`${resolved}\``);
  try {
    real = realpath(resolved);
  } catch {
    real = resolved;
  }

  // 真实路径可能经符号链接逃逸，需再次做禁区与白名单校验。
  const blockedReal = forbiddenReason(real, home);
  if (blockedReal) return blockedReal;

  const roots = allowedRoots.map((r) => resolve(r));
  if (!roots.some((root) => isUnder(real, root))) {
    return err(
      "outside_allowed",
      `目录不在允许范围内。允许的根目录：${roots.map((r) => `\`${r}\``).join("、")}。`,
    );
  }
  return { ok: true, path: real };
}

/** `/`、家目录根、系统目录 → 拒绝原因；其它返回 undefined。 */
function forbiddenReason(path: string, home: string): DirValidationErr | undefined {
  if (path === sep) return err("forbidden", "不能使用根目录 `/`，请选择具体的项目子目录。");
  if (path === home) {
    return err("forbidden", `不能直接使用家目录根 \`${home}\`，请选择其下的项目子目录。`);
  }
  if (isSystemPath(path)) return err("system", `系统目录不可作为工作目录：\`${path}\`。`);
  return undefined;
}

function err(reason: DirInvalidReason, message: string): DirValidationErr {
  return { ok: false, reason, message };
}
