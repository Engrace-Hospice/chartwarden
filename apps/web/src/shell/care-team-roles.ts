// Assignment roles that are an access grant, not a care-team seat (e.g. whoever created the patient from
// a referral). Care-team and IDG rosters must never list them as team members.
export const NON_CARE_TEAM_ROLES: ReadonlySet<string> = new Set(["admitting_staff"]);

export const isCareTeamRole = (role: string): boolean => !NON_CARE_TEAM_ROLES.has(role);
