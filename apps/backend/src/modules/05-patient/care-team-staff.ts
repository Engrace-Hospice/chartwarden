// apps/backend/src/modules/05-patient/care-team-staff.ts — port of the narrow staff lookup behind the
// care-team assign dialog (GET /api/v1/orgs/:id/care-team-staff). The view is an ALLOWLIST: id, display
// name and role labels only — never email, username, phone or credentials (that is `/orgs/:id/members`,
// which stays `member.manage`-gated).
export interface CareTeamStaffView {
  readonly userId: string;
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly roleLabels: readonly string[];
}

export interface CareTeamStaffQuery {
  readonly q?: string;
  readonly limit: number;
}

export interface CareTeamStaffPort {
  /** Active members of the org, name-ordered, optionally narrowed by a display-name substring. */
  search(organizationId: string, query: CareTeamStaffQuery): Promise<readonly CareTeamStaffView[]>;
}
