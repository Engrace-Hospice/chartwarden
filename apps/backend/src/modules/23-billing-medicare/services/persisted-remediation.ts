// apps/backend/src/modules/23-billing-medicare/services/persisted-remediation.ts — the ONE shape a rule result's
// annotations are stored in (`validation_result.remediation` jsonb), shared by assembly's initial run and every
// re-validation. Flat: the remediation fields (`summary`, `blameTarget`, `blameTargetId`, `fixAction`,
// `fixDeepLink`) at the top level — what the worklist reads — plus the optional `observed` aggregates, the
// structured `defects` (e.g. `PLACE_OF_DEATH_MISSING` with the record ids the fix needs) and `skipReason`.
//
// History: assembly stored `annotations.remediation` (flat) while re-validation stored the whole `annotations`
// object (`{ remediation: {...}, observed }`), so a re-validated result's summary sat one level down and the
// worklist showed no remediation for it. Rows written before this change keep their shape; readers accept both
// (`apps/web/.../validation-remediation.ts`).
import type { RuleResult } from "@wardenx/billing";

export function persistedRemediation(r: RuleResult): Record<string, unknown> {
  const a = r.annotations;
  if (!a) return {};
  return {
    ...(a.remediation ?? {}),
    ...(a.observed ? { observed: a.observed } : {}),
    ...(a.defects && a.defects.length > 0 ? { defects: a.defects } : {}),
    ...(a.skipReason ? { skipReason: a.skipReason } : {}),
  };
}
