import { describe, expect, test, vi } from "vitest";
import { isUnder, validateDirectory, type DirValidationDeps } from "../src/feishu/dirs.js";

const HOME = "/home/ubuntu";

/**
 * 假 fs：files 提供已存在路径 → 是否目录；real 提供 realpath 映射。
 * 不存在的路径视为可创建（记录到 `created`）。
 */
function deps(
  files: Record<string, boolean>,
  real: Record<string, string> = {},
  over: { mkdir?: (path: string) => void } = {},
): DirValidationDeps & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    statSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => files[p]! };
    },
    realpathSync: (p) => real[p] ?? p,
    mkdirSync: (p) => {
      created.push(p);
      files[p] = true;
      over.mkdir?.(p);
    },
    homedir: () => HOME,
  };
}

const ROOTS = [HOME];

describe("isUnder", () => {
  test("按路径段判断，避免前缀误匹配", () => {
    expect(isUnder("/a/b", "/a")).toBe(true);
    expect(isUnder("/a", "/a")).toBe(true);
    expect(isUnder("/ab", "/a")).toBe(false);
    expect(isUnder("/anything", "/")).toBe(true);
  });
});

describe("validateDirectory（目录容错：空=允许根 / 不存在=创建）", () => {
  test("相对路径被拒；根目录与系统目录被拒", () => {
    expect(validateDirectory("relative/path", ROOTS, deps({}))).toMatchObject({ ok: false, reason: "not_absolute" });
    const d = deps({ "/etc": true, "/usr": true, "/usr/bin": true });
    expect(validateDirectory("/", ROOTS, d)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(validateDirectory("/etc", ROOTS, d)).toMatchObject({ ok: false, reason: "system" });
    expect(validateDirectory("/usr/bin", ROOTS, d)).toMatchObject({ ok: false, reason: "system" });
  });

  test("目录留空 → 使用允许根目录（allowedRoots[0]），不是错误", () => {
    const d = deps({ [HOME]: true });
    expect(validateDirectory("", ROOTS, d)).toEqual({ ok: true, path: HOME });
    expect(validateDirectory("   ", ROOTS, d)).toEqual({ ok: true, path: HOME });
  });

  test("允许根目录本身可作工作目录（默认就是家目录）", () => {
    expect(validateDirectory(HOME, [HOME], deps({ [HOME]: true }))).toMatchObject({ ok: true, path: HOME });
  });

  test("不存在的目录 → 在允许根之下自动创建（mkdir -p）", () => {
    const d = deps({ [HOME]: true });
    const res = validateDirectory(`${HOME}/work/new-app`, ROOTS, d);
    expect(res).toEqual({ ok: true, path: `${HOME}/work/new-app` });
    expect(d.created).toEqual([`${HOME}/work/new-app`]);
  });

  test("不存在的目录但越出允许根 → 拒绝且**不创建**", () => {
    const d = deps({ [HOME]: true });
    expect(validateDirectory("/data/proj", ROOTS, d)).toMatchObject({ ok: false, reason: "outside_allowed" });
    expect(d.created).toEqual([]);
  });

  test("存在但不是目录 → not_dir，不创建", () => {
    const d = deps({ [`${HOME}/file.txt`]: false });
    expect(validateDirectory(`${HOME}/file.txt`, ROOTS, d)).toMatchObject({ ok: false, reason: "not_dir" });
    expect(d.created).toEqual([]);
  });

  test("创建失败（mkdir 抛错）→ create_failed", () => {
    const d = deps({ [HOME]: true }, {}, { mkdir: () => { throw new Error("EACCES"); } });
    expect(validateDirectory(`${HOME}/work/denied`, ROOTS, d)).toMatchObject({ ok: false, reason: "create_failed" });
  });

  test("已存在目录：返回规范化后的真实路径", () => {
    const d = deps({ [`${HOME}/work/app`]: true }, { [`${HOME}/work/app`]: `${HOME}/work/app` });
    expect(validateDirectory(`${HOME}/work/app`, ROOTS, d)).toEqual({ ok: true, path: `${HOME}/work/app` });
  });

  test("符号链接逃逸：逻辑路径合法但真实路径落系统目录 → 拒绝", () => {
    const d = deps({ [`${HOME}/work/link`]: true }, { [`${HOME}/work/link`]: "/etc" });
    expect(validateDirectory(`${HOME}/work/link`, ROOTS, d)).toMatchObject({ ok: false, reason: "system" });
  });

  test("realpath 落 allowedRoots 之外 → 拒绝", () => {
    const d = deps({ [`${HOME}/work/app`]: true }, { [`${HOME}/work/app`]: "/mnt/data/app" });
    expect(validateDirectory(`${HOME}/work/app`, ROOTS, d)).toMatchObject({ ok: false, reason: "outside_allowed" });
  });

  test("allowedRoots 为空 → 明确报错（不会误落到 /）", () => {
    expect(validateDirectory("", [], deps({}))).toMatchObject({ ok: false, reason: "empty" });
  });
});

// 保留对 mkdir 调用的显式 mock 断言（与上面 injected deps 互补）。
describe("validateDirectory mkdir 调用", () => {
  test("仅在实际不存在时 mkdir", () => {
    const mkdir = vi.fn();
    const d = deps({ [HOME]: true }, {}, { mkdir });
    expect(validateDirectory(`${HOME}/x`, ROOTS, d).ok).toBe(true);
    expect(mkdir).toHaveBeenCalledWith(`${HOME}/x`);
  });
});
