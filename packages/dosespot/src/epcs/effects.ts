// @wardenx/dosespot — EPCS signing-attempt side-effect descriptors (§2.4 §1311.205, M12-T05).
//
// The M12 lifecycle/refill pattern carried forward (`lifecycle/effects.ts`, `refill/effects.ts`): every EPCS
// signing-session transition carries an explicit, in-transaction side-effect list, and the COMMIT binds the
// `epcs_signing_attempt` row (the §1311.205 records-of-application surface), the audit row, and any outbox /
// M36 alert atomically — the "DB updated but the event never went out" failure mode is eliminated
// structurally (M1 §25.5/§25.6). This pure engine returns side effects DECLARATIVELY as data; the service
// layer (M12-T08) executes them inside the order's optimistic-locked transaction, alongside the
// medication-order machine's own `epcs_identity_pending` ↔ `signed`/`pending_signature` transitions. Keeping
// them as data makes the EPCS architecture deterministic and unit-testable with no DB and no DoseSpot runtime.
import type {
  EpcsSecondFactorType,
  EpcsSigningAttemptOutcome,
  M12AlertPayload,
  M12EventName,
} from "@wardenx/types";

/** §4.9 — the discriminating `eventType` of a typed M36 alert M12 dispatches (no outbox wire name). Not
 * re-exported (the package root already surfaces it from `lifecycle/effects`); local to the EPCS effects. */
type M12AlertEventType = M12AlertPayload["eventType"];

/**
 * One in-transaction side effect an EPCS signing-session transition declares (§2.4 §1311.205). The service
 * layer is the only place these run; the submachine never touches IO. `outbox` events are restricted to the
 * §4.4 `m12.*` catalog. The two `*_signing_attempt` descriptors are the §1311.205 records-of-application
 * surface: every controlled-substance signing attempt — succeeded or failed — leaves an append-only row.
 */
export type EpcsSideEffect =
  /** Write the M4 write-audit row for the `epcs_signing_attempt` aggregate (always present per §1311.150). */
  | { readonly kind: "audit" }
  /** Publish an `m12.*` outbox event in the same tx (§4.4 catalog). */
  | { readonly kind: "outbox"; readonly event: M12EventName }
  /** Dispatch a typed M36 alert that carries no outbox wire name (§4.9 — IAL2 expiry / 2FA-failure pattern). */
  | { readonly kind: "alert"; readonly alert: M12AlertEventType }
  /** §1311.116 step 3 — insert the `epcs_signing_attempt` row (outcome `pending`) carrying the SHA-256 of the
   * 60s nonce, `started_at`, and `expires_at`. The raw nonce value is never persisted (only its digest). */
  | {
      readonly kind: "write_signing_attempt";
      /** The SHA-256 of the issued nonce; the service computes the digest, never stores the nonce itself. */
      readonly nonceDigest: string;
      /** The ISO instant the 60s window opens (`started_at`). */
      readonly startedAt: string;
      /** The ISO instant the 60s window closes (`expires_at` = `started_at` + {@link EPCS_2FA_WINDOW_SECONDS}). */
      readonly expiresAt: string;
    }
  /** §1311.116 step 6/7 — resolve the `epcs_signing_attempt` row to its terminal outcome (succeeded /
   * failed_timeout / failed_validation), recording the second-factor type on success. */
  | {
      readonly kind: "update_signing_attempt";
      readonly outcome: EpcsSigningAttemptOutcome;
      readonly secondFactorType?: EpcsSecondFactorType;
    };

/** An EPCS signing-session transition's full result — the resolved outcome + its ordered side-effect list. */
export interface EpcsTransitionResult {
  readonly outcome: EpcsSigningAttemptOutcome;
  readonly effects: ReadonlyArray<EpcsSideEffect>;
}

/** Build an {@link EpcsTransitionResult} (keeps the submachine terse and uniform). */
export function epcsResult(
  outcome: EpcsSigningAttemptOutcome,
  effects: ReadonlyArray<EpcsSideEffect>,
): EpcsTransitionResult {
  return { outcome, effects };
}
