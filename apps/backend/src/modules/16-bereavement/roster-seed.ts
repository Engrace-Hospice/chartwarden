// apps/backend/src/modules/16-bereavement/roster-seed.ts — GAP-129: seeding a bereavement plan's contacts from M5's
// caregiver roster (spec §4.2 `seedFromCaregivers`). Pure — the roster is read through the `PatientCaregiverRosterReader`
// seam by the write service; this decides which caregivers become `proposed` contacts and how M5's relationship maps
// onto M16's value set. A seeded contact is only ever `proposed`: the D6 consent gate (route 13) still decides whether
// anyone may be contacted.
import type { PatientCaregiverRosterEntry } from "@wardenx/types";

/** M5 `patient_caregiver.relationship` → M16 `bereaved_contact_relationship` (the M38 relationship-to-decedent set). */
const RELATIONSHIP_FROM_M5: Readonly<Record<string, string>> = {
  spouse: "spouse",
  child: "child",
  parent: "parent",
  sibling: "sibling",
  other_family: "other",
  friend: "friend",
  guardian: "other",
  paid_caregiver: "caregiver_non_family",
};

/** The M16 relationship for an M5 one; an unknown value is `other` (never dropped, never invented). */
export function bereavedRelationshipFromCaregiver(m5Relationship: string): string {
  return RELATIONSHIP_FROM_M5[m5Relationship] ?? "other";
}

/** One caregiver to seed as a contact. */
export interface CaregiverContactSeed {
  readonly caregiverId: string;
  readonly patientCaregiverId: string;
  readonly displayName: string;
  readonly relationshipCode: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly preferredLanguageIso639: string;
}

/**
 * The caregivers still to seed: every roster entry whose `patient_caregiver` link is not already a contact of the plan
 * (so re-running the seed, or a counselor having added the same person, never duplicates a survivor).
 */
export function planCaregiverSeeds(
  roster: readonly PatientCaregiverRosterEntry[],
  alreadySeededPatientCaregiverIds: ReadonlySet<string>,
): readonly CaregiverContactSeed[] {
  return roster
    .filter((entry) => !alreadySeededPatientCaregiverIds.has(entry.patientCaregiverId))
    .map((entry) => ({
      caregiverId: entry.caregiverId,
      patientCaregiverId: entry.patientCaregiverId,
      displayName: entry.displayName,
      relationshipCode: bereavedRelationshipFromCaregiver(entry.relationship),
      email: entry.email,
      phone: entry.phone,
      preferredLanguageIso639: entry.preferredLanguageCode ?? "en",
    }));
}
