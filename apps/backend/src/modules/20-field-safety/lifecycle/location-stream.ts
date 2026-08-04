// apps/backend/src/modules/20-field-safety/lifecycle/location-stream.ts — M20-T03 (§4.8
// `m20.sos-location-stream.cron`, D6, §7.9, §8.7).
//
// The continuous-location stream is the most invasive thing M20 can do to a member of the workforce, so its
// gate is written as a single total function whose default answer is "no". Every path that does not
// AFFIRMATIVELY satisfy all four conditions returns a `stop` or a refusal — there is no branch that falls
// through to "sample".
//
// TWO INDEPENDENT OPT-INS, NEITHER IMPLYING THE OTHER (D6 / §8.7):
//   1. the TENANT sets `sosContinuousLocationEnabled` in policy, and
//   2. the CLINICIAN grants `continuous_location_during_sos` on her own consent row.
// An agency cannot consent on a clinician's behalf and a clinician cannot enable a feature the agency has
// not bought. `M20-F16` keeps this separate from `sos_coordinates`: declining either one never disables the
// SOS itself.
//
// THE APP'S ACTIVE SET IS NARROWER THAN THE DATABASE'S, DELIBERATELY. Migration 0111's
// `m20_enforce_sos_stream_active` BEFORE INSERT trigger admits the whole `SAFETY_SOS_OPEN_STATES` set —
// it is the fail-closed floor that catches any writer, including a repair script. The app streams over a
// strict subset of it:
//
//   • `raised` / `cancel_window_open` are EXCLUDED. A press cancelled inside its five-second window must
//     leave no location trail at all; starting the stream at the press would defeat the cancel.
//   • `acknowledged` is INCLUDED even though D6's sentence lists only `acknowledging | escalation_tier_* |
//     resolving`. §7.9's own worked sequence has Maria acknowledge and dispatch help while "the stream
//     continues until the SOS resolves OR 4 hours elapse" — cutting the feed the instant a supervisor
//     acknowledges would blind the responder who is still driving to the address.
//   • `emergency_terminus` is INCLUDED. It is an OPEN state (M20-F05) and it is the moment the location
//     matters most; the same reading migration 0110's SLA index was built on.
//
// FORCED SUNSET, NOT A CONFIGURABLE ONE (§8.7). The stream stops at resolve OR at
// `sosContinuousLocationMaxDurationHours`, whichever comes first. A tenant may set that lower; the platform
// band caps it at 4 hours and there is no extension route anywhere in §4.1.
import type {
  IsoInstant,
  SafetyEmergencyContactConsentStatus,
  SafetyPolicyEffectiveDto,
  SafetySosLifecycleState,
} from "@wardenx/types";
import { requireSafety } from "./errors";

/**
 * D6 — the alert states the app streams in. A strict subset of `SAFETY_SOS_OPEN_STATES`, so no sample the
 * app decides to write can violate migration 0111's trigger.
 */
export const SAFETY_SOS_STREAMING_STATES = [
  "acknowledging",
  "acknowledged",
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
  "emergency_terminus",
  "resolving",
] as const satisfies readonly SafetySosLifecycleState[];

/** Is the alert in a state the stream may write in? */
export function isStreamingState(state: SafetySosLifecycleState): boolean {
  return (SAFETY_SOS_STREAMING_STATES as readonly SafetySosLifecycleState[]).includes(state);
}

/** The clinician's `continuous_location_during_sos` consent row as the gate sees it. */
export interface SafetyStreamConsentFacts {
  readonly status: SafetyEmergencyContactConsentStatus;
  readonly grantedAt: IsoInstant;
  readonly expiresAt: IsoInstant | null;
}

/**
 * D6 / §2.2.8 — is the consent ACTIVE at `atIso`?
 *
 * A row whose `expiresAt` has passed is not active even if its `status` still reads `granted`: the tenant's
 * rotation sweep flips the column, and between the expiry instant and the sweep's next run there is a window
 * in which the row lies. Reading the timestamp rather than trusting the enum closes it. `null` (no row at
 * all) is not active — the argument is nullable so a missing consent and a revoked one take the same path.
 */
export function isStreamConsentActive(
  consent: SafetyStreamConsentFacts | null,
  atIso: IsoInstant,
): boolean {
  if (consent === null) return false;
  if (consent.status !== "granted") return false;
  if (consent.expiresAt !== null && Date.parse(consent.expiresAt) <= Date.parse(atIso))
    return false;
  return Date.parse(consent.grantedAt) <= Date.parse(atIso);
}

/** Why the stream worker stopped. Each maps to a distinct §8.8.2 business-event entry — "we stopped because
 *  she revoked" and "we stopped because four hours elapsed" are different facts about the same clinician. */
export type SafetyStreamStopReason =
  | "sos_no_longer_active"
  | "max_duration_reached"
  | "consent_inactive"
  | "tenant_policy_disabled";

/** What the stream worker should do this tick. */
export type SafetyStreamDecision =
  | { readonly kind: "sample"; readonly nextSampleAt: IsoInstant }
  | { readonly kind: "wait"; readonly nextSampleAt: IsoInstant }
  | { readonly kind: "stop"; readonly reason: SafetyStreamStopReason };

/**
 * §4.8 `m20.sos-location-stream.cron` — the per-alert, per-tick decision.
 *
 * Gate order matters and runs coarsest-first: tenant policy, then consent, then the alert's state, then the
 * §8.7 sunset, then the cadence. Checking cadence first would let a revoked consent produce a `wait` that
 * reads, to a caller inspecting the decision, like an authorised stream merely between samples.
 */
export function decideLocationStreamSample(input: {
  readonly lifecycleState: SafetySosLifecycleState;
  readonly policy: SafetyPolicyEffectiveDto;
  readonly consent: SafetyStreamConsentFacts | null;
  /** The alert's `posted_at` — the §8.7 sunset is measured from the PRESS, not from the first sample, so a
   *  worker that started late cannot extend the window. */
  readonly sosPostedAt: IsoInstant;
  readonly lastSampleAt: IsoInstant | null;
  readonly nowIso: IsoInstant;
}): SafetyStreamDecision {
  if (!input.policy.sosContinuousLocationEnabled) {
    return { kind: "stop", reason: "tenant_policy_disabled" };
  }
  if (!isStreamConsentActive(input.consent, input.nowIso)) {
    return { kind: "stop", reason: "consent_inactive" };
  }
  if (!isStreamingState(input.lifecycleState)) {
    return { kind: "stop", reason: "sos_no_longer_active" };
  }

  const now = Date.parse(input.nowIso);
  const sunsetMs =
    Date.parse(input.sosPostedAt) + input.policy.sosContinuousLocationMaxDurationHours * 3_600_000;
  if (now >= sunsetMs) return { kind: "stop", reason: "max_duration_reached" };

  const cadenceMs = input.policy.sosContinuousLocationSampleSeconds * 1000;
  if (input.lastSampleAt === null) {
    return { kind: "sample", nextSampleAt: new Date(now + cadenceMs).toISOString() };
  }
  const dueAt = Date.parse(input.lastSampleAt) + cadenceMs;
  if (now < dueAt) return { kind: "wait", nextSampleAt: new Date(dueAt).toISOString() };
  return { kind: "sample", nextSampleAt: new Date(now + cadenceMs).toISOString() };
}

/**
 * The write-path guard, for the one caller that is not the cron: the mobile client push-back that posts a
 * coordinate sample directly. It raises the §2.3 refusal codes rather than returning a decision, so a
 * client cannot write a sample the cron would have refused.
 */
export function assertStreamSampleWritable(input: {
  readonly lifecycleState: SafetySosLifecycleState;
  readonly policy: SafetyPolicyEffectiveDto;
  readonly consent: SafetyStreamConsentFacts | null;
  readonly sosPostedAt: IsoInstant;
  readonly nowIso: IsoInstant;
}): void {
  requireSafety(
    input.policy.sosContinuousLocationEnabled,
    "SOS_STREAM_POLICY_DISABLED",
    "this tenant has not enabled continuous location during SOS (D6 opt-in)",
  );
  requireSafety(
    isStreamConsentActive(input.consent, input.nowIso),
    "SOS_STREAM_CONSENT_MISSING",
    "this clinician has no active `continuous_location_during_sos` consent",
  );
  requireSafety(
    isStreamingState(input.lifecycleState),
    "SOS_STREAM_NOT_ACTIVE",
    `an alert in '${input.lifecycleState}' is not streaming`,
  );
  requireSafety(
    Date.parse(input.nowIso) <
      Date.parse(input.sosPostedAt) +
        input.policy.sosContinuousLocationMaxDurationHours * 3_600_000,
    "SOS_STREAM_MAX_DURATION_REACHED",
    `the §8.7 forced sunset (${input.policy.sosContinuousLocationMaxDurationHours} h from the press) has elapsed`,
  );
}
