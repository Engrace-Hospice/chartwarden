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

/** Run one read; any failure, synchronous or not, becomes `DRAFT_UNAVAILABLE` naming the read. Never swallowed. */
export async function guarded<T>(read: string, run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof EncounterStateError && cause.code === "DRAFT_UNAVAILABLE") throw cause;
    throw draftUnavailable(read, cause);
  }
}
