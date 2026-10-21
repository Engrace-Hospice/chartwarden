// GAP-051 — M17 availability / time-off own-vs-any rules, shared by the route layer, the in-memory service
// and the DB-backed service so all three enforce the same decision.
//
// The acting membership is server-derived (the session's membership, never a body/query value). A caller may
// act on another membership's availability / PTO only with a spec §4.6 widening key:
// `availability.edit_any`, `time_off.read_team` or `time_off.approve`.
import { ConflictError, ForbiddenError } from "@chartwarden/types";

/** The widening keys the caller holds, resolved server-side from the RBAC engine at the route. */
export interface CallerAuthority {
  readonly availabilityEditAny: boolean;
  readonly timeOffReadTeam: boolean;
  readonly timeOffApprove: boolean;
}

/** No widening: the caller acts on their own membership only. Also the fail-closed fallback. */
export const NO_AUTHORITY: CallerAuthority = {
  availabilityEditAny: false,
  timeOffReadTeam: false,
  timeOffApprove: false,
};

/** The caller may file / list PTO for other memberships (supervisor-class). */
export function canActForTeam(a: CallerAuthority): boolean {
  return a.availabilityEditAny || a.timeOffReadTeam || a.timeOffApprove;
}

export function assertMayEditAvailability(actor: string, target: string, a: CallerAuthority): void {
  if (actor === target || a.availabilityEditAny) return;
  throw new ForbiddenError("cannot edit another clinician's availability");
}

export function assertMayRequestTimeOff(actor: string, target: string, a: CallerAuthority): void {
  if (actor === target || canActForTeam(a)) return;
  throw new ForbiddenError("cannot file time off for another clinician");
}

/** Returns the membership filter a PTO list must apply (undefined = whole org, team readers only). */
export function resolveTimeOffListScope(
  actor: string,
  requested: string | undefined,
  a: CallerAuthority,
): string | undefined {
  if (a.timeOffReadTeam || a.timeOffApprove) return requested;
  if (requested !== undefined && requested !== actor) {
    throw new ForbiddenError("cannot list another clinician's time off");
  }
  return actor;
}

export function assertMayDecideTimeOff(actor: string, owner: string, a: CallerAuthority): void {
  if (!a.timeOffApprove) throw new ForbiddenError("requires permission 'time_off.approve'");
  if (actor === owner) throw new ConflictError("cannot approve or deny your own time off");
}

export function assertMayCancelTimeOff(actor: string, owner: string, a: CallerAuthority): void {
  if (actor === owner || a.timeOffApprove) return;
  throw new ForbiddenError("cannot cancel another clinician's time off");
}
