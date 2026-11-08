import { useCallback, useRef, useState } from "react";
import { useIdempotencyKeeper } from "./idempotency";
// @chartwarden/ui core — how a platform write runs: busy flag, one Idempotency-Key per attempt, and a refusal turned into an
// `OpsFailure` the screen switches on (re-verify, re-read, fix a field, finish an earlier step, try again). `copy` maps a server
// code to the screen's own sentence (see describeOpsError). Shared by the platform console's modules, which may not import each other.
//
// The key is kept across a request that got NO answer (the network dropped it: a retry replays instead of writing twice) and renewed by
// ANY answer: the server caches whatever it answered under the key, refusals included, so a retry on the same key after re-verifying
// would be handed the cached 403.
import { type OpsErrorCopy, type OpsFailure, describeOpsError } from "./ops-error";

export type OpsWriteOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: OpsFailure };

interface FetchResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response?: { readonly status: number };
}

export interface OpsWrite {
  readonly busy: boolean;
  readonly failure: OpsFailure | null;
  /**
   * `fingerprint` is the body (any stable text): the same one keeps the key across a retry, a changed one gets a new key.
   * `afterSuccess` (a reload, closing the editor) runs inside the same in-flight window: until it finishes, `busy` stays true and a
   * second `run` (a double submit, an Enter while the first is saving) is dropped: it never settles, so its caller does nothing.
   * The window is bounded: a follow-up still pending after `AFTER_SUCCESS_TIMEOUT_MS` (a hung reload) stops holding it, so the button
   * cannot stay on "Saving…"; the write already landed, the run returns its outcome and the follow-up finishes on its own.
   */
  run<T>(
    fingerprint: string,
    call: (idempotencyKey: string) => Promise<FetchResult<T>>,
    afterSuccess?: (data: T) => Promise<unknown>,
  ): Promise<OpsWriteOutcome<T>>;
  clear(): void;
}

/** How long a write's follow-up (a reload) may hold the in-flight window before the screen is released. */
export const AFTER_SUCCESS_TIMEOUT_MS = 15_000;

/** Waits for `followUp`, but no longer than `ms`; its failure still reaches the caller when it comes first. */
async function boundedFollowUp(followUp: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([followUp, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A gateway error page: a 5xx whose body is not the API's error envelope never got to the app. */
function reachedNoOne(result: FetchResult<unknown>): boolean {
  if (result.error === undefined || (result.response?.status ?? 0) < 500) return false;
  const code = (result.error as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  return typeof code !== "string";
}

/** No screen copy: the server's sentence (a module constant, so `run` stays stable across renders). */
const NO_COPY: OpsErrorCopy = {};

/**
 * `copy` must be stable across renders (a module constant, never an inline object): it is a dependency of `run`, and an object made
 * on every render would make `run` new on every render and re-fire any effect that depends on it.
 */
export function useOpsWrite(copy: OpsErrorCopy = NO_COPY): OpsWrite {
  const keeper = useIdempotencyKeeper();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OpsFailure | null>(null);
  // A ref, not the `busy` state: two submits in the same tick both see the stale `busy === false`.
  const inFlight = useRef(false);

  const send = useCallback(
    async <T>(
      fingerprint: string,
      call: (idempotencyKey: string) => Promise<FetchResult<T>>,
    ): Promise<OpsWriteOutcome<T>> => {
      try {
        const result = await call(keeper.keyFor(fingerprint));
        // The server answered, and its answer is cached under the key: the next attempt starts on a new one. A 5xx WITHOUT the standard
        // error envelope is a gateway (502/504) that never reached the app: nothing was cached, so a retry keeps the key.
        if (!reachedNoOne(result)) keeper.settled();
        if (result.error !== undefined) {
          const refused = describeOpsError(result.error, result.response ?? null, copy);
          setFailure(refused);
          return { ok: false, failure: refused };
        }
        return { ok: true, data: result.data as T };
      } catch {
        // No answer at all: keep the key so a retry replays.
        const unreachable = describeOpsError(undefined, null, copy);
        setFailure(unreachable);
        return { ok: false, failure: unreachable };
      }
    },
    [keeper, copy],
  );

  const run = useCallback(
    async <T>(
      fingerprint: string,
      call: (idempotencyKey: string) => Promise<FetchResult<T>>,
      afterSuccess?: (data: T) => Promise<unknown>,
    ): Promise<OpsWriteOutcome<T>> => {
      // ponytail: a dropped run never settles (its caller's follow-up never runs); a distinct outcome if a caller ever needs to know.
      if (inFlight.current) return new Promise<never>(() => {});
      inFlight.current = true;
      setBusy(true);
      setFailure(null);
      try {
        const outcome = await send(fingerprint, call);
        // The follow-up's own failure (a reload that throws) is the caller's to see, not a write failure: it is outside `send`.
        if (outcome.ok && afterSuccess) {
          await boundedFollowUp(afterSuccess(outcome.data), AFTER_SUCCESS_TIMEOUT_MS);
        }
        return outcome;
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [send],
  );

  const clear = useCallback(() => setFailure(null), []);
  return { busy, failure, run, clear };
}
