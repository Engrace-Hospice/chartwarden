// apps/backend/src/modules/37-ipu/routes/staff-membership.ts — M37 §4.7 `m37.ipu.staff_member` (GAP-169).
//
// THE RULE. An actor may touch a unit's restraint events (apply / reassess / release) and its bed grid when
// ANY of these holds, evaluated server-side from DB facts + the server-assembled roles (never the request body):
//   1. org-wide role     — the actor carries an org-wide IPU authority role (medical director, director of
//                          nursing, administrator, org admin). Spec: "unit/medical director with org-wide access".
//   2. on shift          — a live (tentative|confirmed, i.e. not cancelled) staff assignment on a shift of this
//                          unit that covers now, widened by a handover grace so the outgoing nurse can still
//                          document and the incoming one can act before the shift formally starts.
//   3. unit roster       — any live assignment on a shift of this unit within the roster window (30 days back /
//                          30 days forward). This is "active staff of the unit": a clinician who works this unit
//                          is not locked out because today's shift was not built yet, or because they were
//                          floated off the exact hour the shift record ends.
//   4. roster not built  — the unit has NO live assignments at all in that window. An unpopulated roster must
//                          not turn every clinician away from a restraint chart (a patient-safety failure worse
//                          than the one this predicate prevents); in that case the RBAC permission
//                          (`m37.restraint.*` / `m37.bed.read`) remains the only gate, and the decision basis is
//                          reported as `roster_unbuilt` so it is visible. The moment ANY assignment exists the
//                          predicate is strict again.
// Anyone else — notably an off-unit clinician such as a home-care RN — is denied (spec §E threat row: 403).
//
// Fail-closed on the facts it controls: a missing membership id can never match a roster row, so a read actor
// without one is allowed only by rule 1 or 4.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, gte, inArray, lte } from "drizzle-orm";

/** Org-wide IPU authority roles (the role templates that carry director-level reach; rule 1). */
export const IPU_ORG_WIDE_ROLE_KEYS = [
  "medical_director",
  "director_of_nursing",
  "administrator",
  "org_admin",
] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Rule 2: how far outside the shift bounds an assignment still counts as "on shift". */
export const STAFF_HANDOVER_GRACE_MS = 12 * HOUR_MS;
/** Rule 3/4: the roster window, each side of now. */
export const STAFF_ROSTER_WINDOW_MS = 30 * DAY_MS;

/** Assignment states that are live (a `cancelled` assignment is not staff). */
const LIVE_ASSIGNMENT_STATES = ["tentative", "confirmed"] as const;

export type StaffBasis = "org_wide_role" | "on_shift" | "unit_roster" | "roster_unbuilt" | "denied";

export interface StaffDecision {
  readonly allowed: boolean;
  readonly basis: StaffBasis;
}

/** One live roster entry of the unit inside the roster window. */
export interface RosterEntry {
  readonly membershipId: string;
  readonly shiftStartAt: Date;
  readonly shiftEndAt: Date;
}

export const hasIpuOrgWideRole = (roles: readonly string[]): boolean =>
  IPU_ORG_WIDE_ROLE_KEYS.some((role) => roles.includes(role));

/** Pure decision over the unit's live roster. `roster` is every live entry in the window (any member). */
export function decideIpuStaffMembership(input: {
  readonly roles: readonly string[];
  readonly membershipId: string | null;
  readonly roster: readonly RosterEntry[];
  readonly now: Date;
}): StaffDecision {
  if (hasIpuOrgWideRole(input.roles)) return { allowed: true, basis: "org_wide_role" };
  if (input.roster.length === 0) return { allowed: true, basis: "roster_unbuilt" };
  const mine =
    input.membershipId === null
      ? []
      : input.roster.filter((e) => e.membershipId === input.membershipId);
  const nowMs = input.now.getTime();
  const onShift = mine.some(
    (e) =>
      e.shiftStartAt.getTime() - STAFF_HANDOVER_GRACE_MS <= nowMs &&
      nowMs <= e.shiftEndAt.getTime() + STAFF_HANDOVER_GRACE_MS,
  );
  if (onShift) return { allowed: true, basis: "on_shift" };
  if (mine.length > 0) return { allowed: true, basis: "unit_roster" };
  return { allowed: false, basis: "denied" };
}

/** Load the unit's live roster inside the window (one query; RLS-scoped by the caller's tx). */
export async function loadUnitRoster(
  t: DbClient,
  unitId: string,
  now: Date,
): Promise<readonly RosterEntry[]> {
  const S = schema.ipuShift;
  const SA = schema.ipuStaffAssignment;
  const from = new Date(now.getTime() - STAFF_ROSTER_WINDOW_MS);
  const to = new Date(now.getTime() + STAFF_ROSTER_WINDOW_MS);
  return t
    .select({
      membershipId: SA.membershipId,
      shiftStartAt: S.shiftStartAt,
      shiftEndAt: S.shiftEndAt,
    })
    .from(SA)
    .innerJoin(S, eq(S.id, SA.shiftId))
    .where(
      and(
        eq(S.unitId, unitId),
        inArray(SA.state, [...LIVE_ASSIGNMENT_STATES]),
        lte(S.shiftStartAt, to),
        gte(S.shiftEndAt, from),
      ),
    );
}

/** Resolve the decision for `actor` on `unitId`. Callers throw {@link staffMemberRefusal} on `!allowed`. */
export async function resolveIpuStaffMembership(
  t: DbClient,
  actor: { readonly roles: readonly string[]; readonly membershipId?: string | null },
  unitId: string,
  now: Date,
): Promise<StaffDecision> {
  // Rule 1 needs no query.
  if (hasIpuOrgWideRole(actor.roles)) return { allowed: true, basis: "org_wide_role" };
  const roster = await loadUnitRoster(t, unitId, now);
  return decideIpuStaffMembership({
    roles: actor.roles,
    membershipId: actor.membershipId ?? null,
    roster,
    now,
  });
}

export const STAFF_MEMBER_REFUSAL_MESSAGE =
  "You are not on this unit's staff roster (m37.ipu.staff_member); ask the charge nurse or a unit director to assign you to the unit.";
