import { CacheEntry } from '../types/index.js';

/**
 * High-performance In-Memory LRU Cache with TTL
 */
export class L1LruCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;

  constructor(maxEntries: number = 500, defaultTtlMs: number = 3600000) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
  }

  public get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    // Check TTL expiration
    if (entry.ttlMs > 0 && now - entry.createdAt > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Refresh LRU position by re-inserting
    this.cache.delete(key);
    entry.lastAccessedAt = now;
    entry.hitCount += 1;
    this.cache.set(key, entry);

    return entry;
  }

  public set(key: string, entry: Omit<CacheEntry, 'createdAt' | 'lastAccessedAt' | 'hitCount'>): void {
    const now = Date.now();
    const fullEntry: CacheEntry = {
      ...entry,
      createdAt: now,
      lastAccessedAt: now,
      hitCount: 0,
      ttlMs: entry.ttlMs ?? this.defaultTtlMs,
    };

    // If already exists, delete before re-inserting
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict least recently used (first item in Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, fullEntry);
  }

  public has(key: string): boolean {
    return this.get(key) !== null;
  }

  public delete(key: string): boolean {
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}
