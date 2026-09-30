import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  attachmentSavedPrompt,
  buildAttachmentFileName,
  downloadAttachment,
  downloadedAttachmentPrompt,
  formatBytes,
  imageExtFromHeaders,
  sanitizeAttachmentName,
  type AttachmentResourceClient,
} from "../src/feishu/attachments.js";
import type { Logger } from "../src/types.js";

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feishu-att-"));
  tmpDirs.push(dir);
  return dir;
}

/** 假客户端：`writeFile` 把固定内容写到目标路径；可注入失败/超时/超大内容。 */
function fakeClient(opts: {
  content?: Buffer;
  headers?: Record<string, unknown>;
  throwOnGet?: boolean;
  hang?: boolean;
  noWriteFile?: boolean;
}): AttachmentResourceClient {
  return {
    im: {
      messageResource: {
        get: async () => {
          if (opts.throwOnGet) throw new Error("api denied");
          if (opts.hang) return new Promise(() => undefined) as never;
          if (opts.noWriteFile) return {} as never;
          return {
            headers: opts.headers,
            writeFile: async (filePath: string) => {
              await writeFile(filePath, opts.content ?? Buffer.from("hello"));
            },
          };
        },
      },
    },
  };
}

describe("附件工具函数", () => {
  test("sanitizeAttachmentName：路径分隔符 / 控制字符 / 前导点 / 限长 / 空回退", () => {
    expect(sanitizeAttachmentName("dir/evil.sh")).toBe("dir_evil.sh");
    expect(sanitizeAttachmentName("a\\b.txt")).toBe("a_b.txt");
    expect(sanitizeAttachmentName("../.ssh/id")).toBe("_.ssh_id");
    expect(sanitizeAttachmentName("...hidden")).toBe("hidden");
    expect(sanitizeAttachmentName("x".repeat(300)).length).toBe(120);
    expect(sanitizeAttachmentName("")).toBe("attachment");
    expect(sanitizeAttachmentName("   ")).toBe("attachment");
  });

  test("imageExtFromHeaders：按 content-type 识别，未知回退 .png", () => {
    expect(imageExtFromHeaders({ "content-type": "image/jpeg" })).toBe(".jpg");
    expect(imageExtFromHeaders({ "content-type": "image/png; charset=binary" })).toBe(".png");
    expect(imageExtFromHeaders({ "Content-Type": "image/webp" })).toBe(".webp");
    expect(imageExtFromHeaders({})).toBe(".png");
    expect(imageExtFromHeaders(undefined)).toBe(".png");
  });

  test("buildAttachmentFileName：图片按头命名，文件沿用原名", () => {
    expect(buildAttachmentFileName({ kind: "image", fileKey: "k" }, { "content-type": "image/jpeg" })).toBe(
      "image.jpg",
    );
    expect(buildAttachmentFileName({ kind: "file", fileKey: "k", fileName: "书.xlsx" }, undefined)).toBe("书.xlsx");
    expect(buildAttachmentFileName({ kind: "file", fileKey: "k" }, undefined)).toBe("file");
  });

  test("formatBytes / attachmentSavedPrompt", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    const text = attachmentSavedPrompt({ kind: "file", name: "a.pdf", path: "/tmp/a.pdf", size: 1234 });
    expect(text).toContain("a.pdf");
    expect(text).toContain("/tmp/a.pdf");
    expect(text).toContain("1.2 KB");
  });
});

describe("downloadAttachment", () => {
  const attachment = { kind: "file" as const, fileKey: "file_1", fileName: "报告.pdf" };

  test("成功：写入 messageId 前缀文件并返回大小", async () => {
    const dir = await makeTmpDir();
    const outcome = await downloadAttachment({
      client: fakeClient({ content: Buffer.from("pdf-bytes") }),
      messageId: "om_1",
      attachment,
      dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      log,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.name).toBe("报告.pdf");
    expect(outcome.path).toBe(join(dir, "om_1-报告.pdf"));
    expect(outcome.size).toBe(9);
    expect(await readFile(outcome.path, "utf8")).toBe("pdf-bytes");
    expect(downloadedAttachmentPrompt(attachment, outcome)).toContain(outcome.path);
  });

  test("超过大小上限：拒绝并删除已落盘文件", async () => {
    const dir = await makeTmpDir();
    const outcome = await downloadAttachment({
      client: fakeClient({ content: Buffer.alloc(4096) }),
      messageId: "om_big",
      attachment,
      dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      log,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("超过大小上限");
    await expect(stat(join(dir, "om_big-报告.pdf"))).rejects.toThrow();
  });

  test("接口异常：返回失败原因，不抛", async () => {
    const dir = await makeTmpDir();
    const outcome = await downloadAttachment({
      client: fakeClient({ throwOnGet: true }),
      messageId: "om_err",
      attachment,
      dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      log,
    });
    expect(outcome).toEqual({ ok: false, reason: "api denied" });
  });

  test("下载超时：返回超时原因", async () => {
    const dir = await makeTmpDir();
    const outcome = await downloadAttachment({
      client: fakeClient({ hang: true }),
      messageId: "om_slow",
      attachment,
      dir,
      maxBytes: 1024,
      timeoutMs: 30,
      log,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("下载超时");
  });

  test("接口未返回文件流：明确报错", async () => {
    const dir = await makeTmpDir();
    const outcome = await downloadAttachment({
      client: fakeClient({ noWriteFile: true }),
      messageId: "om_no",
      attachment,
      dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      log,
    });
    expect(outcome).toEqual({ ok: false, reason: "资源接口未返回文件流" });
  });
});
