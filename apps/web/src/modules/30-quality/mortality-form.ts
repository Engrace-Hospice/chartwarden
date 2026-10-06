// apps/web/src/modules/30-quality — M30 mortality-review form structure (§2.2 / D9 / S-14).
//
// The three review dimensions mirror `@wardenx/quality`'s `mortality_review/dimensions.ts` (the server
// completeness predicate reads the same REQUIRED keys). Kept as plain data so the drawer renders from it and
// the "can complete" check is testable without a DOM.
export type DimensionKey = "clinical" | "satisfaction" | "compliance";
export type DimensionValues = Readonly<Record<string, unknown>>;

export type FieldDef =
  | {
      readonly kind: "select";
      readonly key: string;
      readonly label: string;
      readonly options: readonly string[];
      readonly required: boolean;
    }
  | {
      readonly kind: "check";
      readonly key: string;
      readonly label: string;
      readonly required: boolean;
    }
  | {
      readonly kind: "text";
      readonly key: string;
      readonly label: string;
      readonly required: false;
    };

const ADEQUACY = ["inadequate", "partial", "adequate", "exemplary"] as const;
const CHECK = ["met", "not_met", "not_applicable"] as const;

export const DIMENSION_TITLES: Record<DimensionKey, string> = {
  clinical: "Clinical",
  satisfaction: "Satisfaction",
  compliance: "Compliance",
};

export const DIMENSION_ORDER: readonly DimensionKey[] = ["clinical", "satisfaction", "compliance"];

export const DIMENSION_FIELDS: Record<DimensionKey, readonly FieldDef[]> = {
  clinical: [
    {
      kind: "select",
      key: "symptomManagementAdequacy",
      label: "Symptom management",
      options: ADEQUACY,
      required: true,
    },
    {
      kind: "select",
      key: "painControlAdequacy",
      label: "Pain control",
      options: ADEQUACY,
      required: true,
    },
    {
      kind: "select",
      key: "endOfLifeCarePlanExecution",
      label: "End-of-life care plan execution",
      options: ADEQUACY,
      required: true,
    },
    {
      kind: "check",
      key: "last7DayVisitCadenceMet",
      label: "Last-7-day visit cadence met",
      required: false,
    },
    { kind: "check", key: "comfortPackReady", label: "Comfort pack ready", required: false },
    { kind: "text", key: "freeTextNotes", label: "Clinical notes", required: false },
  ],
  satisfaction: [
    {
      kind: "check",
      key: "caregiverConcernsFlagged",
      label: "Caregiver concerns flagged",
      required: true,
    },
    {
      kind: "check",
      key: "followUpPlanRecorded",
      label: "Follow-up plan recorded",
      required: true,
    },
    { kind: "check", key: "cahpsResultLinked", label: "CAHPS result linked", required: false },
    {
      kind: "text",
      key: "caregiverQualitativeSummary",
      label: "Caregiver experience summary",
      required: false,
    },
  ],
  compliance: [
    {
      kind: "select",
      key: "faceToFaceWindowCompliance",
      label: "Face-to-face window",
      options: CHECK,
      required: true,
    },
    {
      kind: "select",
      key: "ctiTimeliness",
      label: "CTI timeliness",
      options: CHECK,
      required: true,
    },
    {
      kind: "select",
      key: "hopeSubmissionStatus",
      label: "HOPE submission",
      options: CHECK,
      required: true,
    },
    {
      kind: "select",
      key: "emarCompletenessFinal7Days",
      label: "eMAR completeness (final 7 days)",
      options: CHECK,
      required: true,
    },
    {
      kind: "select",
      key: "idgDecisionsCaptured",
      label: "IDG decisions captured",
      options: CHECK,
      required: true,
    },
    { kind: "text", key: "notes", label: "Compliance notes", required: false },
  ],
};

/** True iff every required field of the dimension is answered (booleans always count — false is an answer). */
export function isDimensionComplete(key: DimensionKey, values: DimensionValues): boolean {
  return DIMENSION_FIELDS[key].every((f) => {
    if (!f.required) return true;
    const v = values[f.key];
    if (f.kind === "check") return typeof v === "boolean";
    return typeof v === "string" && v.trim().length > 0;
  });
}

export function areAllDimensionsComplete(all: Record<DimensionKey, DimensionValues>): boolean {
  return DIMENSION_ORDER.every((k) => isDimensionComplete(k, all[k]));
}
