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
 * `Promise.all`, except that it does not answer until EVERY promise has settled, and then throws the first failure in the order given.
 * The draft's store reads run on the request's transaction while its seam reads run beside them: with `Promise.all` a seam that fails at once rejects
 * the whole read, the transaction rolls back and its connection returns to the pool, and a store read still mid-way (`loadSelection` makes four
 * queries in turn) goes on to issue its next query on a connection that by then belongs to the NEXT request, where it can abort that request's
 * transaction. Waiting is bounded because every seam read and every store read of the draft computation goes through `guarded`, which gives up after
 * `DRAFT_SOURCE_READ_TIMEOUT_MS`. Not bounded by it: the tenant-switch read and the two store reads of `resolveSection` (the confirmations and the
 * author's own rows), which are plain queries on the request's own connection.
 *
 * That covers a read that FAILS. A read `guarded` abandoned at its time bound is not cancelled and may still be mid-way when this settles: that one is
 * cut off by the transaction lease (transaction-lease.ts), which makes its next query throw once the unit of work has ended.
 */
export async function settleAll<T extends readonly unknown[] | []>(
  values: T,
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const settled = await Promise.allSettled(values);
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
  }
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [P in keyof T]: Awaited<T[P]>;
  };
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
