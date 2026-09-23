import { createRequire } from 'node:module';
import { CacheEntry } from '../types/index.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: any = null;
try {
  DatabaseSync = nodeRequire('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
}

export class L2SqliteCache {
  private db: any = null;
  private memoryFallback = new Map<string, CacheEntry>();

  constructor(dbFilePath?: string) {
    if (DatabaseSync) {
      if (dbFilePath && dbFilePath !== ':memory:') {
        const dir = path.dirname(dbFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        this.db = new DatabaseSync(dbFilePath);
      } else {
        this.db = new DatabaseSync(':memory:');
      }

      this.initSchema();
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS response_cache (
        hash TEXT PRIMARY KEY,
        request_fingerprint TEXT,
        model TEXT,
        response_body TEXT,
        is_stream INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        created_at INTEGER,
        last_accessed_at INTEGER,
        hit_count INTEGER DEFAULT 0,
        ttl_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_cache_created ON response_cache(created_at);
      CREATE INDEX IF NOT EXISTS idx_cache_model ON response_cache(model);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        client_ip TEXT,
        model TEXT,
        is_cache_hit INTEGER,
        cache_tier TEXT,
        secrets_redacted INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        latency_ms INTEGER,
        status_code INTEGER
      );
    `);
  }

  public get(hash: string): CacheEntry | null {
    if (!this.db) {
      const entry = this.memoryFallback.get(hash);
      if (!entry) return null;
      const now = Date.now();
      if (entry.ttlMs > 0 && now - entry.createdAt > entry.ttlMs) {
        this.memoryFallback.delete(hash);
        return null;
      }
      entry.lastAccessedAt = now;
      entry.hitCount += 1;
      return entry;
    }

    const stmt = this.db.prepare('SELECT * FROM response_cache WHERE hash = ?');
    const row = stmt.get(hash) as any;

    if (!row) return null;

    const now = Date.now();
    if (row.ttl_ms > 0 && now - row.created_at > row.ttl_ms) {
      this.delete(hash);
      return null;
    }

    const updateStmt = this.db.prepare(`
      UPDATE response_cache 
      SET last_accessed_at = ?, hit_count = hit_count + 1 
      WHERE hash = ?
    `);
    updateStmt.run(now, hash);

    return {
      hash: row.hash,
      requestFingerprint: row.request_fingerprint,
      model: row.model,
      responseBody: row.response_body,
      isStream: Boolean(row.is_stream),
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      createdAt: row.created_at,
      lastAccessedAt: now,
      hitCount: row.hit_count + 1,
      ttlMs: row.ttl_ms,
    };
  }

  public set(hash: string, entry: Omit<CacheEntry, 'createdAt' | 'lastAccessedAt' | 'hitCount'>): void {
    const now = Date.now();
    if (!this.db) {
      this.memoryFallback.set(hash, {
        ...entry,
        createdAt: now,
        lastAccessedAt: now,
        hitCount: 0,
        ttlMs: entry.ttlMs,
      });
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO response_cache (
        hash, request_fingerprint, model, response_body, is_stream,
        prompt_tokens, completion_tokens, created_at, last_accessed_at,
        hit_count, ttl_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      hash,
      entry.requestFingerprint,
      entry.model,
      entry.responseBody,
      entry.isStream ? 1 : 0,
      entry.promptTokens,
      entry.completionTokens,
      now,
      now,
      0,
      entry.ttlMs
    );
  }

  public delete(hash: string): void {
    if (!this.db) {
      this.memoryFallback.delete(hash);
      return;
    }
    const stmt = this.db.prepare('DELETE FROM response_cache WHERE hash = ?');
    stmt.run(hash);
  }

  public clear(): void {
    if (!this.db) {
      this.memoryFallback.clear();
      return;
    }
    this.db.exec('DELETE FROM response_cache');
  }

  public pruneExpired(): number {
    if (!this.db) return 0;
    const now = Date.now();
    const stmt = this.db.prepare('DELETE FROM response_cache WHERE ttl_ms > 0 AND (? - created_at) > ttl_ms');
    const result = stmt.run(now);
    return (result as any)?.changes || 0;
  }

  public recordAuditLog(log: {
    clientIp: string;
    model: string;
    isCacheHit: boolean;
    cacheTier?: string;
    secretsRedacted: number;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    statusCode: number;
  }): void {
    if (!this.db) return;
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (
        timestamp, client_ip, model, is_cache_hit, cache_tier,
        secrets_redacted, prompt_tokens, completion_tokens, latency_ms, status_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      Date.now(),
      log.clientIp,
      log.model,
      log.isCacheHit ? 1 : 0,
      log.cacheTier || null,
      log.secretsRedacted,
      log.promptTokens,
      log.completionTokens,
      log.latencyMs,
      log.statusCode
    );
  }

  public getStats(): { totalEntries: number; totalHits: number; tokensSaved: number } {
    if (!this.db) {
      let totalHits = 0;
      let tokensSaved = 0;
      for (const e of this.memoryFallback.values()) {
        totalHits += e.hitCount;
        tokensSaved += e.hitCount * (e.promptTokens + e.completionTokens);
      }
      return {
        totalEntries: this.memoryFallback.size,
        totalHits,
        tokensSaved,
      };
    }

    const row = this.db
      .prepare(`
      SELECT 
        COUNT(*) as total_entries,
        COALESCE(SUM(hit_count), 0) as total_hits,
        COALESCE(SUM(hit_count * (prompt_tokens + completion_tokens)), 0) as tokens_saved
      FROM response_cache
    `)
      .get() as any;

    return {
      totalEntries: row?.total_entries || 0,
      totalHits: row?.total_hits || 0,
      tokensSaved: row?.tokens_saved || 0,
    };
  }

  public close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
