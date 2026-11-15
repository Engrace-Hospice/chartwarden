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
  id: "required" | "awaiting" | "follow_up";
  label: string;
  description: string;
  requirements: ReadinessRequirement[];
}

const GROUPS: ReadonlyArray<Omit<ReadinessGroup, "requirements">> = [
  {
    id: "required",
    label: "Required before activation",
    description: "Blocking requirements that the admission team can move forward now.",
  },
  {
    id: "awaiting",
    label: "Awaiting another person",
    description: "Blocking signatures or attestations that require the named signer or discipline.",
  },
  {
    id: "follow_up",
    label: "After admission and follow-up",
    description: "Non-blocking work and advisory items that do not prevent activation.",
  },
];

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
    const id: ReadinessGroup["id"] = !requirement.blocking
      ? "follow_up"
      : requirement.status === "awaiting_signature"
        ? "awaiting"
        : "required";
    grouped.set(id, [...(grouped.get(id) ?? []), requirement]);
  }

  return GROUPS.flatMap((group) => {
    const items = grouped.get(group.id);
    return items?.length ? [{ ...group, requirements: items }] : [];
  });
}

export interface ReadinessActionContext {
  permissions: readonly string[];
  hasElectionStatement: boolean;
  hasCti: boolean;
  ctiHospiceMdSigned: boolean;
}

/**
 * Returns the route permission needed for a readiness action's next mutation or governed read.
 * This only improves affordance: backend RBAC/ABAC remains authoritative at submission time.
 */
export function readinessActionPermission(
  action: string,
  context: Omit<ReadinessActionContext, "permissions">,
): string | null {
  switch (action) {
    case "ACKNOWLEDGE_NOR":
    case "COMPLETE_NOTICE_OF_RIGHTS":
      return "nor.acknowledge";
    case "COMPLETE_ADMISSION_DETAILS":
      return "admission.update";
    case "COMPLETE_ELECTION":
    case "COMPLETE_ELECTION_STATEMENT":
      return context.hasElectionStatement ? "election.sign" : "election.draft";
    case "COMPLETE_ELECTION_SIGNATURE":
      return "election.sign";
    case "REVIEW_CTI":
      return !context.hasCti
        ? "cti.draft"
        : !context.ctiHospiceMdSigned
          ? "cti.sign_hospice_md"
          : "cti.read";
    case "COMPLETE_CTI":
      return "cti.draft";
    case "COMPLETE_CTI_SIGNATURE":
      return "cti.sign_hospice_md";
    case "RECORD_ADMISSION_RECOMMENDATION":
      return "admission.record_recommendation";
    case "COMPLETE_ELECTION_ADDENDUM":
      return "election_addendum.read";
    case "REVIEW_F2F":
      return "f2f.read";
    case "RESOLVE_PATIENT":
      return "referral.update";
    case "REVIEW_PRIVACY":
      return null;
    default:
      return null;
  }
}

export function readinessActionIsPermitted(
  action: string,
  context: ReadinessActionContext,
): boolean {
  const permission = readinessActionPermission(action, context);
  return permission === null || context.permissions.includes(permission);
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
