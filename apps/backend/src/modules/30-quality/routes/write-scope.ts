// apps/backend/src/modules/30-quality/routes/write-scope.ts — GAP-091 follow-up (service-layer half).
//
// The route predicate (`assertPatientInScope` over `scopeOf(actor)`) is the first layer; this is the second,
// called by the write service itself so a caller that skips the route (a second route, a script, a future
// worker) still cannot author a patient-linked M30 row about a patient outside its scope.
//
//   - typed system actor (`m30SystemWriteActor`, never a role string) ⇒ no caseload applies, allowed;
//   - patient-less row (null / undefined) ⇒ org-level, allowed without consulting the seam;
//   - otherwise the SERVER-resolved scope decides; a denied patient is a NotFound (404, no existence leak);
//   - ANY failure resolving the scope (seam unbound/down, resolver throws) is a DENY, never an allow.
import { NotFoundError } from "@wardenx/types";
import { type M30WriteActor, isM30SystemActor } from "./actor";
import { assertPatientInScope } from "./patient-scope";
import type { PatientScopeResolver } from "./scope-resolver";

export async function assertWritePatientInScope(
  actor: M30WriteActor,
  patientId: string | null | undefined,
  resolveScope: PatientScopeResolver,
  what = "patient",
  ownsRow = false,
): Promise<void> {
  if (isM30SystemActor(actor)) return;
  if (patientId === undefined || patientId === null) return;
  let scope: Awaited<ReturnType<PatientScopeResolver>>;
  try {
    scope = await resolveScope(actor);
  } catch {
    throw new NotFoundError(what);
  }
  assertPatientInScope(scope, patientId, what, ownsRow);
}
