// apps/backend/src/modules/07-care-plan/seams/reader.ts — M7-T04 the §7.8 CarePlanReader implementation:
// pure orchestration over an injected {@link CarePlanReaderStore}. Returns the leaf-typed seam interface
// (@chartwarden/types) the M1 registry validates and M8/M14/M15 resolve. The reader adds NO tenant logic —
// RLS scopes every store read by the consumer's `app.org_id`; it only projects store DTOs and applies
// the two derived rules with one home each: the §7.8 encounter-relevance filter and the §2.6 overdue
// gate (delegated to the pure lifecycle/overdue-gate helper).
import type {
  CarePlanElementsAudience,
  CarePlanReader,
  InterventionDiscipline,
  IsoInstant,
  PatientId,
  RelevantCarePlanElements,
} from "@chartwarden/types";
import { evaluateCarePlanOverdue } from "../lifecycle/index";
import { projectRelevantElements, relevantElementsFromVersion } from "./relevant-elements";
import type { CarePlanReaderStore } from "./store";

/** Injected wall clock (ISO instant). Overridable for deterministic tests; defaults to real time. */
export type NowClock = () => string;

const realClock: NowClock = () => new Date().toISOString();

/**
 * §7.8 CarePlanReader over the store. `relevantElementsForEncounter` populates the encounter form's
 * picker — active problems, the active interventions tagged with `discipline`, and the goals of those
 * interventions' parent problems — with SUD content filtered out (and `redacted=true`) when the caller
 * is not entitled (D7). `relevantElementsAsOf` (VN-D11) answers the same question for an instant in the past, from
 * the frozen snapshot of the version in effect then (./relevant-elements.ts holds the one rule both share).
 * `isReviewOverdue` is the encounter-sign gate M8 calls: `overdue=true` blocks
 * signing with `CARE_PLAN_REVIEW_OVERDUE` (override → Clinical Supervisor + reason).
 */
export function createCarePlanReader(
  store: CarePlanReaderStore,
  now: NowClock = realClock,
): CarePlanReader {
  return {
    async relevantElementsForEncounter(
      patientId: PatientId,
      _encounterType: string,
      discipline: InterventionDiscipline,
      admissionId: string | undefined,
      viewer: CarePlanElementsAudience,
    ): Promise<RelevantCarePlanElements | null> {
      const record = await store.activeCarePlanElements(patientId, admissionId, viewer);
      return record === null ? null : projectRelevantElements(record, discipline);
    },

    async relevantElementsAsOf(
      patientId: PatientId,
      _encounterType: string,
      discipline: InterventionDiscipline,
      admissionId: string | undefined,
      viewer: CarePlanElementsAudience,
      asOf: IsoInstant,
    ): Promise<RelevantCarePlanElements | null> {
      // A malformed instant is a caller bug: fail loudly rather than read "no version" or a guessed one.
      if (Number.isNaN(Date.parse(asOf))) {
        throw new RangeError(
          `relevantElementsAsOf: asOf must be an ISO instant, got ${JSON.stringify(asOf)}`,
        );
      }
      const version = await store.carePlanVersionAsOf(patientId, admissionId, asOf, viewer);
      return version === null ? null : relevantElementsFromVersion(version, discipline);
    },

    async fifteenDayCycleCountsForOrg(
      organizationId: string,
      window: { from: string; to: string },
    ) {
      return store.fifteenDayCycleCountsForOrg(organizationId, window);
    },
    async terminologyCodeUsageForOrg(
      organizationId: string,
      codes: readonly { readonly systemId: string; readonly code: string }[],
    ) {
      // No codes asked for → no rows possible; skip the round-trip entirely (M38 sends the
      // currently-deprecated set, which is empty for a system with no deprecations loaded).
      if (codes.length === 0) return [];
      return store.terminologyCodeUsageForOrg(organizationId, codes);
    },
    async linkSummary(organizationId: string, id: string) {
      // Fail closed: no tenant or no id means no answer, never a guessed one.
      if (!organizationId?.trim()) throw new Error("linkSummary: organizationId required");
      if (!id?.trim()) throw new Error("linkSummary: id required");
      return store.linkSummary(organizationId, id);
    },
    async isReviewOverdue(patientId: PatientId) {
      const clock = await store.activeCarePlanClock(patientId);
      if (clock === null) return null;
      return evaluateCarePlanOverdue(clock, now(), clock.timeZone);
    },
  };
}
