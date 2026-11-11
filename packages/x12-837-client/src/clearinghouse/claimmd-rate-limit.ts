// @chartwarden/x12-837-client — Claim.MD's request budget. Claim.MD allows 100 requests a minute PER ACCOUNT, then
// blocks the account (every tenant on it) with HTTP 403. One account per usage mode is shared by every tenant and every
// backend process, so the counter is a port: in-process by default, the shared Valkey store when the backend injects it.
//
// A budget is taken BEFORE a request leaves. Without one the request is not sent and the wire reports it as
// not reached, so an upload releases its reservation and every caller sees retryable CH_UNAVAILABLE.

type Usage = "test" | "production";

/** A fixed-window counter: increment `key`, arming a `windowMs` expiry on the window's first hit; the count after. */
export interface ClaimMdRequestCounter {
  increment(key: string, windowMs: number): Promise<number>;
}

/**
 * Short windows keep the worst case near the sustained rate: two fixed windows can be spent back to back, so any 60 s
 * spans at most 13 windows of 5 s, 13 × 7 = 91 requests (headroom under 100), sustained 84 a minute.
 */
export const CLAIMMD_RATE_WINDOW_MS = 5_000;
export const CLAIMMD_REQUESTS_PER_WINDOW = 7;
/** A caller waits at most one window, so a sequential caller (an ERA download loop) always progresses. */
const MAX_WAIT_MS = CLAIMMD_RATE_WINDOW_MS;
const POLL_MS = 500;

/** Thrown by the budgeted fetch instead of sending; the wire maps it to a not-reached failure. */
export class ClaimMdBudgetExhausted extends Error {
  constructor() {
    super("Claim.MD request budget exhausted; the request was not sent");
  }
}

/** Single-process default: correct for one process only (each process would spend its own budget). */
export function createInProcessClaimMdCounter(now: () => number = Date.now): ClaimMdRequestCounter {
  const windows = new Map<string, { count: number; start: number }>();
  return {
    async increment(key, windowMs) {
      const t = now();
      const w = windows.get(key);
      const next =
        !w || t - w.start >= windowMs
          ? { count: 1, start: t }
          : { count: w.count + 1, start: w.start };
      windows.set(key, next);
      return next.count;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `fetchImpl` gated by the budget of the account the request opens. `usageOf` names that account (never the key: the
 * counter key is the usage mode only); an unknown account is refused, never sent unthrottled.
 *
 * A counter that throws (Valkey down) refuses at once, without waiting: the request is retryable and was never sent.
 * Falling back to per-process counting instead would let N processes spend N budgets and trip the 403 block on the
 * shared account for every tenant, so fail closed.
 */
export function budgetedFetch(
  fetchImpl: typeof fetch,
  counter: ClaimMdRequestCounter,
  usageOf: (init: RequestInit | undefined) => Usage | undefined,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const usage = usageOf(init);
    if (!usage) throw new ClaimMdBudgetExhausted();
    for (let waited = 0; ; waited += POLL_MS) {
      let count: number;
      try {
        count = await counter.increment(`claimmd:${usage}`, CLAIMMD_RATE_WINDOW_MS);
      } catch {
        throw new ClaimMdBudgetExhausted();
      }
      if (count <= CLAIMMD_REQUESTS_PER_WINDOW) return fetchImpl(input, init);
      if (waited >= MAX_WAIT_MS) throw new ClaimMdBudgetExhausted();
      await sleep(POLL_MS);
    }
  }) as typeof fetch;
}
