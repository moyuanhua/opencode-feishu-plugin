/**
 * 允许根目录下一级子目录扫描（P6.3，可注入 `readdir` 便于单测）。
 *
 * 用途：建会话表单的目录下拉选项来源。
 * - 只扫描 **一级**（不递归），只取目录；
 * - 过滤隐藏目录（`.` 开头）与 `node_modules`；
 * - 按名称排序，最多 `MAX_ROOT_SUBDIRS` 个；
 * - 含 `.git` 的子目录标记 `isRepo`（只判断存在性，不读文件内容）；
 * - 任何失败（不存在 / 无权限 / 非目录）**静默降级为空列表**，绝不抛异常。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface RootSubdir {
  readonly name: string;
  readonly path: string;
  /** 该子目录内含 `.git`（文件或目录）→ 视为仓库。 */
  readonly isRepo: boolean;
}

/** 子目录下拉最多展示的数量。 */
export const MAX_ROOT_SUBDIRS = 15;

/** 目录项最小接口（`node:fs` 的 `Dirent` 兼容子集，便于注入假实现）。 */
export interface DirEntLike {
  readonly name: string;
  isDirectory(): boolean;
}

export type ReadDirFn = (
  path: string,
  options: { withFileTypes: true },
) => Promise<ReadonlyArray<DirEntLike>>;

export interface ScanRootDeps {
  /** 默认 `node:fs/promises.readdir`；测试注入假实现。 */
  readonly readdir?: ReadDirFn;
}

/**
 * 扫描 `root` 的一级子目录，返回已排序、已过滤、已截断的候选。
 * 失败时返回 `[]`（调用方只保留「手动输入」与根目录两项）。
 */
export async function scanRootSubdirs(root: string, deps: ScanRootDeps = {}): Promise<RootSubdir[]> {
  const rootPath = root.trim();
  if (!rootPath) return [];
  const rd: ReadDirFn = deps.readdir ?? ((path, options) => readdir(path, options));

  let entries: ReadonlyArray<DirEntLike>;
  try {
    entries = await rd(rootPath, { withFileTypes: true });
  } catch {
    return []; // 静默降级：权限 / 不存在 / 非目录
  }

  const names = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_ROOT_SUBDIRS);

  const out: RootSubdir[] = [];
  for (const name of names) {
    const path = join(rootPath, name);
    out.push({ name, path, isRepo: await hasGit(path, rd) });
  }
  return out;
}

/** 判断子目录是否含 `.git`（存在性；失败按“否”处理）。 */
async function hasGit(path: string, rd: ReadDirFn): Promise<boolean> {
  try {
    const entries = await rd(path, { withFileTypes: true });
    return entries.some((e) => e.name === ".git");
  } catch {
    return false;
  }
}
