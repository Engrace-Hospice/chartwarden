// @wardenx/ai-platform — §5.3 / W4 tenant opt-in rules (M32-T03).
//
// The tenant admin's decision to let one AI capability run against their agency's charts, and the
// evidence they had in front of them when they took it. Pure: every fact the gate needs is an ARGUMENT
// (the BAA resolution, the ZDR contract, the reviewer's role) because each of them is an upstream seam
// M32-T06 binds — a rule that fetched them could not be tested and would drag M2 into this package.
//
// ── WHICH ACKNOWLEDGMENTS ARE CONDITIONAL, AND WHY THAT IS NOT A WEAKENING ─────────────────────────
//
// §5.3.1 lists four acknowledgments flatly. Two of them are about DISCLOSURE TO A MODEL VENDOR — the
// BAA covering generative-AI processing and the Anthropic Zero-Data-Retention contract — and the
// architecture (AI Governance §10.9, authoritative over a module spec) states the `local_only`
// disclosure verbatim as "Your agency's PHI is not transmitted to any AI vendor." Where no PHI reaches
// a vendor there is no disclosure for a BAA to cover, and demanding a contract reference anyway would
// mean an agency running a purely local embedding model has to type a made-up Anthropic contract id
// into a field an auditor will later read as evidence. So those two are required exactly when the
// opt-in's routing CAN reach a cloud backend, and `cloudReachable` is a required input so the caller
// must decide it rather than inherit a default.
//
// The mirror-image conditional comes from the same corpus and points the other way: AI Governance
// §10.10 requires the per-capability CALIBRATION TRADE-OFF acknowledgment only when the tenant chooses
// `prefer_local` or `local_only` (the trade-off is precisely the local model's worse numbers), which is
// why `ai_tenant_opt_in_record.calibration_trade_off_acknowledged` is nullable in §3.2.6.
//
// The §164.528 disclosure-accounting acknowledgment stays conditional on `risk_tier = 'high'`, exactly
// as §5.3.1 writes it — and it is required whether or not the route is cloud, because M32 records
// every invocation in the §164.528 ledger regardless of where the model ran.
//
// ── THE OFFERABILITY RULE IS NOT "IS THE CAPABILITY APPROVED" ──────────────────────────────────────
//
// §2.2's consumer posture already answers "may this capability serve", but opting IN is a different
// question with two states where the answers diverge:
//   · PILOT is `unavailable` to a consumer and yet a pilot tenant MUST be able to opt in — the posture
//     is `pilot_tenants_only` precisely because `ai_tenant_opt_in_record.pilot_enrollment = true` is
//     what unlocks it. An opt-in request that does not enroll as a pilot is refused; one that does is
//     the only way the PILOT state is ever reachable.
//   · DEPRECATED is `existing_opt_ins_only`: §2.2 says in as many words that "new tenants cannot opt
//     in; tenants who had `active` opt-in continue to use". A tenant sitting at `paused` never
//     withdrew — resuming is continuing. A tenant at `opted_out` withdrew, and re-entering a
//     capability the platform is retiring is the one case §2.2 forecloses.
import type {
  AiCapabilityConsumerPosture,
  AiCapabilityRiskTier,
  AiRoutingMode,
  AiRoutingPreference,
  AiTenantOptInStatus,
} from "@wardenx/types";

import { aiGovernanceRefusal, type AiGovernanceRefusal } from "./errors";

/** The routing preferences under which a local backend is the only thing that may run (§10.8). */
export const AI_LOCAL_ONLY_PREFERENCES: readonly AiRoutingPreference[] = ["local_only"];

/** The preferences that trigger §10.10's calibration trade-off disclosure. */
export const AI_TRADE_OFF_DISCLOSURE_PREFERENCES: readonly AiRoutingPreference[] = [
  "prefer_local",
  "local_only",
];

/**
 * §5.3.1's routing-mode selector → the `routing_preference_snapshot` column's vocabulary (§3.2.6's
 * CHECK). `default` inherits the org's own M2 `TenantConfiguration.ai_routing_preference`; the other
 * two are explicit narrowings the admin made on this capability's card.
 */
export function aiResolveRoutingPreference(
  mode: AiRoutingMode,
  orgPreference: AiRoutingPreference,
): AiRoutingPreference {
  switch (mode) {
    case "default":
      return orgPreference;
    case "prefer_local":
      return "prefer_local";
    case "local_only":
      return "local_only";
  }
}

/** Can a cloud backend run under this preference, for a capability with these backends? */
export function aiCloudReachableUnder(
  preference: AiRoutingPreference,
  cloudBackendAvailable: boolean,
): boolean {
  return preference !== "local_only" && cloudBackendAvailable;
}

/** The `ai_capability` columns the opt-in gate reads. */
export interface AiOptInCapabilitySnapshot {
  readonly riskTier: AiCapabilityRiskTier;
  readonly posture: AiCapabilityConsumerPosture;
  /** §10.8 — `local_only` hides a capability with no local backend. */
  readonly localBackendAvailable: boolean;
  /** §10.8 — `cloud_only` hides a capability with no cloud backend. */
  readonly cloudBackendAvailable: boolean;
}

/** §5.3.1's acknowledgment gate, as the admin submitted it. */
export interface AiOptInAcknowledgmentSubmission {
  /** §5.3.1(1) — the agency's BAA covering generative-AI processing. */
  readonly baaReference: string | null;
  /** §5.3.1(2) — the Anthropic Zero-Data-Retention contract reference. */
  readonly zdrContractReference: string | null;
  /** §5.3.1(3) — the clinical reviewer who attested to the calibration. */
  readonly clinicalReviewerMembershipId: string | null;
  readonly clinicalReviewerAttestationText: string | null;
  /** §5.3.1(4) — high-risk only: the §164.528 disclosure-accounting implication. */
  readonly disclosureAccountingAcknowledged: boolean;
  /** §10.10 — the trade-off body as it was SHOWN (frozen evidence, not a flag). */
  readonly calibrationTradeOffAcknowledged: string | null;
}

/**
 * What the caller RESOLVED upstream before asking. M32-T06 binds these to `OrgContextResolver` (M2's
 * contract registry) and `IdentityResolver`/`PermissionEvaluator`; T03 takes them as facts so the rule
 * is a function. Every field is three-valued in effect — `false` means "we asked and the answer was
 * no", and a caller that could not ask must not pass `true`.
 */
export interface AiOptInResolvedEvidence {
  readonly baaResolved: boolean;
  /** ISO instant; `null` for a BAA with no stated expiry. */
  readonly baaExpiresAt: string | null;
  readonly zdrContractOnRecord: boolean;
  /** W4.1 — the named reviewer holds `clinical_safety_lead` WITHIN this org. */
  readonly clinicalReviewerHasSafetyLeadRole: boolean;
}

/** R10's body, already parsed. */
export interface AiTenantOptInRequest {
  readonly routingMode: AiRoutingMode;
  readonly pilotEnrollment: boolean;
  readonly acknowledgments: AiOptInAcknowledgmentSubmission;
}

/** The `ai_tenant_opt_in_record` column values an accepted opt-in implies. */
export interface AiTenantOptInPatch {
  readonly status: "active";
  readonly pilotEnrollment: boolean;
  readonly routingPreferenceSnapshot: AiRoutingPreference;
  readonly optedInAt: string;
  readonly calibrationTradeOffAcknowledged: string | null;
  /** Cleared: an opt-in that was previously paused or withdrawn is now neither. */
  readonly pausedAt: null;
  readonly pausedReason: null;
  readonly optedOutAt: null;
  readonly optedOutReason: null;
}

export type AiTenantOptInDecision =
  | {
      readonly ok: true;
      readonly patch: AiTenantOptInPatch;
      /** True where §10.9 obliges the vendor-disclosure text — surfaced so the caller records which
       *  disclosure the admin was actually shown rather than re-deriving it later. */
      readonly cloudReachable: boolean;
    }
  | AiGovernanceRefusal;

/**
 * §2.2 / §5.3.1 — may this tenant take (or retake) an opt-in on a capability in this posture?
 *
 * `priorStatus` is `null` when no `ai_tenant_opt_in_record` row exists yet. Note that a row at
 * `opted_out` is NOT the same as no row: §3.2.6 defaults the column to `opted_out` precisely so an
 * abandoned workflow does not read as consent, so "there is a row" is never itself evidence of
 * anything and the DEPRECATED rule keys on the STATUS, not on the row's existence.
 */
export function aiTenantOptInOfferable(
  posture: AiCapabilityConsumerPosture,
  priorStatus: AiTenantOptInStatus | null,
  pilotEnrollment: boolean,
): AiGovernanceRefusal | { readonly ok: true } {
  switch (posture.kind) {
    case "generally_available":
      return { ok: true };
    case "pilot_tenants_only":
      return pilotEnrollment
        ? { ok: true }
        : aiGovernanceRefusal(
            "AI_OPT_IN_CAPABILITY_NOT_OFFERABLE",
            "a PILOT capability is reachable only through an opt-in enrolled as a pilot tenant (§2.2)",
          );
    case "existing_opt_ins_only":
      return priorStatus === "active" || priorStatus === "paused"
        ? { ok: true }
        : aiGovernanceRefusal(
            "AI_OPT_IN_CAPABILITY_NOT_OFFERABLE",
            "a DEPRECATED capability accepts no new tenant opt-in (§2.2)",
          );
    case "unavailable":
      return aiGovernanceRefusal(
        "AI_OPT_IN_CAPABILITY_NOT_OFFERABLE",
        `the capability is not offerable: ${posture.reason}`,
      );
  }
}

function blank(value: string | null | undefined): boolean {
  return (value ?? "").trim().length === 0;
}

/**
 * W4 — validate the acknowledgment gate and produce the opt-in row's values, or refuse.
 *
 * Guard order: offerability first (there is no point validating a BAA for a capability the tenant may
 * not have), then routing legality (it decides WHICH acknowledgments apply), then the acknowledgments
 * the admin submitted, then the evidence the platform resolved. The last two are separate on purpose —
 * "you did not tick the box" and "the reference you gave does not resolve" send an admin to different
 * places.
 */
export function evaluateAiTenantOptIn(
  capability: AiOptInCapabilitySnapshot,
  priorStatus: AiTenantOptInStatus | null,
  request: AiTenantOptInRequest,
  evidence: AiOptInResolvedEvidence,
  orgRoutingPreference: AiRoutingPreference,
  at: string,
): AiTenantOptInDecision {
  const offerable = aiTenantOptInOfferable(
    capability.posture,
    priorStatus,
    request.pilotEnrollment,
  );
  if (offerable.ok === false) return offerable;

  const preference = aiResolveRoutingPreference(request.routingMode, orgRoutingPreference);
  if (preference === "local_only" && !capability.localBackendAvailable) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ROUTING_MODE_UNSUPPORTED",
      "local_only routing hides a capability with no local backend (AI Governance §10.8)",
    );
  }
  if (preference === "cloud_only" && !capability.cloudBackendAvailable) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ROUTING_MODE_UNSUPPORTED",
      "cloud_only routing hides a capability with no cloud backend (AI Governance §10.8)",
    );
  }

  const cloudReachable = aiCloudReachableUnder(preference, capability.cloudBackendAvailable);
  const ack = request.acknowledgments;

  // §5.3.1(1)/(2) — vendor-disclosure acknowledgments, required iff PHI can reach a vendor (header).
  if (cloudReachable) {
    if (blank(ack.baaReference)) {
      return aiGovernanceRefusal(
        "AI_OPT_IN_ACKNOWLEDGMENT_MISSING",
        "§5.3.1(1) BAA reference is required for a capability that can route to a cloud backend",
      );
    }
    if (blank(ack.zdrContractReference)) {
      return aiGovernanceRefusal(
        "AI_OPT_IN_ACKNOWLEDGMENT_MISSING",
        "§5.3.1(2) Zero-Data-Retention contract reference is required for a cloud-reachable capability",
      );
    }
  }

  // §5.3.1(3) — the clinical reviewer's attestation. Unconditional: the trade-offs a reviewer attests
  // to are the CAPABILITY's, not the vendor's, and a local model has them too.
  if (blank(ack.clinicalReviewerMembershipId) || blank(ack.clinicalReviewerAttestationText)) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ACKNOWLEDGMENT_MISSING",
      "§5.3.1(3) clinical reviewer id and attestation text are required",
    );
  }

  // §5.3.1(4) — high-risk only.
  if (capability.riskTier === "high" && !ack.disclosureAccountingAcknowledged) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ACKNOWLEDGMENT_MISSING",
      "§5.3.1(4) §164.528 disclosure-accounting acknowledgment is required for a high-risk capability",
    );
  }

  // AI Governance §10.10 — the trade-off body, required only where the tenant chose a local route.
  if (
    AI_TRADE_OFF_DISCLOSURE_PREFERENCES.includes(preference) &&
    blank(ack.calibrationTradeOffAcknowledged)
  ) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ACKNOWLEDGMENT_MISSING",
      "AI Governance §10.10 requires the calibration trade-off acknowledgment for a local routing preference",
    );
  }

  // ── the evidence the platform resolved (W4.1) ───────────────────────────────────────────────────
  if (cloudReachable) {
    if (!evidence.baaResolved) {
      return aiGovernanceRefusal(
        "AI_OPT_IN_BAA_UNRESOLVED",
        "the BAA reference did not resolve to a record in the org's contract registry",
      );
    }
    if (evidence.baaExpiresAt !== null && Date.parse(evidence.baaExpiresAt) <= Date.parse(at)) {
      return aiGovernanceRefusal(
        "AI_OPT_IN_BAA_EXPIRED",
        `the BAA expired at ${evidence.baaExpiresAt}`,
      );
    }
    if (!evidence.zdrContractOnRecord) {
      return aiGovernanceRefusal(
        "AI_OPT_IN_ZDR_CONTRACT_MISSING",
        "no Zero-Data-Retention contract reference on the org's vendor contract metadata",
      );
    }
  }

  if (!evidence.clinicalReviewerHasSafetyLeadRole) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_CLINICAL_REVIEWER_INVALID",
      "the named clinical reviewer does not hold clinical_safety_lead within this organization",
    );
  }

  return {
    ok: true,
    cloudReachable,
    patch: {
      status: "active",
      pilotEnrollment: request.pilotEnrollment,
      routingPreferenceSnapshot: preference,
      optedInAt: at,
      calibrationTradeOffAcknowledged: ack.calibrationTradeOffAcknowledged?.trim() || null,
      pausedAt: null,
      pausedReason: null,
      optedOutAt: null,
      optedOutReason: null,
    },
  };
}

/** The `ai_tenant_opt_in_record` values a withdrawal implies (R11 / §10.6). */
export interface AiTenantOptInWithdrawalPatch {
  readonly status: "opted_out";
  readonly optedOutAt: string;
  readonly optedOutReason: string | null;
  readonly pausedAt: null;
  readonly pausedReason: null;
}

/**
 * §10.6 — withdrawal is "immediate, no questions asked". So the ONLY refusal here is the one that
 * would make the record lie: withdrawing something already withdrawn, which would overwrite the
 * instant consent actually ended. A reason is accepted and never required (§10.6: the follow-up to
 * understand why is explicitly optional).
 */
export function evaluateAiTenantOptInWithdrawal(
  priorStatus: AiTenantOptInStatus | null,
  reason: string | null,
  at: string,
): { readonly ok: true; readonly patch: AiTenantOptInWithdrawalPatch } | AiGovernanceRefusal {
  if (priorStatus === null) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_NOT_FOUND",
      "no tenant opt-in record exists for this capability",
    );
  }
  if (priorStatus === "opted_out") {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ALREADY_INACTIVE",
      "the tenant opt-in is already withdrawn",
    );
  }
  return {
    ok: true,
    patch: {
      status: "opted_out",
      optedOutAt: at,
      optedOutReason: reason?.trim() || null,
      pausedAt: null,
      pausedReason: null,
    },
  };
}

/** The `ai_tenant_opt_in_record` values a pause implies. */
export interface AiTenantOptInPausePatch {
  readonly status: "paused";
  readonly pausedAt: string;
  readonly pausedReason: string;
}

/**
 * Pause — the reversible half of §10.5, used by W3's kill-switch follow-up and by an admin who wants
 * the capability off without discarding the acknowledgment evidence a fresh opt-in would have to
 * rebuild. Unlike a withdrawal the reason IS required: a pause with no reason cannot be resumed by
 * anyone who was not in the room.
 */
export function evaluateAiTenantOptInPause(
  priorStatus: AiTenantOptInStatus | null,
  reason: string,
  at: string,
): { readonly ok: true; readonly patch: AiTenantOptInPausePatch } | AiGovernanceRefusal {
  if (priorStatus === null) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_NOT_FOUND",
      "no tenant opt-in record exists for this capability",
    );
  }
  if (priorStatus !== "active") {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ALREADY_INACTIVE",
      `only an active opt-in can be paused; status is ${priorStatus}`,
    );
  }
  if (reason.trim().length === 0) {
    return aiGovernanceRefusal(
      "AI_OPT_IN_ACKNOWLEDGMENT_MISSING",
      "ai_tenant_opt_in_record.paused_reason is required",
    );
  }
  return { ok: true, patch: { status: "paused", pausedAt: at, pausedReason: reason.trim() } };
}
