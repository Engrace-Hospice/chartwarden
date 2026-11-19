// apps/backend/src/modules/08-encounters/drafting/unavailable.ts — the one way the draft computation fails
// (S1 PR C2a, design §3.2): `DRAFT_UNAVAILABLE` (503), never a partial draft passed off as complete.
import { EncounterStateError } from "../lifecycle/errors";

/**
 * A draft that could not be computed. The message names the failing read and nothing else: the upstream message may
 * carry PHI, so it stays on `cause` for the server log and never reaches the response.
 */
export function draftUnavailable(read: string, cause?: unknown): EncounterStateError {
  return new EncounterStateError(
    "DRAFT_UNAVAILABLE",
    `the visit-note draft could not be computed: ${read} is unavailable`,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * How long one source read may take before the draft is unavailable. A read inside the sign transaction that never answers would hold that
 * transaction (and its row lock) open, so every read is bounded; the bound is generous for an in-process seam and short enough that a hung
 * one fails the request instead of the connection pool.
 */
export const DRAFT_SOURCE_READ_TIMEOUT_MS = 5_000;

/**
 * Run one read; any failure, synchronous or not, and any read that does not answer within `DRAFT_SOURCE_READ_TIMEOUT_MS`, becomes
 * `DRAFT_UNAVAILABLE` naming the read. Never swallowed, never retried: a read that gave up is not a pass. The abandoned read is not
 * cancelled (a seam has no cancel); its late answer is ignored.
 */
export async function guarded<T>(read: string, run: () => Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(draftUnavailable(`${read} (no answer within ${DRAFT_SOURCE_READ_TIMEOUT_MS} ms)`)),
      DRAFT_SOURCE_READ_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(run), deadline]);
  } catch (cause) {
    if (cause instanceof EncounterStateError && cause.code === "DRAFT_UNAVAILABLE") throw cause;
    throw draftUnavailable(read, cause);
  } finally {
    clearTimeout(timer);
  }
}
