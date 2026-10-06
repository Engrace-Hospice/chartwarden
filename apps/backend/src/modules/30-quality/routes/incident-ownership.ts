// apps/backend/src/modules/30-quality/routes/incident-ownership.ts — GAP-091.
//
// The own-record arm of the incident PHI scope, shared by the read detail and the lifecycle writes so the two
// layers cannot drift: the reporter, the triager, or the assigned investigator keeps access to the record
// they were given, even when the patient is off their caseload. The assignee is held in the reserved
// `kind_data._m30` sidecar (no dedicated column).
const SIDECAR_KEY = "_m30";

interface OwnableIncident {
  readonly reportedByMembershipId: string | null;
  readonly triagedByMembershipId: string | null;
  readonly kindData: unknown;
}

function assignedInvestigator(kindData: unknown): string | undefined {
  if (!kindData || typeof kindData !== "object") return undefined;
  const sidecar = (kindData as Record<string, unknown>)[SIDECAR_KEY];
  if (!sidecar || typeof sidecar !== "object") return undefined;
  const assigned = (sidecar as Record<string, unknown>).assignedToMembershipId;
  return typeof assigned === "string" && assigned.length > 0 ? assigned : undefined;
}

/** Does `membershipId` own this incident (reporter, triager, or assigned investigator)? */
export function incidentOwnedBy(row: OwnableIncident, membershipId: string | undefined): boolean {
  if (!membershipId) return false;
  return (
    row.reportedByMembershipId === membershipId ||
    row.triagedByMembershipId === membershipId ||
    assignedInvestigator(row.kindData) === membershipId
  );
}
