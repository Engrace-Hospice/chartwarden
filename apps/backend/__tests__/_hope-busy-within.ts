// apps/backend/__tests__/_hope-busy-within.ts — the shared "a call parked behind a lock someone else holds" helper of the M10 live
// suites (m10-hope-write.live.test.ts). Unit-tested in hope-g2-busy-within.test.ts, because the live suites are not run
// with every change.

/** The part of a `pg` `Client` the helper uses: the second connection that holds the row lock. */
export interface LockHolder {
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

/** Only a stuck call reaches this: the lock timeout is 5 s, so a call still parked this long after it was made never gave up. */
export const HOLDER_SAFETY_RELEASE_MS = 20_000;

/**
 * The outcome (`statusCode:code`, null when it succeeded) of a call that is parked behind a lock `holder` keeps; the holder is
 * rolled back and closed once the call has settled. NO elapsed bound is asserted: the 409 is the proof that the wait ended, and
 * a wait that never ends is caught by the test's own timeout. The safety timer only keeps a hung call from outliving the test:
 * it releases the holder, the call then SUCCEEDS, and the caller's 409 assertion fails.
 */
export async function busyWithin(
  call: Promise<unknown>,
  holder: LockHolder,
): Promise<string | null> {
  const settled = call.then(
    () => null,
    (e: { code?: string; statusCode?: number }) => `${e.statusCode}:${e.code ?? "OTHER"}`,
  );
  const safety = setTimeout(() => {
    void holder.query("ROLLBACK").catch(() => undefined);
  }, HOLDER_SAFETY_RELEASE_MS);
  try {
    return await settled;
  } finally {
    clearTimeout(safety);
    await holder.query("ROLLBACK");
    await holder.end();
  }
}

/** 100 polls 50 ms apart: the budget the live suites' inline "is it parked yet" loops each carried. */
export const PARKED_POLL_ATTEMPTS = 100;
export const PARKED_POLL_INTERVAL_MS = 50;

/**
 * Wait until `isParked` reports that the statement under test is waiting on a lock. THROWS when it never does, naming `what`:
 * a poll that falls through would release the holder before the call queued, so the ordering the test exists to prove would be
 * silently dropped (or the assertion after it would fail with a message about something else). `sleep` is injectable so the
 * failure path is unit-testable without waiting 5 s (hope-g1-r6-await-parked.test.ts).
 */
export async function awaitParked(
  isParked: () => Promise<boolean>,
  what: string,
  sleep: (ms: number) => Promise<unknown> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (await isParked()) return;
    if (attempt >= PARKED_POLL_ATTEMPTS) throw new Error(`${what} never became blocked on a lock`);
    await sleep(PARKED_POLL_INTERVAL_MS);
  }
}
