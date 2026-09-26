/**
 * 最近使用记录（LRU，去重，限长）（P6）。
 *
 * key：`feishu:v2:recent:dirs`（string[]）/ `feishu:v2:recent:models`（ModelRef[]）。
 * 最新在前；写入即去重并截断到 limit。storage 异常只降级为空列表 / no-op。
 */
import { errorMessage } from "../logger.js";
import type { Logger, ModelRef, StorageLike } from "../types.js";

export const RECENT_DIRS_KEY = "feishu:v2:recent:dirs";
export const RECENT_MODELS_KEY = "feishu:v2:recent:models";

export interface RecentLimits {
  readonly dirs: number;
  readonly models: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelKey(model: ModelRef): string {
  return `${model.providerID}/${model.id}`;
}

function parseModel(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const providerID = typeof value.providerID === "string" ? value.providerID : "";
  const id = typeof value.id === "string" ? value.id : "";
  if (!providerID || !id) return undefined;
  const name = typeof value.name === "string" ? value.name : "";
  return { providerID, id, ...(name ? { name } : {}) };
}

export class RecentStore {
  constructor(
    private readonly storage: StorageLike,
    private readonly log: Logger,
    private readonly limits: RecentLimits,
  ) {}

  async listDirs(): Promise<string[]> {
    const raw = await this.read(RECENT_DIRS_KEY);
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  }

  async addDir(dir: string): Promise<void> {
    const value = dir.trim();
    if (!value) return;
    const list = [value, ...(await this.listDirs()).filter((d) => d !== value)];
    await this.write(RECENT_DIRS_KEY, list.slice(0, Math.max(1, this.limits.dirs)));
  }

  async listModels(): Promise<ModelRef[]> {
    const raw = await this.read(RECENT_MODELS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(parseModel).filter((m): m is ModelRef => Boolean(m));
  }

  async addModel(model: ModelRef): Promise<void> {
    if (!model.providerID || !model.id) return;
    const key = modelKey(model);
    const list = [model, ...(await this.listModels()).filter((m) => modelKey(m) !== key)];
    await this.write(RECENT_MODELS_KEY, list.slice(0, Math.max(1, this.limits.models)));
  }

  private async read(key: string): Promise<unknown> {
    try {
      return await this.storage.get(key);
    } catch (err) {
      this.log.warn("最近记录读取失败", { key, error: errorMessage(err) });
      return undefined;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.set(key, value);
    } catch (err) {
      this.log.warn("最近记录写入失败", { key, error: errorMessage(err) });
    }
  }
}
