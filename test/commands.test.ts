import { describe, expect, test } from "vitest";
import {
  defaultSessionTitle,
  helpText,
  isCommand,
  isCommandAllowedInThread,
  matchSession,
  parseCommand,
  sessionLine,
  shortSessionId,
  threadForbiddenText,
  topicTitle,
  useErrorText,
} from "../src/feishu/commands.js";
import type { SessionEntry } from "../src/feishu/session-map.js";

const entries: SessionEntry[] = [
  { sessionID: "ses_aaa111", title: "一", updatedAt: 1 },
  { sessionID: "ses_bbb222", title: "二", updatedAt: 2 },
  { sessionID: "ses_abc999", title: "", updatedAt: 3 },
];

describe("parseCommand", () => {
  test("非命令返回 undefined", () => {
    expect(parseCommand("hello")).toBeUndefined();
    expect(parseCommand("")).toBeUndefined();
    expect(parseCommand("你好 /new")).toBeUndefined();
  });

  test("/new 带标题 / 不带标题", () => {
    expect(parseCommand("/new")).toEqual({ name: "new", args: "", raw: "new" });
    expect(parseCommand("/new 我的标题")).toEqual({ name: "new", args: "我的标题", raw: "new" });
  });

  test("别名 /ls 与大小写", () => {
    expect(parseCommand("/ls")?.name).toBe("sessions");
    expect(parseCommand("/SESSIONS")?.name).toBe("sessions");
    expect(parseCommand("/Use 2")).toEqual({ name: "use", args: "2", raw: "Use" });
  });

  test("/use 序号或 id 前缀", () => {
    expect(parseCommand("/use 2")).toEqual({ name: "use", args: "2", raw: "use" });
    expect(parseCommand("/use ses_abc")).toEqual({ name: "use", args: "ses_abc", raw: "use" });
  });

  test("未知命令标记 unknown，空命令视为 help", () => {
    expect(parseCommand("/frobnicate x")?.name).toBe("unknown");
    expect(parseCommand("/")?.name).toBe("help");
  });

  test("P6 新命令：dir/model/perm/cd/cancel 与别名", () => {
    expect(parseCommand("/dir /home/ubuntu/x")).toEqual({ name: "dir", args: "/home/ubuntu/x", raw: "dir" });
    expect(parseCommand("/model claude")?.name).toBe("model");
    expect(parseCommand("/perm edit")?.name).toBe("perm");
    expect(parseCommand("/permissions edit")?.name).toBe("perm");
    expect(parseCommand("/cd /home/ubuntu/x")?.name).toBe("cd");
    expect(parseCommand("/cancel")?.name).toBe("cancel");
  });

  test("P6.1 /form 命令", () => {
    expect(parseCommand("/form")).toEqual({ name: "form", args: "", raw: "form" });
  });

  test("isCommand 只看前导 /", () => {
    expect(isCommand("/new")).toBe(true);
    expect(isCommand("  /new")).toBe(true);
    expect(isCommand("你好")).toBe(false);
    expect(isCommand("[图片]")).toBe(false);
  });
});

describe("matchSession", () => {
  test("数字序号按 1-based", () => {
    expect(matchSession("1", entries)).toEqual({ ok: true, entry: entries[0] });
    expect(matchSession("3", entries)).toEqual({ ok: true, entry: entries[2] });
    expect(matchSession("4", entries)).toEqual({ ok: false, reason: "not_found" });
  });

  test("id 前缀唯一命中", () => {
    const result = matchSession("ses_bbb", entries);
    expect(result.ok && result.entry.sessionID).toBe("ses_bbb222");
  });

  test("前缀歧义 / 未命中 / 空", () => {
    expect(matchSession("ses_", entries)).toEqual({ ok: false, reason: "ambiguous" });
    expect(matchSession("ses_zzz", entries)).toEqual({ ok: false, reason: "not_found" });
    expect(matchSession("   ", entries)).toEqual({ ok: false, reason: "empty" });
  });

  test("大小写不敏感前缀", () => {
    const result = matchSession("SES_BBB", entries);
    expect(result.ok && result.entry.sessionID).toBe("ses_bbb222");
  });
});

describe("文案与展示", () => {
  test("defaultSessionTitle 由时间戳决定", () => {
    const title = defaultSessionTitle(0);
    expect(title).toContain("1970-01-01");
    expect(defaultSessionTitle(1_700_000_000_000)).not.toBe(title);
  });

  test("shortSessionId 截断", () => {
    expect(shortSessionId("ses_abc")).toBe("ses_abc");
    expect(shortSessionId("ses_aaaaaaaaaaaaaaaa")).toMatch(/…$/);
  });

  test("sessionLine 标记当前", () => {
    expect(sessionLine(entries[0]!, 0, "ses_aaa111")).toContain("← 当前");
    expect(sessionLine(entries[2]!, 2)).toContain("(未命名)");
  });

  test("useErrorText 三种提示", () => {
    expect(useErrorText("empty")).toContain("/use");
    expect(useErrorText("ambiguous")).toContain("多个");
    expect(useErrorText("not_found")).toContain("未找到");
  });

  test("helpText 覆盖全部命令", () => {
    for (const cmd of ["/new", "/form", "/dir", "/model", "/perm", "/cancel", "/sessions", "/use", "/resume", "/current", "/stop", "/help"]) {
      expect(helpText()).toContain(cmd);
    }
  });

  test("helpText(thread) 只列话题内可用命令并提示去主聊天流", () => {
    const text = helpText("thread");
    expect(text).toContain("/current");
    expect(text).toContain("/stop");
    expect(text).toContain("/model");
    expect(text).toContain("/perm");
    expect(text).toContain("/cd");
    expect(text).not.toContain("/new [标题]");
    expect(text).not.toContain("/use <序号");
    expect(text).not.toContain("`/dir <绝对路径>`");
    expect(text).toContain("主聊天流");
  });

  test("话题命令白名单：current/stop/help/model/perm/cd/unknown 允许", () => {
    expect(isCommandAllowedInThread("current")).toBe(true);
    expect(isCommandAllowedInThread("stop")).toBe(true);
    expect(isCommandAllowedInThread("help")).toBe(true);
    expect(isCommandAllowedInThread("model")).toBe(true);
    expect(isCommandAllowedInThread("perm")).toBe(true);
    expect(isCommandAllowedInThread("cd")).toBe(true);
    expect(isCommandAllowedInThread("unknown")).toBe(true);
    expect(isCommandAllowedInThread("new")).toBe(false);
    expect(isCommandAllowedInThread("sessions")).toBe(false);
    expect(isCommandAllowedInThread("use")).toBe(false);
    expect(isCommandAllowedInThread("resume")).toBe(false);
    expect(isCommandAllowedInThread("dir")).toBe(false);
    expect(isCommandAllowedInThread("cancel")).toBe(false);
    expect(isCommandAllowedInThread("form")).toBe(false);
  });

  test("threadForbiddenText 指向主聊天流", () => {
    expect(threadForbiddenText("new")).toContain("/new");
    expect(threadForbiddenText("new")).toContain("主聊天流");
  });

  test("topicTitle 取首条消息摘要（压缩空白、按 20 字截断）", () => {
    expect(topicTitle("  帮我   看看这个 bug ")).toBe("话题: 帮我 看看这个 bug");
    expect(topicTitle("")).toBe("话题会话");
    const long = topicTitle("一".repeat(30));
    expect(long.startsWith("话题: ")).toBe(true);
    expect(long).toMatch(/…$/);
  });
});
