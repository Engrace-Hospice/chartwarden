/** Canonical display names for clinical/system role keys used outside ROLE_TEMPLATES. */
export const SYSTEM_ROLE_DISPLAY_NAMES = {
  rn: "Registered Nurse (RN)",
  rn_case_manager: "RN Case Manager",
  lpn: "Licensed Practical Nurse (LPN)",
  lvn: "Licensed Vocational Nurse (LVN)",
  md: "Physician (MD/DO)",
  hospice_physician: "Hospice Physician",
  medical_director: "Hospice Medical Director",
  np: "Nurse Practitioner",
  msw: "Medical Social Worker",
  chaplain: "Chaplain",
  volunteer: "Volunteer",
  volunteer_coordinator: "Volunteer Coordinator",
  clinical_supervisor: "Clinical Supervisor",
  compliance_officer: "Compliance Officer",
  chha: "Home Health Aide",
  hipaa_privacy_officer: "HIPAA Privacy Officer",
} as const;

export type SystemRoleDisplayNameKey = keyof typeof SYSTEM_ROLE_DISPLAY_NAMES;

/**
 * Resolves a known system role key without inventing a fallback label. Seeds must fail loudly when
 * a new technical role has not been assigned a reviewed display name.
 */
export function systemRoleDisplayName(key: string): string {
  if (!Object.hasOwn(SYSTEM_ROLE_DISPLAY_NAMES, key)) {
    throw new Error(`No canonical display name is registered for system role '${key}'`);
  }
  return SYSTEM_ROLE_DISPLAY_NAMES[key as SystemRoleDisplayNameKey];
}
