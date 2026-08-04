// apps/backend/src/modules/29-external-interfaces/nppes — token-bucket rate limiter (M29-T07, §2.3).
// A courtesy throttle over the public CMS NPI Registry API. CMS publishes no hard limit; community
// observation places sustained throughput around 5-10 req/sec, so the Phase-1 default is a conservative
// 4 req/sec (≈14K NPIs/hour — comfortably above Engrace's ~5K-NPI footprint).
//
// The clock + sleeper are INJECTED so the limiter is deterministic under test (no wall-clock, no real
// setTimeout). The real client passes `Date.now` + a `setTimeout`-backed sleeper.

export interface RateLimiterConfig {
  readonly rps: number;
  readonly burst?: number;
  /** Injected monotonic clock in ms (default `Date.now`). */
  readonly now?: () => number;
  /** Injected sleeper (default a `setTimeout`-backed promise). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: RateLimiterConfig) {
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? defaultSleep;
    this.capacity = config.burst ?? config.rps;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
    this.refillPerMs = config.rps / 1000;
  }

  /** Block until a token is available, then consume it. */
  async acquire(): Promise<void> {
    // Bounded loop: each iteration either consumes a token or sleeps until at least one has refilled.
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
      await this.sleep(waitMs);
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
}
