import { describe, expect, test } from "vitest";
import { isUnder, validateDirectory, type DirValidationDeps } from "../src/feishu/dirs.js";

const HOME = "/home/ubuntu";

/** 假 fs：files 提供路径→是否目录；real 提供 realpath 映射。 */
function deps(files: Record<string, boolean>, real: Record<string, string> = {}): DirValidationDeps {
  return {
    homedir: () => HOME,
    statSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => files[p]! };
    },
    realpathSync: (p) => real[p] ?? p,
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

describe("validateDirectory", () => {
  test("空 / 相对路径", () => {
    expect(validateDirectory("  ", ROOTS, deps({}))).toMatchObject({ ok: false, reason: "empty" });
    expect(validateDirectory("relative/path", ROOTS, deps({}))).toMatchObject({ ok: false, reason: "not_absolute" });
  });

  test("拒绝根目录、家目录根、系统目录", () => {
    const d = deps({ "/etc": true, "/usr": true, "/usr/bin": true, HOME: true });
    expect(validateDirectory("/", ROOTS, d)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(validateDirectory(HOME, ROOTS, d)).toMatchObject({ ok: false, reason: "forbidden" });
    expect(validateDirectory("/etc", ROOTS, d)).toMatchObject({ ok: false, reason: "system" });
    expect(validateDirectory("/usr/bin", ROOTS, d)).toMatchObject({ ok: false, reason: "system" });
  });

  test("不存在 / 不是目录", () => {
    expect(validateDirectory("/home/ubuntu/nope", ROOTS, deps({}))).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    const fileOnly = deps({ "/home/ubuntu/file.txt": false });
    expect(validateDirectory("/home/ubuntu/file.txt", ROOTS, fileOnly)).toMatchObject({
      ok: false,
      reason: "not_dir",
    });
  });

  test("allowedRoots 之外被拒", () => {
    const d = deps({ "/data/proj": true, "/home/ubuntu/work/app": true });
    expect(validateDirectory("/data/proj", ROOTS, d)).toMatchObject({ ok: false, reason: "outside_allowed" });
    expect(validateDirectory("/home/ubuntu/work/app", ROOTS, d)).toMatchObject({
      ok: true,
      path: "/home/ubuntu/work/app",
    });
  });

  test("符号链接逃逸：逻辑路径合法但真实路径落系统目录 → 拒绝", () => {
    const d = deps(
      { "/home/ubuntu/work/link": true },
      { "/home/ubuntu/work/link": "/etc" },
    );
    expect(validateDirectory("/home/ubuntu/work/link", ROOTS, d)).toMatchObject({ ok: false, reason: "system" });
  });

  test("返回规范化后的真实路径", () => {
    const d = deps({ "/home/ubuntu/work/app": true }, { "/home/ubuntu/work/app": "/mnt/data/app" });
    // realpath 落 /mnt（不在 allowedRoots）→ 拒绝，证明用的是真实路径校验。
    expect(validateDirectory("/home/ubuntu/work/app", ROOTS, d)).toMatchObject({ ok: false, reason: "outside_allowed" });
  });
});
