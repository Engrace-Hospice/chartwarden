// @chartwarden/portal — one place that decides whose record the signed-in person is looking at. The backend's
// value for a patient's own account is `patient_self` (M31 invitation kinds); every other kind is a delegate's.
import { humanize } from "./screens/portal-format";

const OWN_RECORD = "patient_self";

const RELATIONSHIP_LABELS: Readonly<Record<string, string>> = {
  patient_self: "Patient",
  family_caregiver: "Family caregiver",
  dpoa_healthcare_agent: "Healthcare agent",
  personal_representative_post_death: "Personal representative",
};

/** True when the signed-in person is the patient themselves, not a caregiver or loved one. */
export const isOwnRecord = (relationship: string | null | undefined): boolean =>
  relationship === OWN_RECORD;

/** Lay-language role, e.g. "Family caregiver". Unknown kinds are humanized, never shown raw. */
export const relationshipLabel = (relationship: string): string =>
  RELATIONSHIP_LABELS[relationship] ?? humanize(relationship);

const NOON_HOUR = 12;
const EVENING_HOUR = 18;

/** "Good morning" / "Good afternoon" / "Good evening" for the viewer's local time. */
export function greetingFor(now: Date = new Date()): string {
  const hour = now.getHours();
  if (hour < NOON_HOUR) return "Good morning";
  return hour < EVENING_HOUR ? "Good afternoon" : "Good evening";
}

/** The care-summary placeholder the API sends when the patient has no display name (M31 read.routes). */
export const GENERIC_PATIENT_LABEL = "Your family member";

/** The patient's real display name, or null for the API's generic placeholder / a missing name. */
export function patientNameOf(
  patient: { preferredName?: string; layLabel?: string } | null | undefined,
): string | null {
  const name = patient?.preferredName?.trim() || patient?.layLabel?.trim();
  return name && name !== GENERIC_PATIENT_LABEL ? name : null;
}

/** First word of a display name, or null when there is no usable name. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}
