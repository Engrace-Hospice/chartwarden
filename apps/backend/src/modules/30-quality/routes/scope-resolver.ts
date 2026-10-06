// apps/backend/src/modules/30-quality/routes/scope-resolver.ts — GAP-091.
//
// The route-side binding of the PHI patient scope: derive it from the SERVER session (`actorOf`), reaching
// M5's CaseloadProvider through the seam registry. Resolved lazily per request (`getSeam` at call time, not
// at module load) so an unbound seam fails closed per request instead of crashing boot. Deps may inject a
// resolver for tests.
import { getSeam } from "../../../bootstrap/index";
import type { M30ReadActor } from "./actor";
import {
  type CaseloadLookup,
  type QualityPatientScope,
  type QualityReadSurface,
  resolveQualityPatientScope,
} from "./patient-scope";

/** `readSurface` is set by the read routes only (M30 org-wide read arm); writes call it without. */
export type PatientScopeResolver = (
  actor: M30ReadActor,
  readSurface?: QualityReadSurface,
) => Promise<QualityPatientScope>;

/** The production resolver: org-wide roles read the org, everyone else their M5 caseload. */
export const defaultPatientScopeResolver: PatientScopeResolver = (actor, readSurface) =>
  resolveQualityPatientScope(
    actor,
    () => getSeam("CaseloadProvider") as CaseloadLookup,
    readSurface,
  );
