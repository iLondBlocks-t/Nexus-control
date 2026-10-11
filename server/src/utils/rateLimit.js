/**
 * Sliding-window rate limiter.
 *
 * Deliberately dependency free and in-process: a single NEXUS server for one
 * owner does not need a distributed store, and every limiter is bounded so a
 * burst of requests cannot grow memory without limit.
 */
export class RateLimiter {
  constructor({ limit, windowMs, maxKeys = 10000, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.hits = new Map();
  }

  /** @returns {{allowed: boolean, remaining: number, retryAfterMs: number}} */
  consume(key, cost = 1) {
    const current = this.now();
    const cutoff = current - this.windowMs;
    const existing = this.hits.get(key) ?? [];
    const fresh = existing.filter((timestamp) => timestamp > cutoff);

    if (fresh.length + cost > this.limit) {
      const oldest = fresh[0] ?? current;
      this.hits.set(key, fresh);
      return {
        allowed: false,
        remaining: Math.max(0, this.limit - fresh.length),
        retryAfterMs: Math.max(1, oldest + this.windowMs - current),
      };
    }

    for (let i = 0; i < cost; i += 1) fresh.push(current);
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) this.#evictOldest(cutoff);
    this.hits.set(key, fresh);
    return { allowed: true, remaining: Math.max(0, this.limit - fresh.length), retryAfterMs: 0 };
  }

  reset(key) {
    this.hits.delete(key);
  }

  peek(key) {
    const cutoff = this.now() - this.windowMs;
    const fresh = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    return { remaining: Math.max(0, this.limit - fresh.length), used: fresh.length };
  }

  #evictOldest(cutoff) {
    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
      if (fresh.length === 0) this.hits.delete(key);
    }
    if (this.hits.size >= this.maxKeys) {
      const firstKey = this.hits.keys().next().value;
      this.hits.delete(firstKey);
    }
  }

  /** Drop stale buckets (call from a periodic timer). */
  prune() {
    const cutoff = this.now() - this.windowMs;
    this.#evictOldest(cutoff);
  }
}

export function createRateLimiter(options) {
  return new RateLimiter(options);
}
