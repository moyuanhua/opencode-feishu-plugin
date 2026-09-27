/**
 * 模型列表归一化与模糊匹配（P6，纯函数，可单测）。
 *
 * `ctx.model.list()` 在不同版本可能返回 `ModelInfo[]` 或 `{ data: ModelInfo[] }`，
 * 这里统一成 `ModelEntry[]`（providerID + id + name，另附 released/status 用于排序展示）。
 */
import type { ModelRef } from "../types.js";

export interface ModelEntry extends ModelRef {
  readonly name: string;
  readonly released?: number;
  readonly status?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 兼容数组 / `{data:[]}` 两种返回形态，过滤 disabled 与非法项。 */
export function normalizeModelList(raw: unknown): ModelEntry[] {
  const arr = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.data)
      ? raw.data
      : [];
  const out: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!isRecord(item)) continue;
    if (item.enabled === false) continue;
    const providerID = str(item.providerID);
    const id = str(item.id) || str(item.modelID);
    if (!providerID || !id) continue;
    const key = `${providerID}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const time = isRecord(item.time) ? item.time : {};
    const released = typeof time.released === "number" && Number.isFinite(time.released) ? time.released : undefined;
    const status = str(item.status) || undefined;
    out.push({
      providerID,
      id,
      name: str(item.name) || id,
      ...(released !== undefined ? { released } : {}),
      ...(status ? { status } : {}),
    });
  }
  return out;
}

/** 模型展示名：优先 name，其次 `providerID/id`。 */
export function modelLabel(model: Pick<ModelRef, "providerID" | "id" | "name">): string {
  return model.name && model.name.trim() ? model.name.trim() : `${model.providerID}/${model.id}`;
}

/** 两个模型是否同一引用。 */
export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  if (!a || !b) return false;
  return a.providerID === b.providerID && a.id === b.id;
}

/**
 * 从 `ctx.session.get()` 的原始返回里提取当前模型（读回校验用）。
 *
 * 兼容两种形状：`Session.Info`（`{ model: { providerID, id } }`）与直接的 `Model.Ref`。
 * 缺 providerID/id 返回 undefined（由调用方降级处理）。
 */
export function extractSessionModel(raw: unknown): ModelRef | undefined {
  if (!isRecord(raw)) return undefined;
  const candidate = isRecord(raw.model) ? raw.model : raw;
  const providerID = str(candidate.providerID);
  const id = str(candidate.id);
  if (!providerID || !id) return undefined;
  return { providerID, id };
}

/**
 * 模型切换结果（`switchSessionModel` 的返回值）。
 *
 * 语义：`switchModel` 只影响**后续** provider turn；`Session.Info.model` 是权威的
 * 「下一轮」模型，因此切换后要 Read-back 校验，并以读回值作为展示/记录依据。
 */
export interface ModelSwitchOutcome {
  /** 用户请求切换到的模型。 */
  readonly requested: ModelRef;
  /** 读回校验后的实际模型；读回失败时降级为 `requested`。 */
  readonly effective: ModelRef;
  /** 是否成功读回并校验。false = 读回失败（降级）。 */
  readonly verified: boolean;
  /** 读回值与请求值不一致（切换可能未生效）。 */
  readonly mismatch?: boolean;
  /** 非致命说明（读回失败原因等），不回显 secret。 */
  readonly warning?: string;
}

export type ModelMatch =
  | { readonly ok: true; readonly model: ModelEntry }
  | { readonly ok: false; readonly reason: "empty" | "not_found" | "ambiguous"; readonly candidates: ModelEntry[] };

function matchesQuery(model: ModelEntry, query: string): boolean {
  const haystack = `${model.name} ${model.id} ${model.providerID} ${model.providerID}/${model.id}`.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => haystack.includes(t));
}

function sortModels(models: ModelEntry[]): ModelEntry[] {
  return [...models].sort((a, b) => {
    const ar = a.released ?? 0;
    const br = b.released ?? 0;
    if (ar !== br) return br - ar;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 模糊匹配模型。优先级：
 * 1. `provider/id` 精确；2. `id` 精确；3. `name` 精确；4. 全词子串（唯一才算命中）。
 * 多命中返回 `ambiguous` 并附候选（最多 5 个）。
 */
export function matchModel(query: string, models: readonly ModelEntry[]): ModelMatch {
  const q = query.trim();
  if (!q) return { ok: false, reason: "empty", candidates: [] };
  const lower = q.toLowerCase();
  const byRef = models.find((m) => `${m.providerID}/${m.id}`.toLowerCase() === lower);
  if (byRef) return { ok: true, model: byRef };
  const byId = models.filter((m) => m.id.toLowerCase() === lower);
  if (byId.length === 1) return { ok: true, model: byId[0]! };
  if (byId.length > 1) return { ok: false, reason: "ambiguous", candidates: sortModels(byId).slice(0, 5) };
  const byName = models.filter((m) => m.name.toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, model: byName[0]! };
  if (byName.length > 1) return { ok: false, reason: "ambiguous", candidates: sortModels(byName).slice(0, 5) };

  const fuzzy = models.filter((m) => matchesQuery(m, q));
  if (fuzzy.length === 1) return { ok: true, model: fuzzy[0]! };
  if (fuzzy.length > 1) return { ok: false, reason: "ambiguous", candidates: sortModels(fuzzy).slice(0, 5) };
  return { ok: false, reason: "not_found", candidates: [] };
}

/** 模型回执/候选文案。 */
export function modelMatchErrorText(reason: "empty" | "not_found" | "ambiguous", candidates: readonly ModelEntry[]): string {
  switch (reason) {
    case "empty":
      return "用法：`/model <关键词>`，例如 `/model claude`。";
    case "ambiguous":
      return [
        "匹配到多个模型，请输入更精确的关键词：",
        ...candidates.map((m) => `- ${modelLabel(m)}（\`${m.providerID}/${m.id}\`）`),
      ].join("\n");
    case "not_found":
    default:
      return "没有匹配的模型，试试更短的关键词或先发送 `/model` 查看列表。";
  }
}
