// apps/backend/src/modules/06-admission/certification/adequacy.ts — F-217 the F2F/CTI ADEQUACY predicate
// (M11 D10; M6 §2.3.2/§2.3.3/§2.3.4, §2.4 R-CTI-01/R-CTI-03/R-F2F-01..04, §11 D3/D4/D5/D8/D9).
//
// Before this module no callable function anywhere answered "is this election period's certification
// adequate?" — `window-math.ts` is calendar math only (WHEN is a deadline), `state-machines/certification.ts`
// is the multi-step human CTI workflow, and `hasAttestedF2f` (admission-route-service-db.ts) only asked "is
// there an attested row?" (F-159/F-167 recorded that as the blocker for `m11.order.recertification_signed`).
//
// PURE: no IO, no `Date.now()` — every fact (the period, the CTI rows, the F2F rows, the admission's
// hospice physician, the org timezone) is passed in, so the verdict is deterministic and unit-testable on the
// exact day boundaries. The result carries machine-readable reason codes and NOTHING ELSE about the patient
// (no ids of people, no narrative text): it is safe to put in an outbox payload, an audit row, an error
// `details` array or a log line.
//
// WHAT "ADEQUATE" MEANS — every clause cites the spec that states it; nothing here is invented:
//   CTI  (any period)
//     · a non-voided, non-superseded CTI exists for THIS period                     (§2.2 UNIQUE per period)
//     · the hospice-MD signature is on file, and the CTI is `signed` — except period 1, where D3 (amended
//       v0.6) makes the hospice-MD signature alone sufficient and the attending co-sign a BILLING gate
//       (M23 `cti_signed_per_period`), surfaced here only as the non-blocking flag CTI_ATTENDING_COSIGN_PENDING
//     · the signer is the admission's selected hospice physician (the rule `signCtiHospiceMd` already enforces
//       as CTI_HOSPICE_PHYSICIAN_MISMATCH; the route layer separately enforces the `cti.sign_hospice_md` role)
//     · the narrative is present and ≥ 200 characters                               (§2.3.3 submit guard;
//                                                                                    TEXT_MINIMUMS.ctiNarrative)
//     · LATE is a FLAG, never a block (R-CTI-01, D4: "flagged but not auto-held"): CTI_SIGNED_LATE when the
//       org-local signature date is after the period start (or the row was marked late via route 27),
//       CTI_LATE_REASON_MISSING when late with no reason on file, CTI_WRITTEN_CERT_DEADLINE_MISSED when the
//       signature landed after `period_start + 2 calendar days 23:59 org-TZ` (D4/D8).
//   F2F  (REQUIRED from sequence 3 onward — R-F2F-04, 42 CFR 418.22(a)(4), D9: follows the INHERITED sequence)
//     · an F2F row for this period, `attested`, with an attestation signature timestamp
//     · performed by a hospice MD or hospice NP (R-F2F-01; the `f2f_performer_role` enum)
//     · inside [period_start − 30, period_start] org-local days (R-F2F-02) — OR carrying a valid window
//       override (R-F2F-03 / D5: reason ≥ 20 chars + an overriding user), which passes with the non-blocking
//       flag F2F_WINDOW_OVERRIDDEN. See `windowBasis` below for how "inside the window" is established.
//   PERIOD: `period_kind` agrees with the 90/90/60… sequence (§2.2 CHECK; 42 CFR 418.21(a)).
//
// AMBIGUITIES THE SPEC LEAVES (chosen conservatively, recorded in docs/history):
//   · D5 says the override is compliance-officer-only, R-F2F-03/§2.3.4 say Medical Director. The predicate
//     does not re-decide WHO may override (that is the route permission); it accepts any row that carries the
//     override facts the DB CHECK requires, plus the ≥ 20-char reason R-F2F-03 names.
//   · `windowBasis`: 'recorded' trusts `face_to_face_encounter.within_window` (the value R-F2F-02 persisted at
//     completion) and refuses NULL as unverified; 'dates' recomputes from `encounter_date` + the window start;
//     'strict' (F-226, what the recert activation gate uses) does BOTH and fails closed on any disagreement:
//     the recomputed verdict must be inside the window AND the persisted flag must be exactly `true`.
//     The window start is `period.f2fWindowStart` (the period's EXPECTED start, prior end + 1) when given,
//     else `period.startDate`. `null` = the start is not derivable: unverifiable, fail closed.
import type { LocalDate } from "@chartwarden/types";
import {
  RECERT_SEQUENCE_FLOOR,
  electionPeriodKindForSequence,
} from "../state-machines/election-period";
import { TEXT_MINIMUMS } from "../state-machines/validation";
import {
  computeF2fWindow,
  computeWrittenCertDeadline,
  isF2fScheduledWithinWindow,
  localDateOfInstant,
} from "./window-math";

// ── result vocabulary ──────────────────────────────────────────────────────────────────────────────────

/** Blocking reason codes — any one makes the verdict `inadequate`. Stable wire values (no PHI). */
export const ADEQUACY_REASON_CODES = [
  "PERIOD_SEQUENCE_INVALID",
  "PERIOD_KIND_SEQUENCE_MISMATCH",
  "CTI_MISSING",
  "CTI_WRONG_PERIOD",
  "CTI_VOIDED",
  "CTI_SUPERSEDED",
  "CTI_NOT_SIGNED",
  "CTI_SIGNATURE_MISSING",
  "CTI_SIGNER_UNRESOLVED",
  "CTI_SIGNER_NOT_ADMISSION_PHYSICIAN",
  "CTI_NARRATIVE_MISSING",
  "CTI_NARRATIVE_TOO_SHORT",
  "F2F_MISSING",
  "F2F_WRONG_PERIOD",
  "F2F_NOT_ATTESTED",
  "F2F_ATTESTATION_UNSIGNED",
  "F2F_PERFORMER_INELIGIBLE",
  "F2F_OUTSIDE_WINDOW",
  "F2F_WINDOW_UNVERIFIED",
  "F2F_ENCOUNTER_DATE_MISSING",
  "F2F_OVERRIDE_INVALID",
] as const;
export type AdequacyReasonCode = (typeof ADEQUACY_REASON_CODES)[number];

/** Non-blocking flags — surfaced for compliance/billing, never change the verdict. */
export const ADEQUACY_FLAG_CODES = [
  "CTI_SIGNED_LATE",
  "CTI_LATE_REASON_MISSING",
  "CTI_WRITTEN_CERT_DEADLINE_MISSED",
  "CTI_ATTENDING_COSIGN_PENDING",
  "F2F_WINDOW_OVERRIDDEN",
] as const;
export type AdequacyFlagCode = (typeof ADEQUACY_FLAG_CODES)[number];

// ── facts ──────────────────────────────────────────────────────────────────────────────────────────────

export interface AdequacyPeriodFact {
  readonly electionPeriodId: string;
  /** Benefit-period sequence (D9: the INHERITED sequence for a transfer-in). */
  readonly sequenceNumber: number;
  /** Stored `period_kind`, when known — checked against the 90/90/60 sequencing. */
  readonly periodKind?: string | null;
  /** Org-local calendar date the period starts (effective) — the anchor of the F2F window and late math. */
  readonly startDate: LocalDate;
  /**
   * F-226 — the start the F2F prior-to window [start-30, start] is anchored to, when it differs from
   * `startDate` (a pending recert period activates "today" but its benefit period started at prior end + 1).
   * `undefined` = use `startDate`; `null` = not derivable (unverifiable, fail closed).
   */
  readonly f2fWindowStart?: LocalDate | null;
}

export interface AdequacyCtiFact {
  readonly electionPeriodId: string;
  /** `cti_status`: drafted | awaiting_hospice_md | awaiting_attending | signed | voided | superseded. */
  readonly status: string;
  readonly hospiceMdId: string | null;
  /** ISO instant of the hospice-MD signature, or null. */
  readonly hospiceMdSignedAt: string | null;
  readonly attendingMdId: string | null;
  readonly attendingMdSignedAt: string | null;
  readonly narrative: string | null;
  readonly signedLate: boolean;
  readonly lateReason: string | null;
}

export interface AdequacyF2fFact {
  readonly electionPeriodId: string;
  /** `f2f_encounter_status`: scheduled | completed | attested. */
  readonly status: string;
  /** `f2f_performer_role`: hospice_md | hospice_np. */
  readonly performerRole: string | null;
  readonly encounterDate: LocalDate | null;
  /** R-F2F-02's persisted verdict; null = never computed. */
  readonly withinWindow: boolean | null;
  readonly windowOverride: boolean;
  readonly windowOverrideReason: string | null;
  readonly windowOverrideBy: string | null;
  /** ISO instant, or null. */
  readonly attestationSignedAt: string | null;
}

export type F2fWindowBasis = "recorded" | "dates" | "strict";

export interface AdequacyInput {
  readonly period: AdequacyPeriodFact;
  /** `admission.hospice_physician_id` — the physician a CTI must be signed by. */
  readonly admissionHospicePhysicianId: string | null;
  /** The org timezone (D8), e.g. `DEFAULT_ORG_TIME_ZONE`. */
  readonly timeZone: string;
  /** Every CTI row for the period, oldest first (the order `claimAssemblyRangeContextForOrg` reads). */
  readonly ctis: readonly AdequacyCtiFact[];
  /** Every F2F row for the period, oldest first. */
  readonly f2fs: readonly AdequacyF2fFact[];
  /** How "inside the window" is established — see the file header. Default `recorded`. */
  readonly windowBasis?: F2fWindowBasis;
}

export interface AdequacySection {
  readonly adequate: boolean;
  readonly reasonCodes: readonly AdequacyReasonCode[];
}

export interface AdequacyResult {
  readonly verdict: "adequate" | "inadequate";
  readonly electionPeriodId: string;
  readonly sequenceNumber: number;
  /** F2F is required for this period (sequence ≥ 3). */
  readonly f2fRequired: boolean;
  /** Every blocking reason across the period, CTI, and F2F sections (empty iff adequate). */
  readonly reasonCodes: readonly AdequacyReasonCode[];
  readonly flags: readonly AdequacyFlagCode[];
  readonly cti: AdequacySection;
  readonly f2f: AdequacySection & { readonly required: boolean };
}

// ── row selection (shared with the M23 claim-assembly range reader — F-121 parity) ─────────────────────

/**
 * The CTI that represents a period: the first non-voided, non-superseded row, else the most recent row
 * (so a voided-only period reports CTI_VOIDED rather than CTI_MISSING). `ctis` is oldest-first.
 */
export function pickCertification<T extends { readonly status: string }>(
  ctis: readonly T[],
): T | undefined {
  return ctis.find((r) => r.status !== "voided" && r.status !== "superseded") ?? ctis.at(-1);
}

/** The F2F that represents a period: the attested row if any, else the oldest row. `f2fs` is oldest-first. */
export function pickFaceToFace<T extends { readonly status: string }>(
  f2fs: readonly T[],
): T | undefined {
  return f2fs.find((r) => r.status === "attested") ?? f2fs[0];
}

/** Does this sequence require a face-to-face (R-F2F-04: the third and every later benefit period)? */
export function f2fRequiredForSequence(sequenceNumber: number): boolean {
  return sequenceNumber >= RECERT_SEQUENCE_FLOOR;
}

// ── the two section predicates ─────────────────────────────────────────────────────────────────────────

const ELIGIBLE_F2F_PERFORMERS: ReadonlySet<string> = new Set(["hospice_md", "hospice_np"]);

function ctiSection(input: AdequacyInput): {
  reasons: AdequacyReasonCode[];
  flags: AdequacyFlagCode[];
} {
  const reasons: AdequacyReasonCode[] = [];
  const flags: AdequacyFlagCode[] = [];
  const { period } = input;
  const cti = pickCertification(input.ctis);
  if (!cti) return { reasons: ["CTI_MISSING"], flags };
  if (cti.electionPeriodId !== period.electionPeriodId) {
    return { reasons: ["CTI_WRONG_PERIOD"], flags };
  }
  if (cti.status === "voided") return { reasons: ["CTI_VOIDED"], flags };
  if (cti.status === "superseded") return { reasons: ["CTI_SUPERSEDED"], flags };

  // Signature + status. Period 1: the hospice-MD signature alone clears the CTI (D3); a period-1 CTI that
  // has the MD signature but is `awaiting_attending` is adequate, with the billing-side co-sign flagged.
  const mdSigned = cti.hospiceMdSignedAt !== null;
  const period1AwaitingAttending =
    period.sequenceNumber === 1 && cti.status === "awaiting_attending" && mdSigned;
  if (!mdSigned) {
    reasons.push(cti.status === "signed" ? "CTI_SIGNATURE_MISSING" : "CTI_NOT_SIGNED");
  } else if (cti.status !== "signed" && !period1AwaitingAttending) {
    reasons.push("CTI_NOT_SIGNED");
  }
  if (
    period1AwaitingAttending ||
    (period.sequenceNumber === 1 && cti.attendingMdId !== null && cti.attendingMdSignedAt === null)
  ) {
    flags.push("CTI_ATTENDING_COSIGN_PENDING");
  }

  // Signer.
  if (input.admissionHospicePhysicianId === null || cti.hospiceMdId === null) {
    reasons.push("CTI_SIGNER_UNRESOLVED");
  } else if (cti.hospiceMdId !== input.admissionHospicePhysicianId) {
    reasons.push("CTI_SIGNER_NOT_ADMISSION_PHYSICIAN");
  }

  // Narrative (§2.3.3 guard: ≥ 200 characters).
  const narrativeLength = cti.narrative === null ? 0 : cti.narrative.trim().length;
  if (narrativeLength === 0) reasons.push("CTI_NARRATIVE_MISSING");
  else if (narrativeLength < TEXT_MINIMUMS.ctiNarrative) reasons.push("CTI_NARRATIVE_TOO_SHORT");

  // Late — a flag, never a block (R-CTI-01 / D4). Only meaningful once a signature instant exists.
  let late = cti.signedLate;
  if (cti.hospiceMdSignedAt !== null) {
    const signedOn = localDateOfInstant(cti.hospiceMdSignedAt, input.timeZone);
    if (signedOn > period.startDate) late = true;
    if (late) {
      const deadline = computeWrittenCertDeadline(period.startDate, input.timeZone);
      if (Date.parse(cti.hospiceMdSignedAt) > Date.parse(deadline)) {
        flags.push("CTI_WRITTEN_CERT_DEADLINE_MISSED");
      }
    }
  }
  if (late) {
    flags.push("CTI_SIGNED_LATE");
    if (cti.lateReason === null || cti.lateReason.trim().length === 0) {
      flags.push("CTI_LATE_REASON_MISSING");
    }
  }
  return { reasons, flags };
}

function f2fSection(input: AdequacyInput): {
  reasons: AdequacyReasonCode[];
  flags: AdequacyFlagCode[];
} {
  const reasons: AdequacyReasonCode[] = [];
  const flags: AdequacyFlagCode[] = [];
  const { period } = input;
  const f2f = pickFaceToFace(input.f2fs);
  if (!f2f) return { reasons: ["F2F_MISSING"], flags };
  if (f2f.electionPeriodId !== period.electionPeriodId) {
    return { reasons: ["F2F_WRONG_PERIOD"], flags };
  }
  if (f2f.status !== "attested") {
    reasons.push("F2F_NOT_ATTESTED");
    return { reasons, flags };
  }
  if (f2f.attestationSignedAt === null) reasons.push("F2F_ATTESTATION_UNSIGNED");
  if (f2f.performerRole === null || !ELIGIBLE_F2F_PERFORMERS.has(f2f.performerRole)) {
    reasons.push("F2F_PERFORMER_INELIGIBLE");
  }

  // Window: a valid override satisfies it (flagged); an override without its facts is its own reason.
  if (f2f.windowOverride) {
    const reasonOk =
      f2f.windowOverrideReason !== null &&
      f2f.windowOverrideReason.trim().length >= TEXT_MINIMUMS.f2fOverrideReason;
    if (reasonOk && f2f.windowOverrideBy !== null) flags.push("F2F_WINDOW_OVERRIDDEN");
    else reasons.push("F2F_OVERRIDE_INVALID");
    return { reasons, flags };
  }
  const basis = input.windowBasis ?? "recorded";
  if (basis === "dates" || basis === "strict") {
    const windowStart =
      period.f2fWindowStart === undefined ? period.startDate : period.f2fWindowStart;
    if (f2f.encounterDate === null) {
      reasons.push("F2F_ENCOUNTER_DATE_MISSING");
    } else if (windowStart === null) {
      reasons.push("F2F_WINDOW_UNVERIFIED");
    } else {
      const window = computeF2fWindow(windowStart, input.timeZone);
      if (!isF2fScheduledWithinWindow(f2f.encounterDate, window)) {
        reasons.push("F2F_OUTSIDE_WINDOW");
      } else if (basis === "strict" && f2f.withinWindow !== true) {
        // Recomputed inside but the persisted verdict is false/NULL: the two disagree -> unverified.
        reasons.push("F2F_WINDOW_UNVERIFIED");
      }
    }
  } else if (f2f.withinWindow === null) {
    reasons.push("F2F_WINDOW_UNVERIFIED");
  } else if (!f2f.withinWindow) {
    reasons.push("F2F_OUTSIDE_WINDOW");
  }
  return { reasons, flags };
}

// ── the predicate ──────────────────────────────────────────────────────────────────────────────────────

/** Is this election period's CTI (and, from period 3 on, F2F) adequate? PURE and deterministic. */
export function evaluatePeriodAdequacy(input: AdequacyInput): AdequacyResult {
  const { period } = input;
  const periodReasons: AdequacyReasonCode[] = [];
  if (!Number.isInteger(period.sequenceNumber) || period.sequenceNumber < 1) {
    periodReasons.push("PERIOD_SEQUENCE_INVALID");
  } else if (
    period.periodKind != null &&
    period.periodKind !== electionPeriodKindForSequence(period.sequenceNumber)
  ) {
    periodReasons.push("PERIOD_KIND_SEQUENCE_MISMATCH");
  }

  const f2fRequired = f2fRequiredForSequence(period.sequenceNumber);
  const cti = ctiSection(input);
  const f2f = f2fRequired
    ? f2fSection(input)
    : { reasons: [] as AdequacyReasonCode[], flags: [] as AdequacyFlagCode[] };

  const reasonCodes = [...periodReasons, ...cti.reasons, ...f2f.reasons];
  const flags = [...cti.flags, ...f2f.flags];
  return {
    verdict: reasonCodes.length === 0 ? "adequate" : "inadequate",
    electionPeriodId: period.electionPeriodId,
    sequenceNumber: period.sequenceNumber,
    f2fRequired,
    reasonCodes,
    flags,
    cti: { adequate: cti.reasons.length === 0, reasonCodes: cti.reasons },
    f2f: { required: f2fRequired, adequate: f2f.reasons.length === 0, reasonCodes: f2f.reasons },
  };
}

/** The no-PHI decision summary published on `m6.election.period_started` (additive `adequacy` field). */
export interface AdequacyDecisionSummary {
  readonly verdict: "adequate" | "inadequate";
  readonly f2fRequired: boolean;
  readonly reasonCodes: readonly AdequacyReasonCode[];
  readonly flags: readonly AdequacyFlagCode[];
}

export function summarizeAdequacy(result: AdequacyResult): AdequacyDecisionSummary {
  return {
    verdict: result.verdict,
    f2fRequired: result.f2fRequired,
    reasonCodes: [...result.reasonCodes],
    flags: [...result.flags],
  };
}
