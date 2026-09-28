import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  discoverLocalService,
  cancelFormOverHttp,
  replyFormOverHttp,
  serviceStatePath,
} from "../src/feishu/form-reply.js";
import { createLogger } from "../src/logger.js";

const log = createLogger({ level: "error", sink: () => undefined });

const dirs: string[] = [];
async function tmpFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "form-reply-"));
  dirs.push(dir);
  const file = join(dir, "service.json");
  await writeFile(file, content, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("serviceStatePath", () => {
  test("优先 XDG_STATE_HOME", () => {
    expect(serviceStatePath({ XDG_STATE_HOME: "/xdg" })).toBe("/xdg/opencode/service.json");
  });

  test("回退 ~/.local/state", () => {
    const p = serviceStatePath({});
    expect(p.endsWith("/.local/state/opencode/service.json")).toBe(true);
  });
});

describe("discoverLocalService", () => {
  test("解析 url + password，并去掉尾部斜杠", async () => {
    const file = await tmpFile(JSON.stringify({ url: "http://127.0.0.1:3000/", password: "s3cret" }));
    expect(await discoverLocalService(file)).toEqual({ url: "http://127.0.0.1:3000", password: "s3cret" });
  });

  test("无 password → 不返回该字段", async () => {
    const file = await tmpFile(JSON.stringify({ url: "http://127.0.0.1:3000" }));
    expect(await discoverLocalService(file)).toEqual({ url: "http://127.0.0.1:3000" });
  });

  test("文件缺失 / 非法 JSON / 缺 url → undefined", async () => {
    expect(await discoverLocalService(join(tmpdir(), "definitely-missing-xyz", "service.json"))).toBeUndefined();
    expect(await discoverLocalService(await tmpFile("{not json"))).toBeUndefined();
    expect(await discoverLocalService(await tmpFile(JSON.stringify({ port: 3000 })))).toBeUndefined();
  });
});

describe("replyFormOverHttp", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  test("POST 到 /api/session/../form/../reply，带 Basic 认证与目录头（URL 编码）", async () => {
    calls.length = 0;
    await replyFormOverHttp(
      { sessionID: "ses_1", formID: "frm_1", answer: { q0: "a" }, directory: "/home/ubuntu/work" },
      { log, fetchImpl, discover: async () => ({ url: "http://127.0.0.1:3000", password: "pw" }) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:3000/api/session/ses_1/form/frm_1/reply");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-opencode-directory"]).toBe(encodeURIComponent("/home/ubuntu/work"));
    expect(headers["authorization"]).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ answer: { q0: "a" } });
  });

  test("无 directory → 不带目录头", async () => {
    calls.length = 0;
    await replyFormOverHttp(
      { sessionID: "ses_1", formID: "frm_1", answer: { q0: true } },
      { log, fetchImpl, discover: async () => ({ url: "http://127.0.0.1:3000" }) },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-opencode-directory"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
  });

  test("未发现服务 → 抛错", async () => {
    await expect(
      replyFormOverHttp(
        { sessionID: "ses_1", formID: "frm_1", answer: {} },
        { log, fetchImpl, discover: async () => undefined },
      ),
    ).rejects.toThrow(/未发现本机 opencode 服务/);
  });

  test("非 2xx → 抛错并带状态码", async () => {
    const failing = (async () => new Response("boom", { status: 409 })) as typeof fetch;
    await expect(
      replyFormOverHttp(
        { sessionID: "ses_1", formID: "frm_1", answer: {} },
        { log, fetchImpl: failing, discover: async () => ({ url: "http://127.0.0.1:3000" }) },
      ),
    ).rejects.toThrow(/HTTP 409/);
  });
});

describe("cancelFormOverHttp", () => {
  test("DELETE /form/{id} 并带目录头", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenDir = "";
    await cancelFormOverHttp(
      { sessionID: "ses_1", formID: "frm_1", directory: "/home/ubuntu" },
      {
        log: createLogger({ level: "error", sink: () => undefined }),
        discover: async () => ({ url: "http://127.0.0.1:3000", password: "pw" }),
        fetchImpl: (async (url: string, init?: RequestInit) => {
          seenUrl = url;
          seenMethod = init?.method ?? "";
          seenDir = (init?.headers as Record<string, string>)?.["x-opencode-directory"] ?? "";
          return new Response(null, { status: 204 });
        }) as unknown as typeof fetch,
      },
    );
    expect(seenMethod).toBe("DELETE");
    expect(seenUrl).toContain("/api/session/ses_1/form/frm_1");
    expect(seenDir).toBe("%2Fhome%2Fubuntu"); // 与 replyFormOverHttp 一致：目录头 URL 编码
  });

  test("失败时抛错", async () => {
    await expect(
      cancelFormOverHttp(
        { sessionID: "ses_1", formID: "frm_1" },
        {
          log: createLogger({ level: "error", sink: () => undefined }),
          discover: async () => ({ url: "http://127.0.0.1:3000" }),
          fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/表单取消失败/);
  });
});
