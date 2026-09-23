import { describe, it, expect } from 'vitest';
import { hashRequest, canonicalizeRequest } from '../src/cache/hasher.js';
import { L1LruCache } from '../src/cache/l1-lru.js';
import { L2SqliteCache } from '../src/cache/l2-sqlite.js';
import { ChatCompletionRequest } from '../src/types/index.js';

describe('Hasher & Canonicalization', () => {
  it('generates identical hash for identical semantic payloads with different key order', () => {
    const req1: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello world' }],
      temperature: 0.7,
    };

    const req2: ChatCompletionRequest = {
      temperature: 0.7,
      messages: [{ role: 'user', content: 'hello world' }],
      model: 'gpt-4o',
    };

    expect(hashRequest(req1)).toBe(hashRequest(req2));
  });

  it('generates different hash when content changes', () => {
    const req1: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello world' }],
    };

    const req2: ChatCompletionRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello universe' }],
    };

    expect(hashRequest(req1)).not.toBe(hashRequest(req2));
  });
});

describe('L1LruCache', () => {
  it('stores and retrieves cache entries', () => {
    const l1 = new L1LruCache(3, 10000);
    l1.set('key1', {
      hash: 'key1',
      requestFingerprint: 'gpt-4o',
      model: 'gpt-4o',
      responseBody: '{"response": 1}',
      isStream: false,
      promptTokens: 10,
      completionTokens: 20,
      ttlMs: 10000,
    });

    const res = l1.get('key1');
    expect(res).not.toBeNull();
    expect(res?.responseBody).toBe('{"response": 1}');
    expect(res?.hitCount).toBe(1);
  });

  it('evicts least recently used item when max capacity is exceeded', () => {
    const l1 = new L1LruCache(2, 10000);
    const mockEntry = (val: string) => ({
      hash: val,
      requestFingerprint: val,
      model: 'm',
      responseBody: val,
      isStream: false,
      promptTokens: 5,
      completionTokens: 5,
      ttlMs: 10000,
    });

    l1.set('a', mockEntry('a'));
    l1.set('b', mockEntry('b'));
    // Access 'a' so 'b' becomes the oldest
    l1.get('a');

    // Add 'c', should evict 'b'
    l1.set('c', mockEntry('c'));

    expect(l1.get('a')).not.toBeNull();
    expect(l1.get('b')).toBeNull();
    expect(l1.get('c')).not.toBeNull();
  });
});

describe('L2SqliteCache', () => {
  it('persists and retrieves entries from in-memory SQLite', () => {
    const l2 = new L2SqliteCache(':memory:');
    l2.set('test-hash-1', {
      hash: 'test-hash-1',
      requestFingerprint: 'claude-3-5-sonnet',
      model: 'claude-3-5-sonnet',
      responseBody: '{"text":"cached response"}',
      isStream: false,
      promptTokens: 100,
      completionTokens: 50,
      ttlMs: 60000,
    });

    const entry = l2.get('test-hash-1');
    expect(entry).not.toBeNull();
    expect(entry?.model).toBe('claude-3-5-sonnet');
    expect(entry?.hitCount).toBe(1);

    const stats = l2.getStats();
    expect(stats.totalEntries).toBe(1);
    expect(stats.totalHits).toBe(1);
    expect(stats.tokensSaved).toBe(150);

    l2.close();
  });
});
