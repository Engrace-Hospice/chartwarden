// apps/backend/src/modules/15-discipline-care-plans/routes/aide-supervision-roster.ts — the staff picker behind
// the Aide POC supervisory-visit modal (`GET /api/v1/discipline-plans/:planId/aide-supervision-roster`).
//
// The modal used to ask an RN to type two membership uuids. The only staff list the platform has
// (`GET /api/v1/orgs/:id/members`) needs org-admin rights, so an RN could not populate a picker from it; this
// is a plan-scoped, minimum-necessary read instead: membership id, display name and the role that qualified
// the person. Nothing else about them (no email, no licence, no patient data).
//
// WHO QUALIFIES. An aide is a member holding the `chha` role (M3's canonical Home Health Aide key — the same
// key `checkPlanKindAuthoringScope`, M7, M8 and M17 recognise; tenant-created aliases such as `aide` /
// `hospice_aide` are NOT accepted anywhere in M15, so they are not listed here either). A supervisor is a
// member holding `rn` or `rn_case_manager`. The member must be ACTIVE (membership and user), hold the role
// through an enabled, unexpired grant, and have a reach that includes the plan's location — all decided by
// the M3-owned reader behind {@link AideRosterPort}, which the composition root binds (M15 imports no
// authorization code or schema, the `membershipRoleKeysForOrg` / `membershipDisplayForOrg` port shape).
import type { AideSupervisionRosterMemberView, AideSupervisionRosterView } from "./read-service";

/** Role keys that make a member pickable as the supervised aide. */
export const AIDE_ROLE_KEYS: readonly string[] = ["chha"];
/** Role keys that make a member pickable as the supervising RN. */
export const AIDE_SUPERVISOR_ROLE_KEYS: readonly string[] = ["rn", "rn_case_manager"];

/** One (member, qualifying role) pair as the M3 reader reports it. `displayName` null = no name on file. */
export interface AideRosterStaffRow {
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly roleKey: string;
}

/** The org-explicit, location-scoped staff read the composition root binds to M3's reader. */
export interface AideRosterPort {
  listStaffAtLocation(input: {
    readonly organizationId: string;
    readonly locationId: string;
    readonly roleKeys: readonly string[];
  }): Promise<readonly AideRosterStaffRow[]>;
}

/** The unbound default: nobody is offered (fail closed — an unwired port reveals no staff). */
export const emptyAideRosterPort: AideRosterPort = {
  async listStaffAtLocation() {
    return [];
  },
};

/** A member with no name on file still has to be pickable, and must not be labelled with an email. */
const fallbackName = (membershipId: string): string => `Member ${membershipId.slice(0, 8)}`;

function toMember(row: AideRosterStaffRow): AideSupervisionRosterMemberView {
  const name = row.displayName?.trim() ?? "";
  return {
    membershipId: row.membershipId,
    displayName: name.length > 0 ? name : fallbackName(row.membershipId),
    roleKey: row.roleKey,
  };
}

/** One entry per member (the first role seen wins), ordered by name then id so the picker is stable. */
function distinctMembers(rows: readonly AideRosterStaffRow[]): AideSupervisionRosterMemberView[] {
  const byMembership = new Map<string, AideSupervisionRosterMemberView>();
  for (const row of rows) {
    if (!byMembership.has(row.membershipId)) byMembership.set(row.membershipId, toMember(row));
  }
  return [...byMembership.values()].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName, "en") ||
      a.membershipId.localeCompare(b.membershipId),
  );
}

/** Split the reader's rows into the two pickers. Pure; the response carries exactly these three keys per member. */
export function assembleAideSupervisionRoster(
  rows: readonly AideRosterStaffRow[],
): AideSupervisionRosterView {
  return {
    aides: distinctMembers(rows.filter((r) => AIDE_ROLE_KEYS.includes(r.roleKey))),
    supervisors: distinctMembers(rows.filter((r) => AIDE_SUPERVISOR_ROLE_KEYS.includes(r.roleKey))),
  };
}
