// apps/backend/src/modules/07-care-plan/authoring/discipline.ts — M7-T06 (§7.4).
//
// Discipline contribution + the cross-discipline view. Two pure concerns:
//
//  1. `discipline_scope` (§6 ABAC / §2.3): an intervention's `discipline` must match the authoring
//     clinician's own discipline — a chaplain may not author an `rn` intervention. The IDG Coordinator
//     is the single cross-discipline exception (audited at `warn`, §7.4). `canAuthorInterventionDiscipline`
//     is the pure decision both the `discipline_scope` ABAC predicate (abac-predicates.ts) and the
//     service-level write guard (`assertDisciplineScope`) resolve through, so the rule has ONE home.
//
//  2. The cross-discipline review surface (§7.4): `groupInterventionsByDiscipline` /
//     `disciplineCounts` group entries by discipline for the Module-7 cross-discipline view and the
//     Module-30 survey-readiness per-discipline counts (Module 14 renders the same grouping).
//
// Pure data in / data out — no I/O, no clock. The caller's disciplines are assembled server-side from
// the session (never client input); the IDG-coordinator flag is a role membership.
import type { InterventionDiscipline } from "@wardenx/types";
import { CarePlanStateError } from "../lifecycle/errors";

/** The role key whose holder is the §7.4 cross-discipline exception (may author any discipline). */
export const IDG_COORDINATOR_ROLE = "idg_coordinator";

/** The server-assembled discipline scope of the authoring actor (from session roles/attributes). */
export interface AuthoringDisciplineScope {
  /** The disciplines the actor may author for (e.g. `["rn"]` for an RN, `["chha"]` for an aide). */
  readonly disciplines: readonly InterventionDiscipline[];
  /** True when the actor holds the IDG Coordinator role (cross-discipline author, §7.4). */
  readonly isIdgCoordinator: boolean;
}

/**
 * §7.4 / §6 `discipline_scope`: may this actor author an intervention tagged `targetDiscipline`?
 * True iff the actor's own discipline set covers it OR the actor is the IDG Coordinator (the lone
 * cross-discipline exception). Fail-closed — an actor with no discipline and no IDG role authors nothing.
 */
export function canAuthorInterventionDiscipline(
  scope: AuthoringDisciplineScope,
  targetDiscipline: InterventionDiscipline,
): boolean {
  if (scope.isIdgCoordinator) return true;
  return scope.disciplines.includes(targetDiscipline);
}

/**
 * Service-level write guard mirroring the `discipline_scope` predicate (defense in depth — the ABAC
 * gate is the first line; this backstops the in-memory/Drizzle write path). Raises the §7.4
 * `DISCIPLINE_SCOPE_VIOLATION` (403) when the actor is outside their discipline.
 */
export function assertDisciplineScope(
  scope: AuthoringDisciplineScope,
  targetDiscipline: InterventionDiscipline,
): void {
  if (!canAuthorInterventionDiscipline(scope, targetDiscipline)) {
    throw new CarePlanStateError(
      "DISCIPLINE_SCOPE_VIOLATION",
      `actor may not author a '${targetDiscipline}' intervention (discipline_scope)`,
    );
  }
}

/** A minimal intervention projection the cross-discipline view groups (the slice/Drizzle row subset). */
export interface DisciplineTaggedEntry {
  readonly id: string;
  readonly discipline: InterventionDiscipline;
  readonly status: string;
}

/**
 * §7.4 cross-discipline view: group entries by discipline (insertion order preserved within a group),
 * skipping nothing — the IDG/cross-discipline review renders every discipline that has ≥1 entry.
 */
export function groupInterventionsByDiscipline<T extends DisciplineTaggedEntry>(
  entries: readonly T[],
): ReadonlyArray<{ discipline: InterventionDiscipline; entries: readonly T[] }> {
  const byDiscipline = new Map<InterventionDiscipline, T[]>();
  for (const entry of entries) {
    const bucket = byDiscipline.get(entry.discipline);
    if (bucket) bucket.push(entry);
    else byDiscipline.set(entry.discipline, [entry]);
  }
  return [...byDiscipline.entries()].map(([discipline, grouped]) => ({ discipline, entries: grouped }));
}

/**
 * §7.4 survey-readiness counts (Module 30): per-discipline ACTIVE-intervention counts. Only `active`
 * entries are counted — discontinued/completed work is excluded from the survey-readiness rollup.
 */
export function disciplineCounts(
  entries: readonly DisciplineTaggedEntry[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.status !== "active") continue;
    counts[entry.discipline] = (counts[entry.discipline] ?? 0) + 1;
  }
  return counts;
}
