import { describe, expect, test } from "vitest";
import {
  WizardStore,
  WIZARD_KEY_PREFIX,
  parseWizardState,
  reduceWizard,
  wizardStart,
  wizardStepHint,
  type WizardAction,
} from "../src/feishu/wizard.js";
import { createLogger } from "../src/logger.js";
import { FakeStorage } from "./helpers.js";

const log = createLogger({ level: "error", sink: () => undefined });

const apply = (actions: WizardAction[]) =>
  actions.reduce<ReturnType<typeof wizardStart> | undefined>((state, action) => reduceWizard(state, action), undefined);

describe("reduceWizard 状态机", () => {
  test("start → dir；setDir → model；setModel → perm；setPerm → confirm", () => {
    const state = apply([
      { type: "start", title: "标题", anchorMessageId: "om_1" },
      { type: "setDir", dir: "/home/ubuntu/work/app" },
      { type: "setModel", model: { providerID: "p", id: "m", name: "M" } },
      { type: "setPerm", perm: "edit" },
    ]);
    expect(state).toEqual({
      step: "confirm",
      title: "标题",
      anchorMessageId: "om_1",
      dir: "/home/ubuntu/work/app",
      model: { providerID: "p", id: "m", name: "M" },
      perm: "edit",
    });
  });

  test("非法输入：未 start 就 setDir/setModel/setPerm 返回 undefined", () => {
    expect(reduceWizard(undefined, { type: "setDir", dir: "/x" })).toBeUndefined();
    expect(reduceWizard(undefined, { type: "setModel", model: { providerID: "p", id: "m" } })).toBeUndefined();
    expect(reduceWizard(undefined, { type: "setPerm", perm: "edit" })).toBeUndefined();
  });

  test("setPage 只改分页不改步骤；cancel 清空", () => {
    const started = apply([{ type: "start" }]);
    const paged = reduceWizard(started, { type: "setPage", page: 2 });
    expect(paged?.step).toBe("dir");
    expect(paged?.page).toBe(2);
    expect(reduceWizard(paged, { type: "cancel" })).toBeUndefined();
    expect(reduceWizard(undefined, { type: "cancel" })).toBeUndefined();
  });

  test("wizardStepHint 覆盖所有步骤", () => {
    expect(wizardStepHint("dir")).toContain("/dir");
    expect(wizardStepHint("model")).toContain("/model");
    expect(wizardStepHint("perm")).toContain("权限");
    expect(wizardStepHint("confirm")).toContain("创建");
    expect(wizardStepHint(undefined)).toContain("/new");
  });
});

describe("parseWizardState", () => {
  test("合法状态往返", () => {
    const state = {
      step: "model" as const,
      dir: "/home/ubuntu/work/app",
      model: { providerID: "p", id: "m" },
      page: 1,
      anchorMessageId: "om_1",
    };
    expect(parseWizardState(state)).toEqual(state);
  });

  test("非法步骤 / 非对象 → undefined；perm 非预设被丢弃", () => {
    expect(parseWizardState({ step: "nope" })).toBeUndefined();
    expect(parseWizardState(null)).toBeUndefined();
    const parsed = parseWizardState({ step: "dir", perm: "bogus", model: { providerID: "", id: "m" } });
    expect(parsed).toEqual({ step: "dir" });
  });
});

describe("WizardStore", () => {
  test("start/get/apply/cancel 持久化", async () => {
    const storage = new FakeStorage();
    const store = new WizardStore(storage, log);
    await store.start("oc_1", "标题", "om_1");
    expect((await store.get("oc_1"))?.step).toBe("dir");
    await store.apply("oc_1", { type: "setDir", dir: "/home/ubuntu/work/app" });
    const state = await store.get("oc_1");
    expect(state?.step).toBe("model");
    expect(state?.dir).toBe("/home/ubuntu/work/app");
    await store.cancel("oc_1");
    expect(await store.get("oc_1")).toBeUndefined();
    expect(storage.raw(`${WIZARD_KEY_PREFIX}oc_1`)).toBeUndefined();
  });

  test("storage 异常降级不抛", async () => {
    const broken = {
      get: async () => {
        throw new Error("boom");
      },
      set: async () => {
        throw new Error("boom");
      },
      remove: async () => {
        throw new Error("boom");
      },
    };
    const store = new WizardStore(broken, log);
    expect(await store.get("oc_1")).toBeUndefined();
    await expect(store.set("oc_1", { step: "dir" })).resolves.toBeUndefined();
    await expect(store.cancel("oc_1")).resolves.toBeUndefined();
  });
});
