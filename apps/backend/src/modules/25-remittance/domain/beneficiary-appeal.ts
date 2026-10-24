// M25 milestone 13a - the BENEFICIARY APPEAL record (hospice ADR/TPE/QIC PRD, milestone 13). PURE.
//
// An appeal the BENEFICIARY (or their representative) filed and the hospice learned of or supports. ChartWarden records it:
// it computes NO deadline for it (a due date is a recorded_deadline typed from a notice), files nothing, never auto-spawns a
// next tier, and never changes the hospice's own appeal_case or denial_case. The tier is a label as the notice names it; the
// outcome is a label that is never acted on. A representative filer may have no appointment on file: that is flagged on the
// timeline ("none_on_file"), not blocked.
import {
  type AppointmentStatus,
  appointmentStatus,
  dayRefusal,
  freeTextRefusal,
} from "./representative";
import type { AppealTier } from "./types";

export const BENEFICIARY_FILER_KINDS = ["beneficiary", "representative"] as const;
export type BeneficiaryFilerKind = (typeof BENEFICIARY_FILER_KINDS)[number];

const MEDICARE_TIERS: readonly AppealTier[] = [
  "redetermination",
  "reconsideration",
  "alj",
  "council",
  "federal_court",
];
export const BENEFICIARY_TIER_LABELS = [...MEDICARE_TIERS, "other"] as const;

export const BENEFICIARY_APPEAL_STATES = [
  "recorded",
  "supporting",
  "decided",
  "closed",
  "withdrawn",
] as const;
export type BeneficiaryAppealState = (typeof BENEFICIARY_APPEAL_STATES)[number];

export const BENEFICIARY_OUTCOME_LABELS = [
  "favorable",
  "partial",
  "unfavorable",
  "dismissed",
  "other",
] as const;

/** Validation bounds (not rule values). */
export const BENEFICIARY_APPEAL_BOUNDS = { referenceMax: 200, noteMax: 1000 } as const;
/** Documents on one beneficiary appeal; a cap so a record cannot grow without bound (not a filing rule). */
export const MAX_BENEFICIARY_APPEAL_DOCUMENTS = 50;

const TRANSITIONS: Readonly<Record<BeneficiaryAppealState, readonly BeneficiaryAppealState[]>> = {
  recorded: ["supporting", "decided", "closed", "withdrawn"],
  supporting: ["decided", "closed", "withdrawn"],
  decided: ["closed"],
  closed: [],
  withdrawn: [],
};

export const canTransitionBeneficiaryAppeal = (
  from: BeneficiaryAppealState,
  to: BeneficiaryAppealState,
): boolean => TRANSITIONS[from]?.includes(to) ?? false;

export const isBeneficiaryAppealTerminal = (state: string): boolean =>
  state === "closed" || state === "withdrawn";

const blank = (v: string | null | undefined): boolean =>
  v === null || v === undefined || v.trim() === "";
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (set as readonly string[]).includes(v);

export type BeneficiaryIntakeRefusal =
  | "FILER_INVALID"
  | "TIER_INVALID"
  | "SOURCE_NOTE_REQUIRED"
  | "DATE_INVALID"
  | "DATE_IN_FUTURE"
  | "APPOINTMENT_NEEDS_REPRESENTATIVE_FILER"
  | "TEXT_TOO_LONG"
  | "MBI_IN_FREE_TEXT";

export function checkBeneficiaryIntake(
  input: {
    readonly filerKind: string;
    readonly tierLabel: string;
    readonly filedOn: string | null;
    readonly externalReference: string | null;
    readonly sourceNote: string;
    readonly hasAppointment: boolean;
  },
  today: string,
): BeneficiaryIntakeRefusal | null {
  if (!oneOf(BENEFICIARY_FILER_KINDS, input.filerKind)) return "FILER_INVALID";
  if (!oneOf(BENEFICIARY_TIER_LABELS, input.tierLabel)) return "TIER_INVALID";
  if (blank(input.sourceNote)) return "SOURCE_NOTE_REQUIRED";
  const day = dayRefusal(input.filedOn, today);
  if (day) return day;
  if (input.hasAppointment && input.filerKind !== "representative") {
    return "APPOINTMENT_NEEDS_REPRESENTATIVE_FILER";
  }
  return freeTextRefusal(
    [input.externalReference, input.sourceNote],
    BENEFICIARY_APPEAL_BOUNDS.noteMax,
  );
}

export type BeneficiaryOutcomeRefusal =
  | "OUTCOME_REQUIRED"
  | "OUTCOME_INVALID"
  | "OUTCOME_NOTE_REQUIRED"
  | "TEXT_TOO_LONG"
  | "MBI_IN_FREE_TEXT";

export function checkBeneficiaryOutcome(input: {
  readonly outcomeLabel?: string | undefined;
  readonly outcomeNote?: string | null | undefined;
}): BeneficiaryOutcomeRefusal | null {
  if (input.outcomeLabel === undefined) return "OUTCOME_REQUIRED";
  if (!oneOf(BENEFICIARY_OUTCOME_LABELS, input.outcomeLabel)) return "OUTCOME_INVALID";
  if (input.outcomeLabel === "other" && blank(input.outcomeNote)) return "OUTCOME_NOTE_REQUIRED";
  return freeTextRefusal([input.outcomeNote], BENEFICIARY_APPEAL_BOUNDS.noteMax);
}

export type RepresentativeFlag = "none_on_file" | AppointmentStatus;

/**
 * The representative-status badge of a beneficiary appeal on the timeline: nothing for a beneficiary filer, "none_on_file"
 * for a representative filer with no linked appointment, otherwise the linked appointment's status derived from typed dates.
 */
export function representativeFlag(
  input: {
    readonly filerKind: string;
    readonly appointment: { readonly state: string; readonly validThroughOn: string | null } | null;
  },
  today: string,
): RepresentativeFlag | null {
  if (input.filerKind !== "representative") return null;
  if (input.appointment === null) return "none_on_file";
  return appointmentStatus(input.appointment, today);
}
