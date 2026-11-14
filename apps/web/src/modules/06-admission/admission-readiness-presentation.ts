export type ReadinessStatus =
  | "complete"
  | "action_required"
  | "awaiting_signature"
  | "pending"
  | "blocked"
  | "overdue"
  | "not_applicable";

export interface ReadinessRequirement {
  code: string;
  label: string;
  status: ReadinessStatus;
  blocking: boolean;
  message?: string;
  action?: string;
  satisfiedBy?: "normal" | "override";
  reasonCode?: string;
  evidence?: {
    sourceType: "structured" | "uploaded";
    documentId?: string;
    documentVersionId?: string;
    completedAt?: string;
  };
}

export interface ReadinessGroup {
  id: "setup" | "notices" | "clinical" | "other";
  label: string;
  description: string;
  requirements: ReadinessRequirement[];
}

const GROUPS: ReadonlyArray<Omit<ReadinessGroup, "requirements">> = [
  {
    id: "setup",
    label: "Admission setup and privacy",
    description: "Patient identity, service details, and privacy clearance.",
  },
  {
    id: "notices",
    label: "Notices, election, and certification",
    description: "Required notices and documents for the hospice election.",
  },
  {
    id: "clinical",
    label: "Timing and clinical follow-up",
    description: "Clinical review and time-sensitive follow-up owned by the care team.",
  },
  {
    id: "other",
    label: "Other readiness items",
    description: "Additional requirements supplied by the readiness service.",
  },
];

const GROUP_BY_CODE: Record<string, ReadinessGroup["id"]> = {
  patient_identity: "setup",
  admission_details: "setup",
  patient_privacy: "setup",
  notice_of_rights: "notices",
  election_statement: "notices",
  cti: "notices",
  election_addendum: "notices",
  f2f: "clinical",
  admission_recommendation: "clinical",
};

const OWNER_BY_CODE: Record<string, string> = {
  patient_identity: "Intake coordinator",
  admission_details: "Intake coordinator",
  patient_privacy: "Privacy or intake team",
  notice_of_rights: "Intake coordinator",
  election_statement: "Intake coordinator",
  cti: "Hospice physician",
  election_addendum: "Intake coordinator",
  f2f: "Hospice physician or nurse practitioner",
  admission_recommendation: "Clinical reviewer",
};

export function groupReadinessRequirements(requirements: ReadinessRequirement[]): ReadinessGroup[] {
  const grouped = new Map<ReadinessGroup["id"], ReadinessRequirement[]>();
  for (const requirement of requirements) {
    const id = GROUP_BY_CODE[requirement.code] ?? "other";
    grouped.set(id, [...(grouped.get(id) ?? []), requirement]);
  }

  return GROUPS.flatMap((group) => {
    const items = grouped.get(group.id);
    return items?.length ? [{ ...group, requirements: items }] : [];
  });
}

export function readinessOwner(requirement: ReadinessRequirement): string {
  return OWNER_BY_CODE[requirement.code] ?? "Admission team";
}

export function readinessReason(requirement: ReadinessRequirement): string {
  if (requirement.message) return requirement.message;
  if (requirement.status === "complete") return "Requirement complete.";
  if (requirement.status === "not_applicable") return "Not required for this admission.";
  return "Review this requirement before admission activation.";
}

export function readinessRequirementIsSatisfied(requirement: ReadinessRequirement): boolean {
  return requirement.status === "complete" || requirement.status === "not_applicable";
}
