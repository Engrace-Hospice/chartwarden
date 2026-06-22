// apps/backend/src/modules/06-admission/state-machines/validation.ts — M6-T04 (§2.4).
//
// §2.4 has two kinds of rule: SYNCHRONOUS (run inside the service before any DB write, raise an inline
// `AdmissionStateError` with the §2.4 code) and DEFERRED (surfaced as outbox events for M23/M30 to
// act on in their own domains). This module ships the synchronous catalog as pure validators the §2.3
// machines compose, plus the deferred catalog as data (the events the transitions emit). No IO: every
// fact the rule needs (an M5 patient lookup, an M38 ICD-10 check, an M39 consent read) is resolved by
// the caller and passed in as a boolean/value — M6 never imports another module's schema (§2.5).
import {
  AdmissionStateError,
  type M6ErrorCode,
  require_,
} from "./errors";
import type { LocalDate } from "@wardenx/types";

// ── §2.4.1 synchronous rule catalog (rule id → the §2.4 failure code it raises) ─────────────────────

/** The §2.4.1 synchronous rule ids, mapped to the machine-readable code each raises on failure. */
export const SYNC_VALIDATION_RULES = {
  "R-EL-01": "REPRESENTATIVE_AUTHORITY_MISSING",
  "R-EL-02": "PATIENT_ALREADY_ELECTED",
  "R-EL-03": "BENEFIT_PERIOD_SEQUENCE_GAP",
  "R-EL-04": "CURATIVE_CARE_ACK_REQUIRED",
  "R-CTI-02": "TERMINAL_DX_NOT_ALLOWABLE",
  "R-CTI-03": "ATTENDING_SIGNATURE_REQUIRED",
  "R-F2F-01": "F2F_INVALID_PERFORMER",
  "R-F2F-02": "F2F_OUTSIDE_WINDOW",
  "R-F2F-03": "F2F_OVERRIDE_FORBIDDEN",
  "R-F2F-04": "F2F_REQUIRED_FOR_RECERT",
  "R-ADM-01": "NOTICE_OF_RIGHTS_REQUIRED",
  "R-ADM-02": "INITIAL_ASSESSMENT_OVERDUE",
  "R-ADM-03": "FOR_CAUSE_REQUIRES_COSIGN",
  "R-LCP-01": "GIP_DOCUMENTATION_INSUFFICIENT",
  "R-RV-01": "REVOCATION_EFFECTIVE_BEFORE_SIGNED",
  "R-XFR-01": "TRANSFER_LIMIT_EXCEEDED",
  "R-XFR-02": "TRANSFER_IN_SOURCE_INVALID",
  "R-DC-01": "DEATH_CERTIFIER_INVALID",
  "R-CW-01": "WINDOW_OVERRIDE_FORBIDDEN",
} as const satisfies Record<string, M6ErrorCode>;

/** A §2.4.1 synchronous rule id. */
export type SyncValidationRuleId = keyof typeof SYNC_VALIDATION_RULES;

// ── §2.4.2 deferred rule catalog (data — surfaced via the named outbox event, never a sync block) ───

/** The §2.4.2 deferred rules: the outbox event each raises for a downstream module to act on. */
export const DEFERRED_VALIDATION_EVENTS = {
  "cti.signed_late": "m23",
  "f2f.window_overridden": "m30",
  "compliance_window.overdue": "m36",
  "cti.signature_lookahead_due": "m36",
  "bereavement.eligible": "m16",
  "m6.applier.refused": "m30",
} as const;

// ── Per-entity field minimums (§2.4 / §2.3 guard thresholds) ────────────────────────────────────────

/** Minimum free-text lengths the §2.3 guards enforce (CTI narrative, F2F attestation/override). */
export const TEXT_MINIMUMS = {
  ctiNarrative: 200,
  f2fAttestation: 100,
  f2fOverrideReason: 20,
  windowOverrideReason: 20,
  gipDocumentation: 30,
} as const;

/** Inclusive day window for a CTI's `period_start` at submission (§2.3.3: [today-14d, today+30d]). */
export const CTI_SUBMIT_WINDOW = { backDays: 14, forwardDays: 30 } as const;

/** Inclusive prior-to F2F window relative to `period_start` (§2.4 R-F2F-02 / CMS 418.22). */
export const F2F_PRIOR_WINDOW = { earliestDaysBefore: 30, latestDaysBefore: 1 } as const;

// ── Pure calendar helpers (LocalDate `yyyy-mm-dd`; UTC-noon math avoids DST drift) ──────────────────

/** Whole calendar days from `a` to `b` (b - a). Negative when `b` precedes `a`. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

// ── §2.4.1 synchronous validators (each raises the catalogued code on failure) ──────────────────────

/** R-EL-01: a representative signer needs an active M39 `dpoa_healthcare` consent (resolved upstream). */
export function checkRepresentativeAuthority(input: {
  signerKind: "patient" | "representative";
  hasActiveDpoaConsent: boolean;
}): void {
  if (input.signerKind !== "representative") return;
  require_(
    input.hasActiveDpoaConsent,
    "REPRESENTATIVE_AUTHORITY_MISSING",
    "representative signer requires an active DPOA-healthcare consent",
  );
}

/** R-EL-02: cannot elect a patient already actively elected at another ProviderEntity in this org. */
export function checkNoConcurrentElection(input: { existingActiveElectionElsewhere: boolean }): void {
  require_(
    !input.existingActiveElectionElsewhere,
    "PATIENT_ALREADY_ELECTED",
    "patient already has an active election at another provider entity",
  );
}

/** R-EL-03: a new period's `sequence_number` must be `MAX(prior)+1` (computed via M5 across CCNs). */
export function checkBenefitPeriodSequence(input: {
  proposedSequence: number;
  priorMaxSequence: number;
}): void {
  require_(
    input.proposedSequence === input.priorMaxSequence + 1,
    "BENEFIT_PERIOD_SEQUENCE_GAP",
    `benefit-period sequence ${input.proposedSequence} is not MAX(prior)+1 (${input.priorMaxSequence + 1})`,
  );
}

/** R-EL-04: curative-care acknowledgment must be true (CMS election-statement requirement). */
export function checkCurativeCareAck(input: { curativeCareAcknowledgment: boolean }): void {
  require_(
    input.curativeCareAcknowledgment === true,
    "CURATIVE_CARE_ACK_REQUIRED",
    "election statement requires the curative-care acknowledgment",
  );
}

/** R-CTI-02: the terminal dx must be a valid current ICD-10 (M38) AND CMS hospice-allowable. */
export function checkTerminalDxAllowable(input: {
  isValidIcd10: boolean;
  isHospiceAllowable: boolean;
}): void {
  require_(
    input.isValidIcd10 && input.isHospiceAllowable,
    "TERMINAL_DX_NOT_ALLOWABLE",
    "terminal diagnosis is not a valid current ICD-10 on the CMS hospice-allowable list",
  );
}

/** R-CTI-03: period-1 attending signature required when the patient has an attending physician. */
export function checkAttendingSignature(input: {
  sequence: number;
  patientHasAttending: boolean;
  attendingSigned: boolean;
}): void {
  if (input.sequence !== 1 || !input.patientHasAttending) return;
  require_(
    input.attendingSigned,
    "ATTENDING_SIGNATURE_REQUIRED",
    "period 1 requires the attending physician signature",
  );
}

/** R-F2F-01: the F2F performer must be a hospice MD or hospice NP (never the attending). */
export function checkF2fPerformer(input: { performerRole: "hospice_md" | "hospice_np" | "attending" }): void {
  require_(
    input.performerRole === "hospice_md" || input.performerRole === "hospice_np",
    "F2F_INVALID_PERFORMER",
    "F2F performer must be a hospice MD or NP, not the attending",
  );
}

/**
 * R-F2F-02: encounter date must be in [period_start-30d, period_start-1d] unless overridden. Returns
 * whether the encounter is `within_window` (the machine persists it; an out-of-window date with no
 * override raises `F2F_OUTSIDE_WINDOW`).
 */
export function checkF2fWindow(input: {
  periodStart: LocalDate;
  encounterDate: LocalDate;
  hasOverride: boolean;
}): { withinWindow: boolean } {
  const daysBefore = daysBetween(input.encounterDate, input.periodStart);
  const withinWindow =
    daysBefore >= F2F_PRIOR_WINDOW.latestDaysBefore && daysBefore <= F2F_PRIOR_WINDOW.earliestDaysBefore;
  if (!withinWindow && !input.hasOverride) {
    throw new AdmissionStateError(
      "F2F_OUTSIDE_WINDOW",
      "F2F encounter date is outside the CMS 418.22 prior-to window",
    );
  }
  return { withinWindow };
}

/** R-F2F-03: a window override needs the Medical Director role AND a reason ≥ 20 chars. */
export function checkF2fOverride(input: { isMedicalDirector: boolean; reason: string }): void {
  require_(
    input.isMedicalDirector,
    "F2F_OVERRIDE_FORBIDDEN",
    "F2F window override requires the hospice medical director role",
  );
  require_(
    input.reason.trim().length >= TEXT_MINIMUMS.f2fOverrideReason,
    "F2F_OVERRIDE_REASON_TOO_SHORT",
    `F2F window override reason must be ≥ ${TEXT_MINIMUMS.f2fOverrideReason} characters`,
  );
}

/** R-DC-01: a death discharge needs `death_at ≤ now` and a credentialed certifier. */
export function checkDeathCertifier(input: {
  deathAt: LocalDate;
  today: LocalDate;
  certifierIsCredentialed: boolean;
}): void {
  require_(
    daysBetween(input.deathAt, input.today) >= 0 && input.certifierIsCredentialed,
    "DEATH_CERTIFIER_INVALID",
    "death discharge requires death_at ≤ today and a credentialed certifier",
  );
}

/** R-CW-01: a compliance-window override needs a ≥20-char reason and a compliance/DON actor. */
export function checkWindowOverride(input: { isComplianceOrDon: boolean; reason: string }): void {
  require_(
    input.isComplianceOrDon && input.reason.trim().length >= TEXT_MINIMUMS.windowOverrideReason,
    "WINDOW_OVERRIDE_FORBIDDEN",
    "compliance-window override requires a compliance/DON actor and a ≥20-char reason",
  );
}
