/**
 * Token Bucket Rate Limiter
 * Provides smooth rate-limiting with configurable burst allowance.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;

  /**
   * @param requestsPerMinute Maximum sustained requests per minute
   * @param burstMultiplier Multiplier for maximum burst capacity (default 1.5x)
   */
  constructor(requestsPerMinute: number = 60, burstMultiplier: number = 1.5) {
    this.capacity = Math.max(1, Math.round(requestsPerMinute * burstMultiplier));
    this.refillPerMs = requestsPerMinute / 60000;
  }

  /**
   * Attempts to consume 1 or more tokens.
   * Returns true if allowed, false if rate limited.
   */
  public tryConsume(key: string, tokensRequested: number = 1): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      // Calculate token refill since last check
      const elapsed = now - bucket.lastRefill;
      const refilled = elapsed * this.refillPerMs;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refilled);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= tokensRequested) {
      bucket.tokens -= tokensRequested;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetMs: 0,
      };
    }

    const deficit = tokensRequested - bucket.tokens;
    const waitMs = Math.ceil(deficit / this.refillPerMs);

    return {
      allowed: false,
      remaining: 0,
      resetMs: waitMs,
    };
  }

  /**
   * Cleanup stale buckets to prevent memory leak
   */
  public prune(idleTimeoutMs: number = 300000): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > idleTimeoutMs) {
        this.buckets.delete(key);
      }
    }
  }
}
