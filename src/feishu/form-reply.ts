/**
 * 表单答复的 HTTP 兜底通道。
 *
 * 现状（opencode 2.0.16–2.0.18）：V2 插件的 `ctx.session` 域**不暴露** `form`
 * （`@opencode/plugin` 的 promise adapter 只接了 create/get/prompt/… 未接 form），
 * 因此 `ctx.session.form.reply` 在运行时恒为 `undefined`（旧实现会抛
 * “session.form.reply 不可用”，让表单永久卡在待回答态）。
 *
 * 但服务端本身提供 `POST /api/session/{sessionID}/form/{formID}/reply`，且插件与
 * 服务端同机：读取 opencode 的服务注册文件 `service.json` 发现本机 endpoint
 * （含 Basic 口令）即可提交答复，无需公网、无需额外配置。
 *
 * 与飞书 SDK 解耦，纯 IO + 可注入依赖，便于单测。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../types.js";
import type { FormValue } from "./forms.js";

/** 本机 opencode 服务 endpoint（来自 `service.json`）。 */
export interface LocalService {
  readonly url: string;
  readonly password?: string;
}

export interface HttpFormReplyInput {
  readonly sessionID: string;
  readonly formID: string;
  readonly answer: Readonly<Record<string, FormValue>>;
  readonly directory?: string;
}

export interface FormReplyDeps {
  readonly log: Logger;
  /** 覆盖服务发现（测试用）。 */
  readonly discover?: () => Promise<LocalService | undefined>;
  /** 覆盖 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 单次提交超时，默认 8s。 */
  readonly timeoutMs?: number;
}

/** opencode 后台服务注册文件路径：`$XDG_STATE_HOME/opencode/service.json`。 */
export function serviceStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "opencode", "service.json");
}

/** 读取本机服务 endpoint；文件缺失/损坏返回 undefined（best-effort，不抛错）。 */
export async function discoverLocalService(
  file: string = serviceStatePath(),
): Promise<LocalService | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof info !== "object" || info === null) return undefined;
  const record = info as Record<string, unknown>;
  const url = record["url"];
  if (typeof url !== "string" || url.length === 0) return undefined;
  const password = record["password"];
  return {
    url: url.replace(/\/+$/, ""),
    ...(typeof password === "string" && password.length > 0 ? { password } : {}),
  };
}

function authHeaders(service: LocalService): Record<string, string> {
  if (!service.password) return {};
  const token = Buffer.from(`opencode:${service.password}`, "utf8").toString("base64");
  return { authorization: `Basic ${token}` };
}

/**
 * 经本机 HTTP API 提交表单答复。
 * 与 TUI 行为对齐：`x-opencode-directory` 用 URL 编码（跨 location 会话必需）。
 */
export async function replyFormOverHttp(
  input: HttpFormReplyInput,
  deps: FormReplyDeps,
): Promise<void> {
  const discover = deps.discover ?? (() => discoverLocalService());
  const doFetch = deps.fetchImpl ?? fetch;
  const service = await discover();
  if (!service) throw new Error("未发现本机 opencode 服务注册（service.json 缺失或损坏）");

  const path = `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/reply`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(service),
  };
  if (input.directory) headers["x-opencode-directory"] = encodeURIComponent(input.directory);

  const response = await doFetch(`${service.url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ answer: input.answer }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    deps.log.debug("表单 HTTP 提交失败", { status: response.status, formID: input.formID });
    throw new Error(
      `表单提交失败 HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
}
