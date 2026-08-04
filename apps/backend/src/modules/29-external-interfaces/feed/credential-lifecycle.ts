// apps/backend/src/modules/29-external-interfaces/feed — `external_feed_credential` lifecycle (M29-T03,
// §2.2/§4.11.2). The per-feed rotating channel material (mTLS cert or MLLP channel password). PURE.
//
// The credential FSM is deliberately tiny: `active → retired`. Rotation is NOT an in-place mutation — it
// INSERTS a new `active` row and RETIRES the prior one, so the audit ledger and the §3.7 eraser both see a
// discrete row per key generation (a retired row keeps its `fingerprint` for ops display while the §3.7
// eraser destroys its `secret_cipher`). There is exactly ONE `active` credential per (feed, kind) at a time
// — `loadActive(feedId, kind)` returns it; the listener's `tls.createServer` opts read from it (§4.11.2).
//
// STEP-UP (D18, W-XI-13): rotation is a step-up-gated operator action — enforced at the T08 route, not
// here; this file is the state-shape the route walks the rows through.
import type { ExternalFeedCredentialStatus } from "@wardenx/types";

/** A fresh credential row lands `active` (§3.3 default). */
export const EXTERNAL_FEED_CREDENTIAL_INITIAL_STATUS: ExternalFeedCredentialStatus = "active";

/** The only legal credential edge: an `active` key is retired when a replacement is minted. Terminal. */
export function canRetireCredential(status: ExternalFeedCredentialStatus): boolean {
  return status === "active";
}

/** The minimal view of a credential row the rotation planner reasons over (no cipher — the plaintext key
 *  never leaves the M2 envelope layer; the planner only decides WHICH rows retire). */
export interface CredentialRotationRow {
  readonly id: string;
  readonly status: ExternalFeedCredentialStatus;
}

/** A rotation plan: the ids of the currently-active credentials to retire when the new key is inserted.
 *  Pure over the current rows — the T08 route runs the INSERT (new active) + these RETIREs in one tx. */
export interface CredentialRotationPlan {
  readonly retireIds: readonly string[];
}

/**
 * Plan a credential rotation for a (feed, kind): every currently-`active` row retires. Normally there is
 * exactly one, but the plan retires ALL active rows so a prior mint-without-retire bug self-heals to the
 * single-active invariant on the next rotation rather than silently leaving two live keys.
 */
export function planCredentialRotation(
  current: readonly CredentialRotationRow[],
): CredentialRotationPlan {
  return { retireIds: current.filter((r) => r.status === "active").map((r) => r.id) };
}
