// apps/web/src/modules/06-admission — pure helpers of the readmission workflow (readmission.tsx) and the benefit-period
// field the New admission screen shares (benefit-period-field.tsx). The plan shape is the server's
// (GET /api/v1/admissions/:id/readmission-context, GET /api/v1/patients/:id/benefit-period-plan); everything here only
// decides what to SHOW — the server validates and enforces every rule on submit.
//
// Medicare counts benefit periods per BENEFICIARY across every hospice (Claims Processing Manual ch. 11 §20.1.6), so
// our history's suggestion is only a starting point: the number is confirmed against HETS / ELGA / ELGH. An
// unconfirmed or edited number is a WARNING, never a block.

export type BenefitPeriodSource =
  | "hets_confirmed"
  | "staff_entered_unverified"
  | "internal_history";

export interface BenefitPeriodPlan {
  patientId: string;
  previous: {
    admissionId: string;
    admissionState: string;
    startedOn: string | null;
    endedOn: string | null;
    endKind: "live_discharge" | "revocation" | "transfer_out" | "death" | "unknown";
    dischargeType: string | null;
    transfer: boolean;
    lastSequence: number | null;
    daysSinceDischarge: number | null;
  } | null;
  readmission: { eligible: boolean; blockers: string[] };
  priorElectionClosure: {
    admissionId: string;
    status: "filed" | "not_filed" | "unknown";
    notrFiled: boolean | null;
    finalClaimFiled: boolean | null;
  } | null;
  noeBlocked: boolean;
  suggestion: {
    suggestedSequence: number;
    basis: string;
    fromAdmissionId: string | null;
    lastKnownSequence: number | null;
  };
  requirements: {
    sequence: number;
    periodKind: "ninety_day" | "sixty_day";
    lengthDays: number;
    startDate: string;
    endDate: string;
    certification: { hospicePhysician: true; attendingIfDesignated: boolean };
    faceToFace: {
      required: boolean;
      windowStart: string | null;
      windowEnd: string | null;
      exceptionWindowEnd: string | null;
    };
    electionStatementRequired: true;
    noeDueBy: string;
    initialAssessmentDueBy: string;
    comprehensiveAssessmentDueBy: string;
    hopeAdmissionA0220: string;
  };
  rhc: {
    applies: boolean;
    daysSinceDischarge: number | null;
    priorHospiceDays: number;
    startsAtDay: number;
    highRateDaysRemaining: number;
  };
}

/** The benefit-period entry as the form holds it (strings, as typed). */
export interface BenefitPeriodDraft {
  sequence: string;
  hetsConfirmed: boolean;
  confirmedOn: string;
}

export const MAX_BENEFIT_PERIOD = 200;
export const MIN_F2F_EXCEPTION_REASON = 20;

export function emptyBenefitPeriodDraft(suggested: number | null): BenefitPeriodDraft {
  return { sequence: suggested ? String(suggested) : "", hetsConfirmed: false, confirmedOn: "" };
}

/** Field errors (blocking: a malformed number or a missing / future confirmation date). */
export function validateBenefitPeriod(
  d: BenefitPeriodDraft,
  today: string,
): Partial<Record<"sequence" | "confirmedOn", string>> {
  const e: Partial<Record<"sequence" | "confirmedOn", string>> = {};
  const n = Number(d.sequence);
  if (!d.sequence.trim() || !Number.isInteger(n) || n < 1 || n > MAX_BENEFIT_PERIOD)
    e.sequence = `Enter the benefit period number (1 to ${MAX_BENEFIT_PERIOD}).`;
  if (d.hetsConfirmed) {
    if (!d.confirmedOn) e.confirmedOn = "Enter the date you checked HETS / ELGA / ELGH.";
    else if (d.confirmedOn > today)
      e.confirmedOn = "The confirmation date cannot be in the future.";
  }
  return e;
}

/** The non-blocking warnings the field shows (empty = none). */
export function benefitPeriodWarnings(d: BenefitPeriodDraft, suggested: number | null): string[] {
  const out: string[] = [];
  const n = Number(d.sequence);
  if (!d.hetsConfirmed)
    out.push(
      "Not confirmed against HETS / ELGA / ELGH. Medicare counts benefit periods across every hospice, so our history may not know about a stay elsewhere. A wrong period number gets the NOE or claims rejected.",
    );
  if (suggested !== null && Number.isInteger(n) && n >= 1 && n !== suggested)
    out.push(
      `This differs from the period our history suggests (${suggested}). Keep it if the CMS eligibility record says so.`,
    );
  return out;
}

/** The request body fragment for `benefitPeriod`; `null` when the draft is not valid. */
export function benefitPeriodBody(
  d: BenefitPeriodDraft,
  suggested: number | null,
  today: string,
): { sequence: number; source: BenefitPeriodSource; confirmedOn?: string } | null {
  if (Object.keys(validateBenefitPeriod(d, today)).length > 0) return null;
  const sequence = Number(d.sequence);
  if (d.hetsConfirmed) return { sequence, source: "hets_confirmed", confirmedOn: d.confirmedOn };
  return {
    sequence,
    source:
      suggested !== null && sequence === suggested
        ? "internal_history"
        : "staff_entered_unverified",
  };
}

export function periodLengthLabel(sequence: number): string {
  return sequence <= 2 ? "90-day period" : "60-day period";
}

const BASIS_LABEL: Record<string, string> = {
  no_history: "No earlier stay with us — period 1 unless HETS shows otherwise.",
  next_after_live_discharge: "The live discharge ended the last period; the next one is available.",
  next_after_revocation: "The revocation ended the last period; the next one is available.",
  same_after_transfer:
    "The stay ended in a transfer, which keeps the period running — the other hospice may since have moved on.",
  next_after_unknown_end: "How the last stay ended is not recorded; check HETS.",
};

export function basisLabel(basis: string): string {
  return BASIS_LABEL[basis] ?? "";
}

const BLOCKER_LABEL: Record<string, string> = {
  NOT_ENDED: "This admission has not ended — only a discharged stay can be readmitted.",
  ENDED_BY_DEATH: "This stay ended in death.",
  OPEN_ADMISSION_EXISTS: "The patient already has an open admission.",
  NEWER_ADMISSION_EXISTS:
    "A later admission already follows this stay — readmit from the latest one.",
};

export function blockerLabel(code: string): string {
  return BLOCKER_LABEL[code] ?? code;
}

const END_KIND_LABEL: Record<string, string> = {
  live_discharge: "Live discharge",
  revocation: "Revocation",
  transfer_out: "Transfer to another hospice",
  death: "Death",
  unknown: "Ended",
};

export function endKindLabel(kind: string): string {
  return END_KIND_LABEL[kind] ?? kind;
}

export type ChecklistTone = "info" | "warning" | "success";

export interface ChecklistItem {
  key: string;
  title: string;
  detail: string;
  tone: ChecklistTone;
}

/**
 * The requirements checklist of the chosen period: what this admission owes, in the order staff meet it. The
 * certification line follows the period number (418.22(c)); the F2F line appears from period 3 (418.22(a)(4));
 * the NOE line says when it is held for the prior election's close-out.
 */
export function requirementChecklist(
  plan: BenefitPeriodPlan,
  fmt: (iso: string | null | undefined) => string,
): ChecklistItem[] {
  const r = plan.requirements;
  const items: ChecklistItem[] = [
    {
      key: "election",
      title: "New signed election statement",
      detail:
        "A re-election is a new election (42 CFR 418.24) — the previous statement does not carry over.",
      tone: "info",
    },
    {
      key: "certification",
      title: r.certification.attendingIfDesignated
        ? "Certification: hospice physician and attending"
        : "Certification: hospice medical director / IDG physician",
      detail: r.certification.attendingIfDesignated
        ? "Period 1 — the attending physician (if the patient names one) certifies too."
        : `Period ${r.sequence} — the attending physician does not certify (42 CFR 418.22(c)).`,
      tone: "info",
    },
  ];
  if (r.faceToFace.required)
    items.push({
      key: "f2f",
      title: "Face-to-face encounter required",
      detail: `By a hospice physician or hospice NP between ${fmt(r.faceToFace.windowStart)} and ${fmt(
        r.faceToFace.windowEnd,
      )}. With documented exceptional circumstances it may happen by ${fmt(
        r.faceToFace.exceptionWindowEnd,
      )}; a death before then counts as complete.`,
      tone: "warning",
    });
  items.push({
    key: "noe",
    title: `NOE (8xA) due by ${fmt(r.noeDueBy)}`,
    detail: plan.noeBlocked
      ? "Held: Medicare rejects it until the previous stay's NOTR (8xB) or final claim is filed."
      : "Five calendar days after the admission date (the day after admission is day 1).",
    tone: plan.noeBlocked ? "warning" : "info",
  });
  items.push({
    key: "assessments",
    title: "Initial and comprehensive assessments",
    detail: `Initial within 48 hours (by ${fmt(r.initialAssessmentDueBy)}), comprehensive by ${fmt(
      r.comprehensiveAssessmentDueBy,
    )}.`,
    tone: "info",
  });
  items.push({
    key: "hope",
    title: "New HOPE Admission record",
    detail: `A0220 = ${fmt(r.hopeAdmissionA0220)}; the HOPE update-visit clock restarts.`,
    tone: "info",
  });
  if (plan.rhc.applies)
    items.push({
      key: "rhc",
      title: "Routine home care day count continues",
      detail: `Readmitted within 60 days: ${plan.rhc.priorHospiceDays} earlier hospice days carry over, so this stay starts at day ${plan.rhc.startsAtDay} (${plan.rhc.highRateDaysRemaining} days left at the day 1–60 rate).`,
      tone: "info",
    });
  return items;
}

/** The prior election's close-out line for the previous-episode summary. */
export function closureLabel(closure: BenefitPeriodPlan["priorElectionClosure"]): string {
  if (!closure) return "Nothing to close out";
  if (closure.status === "filed")
    return closure.notrFiled ? "NOTR (8xB) filed" : "Final claim filed";
  if (closure.status === "not_filed") return "No NOTR or final claim filed yet";
  return "Could not be checked";
}
