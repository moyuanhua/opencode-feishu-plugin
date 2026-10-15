import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  discoverLocalService,
  parseLocalService,
  cancelFormOverHttp,
  replyFormOverHttp,
  serviceConfigPath,
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

describe("serviceConfigPath", () => {
  test("优先 OPENCODE_CONFIG_DIR（该变量直接指向 opencode 配置目录）", () => {
    expect(serviceConfigPath({ OPENCODE_CONFIG_DIR: "/cfg/opencode" })).toBe("/cfg/opencode/service.json");
  });

  test("回退 XDG_CONFIG_HOME/opencode，再回退 ~/.config/opencode", () => {
    expect(serviceConfigPath({ XDG_CONFIG_HOME: "/xdgcfg" })).toBe("/xdgcfg/opencode/service.json");
    expect(serviceConfigPath({}).endsWith("/.config/opencode/service.json")).toBe(true);
  });
});

describe("parseLocalService", () => {
  test("运行态形态：url + password", () => {
    expect(parseLocalService(JSON.stringify({ url: "http://127.0.0.1:3000/", password: "p" }))).toEqual({
      url: "http://127.0.0.1:3000",
      password: "p",
    });
  });

  test("配置态形态：hostname + port 组合出 url（0.0.0.0 → 127.0.0.1）", () => {
    expect(
      parseLocalService(JSON.stringify({ hostname: "0.0.0.0", port: 4096, password: "p" })),
    ).toEqual({ url: "http://127.0.0.1:4096", password: "p" });
    expect(parseLocalService(JSON.stringify({ hostname: "127.0.0.1", port: 4096 }))).toEqual({
      url: "http://127.0.0.1:4096",
    });
    // IPv6 字面量要加方括号才可拼接端口。
    expect(parseLocalService(JSON.stringify({ hostname: "::1", port: 4096 }))).toEqual({
      url: "http://[::1]:4096",
    });
  });

  test("只有 port / 端口非法 / hostname 为空 → undefined（无法确定可达地址）", () => {
    expect(parseLocalService(JSON.stringify({ port: 3000 }))).toBeUndefined();
    expect(parseLocalService(JSON.stringify({ hostname: "127.0.0.1" }))).toBeUndefined();
    expect(parseLocalService(JSON.stringify({ hostname: "127.0.0.1", port: "4096" }))).toBeUndefined();
    expect(parseLocalService(JSON.stringify({ hostname: "127.0.0.1", port: 70000 }))).toBeUndefined();
    expect(parseLocalService(JSON.stringify({ hostname: "  ", port: 4096 }))).toBeUndefined();
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

  test("运行态注册缺失 → 回退配置态服务信息（opencode serve 直跑场景）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "form-reply-cfg-"));
    dirs.push(dir);
    const stateFile = join(dir, "state", "service.json"); // 不存在
    const cfgFile = join(dir, "config", "service.json");
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(cfgFile, JSON.stringify({ hostname: "0.0.0.0", port: 4096, password: "pw" }), "utf8");

    const seen: string[] = [];
    const service = await discoverLocalService(stateFile, {
      fallback: true,
      env: { OPENCODE_CONFIG_DIR: join(dir, "config") },
      readFile: async (path: string) => {
        seen.push(path);
        return await readFile(path, "utf8");
      },
    });
    expect(service).toEqual({ url: "http://127.0.0.1:4096", password: "pw" });
    expect(seen).toEqual([stateFile, cfgFile]);
  });

  test("两处都不可读 → undefined；显式 file 默认不触发配置回退", async () => {
    const dir = await mkdtemp(join(tmpdir(), "form-reply-none-"));
    dirs.push(dir);
    expect(await discoverLocalService(join(dir, "missing.json"), { fallback: true })).toBeUndefined();
    // 未开 fallback 时只读显式 file，绝不顺带读真实机器的配置目录。
    let reads = 0;
    await discoverLocalService(join(dir, "missing.json"), {
      readFile: async () => {
        reads += 1;
        return JSON.stringify({ hostname: "127.0.0.1", port: 1 });
      },
    });
    expect(reads).toBe(1);
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
