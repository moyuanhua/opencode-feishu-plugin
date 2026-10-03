import { describe, expect, test } from "vitest";
import { MAX_ROOT_SUBDIRS, scanRootSubdirs, type DirEntLike, type ReadDirFn } from "../src/feishu/root-scan.js";

const dir = (name: string): DirEntLike => ({ name, isDirectory: () => true });
const file = (name: string): DirEntLike => ({ name, isDirectory: () => false });

/** 按路径返回目录项的假 readdir；未登记的路径抛 ENOENT。 */
class FakeReadDir {
  readonly calls: string[] = [];
  private readonly map = new Map<string, ReadonlyArray<DirEntLike>>();

  set(path: string, entries: ReadonlyArray<DirEntLike>): this {
    this.map.set(path, entries);
    return this;
  }

  readonly fn: ReadDirFn = async (path) => {
    this.calls.push(path);
    const entries = this.map.get(path);
    if (!entries) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return entries;
  };
}

describe("scanRootSubdirs（P6.3 目录下拉来源）", () => {
  test("只取目录：过滤隐藏目录与 node_modules、过滤文件、按名称排序", async () => {
    const fake = new FakeReadDir().set("/root", [
      dir("zeta"),
      dir("alpha"),
      file("readme.txt"),
      dir(".hidden"),
      dir("node_modules"),
      dir("Beta"),
    ]);
    const subs = await scanRootSubdirs("/root", { readdir: fake.fn });
    expect(subs.map((s) => s.name)).toEqual(["Beta", "alpha", "zeta"]);
    expect(subs.every((s) => s.isRepo === false)).toBe(true);
  });

  test("上限截断：超过 MAX_ROOT_SUBDIRS 只保留前 N 个（已排序）", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, "0")}`);
    const fake = new FakeReadDir().set(
      "/root",
      names.map((n) => dir(n)),
    );
    const subs = await scanRootSubdirs("/root", { readdir: fake.fn });
    expect(subs).toHaveLength(MAX_ROOT_SUBDIRS);
    expect(subs.map((s) => s.name)).toEqual(names.slice(0, MAX_ROOT_SUBDIRS));
  });

  test("limit 可自定义（AI 候选放宽；非法值夹取到至少 1）", async () => {
    const names = Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, "0")}`);
    const fake = new FakeReadDir().set(
      "/root",
      names.map((n) => dir(n)),
    );
    const subs = await scanRootSubdirs("/root", { readdir: fake.fn, limit: 18 });
    expect(subs).toHaveLength(18);
    expect(subs.map((s) => s.name)).toEqual(names.slice(0, 18));
    expect(await scanRootSubdirs("/root", { readdir: fake.fn, limit: 0 })).toHaveLength(1);
  });

  test("含 .git 的子目录标记 isRepo（只判断存在性）", async () => {
    const fake = new FakeReadDir()
      .set("/root", [dir("repo"), dir("plain"), dir("broken")])
      .set("/root/repo", [dir(".git"), dir("src")])
      .set("/root/plain", [file("a.txt")]);
    // /root/broken 未登记 → 子 readdir 失败 → isRepo=false，但仍出现在结果中
    const subs = await scanRootSubdirs("/root", { readdir: fake.fn });
    expect(subs.find((s) => s.name === "repo")!.isRepo).toBe(true);
    expect(subs.find((s) => s.name === "plain")!.isRepo).toBe(false);
    expect(subs.find((s) => s.name === "broken")!.isRepo).toBe(false);
  });

  test("扫描失败（不存在 / 无权限）静默降级为空列表", async () => {
    const fake = new FakeReadDir();
    await expect(scanRootSubdirs("/root", { readdir: fake.fn })).resolves.toEqual([]);

    const throwing: ReadDirFn = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    await expect(scanRootSubdirs("/root", { readdir: throwing })).resolves.toEqual([]);
  });

  test("空 root → 空列表，不调用 readdir", async () => {
    const fake = new FakeReadDir();
    await expect(scanRootSubdirs("   ", { readdir: fake.fn })).resolves.toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});
