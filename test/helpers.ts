/** 测试替身：内存版 ctx.storage。 */
import type { StorageLike } from "../src/types.js";

export class FakeStorage implements StorageLike {
  private readonly data = new Map<string, unknown>();
  public readonly setCalls: Array<{ key: string; value: unknown }> = [];

  async get(key: string): Promise<unknown> {
    return this.data.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    this.setCalls.push({ key, value });
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** 测试辅助：直接写入，不记录 setCalls。 */
  seed(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  raw(key: string): unknown {
    return this.data.get(key);
  }

  /** 测试辅助：清空所有条目（含 setCalls）。 */
  clear(): void {
    this.data.clear();
    this.setCalls.length = 0;
  }
}
