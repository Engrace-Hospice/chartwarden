// apps/backend/src/modules/31-portal/telehealth/recording-consent.ts — M31-T05 (§7.4 D9 two-party gate).
//
// The D9 recording-consent decision as a PURE evaluator, backing the `state_two_party_recording_consent_present`
// ABAC predicate (§4.7) that gates the Record button. Facts in — each session participant's residence/service
// state and whether M39 holds an active `telehealth_recording_consent` for them — a verdict out. No clock, no
// seam: the route layer (M31-T07) resolves the M39 consent facts + the M5 state and passes them here.
//
// The rule (§7.4 step 1): the Record button is allowed ONLY IF every participant who is in a two-party-consent
// state (§3.8 matrix, plus any tenant opt-in) has an active recording consent. Participants in one-party states
// need no consent to be recorded. Fails CLOSED — an unknown state is treated as two-party (see state-matrix),
// and any participant missing consent denies the whole room.
import { isTwoPartyRecordingState } from "./state-matrix";
import { requireTelehealth } from "./errors";

/** One participant's recording-consent facts, as resolved from M5 (state) + M39 (consent) by the route layer. */
export interface RecordingConsentParticipant {
  /** Opaque participant handle (a portal account id or a staff membership id) — used only for the deny reason. */
  readonly participantRef: string;
  /** The participant's residence/service state (USCDI state code) — drives the §3.8 two-party gate. */
  readonly stateCode: string | null;
  /** True iff M39 holds an ACTIVE `telehealth_recording_consent` for this participant (fail-closed if unknown). */
  readonly hasActiveRecordingConsent: boolean;
}

/** The verdict: whether recording may start, and — when denied — the participants blocking it + the state list. */
export interface RecordingConsentVerdict {
  readonly allowed: boolean;
  /** Participants in a two-party state without an active consent (empty when `allowed`). */
  readonly blockingParticipantRefs: readonly string[];
  /** The distinct two-party state codes involved in the block (for the §7.4 tooltip), sorted, empty when allowed. */
  readonly blockingStates: readonly string[];
}

/**
 * §7.4 step 1 — evaluate the two-party recording-consent gate over a room's participants. PURE. Returns
 * `allowed: true` only when no participant in a two-party state is missing consent. `tenantOptInStates` may
 * TIGHTEN the matrix (add states); it can never loosen.
 */
export function evaluateRecordingConsent(
  participants: readonly RecordingConsentParticipant[],
  opts?: { tenantOptInStates?: Iterable<string> },
): RecordingConsentVerdict {
  const optIn = opts?.tenantOptInStates;
  const blocking = participants.filter(
    (p) => isTwoPartyRecordingState(p.stateCode, optIn) && !p.hasActiveRecordingConsent,
  );
  const states = [
    ...new Set(
      blocking.map((p) => (p.stateCode == null || p.stateCode.trim() === "" ? "UNKNOWN" : p.stateCode.trim().toUpperCase())),
    ),
  ].sort();
  return {
    allowed: blocking.length === 0,
    blockingParticipantRefs: blocking.map((p) => p.participantRef),
    blockingStates: states,
  };
}

/**
 * §7.4 — the throwing gate the Record-start route (M31-T07) calls before the adapter's `startRecording`. Fails
 * CLOSED with `TELEHEALTH_RECORDING_CONSENT_ABSENT` when the verdict denies.
 */
export function assertRecordingConsent(
  participants: readonly RecordingConsentParticipant[],
  opts?: { tenantOptInStates?: Iterable<string> },
): void {
  const verdict = evaluateRecordingConsent(participants, opts);
  requireTelehealth(
    verdict.allowed,
    "TELEHEALTH_RECORDING_CONSENT_ABSENT",
    `recording requires consent from all participants in [${verdict.blockingStates.join(", ")}]`,
  );
}
