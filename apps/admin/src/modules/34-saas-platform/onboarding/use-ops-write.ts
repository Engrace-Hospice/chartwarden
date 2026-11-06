// apps/admin/src/modules/34-saas-platform/onboarding — how a platform write runs: busy flag, one Idempotency-Key per attempt, and a
// refusal turned into an `OpsFailure` the screen switches on (re-verify, re-read, fix a field, finish an earlier step, try again).
//
// The key is kept across a request that got NO answer (the network dropped it: a retry replays instead of writing twice) and renewed by
// ANY answer: the server caches whatever it answered under the key, refusals included, so a retry on the same key after re-verifying
// would be handed the cached 403.
import { type OpsFailure, describeOpsError, useIdempotencyKeeper } from "@chartwarden/ui";
import { useCallback, useState } from "react";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

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
  /** `fingerprint` is the body (any stable text): the same one keeps the key across a retry, a changed one gets a new key. */
  run<T>(
    fingerprint: string,
    call: (idempotencyKey: string) => Promise<FetchResult<T>>,
  ): Promise<OpsWriteOutcome<T>>;
  clear(): void;
}

export function useOpsWrite(): OpsWrite {
  const keeper = useIdempotencyKeeper();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OpsFailure | null>(null);

  const run = useCallback(
    async <T>(
      fingerprint: string,
      call: (idempotencyKey: string) => Promise<FetchResult<T>>,
    ): Promise<OpsWriteOutcome<T>> => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await call(keeper.keyFor(fingerprint));
        keeper.settled(); // the server answered: its answer is cached under that key
        if (result.error !== undefined) {
          const refused = describeOpsError(
            result.error,
            result.response ?? null,
            WIZARD_ERROR_COPY,
          );
          setFailure(refused);
          return { ok: false, failure: refused };
        }
        return { ok: true, data: result.data as T };
      } catch {
        // No answer at all: keep the key so a retry replays.
        const unreachable = describeOpsError(undefined, null, WIZARD_ERROR_COPY);
        setFailure(unreachable);
        return { ok: false, failure: unreachable };
      } finally {
        setBusy(false);
      }
    },
    [keeper],
  );

  const clear = useCallback(() => setFailure(null), []);
  return { busy, failure, run, clear };
}
