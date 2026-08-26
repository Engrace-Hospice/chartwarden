/**
 * Retry the TWO rate limiters a seed sign-in can hit. They are different controls with different
 * windows and different headers, and treating them as one is what broke `bun run db:reset`:
 *
 *   · Better Auth's own sign-in/sign-up guard — 3 requests / 10 s per IP, advertised on `x-retry-after`.
 *     This helper was written for that one, and handled it correctly.
 *   · WardenX's SD-055 tier — 30 requests / minute for the UNAUTHENTICATED bucket (`ip:<addr>`,
 *     bootstrap/plugins/security.ts), advertised on the standard `Retry-After` header. A sign-in is
 *     inherently pre-auth, so every one of them shares that single bucket.
 *
 * F-014 (#39): only `x-retry-after` was read. Against the SD-055 limiter that header is absent, so
 * the helper fell back to its 11-second Better Auth constant and retried four times inside a SIXTY
 * second fixed window — each retry consuming another token of the very budget it was waiting on —
 * then threw `exhausted rate-limit retries`. The seed chain signs in roughly thirty times across its
 * fourteen steps, so it reached the ceiling at `db:seed:scenario-billing` and the `&&` chain stopped
 * one step from the end. Reading `Retry-After` makes the FIRST retry succeed: both limiters are
 * fixed-window counters (rate-limit-store.ts), so one full window clears the bucket outright.
 *
 * Deliberately not "solved" by raising the server's ceiling: `RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE`
 * exists (WX-PR-018) and would also make the chain pass, but it turns a real control off for the
 * whole boot to paper over a client that was waiting the wrong amount of time.
 */
const MAX_AUTH_ATTEMPTS = 5;

/** Better Auth reports seconds on `x-retry-after`; WardenX's SD-055 tier on the standard header. */
function retryDelaySeconds(response: Response): number {
  for (const header of ["retry-after", "x-retry-after"]) {
    const value = Number(response.headers.get(header));
    // Both limiters compare their window with a strict `>`, so wait one second past the edge.
    if (Number.isFinite(value) && value > 0) return value + 1;
  }
  // Neither header present: assume the shorter (Better Auth) window rather than stalling a seed.
  return 11;
}

export async function fetchAuthWithRateLimitRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt += 1) {
    const response = await fetch(input, init);
    if (response.status !== 429 || attempt === MAX_AUTH_ATTEMPTS - 1) return response;

    const delaySeconds = retryDelaySeconds(response);
    console.log(`${label} rate-limited; retrying in ${delaySeconds}s`);
    await new Promise<void>((resolve) => setTimeout(resolve, delaySeconds * 1_000));
  }

  throw new Error(`${label} exhausted rate-limit retries`);
}
