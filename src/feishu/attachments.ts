/**
 * 消息附件（图片/文件）接收：下载飞书消息资源到本地，作为会话附件喂给模型。
 *
 * - 需要应用开通 **`im:message:readonly`**（消息资源下载接口要求 `im:message` /
 *   `im:message:readonly` / `im:message.history:readonly` 任一）；未开通 / 下载失败时
 *   降级为纯占位文本 + 失败原因（**不阻断消息**，用户仍能获得反馈）。
 * - 下载落盘到**会话工作目录**下：`<会话目录>/.opencode/temp/opencode-feishu-plugin/`
 *   （可用 `attachmentsDir` 覆盖；无法确定会话目录时回退系统临时目录）。
 * - 纯逻辑 + 注入 IO，便于单测；**永不抛异常**（异常收敛为 `{ ok:false, reason }`）。
 */
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { errorMessage } from "../logger.js";
import type { IncomingAttachment, Logger } from "../types.js";

/** 附件目录（会话工作目录内）：`.opencode/temp/opencode-feishu-plugin`。 */
export const ATTACHMENT_DIR_RELATIVE = [".opencode", "temp", "opencode-feishu-plugin"] as const;

/**
 * 计算附件的落盘目录。
 * - 显式 `override` → 精确使用（不再附加任何子目录）；
 * - 否则：有会话目录 → `<会话目录>/.opencode/temp/opencode-feishu-plugin`；
 * - 会话目录未知 → `<系统临时目录>/opencode-feishu-plugin`（回退）。
 */
export function resolveAttachmentDir(override: string | undefined, sessionDir: string | undefined): string {
  if (override && override.trim()) return override.trim();
  if (sessionDir && sessionDir.trim()) return join(sessionDir.trim(), ...ATTACHMENT_DIR_RELATIVE);
  return join(tmpdir(), "opencode-feishu-plugin");
}

/**
 * 在附件目录内放一个 `.gitignore`（内容 `*`），避免下载的图片/文件
 * 出现在用户的 `git status` 里。已存在或写入失败时静默忽略。
 */
export async function ensureAttachmentDirGitIgnored(dir: string): Promise<void> {
  try {
    await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" });
  } catch {
    // 已存在 / 无权限：忽略
  }
}

/** 下载资源所需的最小客户端形状（只依赖用到的方法，便于测试替身）。 */
export interface AttachmentResourceClient {
  readonly im: {
    readonly messageResource: {
      get: (
        payload: {
          params: { type: string };
          path: { message_id: string; file_key: string };
        },
      ) => Promise<{
        writeFile: (filePath: string) => Promise<unknown>;
        headers?: Record<string, unknown> | undefined;
      } | null>;
    };
  };
}

export interface DownloadAttachmentInput {
  readonly client: AttachmentResourceClient;
  readonly messageId: string;
  readonly attachment: IncomingAttachment;
  /** 存放目录（不存在则创建）。 */
  readonly dir: string;
  /** 允许的最大字节数；超限则删除并拒绝。 */
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly log: Logger;
  /** true = 在目录内确保 `.gitignore`（`*`），默认落盘会话目录时用，避免污染 git status。 */
  readonly gitIgnore?: boolean;
}

export type DownloadAttachmentOutcome =
  | { readonly ok: true; readonly path: string; readonly name: string; readonly size: number }
  | { readonly ok: false; readonly reason: string };

/** 超时哨兵错误，便于日志区分「超时」与「其它失败」。 */
export class AttachmentTimeoutError extends Error {
  constructor() {
    super("attachment-timeout");
    this.name = "AttachmentTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AttachmentTimeoutError()), Math.max(1, ms));
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 文件名清洗：去掉路径分隔符 / 控制字符 / 前导点，限长 120；
 * 清洗后为空则回退 `fallback`。
 */
export function sanitizeAttachmentName(raw: string | undefined, fallback = "attachment"): string {
  const base = (raw ?? "").trim();
  const cleaned = base
    .replace(/[\\/]/g, "_")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || fallback;
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

/** 从响应头里识别图片扩展名（无法识别时回退 `.png`）。 */
export function imageExtFromHeaders(headers: Record<string, unknown> | undefined): string {
  const raw = headers?.["content-type"] ?? headers?.["Content-Type"];
  const mime = typeof raw === "string" ? raw.split(";")[0]!.trim().toLowerCase() : "";
  return IMAGE_EXT_BY_MIME[mime] ?? ".png";
}

/** 组装落盘文件名（不含目录；`messageId-` 前缀由调用方拼接保证唯一）。 */
export function buildAttachmentFileName(
  attachment: IncomingAttachment,
  headers: Record<string, unknown> | undefined,
): string {
  if (attachment.kind === "image") {
    return sanitizeAttachmentName(`image${imageExtFromHeaders(headers)}`, "image.png");
  }
  const raw = sanitizeAttachmentName(attachment.fileName, "file");
  return raw;
}

/** 人类可读的字节数（用于提示文本/日志）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 附件落盘后的提示文本（附在用户消息末尾，让模型知道文件在哪）。 */
export function attachmentSavedPrompt(input: {
  readonly kind: "image" | "file";
  readonly name: string;
  readonly path: string;
  readonly size: number;
}): string {
  const size = formatBytes(input.size);
  return input.kind === "image"
    ? `[附件] 图片「${input.name}」已保存到 ${input.path}（${size}），可直接查看。`
    : `[附件] 文件「${input.name}」已保存到 ${input.path}（${size}）。`;
}

/**
 * 下载附件到 `dir`。成功返回落盘路径/名字/大小；失败返回原因（已记日志）。
 * `messageId-` 前缀保证同一目录下同名文件不互相覆盖。
 */
export async function downloadAttachment(
  input: DownloadAttachmentInput,
): Promise<DownloadAttachmentOutcome> {
  const { client, messageId, attachment, dir, maxBytes, timeoutMs, log, gitIgnore } = input;
  const startedAt = Date.now();
  let target: string | undefined;
  try {
    await mkdir(dir, { recursive: true });
    if (gitIgnore) await ensureAttachmentDirGitIgnored(dir);
    const res = await withTimeout(
      client.im.messageResource.get({
        params: { type: attachment.kind },
        path: { message_id: messageId, file_key: attachment.fileKey },
      }),
      timeoutMs,
    );
    if (!res || typeof res.writeFile !== "function") {
      return { ok: false, reason: "资源接口未返回文件流" };
    }
    const name = buildAttachmentFileName(attachment, res.headers);
    target = join(dir, `${messageId}-${name}`);
    await res.writeFile(target);
    const info = await stat(target);
    if (info.size > maxBytes) {
      await rm(target, { force: true });
      return {
        ok: false,
        reason: `附件超过大小上限（${formatBytes(info.size)} > ${formatBytes(maxBytes)}）`,
      };
    }
    log.info("附件已下载", {
      messageId,
      kind: attachment.kind,
      name,
      size: info.size,
      ms: Date.now() - startedAt,
    });
    return { ok: true, path: target, name, size: info.size };
  } catch (err) {
    if (target) await rm(target, { force: true }).catch(() => undefined);
    const reason =
      err instanceof AttachmentTimeoutError
        ? `下载超时（>${Math.round(timeoutMs / 1000)}s）`
        : errorMessage(err);
    log.warn("附件下载失败", { messageId, kind: attachment.kind, error: reason });
    return { ok: false, reason };
  }
}

/** 供提示文本使用的挂载信息（避免调用方重复拼装）。 */
export function downloadedAttachmentPrompt(
  attachment: IncomingAttachment,
  outcome: Extract<DownloadAttachmentOutcome, { ok: true }>,
): string {
  return attachmentSavedPrompt({
    kind: attachment.kind,
    name: outcome.name,
    path: outcome.path,
    size: outcome.size,
  });
}

/** 扩展名提示（测试/日志用）：无扩展名时返回空串。 */
export function attachmentExtensionOf(name: string): string {
  return extname(name).toLowerCase();
}
