// @chartwarden/dosespot — EPCS 60-second 2FA signing-session submachine (§2.4 §1311.116, M12-T05). Pure, IO-free.
//
// The DEA two-factor-authentication-at-signing flow (21 CFR §1311.116), modelled as a two-step submachine
// that brackets the medication-order machine's `pending_signature → epcs_identity_pending → signed` branch:
//
//   step 1 (open)  signControlled    → planEpcsSigningSession: run the gate ladder (flag → cert → IAL2 → DEA),
//                                       then mint the 60s nonce attempt row (outcome `pending`).
//   step 2 (close) completeSecondFactor → validateSecondFactor: within the 60s window + valid proof → outcome
//                                       `succeeded` (the service then invokes M11's signature primitive);
//                                       timed out → `failed_timeout`; bad proof → `failed_validation` (the
//                                       order returns to `pending_signature`, §2.4 step 7).
//
// THE DENY-STUB (§2.4 D18 / Phase-1, M12-T05): the outermost gate is the `dosespot.epcs` platform flag, OFF
// in Phase 1. `planEpcsSigningSession` asserts the flag first, so in Phase 1 it ALWAYS throws
// `EPCS_FEATURE_DISABLED` before a nonce is ever minted — the EPCS architecture is fully built and tested,
// but no Phase-1 route transmits a controlled-substance Rx through it. Every fact (the gate inputs, the
// SHA-256 nonce digest, the `started_at`/`now` instants, the proof validity) is injected as data — no
// `Date.now()`, no crypto, no DB.
import type {
  DeaSchedule,
  EpcsCertificationStatus,
  EpcsSecondFactorType,
  EpcsSigningAttemptOutcome,
  Ial2Status,
} from "@chartwarden/types";
import {
  type DoseSpotEpcsFlags,
  assertEpcsCertified,
  assertEpcsFeatureEnabled,
  evaluateEpcsCertGate,
} from "./cert-gate";
import { assertDeaScheduleAuthorized, isDeaScheduleAuthorized } from "./dea-schedule";
import { type EpcsSideEffect, type EpcsTransitionResult, epcsResult } from "./effects";
import { type M12EpcsErrorCode, requireEpcs } from "./errors";
import { assertIal2Verified, isIal2Verified } from "./ial2";

/** §2.4 §1311.116 — the EPCS two-factor challenge window: the proof must be submitted within 60 seconds. */
export const EPCS_2FA_WINDOW_SECONDS = 60;

/** The facts the §1311.116 gate ladder needs to decide whether a signing session may open. */
export interface EpcsSigningGateFacts {
  /** §1311.300 / D18 — the tenant's `epcs_certification_status`. */
  readonly certStatus: EpcsCertificationStatus;
  /** §1311.115 — the prescriber's `dosespot_prescriber.ial2_status`. */
  readonly ial2Status: Ial2Status;
  /** §1311.120 — the prescriber's `dosespot_prescriber.dea_authorized_schedules`. */
  readonly authorizedSchedules: readonly DeaSchedule[];
  /** The order's DEA schedule (controlled orders always carry one; never `null` on the EPCS path). */
  readonly schedule: DeaSchedule;
}

/** The §1311.116 gate-ladder verdict: ok, or the first failing gate's code. */
export type EpcsSigningGateVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: M12EpcsErrorCode };

/**
 * §2.4 §1311.116 — evaluate the EPCS signing-session gate ladder, returning the FIRST failing gate's code or
 * `{ ok: true }`. Pure verdict (never throws), mirroring the HearthNote eligibility-ladder shape. Priority,
 * outermost first: the `dosespot.epcs` platform flag → the tenant cert gate (D18) → the prescriber's IAL2
 * status (§1311.115) → the DEA schedule authorization (§1311.120). In Phase 1 the flag is OFF, so this
 * always returns `{ ok: false, code: "EPCS_FEATURE_DISABLED" }`.
 */
export function evaluateEpcsSigningGate(
  flags: DoseSpotEpcsFlags,
  facts: EpcsSigningGateFacts,
): EpcsSigningGateVerdict {
  if (!flags.epcs) return { ok: false, code: "EPCS_FEATURE_DISABLED" };
  const cert = evaluateEpcsCertGate(facts.certStatus);
  if (!cert.permitted) return { ok: false, code: cert.code };
  if (!isIal2Verified(facts.ial2Status)) return { ok: false, code: "EPCS_PRESCRIBER_NOT_VERIFIED" };
  if (!isDeaScheduleAuthorized(facts.authorizedSchedules, facts.schedule)) {
    return { ok: false, code: "DEA_SCHEDULE_NOT_AUTHORIZED" };
  }
  return { ok: true };
}

/** §2.4 §1311.116 step 1 — the request to open a 60s signing session. */
export interface OpenSigningSessionRequest {
  readonly flags: DoseSpotEpcsFlags;
  readonly facts: EpcsSigningGateFacts;
  /** The SHA-256 of the issued nonce (the service computes the digest; the nonce value is never persisted). */
  readonly nonceDigest: string;
  /** The ISO instant the 60s window opens (`epcs_signing_attempt.started_at`). */
  readonly startedAtIso: string;
}

/** §2.4 §1311.116 step 1 — the opened-session plan: the computed `expires_at` + the records-of-application
 * write. The service inserts the `epcs_signing_attempt` row (outcome `pending`) and transitions the
 * medication order into `epcs_identity_pending` in the same tx. */
export interface OpenSigningSessionPlan {
  /** `started_at` + {@link EPCS_2FA_WINDOW_SECONDS} (ISO). */
  readonly expiresAt: string;
  readonly effects: ReadonlyArray<EpcsSideEffect>;
}

/**
 * §2.4 §1311.116 step 1 — open a 60-second EPCS signing session (the DENY-STUB path). Asserts the full gate
 * ladder ({@link assertEpcsFeatureEnabled} → {@link assertEpcsCertified} → {@link assertIal2Verified} →
 * {@link assertDeaScheduleAuthorized}), throwing the precise {@link EpcsStateError} on the first failure, then
 * returns the `epcs_signing_attempt` write plan with `expires_at = started_at + 60s`. In Phase 1 the
 * `dosespot.epcs` flag is OFF so this throws `EPCS_FEATURE_DISABLED` before any nonce row is minted — the
 * architecture is built, the path is a deny-stub.
 */
export function planEpcsSigningSession(req: OpenSigningSessionRequest): OpenSigningSessionPlan {
  // The gate ladder, outermost first — assert form (throws the precise code) for the route handler.
  assertEpcsFeatureEnabled(req.flags);
  assertEpcsCertified(req.facts.certStatus);
  assertIal2Verified(req.facts.ial2Status);
  assertDeaScheduleAuthorized(req.facts.authorizedSchedules, req.facts.schedule);

  const started = Date.parse(req.startedAtIso);
  if (Number.isNaN(started)) {
    throw new RangeError("planEpcsSigningSession: startedAt must be a valid ISO instant");
  }
  const expiresAt = new Date(started + EPCS_2FA_WINDOW_SECONDS * 1000).toISOString();
  return {
    expiresAt,
    effects: [
      {
        kind: "write_signing_attempt",
        nonceDigest: req.nonceDigest,
        startedAt: req.startedAtIso,
        expiresAt,
      },
      { kind: "audit" },
    ],
  };
}

/** §2.4 §1311.116 step 2 — the request to close a pending signing session with the second-factor proof. */
export interface CompleteSigningSessionRequest {
  /** The current `epcs_signing_attempt.outcome` — must be `pending` (else the session is already resolved). */
  readonly currentOutcome: EpcsSigningAttemptOutcome;
  /** `epcs_signing_attempt.started_at` (ISO). */
  readonly startedAtIso: string;
  /** `epcs_signing_attempt.expires_at` (ISO). */
  readonly expiresAtIso: string;
  /** The instant the completion request arrives (injected; the service passes its clock). */
  readonly nowIso: string;
  /** The SHA-256 of the nonce the client returned. */
  readonly providedNonceDigest: string;
  /** The persisted `epcs_signing_attempt.nonce` digest to match against. */
  readonly expectedNonceDigest: string;
  /** The second-factor type the challenge used (recorded on the signature on success). */
  readonly secondFactorType: EpcsSecondFactorType;
  /** Whether the submitted second-factor proof verified (resolved upstream by M2's factor verifier). */
  readonly proofValid: boolean;
}

/**
 * §2.4 §1311.116 steps 6–7 — validate a second-factor completion and resolve the `epcs_signing_attempt`
 * outcome. Request-integrity violations THROW the precise {@link EpcsStateError} (the attempt is not
 * `pending`, or the returned nonce does not match — a malformed request, not a legitimate failure). A
 * legitimate-but-failed attempt RETURNS a terminal failure outcome the service drives back to
 * `pending_signature` (§2.4 step 7): past the 60s window → `failed_timeout`; valid window but wrong proof →
 * `failed_validation`. A valid proof inside the window → `succeeded`; the service then invokes M11's
 * `OrderSignatureProvider.signOrderTarget` with the second-factor context.
 */
export function validateSecondFactor(req: CompleteSigningSessionRequest): EpcsTransitionResult {
  requireEpcs(
    req.currentOutcome === "pending",
    "EPCS_SIGNING_ATTEMPT_NOT_PENDING",
    `the EPCS signing attempt is already resolved (outcome='${req.currentOutcome}')`,
  );
  requireEpcs(
    req.providedNonceDigest === req.expectedNonceDigest,
    "EPCS_2FA_NONCE_MISMATCH",
    "the completion request's nonce does not match the pending signing attempt",
  );

  const expires = Date.parse(req.expiresAtIso);
  const now = Date.parse(req.nowIso);
  if (Number.isNaN(expires) || Number.isNaN(now)) {
    throw new RangeError("validateSecondFactor: expiresAt / now must be valid ISO instants");
  }

  // §1311.116 — the proof must arrive within the 60s window. Past it: a recorded timeout, order → pending.
  if (now > expires) {
    return epcsResult("failed_timeout", [
      { kind: "update_signing_attempt", outcome: "failed_timeout" },
      { kind: "audit" },
      { kind: "outbox", event: "m12.medication_order.epcs_2fa_failed" },
    ]);
  }
  // §1311.116 — a present-but-invalid proof: a recorded validation failure, order → pending (§2.4 step 7).
  if (!req.proofValid) {
    return epcsResult("failed_validation", [
      { kind: "update_signing_attempt", outcome: "failed_validation" },
      { kind: "audit" },
      { kind: "outbox", event: "m12.medication_order.epcs_2fa_failed" },
    ]);
  }
  // §1311.116 step 6 — valid proof inside the window: the service now invokes the M11 signature primitive.
  return epcsResult("succeeded", [
    {
      kind: "update_signing_attempt",
      outcome: "succeeded",
      secondFactorType: req.secondFactorType,
    },
    { kind: "audit" },
  ]);
}
