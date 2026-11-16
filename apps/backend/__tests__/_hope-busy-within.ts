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
