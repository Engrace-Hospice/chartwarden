// apps/backend/src/modules/33-reporting/routes/schedule-authz.ts — M33 scheduled-report authorization
// (GAP-097). The single home for the owner / recipient / admin / view-visibility decisions, shared by the
// `report_schedule_access` ABAC predicate (route layer), both write-service backends (service layer) and
// the scheduled-run worker's per-recipient re-check, so the three can never drift.
//
// Every fact compared here is SERVER-DERIVED: the actor's membership id + roles come from the M2 session
// (`request.context`), the schedule/view facts from the stored row — never from the body, query or path.
//
// Model (spec §4.1 route table + §8 matrix):
//   - create: the actor must be able to SEE the view (`dashboard_visibility` ladder) — a private view of
//     another user cannot be scheduled; the owner stamped on the row is the session membership.
//   - read: the schedule's owner, a listed recipient ("Schedules Affecting Me"), or an org admin.
//   - mutate (edit/pause/resume/cancel): the owner or an org admin ONLY (a recipient may read, not mutate).
//   - delete_all_runs: org admin only (`org_admin_scope`).
// A caller outside those sets gets a non-leaking 404 (existence is not disclosed).

/** The only org-wide role that bypasses the schedule owner check (the audit row: "owner or org_admin"). */
export const SCHEDULE_ADMIN_ROLE = "org_admin";

/** The minimal session-derived facts every decision needs. */
export interface ScheduleActorFacts {
  readonly membershipId: string | null | undefined;
  readonly roles: readonly string[];
}

/** The stored schedule facts a decision compares against. */
export interface ScheduleOwnerFacts {
  readonly ownerMembershipId: string;
  readonly recipientMembershipIds: readonly string[];
}

/** The stored view facts the visibility ladder compares against (§4.7.2). */
export interface ViewVisibilityFacts {
  readonly ownerMembershipId: string;
  readonly shareScope: "private" | "role" | "org";
  readonly shareRoleKeys: readonly string[] | null;
}

export const isScheduleAdmin = (roles: readonly string[]): boolean =>
  roles.includes(SCHEDULE_ADMIN_ROLE);

const isOwner = (actor: ScheduleActorFacts, schedule: ScheduleOwnerFacts): boolean =>
  typeof actor.membershipId === "string" &&
  actor.membershipId.length > 0 &&
  schedule.ownerMembershipId === actor.membershipId;

/** Edit / pause / resume / cancel: the owner or an org admin. */
export const canMutateSchedule = (
  actor: ScheduleActorFacts,
  schedule: ScheduleOwnerFacts,
): boolean => isScheduleAdmin(actor.roles) || isOwner(actor, schedule);

/** Read / list runs: the owner, a recipient, or an org admin. */
export const canReadSchedule = (actor: ScheduleActorFacts, schedule: ScheduleOwnerFacts): boolean =>
  canMutateSchedule(actor, schedule) ||
  (typeof actor.membershipId === "string" &&
    schedule.recipientMembershipIds.includes(actor.membershipId));

/** §4.7.2 ladder (verbatim): owner OR org-shared OR role-shared (actor holds a shared role); else deny. */
export const viewVisibleTo = (view: ViewVisibilityFacts, actor: ScheduleActorFacts): boolean => {
  if (typeof actor.membershipId === "string" && view.ownerMembershipId === actor.membershipId) {
    return true;
  }
  if (view.shareScope === "org") return true;
  if (view.shareScope === "role") {
    return (view.shareRoleKeys ?? []).some((role) => actor.roles.includes(role));
  }
  return false;
};

/** The §4.7.1 scope a scheduled snapshot is rendered under: `org` only when the view owner is an org admin. */
export type SnapshotScopeKind = "org" | "self";

export const snapshotScopeKind = (ownerIsOrgAdmin: boolean): SnapshotScopeKind =>
  ownerIsOrgAdmin ? "org" : "self";

export interface SnapshotRecipientFacts {
  readonly scopeKind: SnapshotScopeKind;
  readonly ownerMembershipId: string;
  readonly recipientMembershipId: string;
  readonly recipientIsAdmin: boolean;
}

/**
 * May this recipient RECEIVE a snapshot rendered under `scopeKind`? Delivery carries the rows themselves,
 * so the recipient must be at least as entitled as the scope the rows were drawn under:
 *   - `org`  snapshot: org admins only;
 *   - `self` snapshot: the owner whose rows these are, or an org admin.
 * Pure and fail-closed by construction (anything not positively allowed is denied).
 */
export const snapshotRecipientAllowed = (facts: SnapshotRecipientFacts): boolean =>
  facts.recipientIsAdmin ||
  (facts.scopeKind === "self" && facts.recipientMembershipId === facts.ownerMembershipId);
