// apps/backend/src/modules/08-encounters/drafting/source-reads.ts — the read keys of the SOURCE domains a draft is compiled from (ADR-0114 S3, VN-D42).
//
// The draft reads the care plan (M7), the medication orders (M12) and the scored scales (M9) through seams that apply no permission check of
// their own, so a caller who could not read them through those modules' own routes must not read them through the draft. Until S3 the draft routes
// asked all three keys of every draft, whatever the template read, so an aide's draft, which states care-plan interventions alone, needed a
// medication-order read and a scale-trend read. The keys now follow the sources the template's drafted sections are built from
// (`draftSourceNeeds` in `@chartwarden/hearthnote`), the same rule that decides which sources the draft reads at all (`inputs.ts`).
//
// ONE draft per patient and visit still holds: the keys are decided by the template, the same for every viewer, so a section's hash is never
// computed from fewer sources for one viewer than for another. Asked at the draft routes only (the service's `loadOr404`), after the switch
// and the tenant are known and before any source is read; finalize, sign and an addendum's recompute recompute the same full draft for the
// signer without them (S1), and ask the admission facts' keys by template (`admission-reads.ts`).
import { type DraftSourceNeeds, draftSourceNeeds } from "@chartwarden/hearthnote";
import { ForbiddenError } from "@chartwarden/types";
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";

/** The sibling routes' read keys: M7 `GET /care-plan/...`, M12 `GET /medication-orders`, M9 `GET /patients/:id/scales/:type/series`. */
export const SOURCE_DOMAIN_KEYS = {
  carePlan: "care_plan.read",
  medicationChanges: "prescribing.read",
  scales: "assessment.read_trend",
} as const;

/**
 * The source-domain read keys the draft of the pair needs: one per source its drafted sections are built from, in the order the draft routes
 * always asked them (care plan, medication orders, scales). A template that drafts nothing needs none. The vitals are M8's own record: `encounter.read`.
 */
export function sourceDomainReadsFor(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): readonly string[] {
  const needs = draftSourceNeeds(encounterType, discipline);
  return [
    ...(needs.carePlan ? [SOURCE_DOMAIN_KEYS.carePlan] : []),
    ...(needs.medicationChanges ? [SOURCE_DOMAIN_KEYS.medicationChanges] : []),
    ...(needs.scales ? [SOURCE_DOMAIN_KEYS.scales] : []),
  ];
}

/**
 * Whether the draft reads the previous signed visit: it bounds the "since the last visit" windows of the scale readings and the medication
 * changes, and of nothing else. ONE rule for the store snapshot (`compute.ts`) and the as-of reads (`inputs.ts`), so the two cannot disagree.
 */
export function readsPreviousVisit(needs: DraftSourceNeeds): boolean {
  return needs.scales || needs.medicationChanges;
}

/** 403 for a caller who lacks one of the source-domain keys the template's draft needs. The message names the key, as `requirePermission` does. */
export function assertMayReadSourceDomains(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
  permissions: ReadonlySet<string>,
): void {
  const missing = sourceDomainReadsFor(encounterType, discipline).find(
    (key) => !permissions.has(key),
  );
  if (missing !== undefined) throw new ForbiddenError(`requires permission '${missing}'`);
}
