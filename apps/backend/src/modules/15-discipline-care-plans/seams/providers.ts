// apps/backend/src/modules/15-discipline-care-plans/seams/providers.ts — M15-T05 the §4.3 seam
// implementations: pure orchestration over an injected {@link DisciplinePlanSeamStore} plus the module's own
// pure decision functions. Each returns the leaf-typed seam interface (@wardenx/types) the M1 registry
// validates and M14/M16/M17/M22/M28/M30/M31/M33 resolve. The providers add NO tenant logic — RLS scopes every
// store read by the consumer's `app.org_id` (§3.6) — and NO second copy of the domain rules:
//
//   • the volunteer gate answers through `effectiveStatusFor` (`../volunteer`), so a MISSING gate fails
//     exactly like an expired one and the derivation runs over the validity WINDOW, never the materialized
//     `status` column (a missed nightly cron must not re-qualify an expired volunteer);
//   • both supervisory seams answer through `evaluateSupervisoryCadence` (`../lifecycle`), so "day 12 warn /
//     day 14 red / day 16 block" is identical whichever seam a consumer reads it through;
//   • the 418.78(e) ratio answers through `computeVolunteerHourRatio`, so a null/zero denominator badges
//     `unavailable` with a stated reason — never a 0% CoP breach the agency did not commit.
//
// FAIL-CLOSED, per seam, per §8.7 / M15-F11 — and the posture differs by what the consumer does with the
// answer, which is the whole point:
//   • `VolunteerComplianceProvider.effectiveStatusFor` NEVER throws: M17's pre-schedule gate reads
//     `.isActive`, so an unreadable gate store must come back `isActive:false` + the `service_unavailable`
//     sentinel. Throwing would surface as an error the scheduler could retry past; denying is the CoP answer.
//   • The supervisory readers DO propagate a store failure. Their contracts use `null` for "no supervisory
//     obligation is armed" — swallowing an outage into `null` would tell the day view an unsupervised aide is
//     fine, which is fail-OPEN. An error is the honest degraded answer for an advisory surface.
import type {
  AdmissionId,
  ComplianceScope,
  DisciplineComplianceProvider,
  DisciplinePlanId,
  DisciplinePlanReader,
  FiscalYear,
  IsoDate,
  IsoInstant,
  MswRiskFactorReader,
  ProviderEntityId,
  SupervisoryCadencePlanReader,
  SupervisoryCadenceReader,
  SupervisoryOverdue,
  VolunteerComplianceProvider,
  VolunteerGateExpiry,
  VolunteerGateExpiryReader,
} from "@wardenx/types";
import { evaluateSupervisoryCadence, hoursOverdue } from "../lifecycle/index";
import { computeVolunteerHourRatio, daysUntilExpiry, effectiveStatusFor } from "../volunteer/index";
import type { DisciplinePlanSeamStore, RateCounts, SupervisoryClockRow } from "./store";

/** The clock the providers derive "now" from — injected so every seam read is deterministic under test. */
export type SeamClock = () => IsoInstant;

/** Org timezone default when M2 `organization.timezone` is unset (mirrors M6 D8 / M7's gate clock). The one
 *  place M15 needs it: the LOCKED `SupervisoryCadenceReader` contract answers an org-tz calendar DATE, while
 *  `discipline_care_plan.next_supervisory_due_at` is a timestamptz. */
export const DEFAULT_ORG_TIME_ZONE = "America/Los_Angeles";

/** The `yyyy-mm-dd` org-local calendar date of a UTC instant. */
export function orgLocalDateOf(instant: IsoInstant, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.parse(instant)));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * §4.3 — a rate from its counts. A ZERO denominator answers `null`, never 0: an empty scope has no rate to
 * fail, and collapsing the two would hand M30 a fabricated 0% that its small-N suppression can no longer see.
 */
export function rateOf(counts: RateCounts): number | null {
  return counts.denominator <= 0 ? null : counts.numerator / counts.denominator;
}

/**
 * §4.3 `DisciplinePlanReader` over the store — the discipline-plan read path M14's IDG packet builder, M22
 * (plan PDFs), M28 (FHIR `CarePlan`), M31 (portal) and M33 (dashboards) consume instead of importing M15's
 * schema. Pure projection; RLS pins the tenant. The SUD / family-violence gated assessment bodies never cross
 * (§2.3 — the DTOs carry the flags, the store's projection drops the free text).
 */
export function createDisciplinePlanReader(store: DisciplinePlanSeamStore): DisciplinePlanReader {
  return {
    async activePlansForPatient(_orgId, patientId) {
      return [...(await store.activePlansForPatient(patientId))];
    },
    async planById(_orgId, planId) {
      return store.planById(planId);
    },
    async planSummaryForIdg(_orgId, planId) {
      return store.planIdgDigest(planId);
    },
  };
}

/**
 * §4.3 `MswRiskFactorReader` over the store — the psychosocial factors M16's bereavement risk rubric scores.
 * M15 EXPOSES the factors and never scores them (§1.2): the rubric, its weights and the 13-month bereavement
 * obligation are M16's, so no severity is re-weighted here.
 */
export function createMswRiskFactorReader(store: DisciplinePlanSeamStore): MswRiskFactorReader {
  return {
    async riskFactorsForAdmission(_orgId, admissionId) {
      return [...(await store.riskFactorsForAdmission(admissionId))];
    },
  };
}

/**
 * §4.4 / §7.4 the LOCKED `VolunteerComplianceProvider` (interface in `@wardenx/types/scheduling`, shipped by
 * M17-F06/ADR-0009) — M15-T05 binds the real impl over M17's deny-stub, CLOSING the Wave-F volunteer-gate
 * stub. This is M17's D8 pre-schedule predicate 6: an inactive status rejects the publish/assign with
 * `VOLUNTEER_GATE_UNMET` (42 CFR §418.78(b)).
 *
 * It NEVER throws. An unreadable gate store resolves to `gates: null`, which `effectiveStatusFor` answers as
 * `isActive:false` + the `service_unavailable` sentinel — the fail-CLOSED §8.7 posture. The sentinel is
 * deliberately not a gate kind so the scheduler can tell "this volunteer is missing their TB screening" apart
 * from "we could not find out".
 */
export function createVolunteerComplianceProvider(
  store: DisciplinePlanSeamStore,
  clock: SeamClock,
): VolunteerComplianceProvider {
  return {
    async effectiveStatusFor(_orgId, membershipId) {
      const gates = await store.gatesForMembership(membershipId).catch(() => null);
      return effectiveStatusFor(membershipId, gates, clock());
    },
  };
}

/**
 * §4.3 `VolunteerGateExpiryReader` over the store — the additive 418.78 expiry sweep the coordinator worklist
 * and the §4.7 `m15.volunteer.gate_expiring` alerts read (the LOCKED M17 contract covers only the per-
 * membership predicate). Already-expired and revoked gates are OUT: this seam answers "who is about to lapse",
 * while a lapse itself is the compliance provider's / the cascade's business.
 */
export function createVolunteerGateExpiryReader(
  store: DisciplinePlanSeamStore,
  clock: SeamClock,
): VolunteerGateExpiryReader {
  return {
    async listExpiringGates(_orgId, daysOut) {
      const now = clock();
      const candidates = await store.expiringGateCandidates(daysOut);
      const expiring: VolunteerGateExpiry[] = [];
      for (const gate of candidates) {
        if (gate.validUntil === null || gate.revokedAt !== null) continue;
        const remaining = daysUntilExpiry(gate.validUntil, now);
        if (remaining === null || remaining < 0 || remaining > daysOut) continue;
        expiring.push({
          membershipId: gate.volunteerMembershipId,
          gateKind: gate.gateKind,
          validUntil: gate.validUntil,
        });
      }
      return expiring;
    },
  };
}

/**
 * §4.4 / §7.2 the LOCKED `SupervisoryCadenceReader` (interface in `@wardenx/types/scheduling`) — M15-T05 binds
 * the real impl over M17's deny-stub, CLOSING the Wave-F supervisory-advisory stub. M17's `propose-from-
 * frequency` worker and the supervising RN's day view read it as an ADVISORY; M17 does not own the cadence
 * math (the attestation lives in M15's `aide_supervisory_visit`).
 *
 * `null` means exactly one thing: no supervisory clock is armed for the admission (no Aide POC, or one not yet
 * signed — the §7.1 state before the POC's first signature). A store failure PROPAGATES rather than
 * collapsing into that `null`, so an outage can never read as "this aide needs no supervision".
 */
export function createSupervisoryCadenceReader(
  store: DisciplinePlanSeamStore,
  timeZone: string,
): SupervisoryCadenceReader {
  return {
    async nextSupervisoryDueAt(_orgId: string, admissionId: AdmissionId) {
      const clock = await store.supervisoryClockForAdmission(admissionId);
      if (clock === null || clock.nextSupervisoryDueAt === null) return null;
      // The contract answers an org-tz service DATE; the column is a timestamptz (§2.3).
      return { admissionId, nextDueAt: orgLocalDateOf(clock.nextSupervisoryDueAt, timeZone) };
    },
  };
}

/** Project a store clock row + the §7.1 ladder verdict onto the §4.3 overdue-worklist DTO. */
function overdueRowOf(
  row: SupervisoryClockRow,
  nextDueAt: IsoInstant,
  gateEngaged: boolean,
  now: IsoInstant,
): SupervisoryOverdue {
  return {
    planId: row.planId,
    patientId: row.patientId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    aideMembershipId: row.aideMembershipId,
    supervisingRnMembershipId: row.supervisingRnMembershipId,
    nextDueAt,
    hoursOverdue: hoursOverdue(nextDueAt, now),
    gateEngaged,
  };
}

/**
 * §4.3 `SupervisoryCadencePlanReader` over the store — the additive per-PLAN cadence state + overdue worklist
 * M14's dashboard and M30's supervisory-on-time measure need (the LOCKED M17 contract is per-ADMISSION and
 * carries no ladder status). Both methods run the §7.1 ladder from `../lifecycle/supervisory`, so the escalation
 * marks are never re-implemented here.
 *
 * `listOverdueSupervisory` returns only plans at or past `due` — a plan still `on_time` is not a worklist item.
 */
export function createSupervisoryCadencePlanReader(
  store: DisciplinePlanSeamStore,
  clock: SeamClock,
): SupervisoryCadencePlanReader {
  return {
    async nextSupervisoryDueFor(_orgId: string, planId: DisciplinePlanId) {
      const row = await store.supervisoryClockForPlan(planId);
      return row === null ? null : evaluateSupervisoryCadence(row, clock());
    },
    async listOverdueSupervisory(scope: ComplianceScope) {
      const now = clock();
      const rows = await store.overdueSupervisoryClocks(scope);
      const overdue: SupervisoryOverdue[] = [];
      for (const row of rows) {
        const state = evaluateSupervisoryCadence(row, now);
        if (state === null || state.status === "on_time" || state.status === "due") continue;
        overdue.push(overdueRowOf(row, state.nextDueAt, state.status === "gate_engaged", now));
      }
      return overdue;
    },
  };
}

/**
 * §4.3 `DisciplineComplianceProvider` over the store — the M30 HQRP measure inputs + the M33 operational
 * dashboards. The store returns the window TALLIES and the provider does the division, so the rate semantics
 * (an empty scope is `null`, never 0) live in ONE pure place; the 418.78(e) ratio delegates wholly to
 * `computeVolunteerHourRatio`, which badges a null/zero patient-care-hours denominator `unavailable` with the
 * reason carried through to the UI (M15-F04 — no signed staff visit duration resolved).
 */
export function createDisciplineComplianceProvider(
  store: DisciplinePlanSeamStore,
  clock: SeamClock = () => new Date().toISOString() as IsoInstant,
): DisciplineComplianceProvider {
  const counts = async (scope: ComplianceScope) => store.complianceCounts(scope);
  return {
    async supervisoryOnTimeRate(scope) {
      return rateOf((await counts(scope)).supervisoryOnTime);
    },
    async supervisoryOnTimeCounts(scope) {
      return (await counts(scope)).supervisoryOnTime;
    },
    async mswInitialOnTimeRate(scope) {
      return rateOf((await counts(scope)).mswInitialOnTime);
    },
    async chaplainInitialOnTimeRate(scope) {
      return rateOf((await counts(scope)).chaplainInitialOnTime);
    },
    async volunteerGateComplianceRate(scope) {
      return rateOf((await counts(scope)).volunteerGateCompliance);
    },
    async volunteerGateComplianceCounts(scope) {
      return (await counts(scope)).volunteerGateCompliance;
    },
    async volunteerHourCostRatio(
      _orgId: string,
      providerEntityId: ProviderEntityId,
      fiscalYear: FiscalYear,
    ) {
      const totals = await store.volunteerHourTotals(providerEntityId, fiscalYear);
      return computeVolunteerHourRatio({
        providerEntityId,
        fiscalYear,
        volunteerHourMinutes: totals.volunteerHourMinutes,
        staffPatientCareMinutes: totals.staffPatientCareMinutes,
        denominatorComputedAt: totals.staffPatientCareComputedAt,
        now: clock(),
      });
    },
  };
}
