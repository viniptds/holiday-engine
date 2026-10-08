/**
 * A bounded in-memory cache (per process) whose entries expire after `ttlMs`. The least recently
 * used entry is evicted first once `max` is reached.
 */
export class TtlLru<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= this.now()) return undefined;
    // Re-inserted: the Map's order is the recency order.
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    while (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value as K);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}
