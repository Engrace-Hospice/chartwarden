import type { GlyphName } from "@chartwarden/ui";

export type ReviewSectionId =
  | "identity-demographics"
  | "diagnoses-history"
  | "medications-allergies"
  | "care-needs"
  | "coverage-referral"
  | "documents-safeguards";

export interface ReviewSectionDefinition {
  readonly id: ReviewSectionId;
  readonly title: string;
  readonly description: string;
  readonly glyph: GlyphName;
}

export const REVIEW_SECTIONS: readonly ReviewSectionDefinition[] = [
  {
    id: "identity-demographics",
    title: "Patient identity & demographics",
    description: "Name, date of birth, contact details, and address",
    glyph: "user-circle",
  },
  {
    id: "diagnoses-history",
    title: "Diagnoses & clinical history",
    description: "Primary diagnosis, conditions, hospitalizations, and key history",
    glyph: "clipboard-list",
  },
  {
    id: "medications-allergies",
    title: "Medications & allergies",
    description: "Medication reconciliation and allergy evidence",
    glyph: "pill",
  },
  {
    id: "care-needs",
    title: "Care needs & functional status",
    description: "Symptoms, activities of daily living, equipment, and support needs",
    glyph: "bed",
  },
  {
    id: "coverage-referral",
    title: "Coverage & referral information",
    description: "Insurance, ordering provider, referral source, and reason",
    glyph: "shield-check",
  },
  {
    id: "documents-safeguards",
    title: "Documents & safeguards",
    description: "Source records, patient identity, Part 2, and unmapped observations",
    glyph: "file-check",
  },
] as const;

const PREFIX_SECTIONS: readonly [readonly string[], ReviewSectionId][] = [
  [["patient."], "identity-demographics"],
  [["diagnoses[", "problems[", "conditions[", "history."], "diagnoses-history"],
  [["medications[", "allergies["], "medications-allergies"],
  [["symptoms[", "adl.", "adls.", "functional.", "equipment[", "careNeeds."], "care-needs"],
  [["insurance.", "coverage.", "referral.", "provider.", "physician."], "coverage-referral"],
];

export function sectionForField(fieldPath: string): ReviewSectionId {
  for (const [prefixes, section] of PREFIX_SECTIONS) {
    if (prefixes.some((prefix) => fieldPath.startsWith(prefix))) return section;
  }
  return "documents-safeguards";
}

export function sectionIndex(sectionId: ReviewSectionId): number {
  return REVIEW_SECTIONS.findIndex((section) => section.id === sectionId);
}
