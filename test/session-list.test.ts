import { describe, expect, test } from "vitest";
import {
  directoryTail,
  fallbackEntries,
  normalizeSessionInfo,
  normalizeSessionList,
  relativeTime,
  sortByUpdatedDesc,
  toMillis,
} from "../src/feishu/session-list.js";

const T = (ms: number) => ms;
const NOW = 1_700_000_000_000;

describe("normalizeSessionList（兼容 ctx.session.list 形状）", () => {
  test("数组形状 + 按 time.updated 倒序 + 过滤无 id", () => {
    const raw = [
      { id: "ses_old", title: "旧", time: { updated: T(NOW - 10_000) } },
      { id: "ses_new", title: "新", time: { updated: T(NOW) } },
      { title: "无 id" },
      { id: "", title: "空 id" },
    ];
    const out = normalizeSessionList(raw);
    expect(out?.map((e) => e.sessionID)).toEqual(["ses_new", "ses_old"]);
    expect(out?.[0]).toEqual({ sessionID: "ses_new", title: "新", updatedAt: NOW });
  });

  test("{data:[...]} 形状（Promise 客户端）", () => {
    const out = normalizeSessionList({
      data: [{ id: "ses_1", title: "一", time: { updated: NOW }, location: { directory: "/home/ubuntu/work/app" } }],
      cursor: { next: null },
    });
    expect(out).toEqual([
      { sessionID: "ses_1", title: "一", updatedAt: NOW, directory: "/home/ubuntu/work/app" },
    ]);
  });

  test("{sessions:[...]} / {items:[...]} 形状", () => {
    expect(normalizeSessionList({ sessions: [{ id: "s1" }] })?.map((e) => e.sessionID)).toEqual(["s1"]);
    expect(normalizeSessionList({ items: [{ id: "s2" }] })?.map((e) => e.sessionID)).toEqual(["s2"]);
  });

  test("识别不出形状返回 undefined（调用方回退）", () => {
    expect(normalizeSessionList(undefined)).toBeUndefined();
    expect(normalizeSessionList(null)).toBeUndefined();
    expect(normalizeSessionList({ foo: "bar" })).toBeUndefined();
    expect(normalizeSessionList("nope")).toBeUndefined();
  });

  test("空数组是合法结果（不是 undefined）", () => {
    expect(normalizeSessionList([])).toEqual([]);
    expect(normalizeSessionList({ data: [] })).toEqual([]);
  });

  test("过滤插件内部临时会话（⚙️ 内部生成（临时…））", () => {
    const out = normalizeSessionList([
      { id: "ses_temp", title: "⚙️ 内部生成（临时，可忽略）", time: { updated: NOW } },
      { id: "ses_real", title: "正常会话", time: { updated: NOW - 1 } },
    ]);
    expect(out?.map((e) => e.sessionID)).toEqual(["ses_real"]);
  });

  test("去重：同一 id 只保留第一次", () => {
    const out = normalizeSessionList([
      { id: "ses_1", title: "a" },
      { id: "ses_1", title: "b" },
    ]);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.title).toBe("a");
  });

  test("slug 兜底标题；缺 title/slug 为空串", () => {
    const out = normalizeSessionList([{ id: "ses_1", slug: "my-slug" }, { id: "ses_2" }]);
    expect(out?.find((e) => e.sessionID === "ses_1")?.title).toBe("my-slug");
    expect(out?.find((e) => e.sessionID === "ses_2")?.title).toBe("");
  });
});

describe("normalizeSessionInfo", () => {
  test("单会话：sessionID 别名 + location.directory", () => {
    expect(normalizeSessionInfo({ sessionID: "ses_x", title: "t", updated: NOW, directory: "/tmp/x" })).toEqual({
      sessionID: "ses_x",
      title: "t",
      updatedAt: NOW,
      directory: "/tmp/x",
    });
  });

  test("缺 id 返回 undefined", () => {
    expect(normalizeSessionInfo({ title: "t" })).toBeUndefined();
    expect(normalizeSessionInfo(null)).toBeUndefined();
  });
});

describe("toMillis（时间形状兼容）", () => {
  test("number / 数字字符串 / ISO / Date / Effect DateTime", () => {
    expect(toMillis(NOW)).toBe(NOW);
    expect(toMillis(String(NOW))).toBe(NOW);
    expect(toMillis(new Date(NOW))).toBe(NOW);
    expect(toMillis("2023-11-14T22:13:20.000Z")).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
    expect(toMillis({ epochMillis: NOW })).toBe(NOW);
    expect(toMillis({ millis: NOW })).toBe(NOW);
  });

  test("非法/空/负数 → 0", () => {
    expect(toMillis(undefined)).toBe(0);
    expect(toMillis(null)).toBe(0);
    expect(toMillis("")).toBe(0);
    expect(toMillis("not-a-date")).toBe(0);
    expect(toMillis(-5)).toBe(0);
    expect(toMillis({})).toBe(0);
  });
});

describe("sortByUpdatedDesc / fallbackEntries", () => {
  test("倒序且不修改入参；0 时间排最后", () => {
    const input = [
      { sessionID: "b", title: "", updatedAt: 10 },
      { sessionID: "a", title: "", updatedAt: 30 },
      { sessionID: "c", title: "", updatedAt: 0 },
    ];
    expect(sortByUpdatedDesc(input).map((e) => e.sessionID)).toEqual(["a", "b", "c"]);
    expect(input.map((e) => e.sessionID)).toEqual(["b", "a", "c"]);
  });

  test("fallbackEntries 保留 0 并排序", () => {
    expect(
      fallbackEntries([
        { sessionID: "a", title: "A", updatedAt: 0 },
        { sessionID: "b", title: "B", updatedAt: 5 },
      ]).map((e) => e.sessionID),
    ).toEqual(["b", "a"]);
  });
});

describe("relativeTime / directoryTail", () => {
  test("相对时间分档", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("刚刚");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(relativeTime(NOW - 3 * 3600_000, NOW)).toBe("3 小时前");
    expect(relativeTime(NOW - 2 * 86400_000, NOW)).toBe("2 天前");
    expect(relativeTime(NOW - 90 * 86400_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(relativeTime(0, NOW)).toBe("时间未知");
  });

  test("目录尾段", () => {
    expect(directoryTail("/home/ubuntu/work/app")).toBe("app");
    expect(directoryTail("/home/ubuntu/work/app/")).toBe("app");
    expect(directoryTail("")).toBe("");
    expect(directoryTail("/")).toBe("");
    expect(directoryTail("///")).toBe("");
  });
});
