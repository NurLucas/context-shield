import { describe, it, expect } from 'vitest';
import { TokenBucketLimiter } from '../src/ratelimit/token-bucket.js';
import { BudgetGuard, BudgetExceededError } from '../src/ratelimit/budget-guard.js';

describe('TokenBucketLimiter', () => {
  it('allows requests within capacity', () => {
    const limiter = new TokenBucketLimiter(60, 1.0); // 60 rpm = 1 req/sec, capacity = 60
    const res = limiter.tryConsume('127.0.0.1', 1);
    expect(res.allowed).toBe(true);
    expect(res.remaining).toBe(59);
  });

  it('rejects requests exceeding bucket capacity', () => {
    const limiter = new TokenBucketLimiter(1, 1.0); // capacity = 1
    const first = limiter.tryConsume('client-a', 1);
    expect(first.allowed).toBe(true);

    const second = limiter.tryConsume('client-a', 1);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
    expect(second.resetMs).toBeGreaterThan(0);
  });
});

describe('BudgetGuard', () => {
  it('estimates request tokens accurately from char count', () => {
    const guard = new BudgetGuard(1000, 5000);
    const est = guard.estimateRequestTokens({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '1234567890123456' }], // 16 chars
    });
    expect(est).toBe(4); // 16 / 4 = 4
  });

  it('allows requests within session budget', () => {
    const guard = new BudgetGuard(500, 2000);
    expect(() => guard.verifyBudget(100)).not.toThrow();
    guard.recordUsage(100);
    expect(guard.getUsage().sessionTokensUsed).toBe(100);
  });

  it('throws BudgetExceededError when limit exceeded', () => {
    const guard = new BudgetGuard(100, 500);
    guard.recordUsage(80);

    expect(() => guard.verifyBudget(30)).toThrow(BudgetExceededError);
  });
});
