// apps/web/src/modules/06-admission — the level-of-care change form's pure model (GAP-122; M6 spec D12, screen 13).
// Mirrors the server's guards so the form fails early, but never replaces them: R-LCP-01 (GIP reason >= 30
// characters), D12 (the three GIP attestations, 412 GIP_DOCUMENTATION_INCOMPLETE) and the IRC/GIP facility rule
// are all enforced again by POST /admissions/:id/level-of-care.

export const LEVELS = [
  { value: "routine_home_care", label: "Routine home care (RHC)" },
  { value: "continuous_home_care", label: "Continuous home care (CHC)" },
  { value: "inpatient_respite_care", label: "Inpatient respite care (IRC)" },
  { value: "general_inpatient_care", label: "General inpatient care (GIP)" },
] as const;

export type LevelValue = (typeof LEVELS)[number]["value"];

/** The three D12 attestations, in the wording the spec gives. */
export const GIP_ATTESTATIONS = [
  { key: "symptomsNotManageableElsewhere", label: "Symptoms are not manageable in other settings" },
  { key: "intensityWarrantsGip", label: "Pain/symptom intensity warrants general inpatient care" },
  { key: "inpatientSettingIdentified", label: "An inpatient setting has been identified" },
] as const;

export type GipAttestationKey = (typeof GIP_ATTESTATIONS)[number]["key"];

export const MIN_REASON = 10;
/** R-LCP-01 — the GIP documentation floor. */
export const MIN_GIP_REASON = 30;

export interface LocDraft {
  newLevel: LevelValue;
  effectiveStart: string;
  reason: string;
  facilityId: string;
  facilityLabel: string;
  attestations: Record<GipAttestationKey, boolean>;
}

export type LocField = "newLevel" | "effectiveStart" | "reason" | "facilityId" | "attestations";
export type LocErrors = Partial<Record<LocField, string>>;

export const emptyAttestations = (): Record<GipAttestationKey, boolean> => ({
  symptomsNotManageableElsewhere: false,
  intensityWarrantsGip: false,
  inpatientSettingIdentified: false,
});

export const emptyDraft = (today: string): LocDraft => ({
  newLevel: "routine_home_care",
  effectiveStart: today,
  reason: "",
  facilityId: "",
  facilityLabel: "",
  attestations: emptyAttestations(),
});

export const needsFacility = (level: LevelValue): boolean =>
  level === "inpatient_respite_care" || level === "general_inpatient_care";

export function validateLocDraft(d: LocDraft): LocErrors {
  const e: LocErrors = {};
  if (!d.effectiveStart) e.effectiveStart = "Enter the date the change takes effect.";
  const floor = d.newLevel === "general_inpatient_care" ? MIN_GIP_REASON : MIN_REASON;
  if (d.reason.trim().length < floor) e.reason = `Enter at least ${floor} characters.`;
  if (needsFacility(d.newLevel) && !d.facilityId)
    e.facilityId = "Select the inpatient facility for this level of care.";
  if (d.newLevel === "general_inpatient_care") {
    const missing = GIP_ATTESTATIONS.filter((a) => !d.attestations[a.key]);
    if (missing.length > 0) e.attestations = "Confirm all three statements to request GIP.";
  }
  return e;
}

/** The request body — attestations are sent only for GIP (the server ignores them otherwise). */
export function locRequestBody(d: LocDraft): Record<string, unknown> {
  return {
    newLevel: d.newLevel,
    effectiveStart: d.effectiveStart,
    reason: d.reason.trim(),
    ...(needsFacility(d.newLevel) && d.facilityId ? { facilityId: d.facilityId } : {}),
    ...(d.newLevel === "general_inpatient_care" ? { gipAttestations: { ...d.attestations } } : {}),
  };
}

/** Admission states a level-of-care change can start from (§2.3.5: active or on hold). */
export const LOC_CHANGEABLE_STATES = new Set(["active", "on_hold"]);
