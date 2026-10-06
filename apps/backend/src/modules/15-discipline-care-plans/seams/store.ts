// apps/backend/src/modules/15-discipline-care-plans/seams/store.ts — M15-T05 the data PORT the §4.3 seam
// providers (DisciplinePlanReader + MswRiskFactorReader + the two LOCKED M17 contracts + VolunteerGate
// ExpiryReader + SupervisoryCadencePlanReader + DisciplineComplianceProvider) compose over, plus an in-memory
// slice for tests / boot-without-DB. The providers (./providers.ts) are pure orchestration over this port;
// production injects a Drizzle-backed store that reads M15's `discipline_care_plan` / `discipline_assessment` /
// `aide_supervisory_visit` / `volunteer_*` rows under the CONSUMER's `withOrgContext` — the providers never
// switch tenants; RLS scopes every read by `app.org_id` (§3.6). Mirrors the M9…M14/M17/M18 read-seam store
// precedents.
//
// Every M15 seam is READ-only (no mutate path — M15 owns the plan / supervisory / volunteer lifecycles
// internally and never writes through a seam). Two shapes deliberately do NOT match their seam DTO:
//
//   • the port returns the raw supervisory CLOCK columns, not a `SupervisoryCadenceState` / `Supervisory
//     Overdue` — the §7.1 ladder (`on_time → due → overdue → gate_engaged`) and the hours-overdue math stay
//     in `../lifecycle/supervisory.ts`, so "day 12 warn / day 14 red / day 16 block" has ONE implementation
//     no matter which of the three seams a consumer reads it through;
//   • the port returns the compliance NUMERATOR + DENOMINATOR pair, not the rate — the seam contract returns
//     a rate, and a store that returned one too would strand the denominator the CMS small-N suppression
//     downstream needs (the M30 measure-input lesson). The provider divides, and answers `null` — never 0 —
//     on an empty denominator.
//
// The gate read is the ONE nullable-by-design method: `gatesForMembership` returns `null` when the rows could
// not be read, and §8.7 / M15-F11 turns that into a fail-CLOSED `isActive:false`, never an assumed pass.
import type {
  AdmissionId,
  ComplianceScope,
  DisciplinePlanDigest,
  DisciplinePlanFull,
  DisciplinePlanId,
  DisciplinePlanIdgDigest,
  FiscalYear,
  IsoInstant,
  LocationId,
  MembershipId,
  MswRiskFactor,
  PatientId,
  ProviderEntityId,
} from "@wardenx/types";
import type { SupervisoryClockFacts } from "../lifecycle/index";
import type { VolunteerGateFacts } from "../volunteer/index";

/** The supervisory clock a plan-scoped read resolves: the §7.1 ladder inputs plus the plan's identity columns
 *  (M15-F05 denormalizes PE + location onto every M15 table, so the worklist needs no cross-schema join). */
export interface SupervisoryClockRow extends SupervisoryClockFacts {
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId;
  readonly aideMembershipId: MembershipId | null;
  readonly supervisingRnMembershipId: MembershipId | null;
}

/** A numerator/denominator pair the §4.3 rate seams divide. Kept as counts so a zero denominator is visible to
 *  the provider (it answers `null`, never a false 0% — the M30 small-N suppression depends on the difference). */
export interface RateCounts {
  readonly numerator: number;
  readonly denominator: number;
}

/** The §4.3 `DisciplineComplianceProvider` tallies for one scope, in ONE store round-trip (all four rates are
 *  read together by the M30 recompute worker and the M33 dashboard). */
export interface DisciplineComplianceCounts {
  /** Supervisory visits attested on or before their `next_due_at` ÷ supervisory obligations in the window. */
  readonly supervisoryOnTime: RateCounts;
  /** MSW initial assessments signed inside the D10 clock ÷ MSW plans whose clock closed in the window. */
  readonly mswInitialOnTime: RateCounts;
  /** Chaplain initial assessments signed inside the D10 clock (a documented decline counts as met, §2.2.5). */
  readonly chaplainInitialOnTime: RateCounts;
  /** Volunteers whose blocking 418.78 gates all clear ÷ volunteers with an open assignment in the window. */
  readonly volunteerGateCompliance: RateCounts;
}

/** The 418.78(e) ledger totals for one (provider entity × fiscal year) bucket. `staffPatientCareMinutes` is
 *  M27's patient-care HOURS denominator (M15-F04 — never dollars) and stays `null` while that read is unbound;
 *  `computeVolunteerHourRatio` turns the null into the honest `unavailable` badge, never a 0% breach. */
export interface VolunteerHourTotals {
  readonly volunteerHourMinutes: number;
  readonly staffPatientCareMinutes: number | null;
  /** When the nightly aggregator persisted the denominator; `null` = never computed (migration 0347). */
  readonly staffPatientCareComputedAt?: IsoInstant | null | undefined;
}

/**
 * The data port the §4.3 seam providers compose over. Reads return the read-only DTO shapes from
 * `@wardenx/types` (never Drizzle rows) or the raw column facts the pure lifecycle/volunteer functions decide
 * over. Reads key on the subject id / a scope — the org is already pinned by RLS — and return an empty slice /
 * null when the subject has no visible rows under the consumer's tenant.
 */
export interface DisciplinePlanSeamStore {
  // ── plan reads (DisciplinePlanReader) ─────────────────────────────────────────────────────────────────
  activePlansForPatient(patientId: PatientId): Promise<readonly DisciplinePlanDigest[]>;
  /** The full plan. The SUD / family-violence gated assessment BODIES are filtered by the read path before
   *  they reach the store's projection (§2.3) — the DTO carries the flags, never the free text. */
  planById(planId: DisciplinePlanId): Promise<DisciplinePlanFull | null>;
  planIdgDigest(planId: DisciplinePlanId): Promise<DisciplinePlanIdgDigest | null>;

  // ── MSW risk-factor reads (MswRiskFactorReader) ───────────────────────────────────────────────────────
  riskFactorsForAdmission(admissionId: AdmissionId): Promise<readonly MswRiskFactor[]>;

  // ── volunteer-gate reads (VolunteerComplianceProvider + VolunteerGateExpiryReader) ────────────────────
  /** EVERY `volunteer_compliance_gate` row for the membership — current AND historical; the §7.4 derivation
   *  picks the clearing ones. `null` = the rows could not be read (§8.7 fail-CLOSED input). */
  gatesForMembership(membershipId: MembershipId): Promise<readonly VolunteerGateFacts[] | null>;
  /** Gates whose `valid_until` falls inside the `daysOut` horizon. The SQL bound is a coarse filter — the
   *  provider re-derives each status over the validity window (a missed cron must never re-qualify anyone). */
  expiringGateCandidates(daysOut: number): Promise<readonly VolunteerGateFacts[]>;

  // ── supervisory clock reads (SupervisoryCadenceReader + SupervisoryCadencePlanReader) ─────────────────
  supervisoryClockForPlan(planId: DisciplinePlanId): Promise<SupervisoryClockRow | null>;
  /** The admission's live Aide POC clock (the M17 day-view advisory). Null when no Aide POC is armed. */
  supervisoryClockForAdmission(admissionId: AdmissionId): Promise<SupervisoryClockRow | null>;
  /** Armed clocks in scope whose `next_due_at` has passed — the provider derives hours-overdue + gate state. */
  overdueSupervisoryClocks(scope: ComplianceScope): Promise<readonly SupervisoryClockRow[]>;

  // ── compliance rollups (DisciplineComplianceProvider) ─────────────────────────────────────────────────
  complianceCounts(scope: ComplianceScope): Promise<DisciplineComplianceCounts>;
  volunteerHourTotals(
    providerEntityId: ProviderEntityId,
    fiscalYear: FiscalYear,
  ): Promise<VolunteerHourTotals>;
}

/** A plan the in-memory slice serves: the digest every read projects from, plus the optional full/IDG bodies
 *  and the supervisory clock columns. */
export interface DisciplinePlanSeamSeedPlan {
  readonly digest: DisciplinePlanDigest;
  readonly full?: DisciplinePlanFull;
  readonly idgDigest?: DisciplinePlanIdgDigest;
  /** `discipline_care_plan.supervisory_cadence_days_override` (null = the 14-day §418.76(h) floor). */
  readonly cadenceDaysOverride?: number | null;
  readonly aideMembershipId?: MembershipId | null;
  readonly supervisingRnMembershipId?: MembershipId | null;
}

/** The slice's seed. Everything is optional — an unseeded store answers empty/null, which is the honest
 *  "no visible rows under this tenant" answer, NOT a fail-open pass (the gate read seeds `gates` explicitly). */
export interface DisciplinePlanSeamSeed {
  readonly plans?: readonly DisciplinePlanSeamSeedPlan[];
  readonly riskFactors?: readonly MswRiskFactor[];
  readonly gates?: readonly VolunteerGateFacts[];
  /** Set to true to simulate the §8.7 unreadable-gate-store path (`gatesForMembership` → null). */
  readonly gateStoreUnavailable?: boolean;
  readonly complianceCounts?: DisciplineComplianceCounts;
  readonly hourTotals?: readonly (VolunteerHourTotals & {
    readonly providerEntityId: ProviderEntityId;
    readonly fiscalYear: FiscalYear;
  })[];
}

const EMPTY_COUNTS: DisciplineComplianceCounts = {
  supervisoryOnTime: { numerator: 0, denominator: 0 },
  mswInitialOnTime: { numerator: 0, denominator: 0 },
  chaplainInitialOnTime: { numerator: 0, denominator: 0 },
  volunteerGateCompliance: { numerator: 0, denominator: 0 },
};

const clockRowOf = (p: DisciplinePlanSeamSeedPlan): SupervisoryClockRow => ({
  planId: p.digest.planId,
  nextSupervisoryDueAt: p.digest.nextSupervisoryDueAt,
  cadenceDaysOverride: p.cadenceDaysOverride ?? null,
  patientId: p.digest.patientId,
  admissionId: p.digest.admissionId,
  providerEntityId: p.digest.providerEntityId,
  locationId: p.digest.locationId,
  aideMembershipId: p.aideMembershipId ?? null,
  supervisingRnMembershipId: p.supervisingRnMembershipId ?? null,
});

const inScope = (row: SupervisoryClockRow, scope: ComplianceScope): boolean =>
  (scope.providerEntityId === undefined || row.providerEntityId === scope.providerEntityId) &&
  (scope.locationId === undefined || row.locationId === scope.locationId);

/**
 * The in-memory slice (tests / boot-without-DB). Production replaces it with a Drizzle-backed store; the
 * providers are identical either way. The slice never invents rows: an unseeded read answers empty/null.
 */
export function createInMemoryDisciplinePlanSeamStore(seed: DisciplinePlanSeamSeed = {}): {
  store: DisciplinePlanSeamStore;
} {
  const plans = seed.plans ?? [];
  const gates = seed.gates ?? [];
  const byPlanId = new Map(plans.map((p) => [p.digest.planId, p]));

  return {
    store: {
      async activePlansForPatient(patientId) {
        return plans
          .filter((p) => p.digest.patientId === patientId && p.digest.status === "active")
          .map((p) => p.digest);
      },
      async planById(planId) {
        return byPlanId.get(planId)?.full ?? null;
      },
      async planIdgDigest(planId) {
        return byPlanId.get(planId)?.idgDigest ?? null;
      },
      async riskFactorsForAdmission(admissionId) {
        return (seed.riskFactors ?? []).filter((f) => f.admissionId === admissionId);
      },
      async gatesForMembership(membershipId) {
        if (seed.gateStoreUnavailable === true) return null;
        return gates.filter((g) => g.volunteerMembershipId === membershipId);
      },
      async expiringGateCandidates(_daysOut) {
        // The slice hands back every dated, unrevoked gate and lets the provider apply the exact §7.5
        // derivation against ITS injected clock (the slice owns no clock — determinism, no `Date.now()`).
        // The Drizzle store narrows the same set in SQL with a `valid_until < now() + interval` bound.
        return gates.filter((g) => g.validUntil !== null && g.revokedAt === null);
      },
      async supervisoryClockForPlan(planId) {
        const plan = byPlanId.get(planId);
        return plan === undefined ? null : clockRowOf(plan);
      },
      async supervisoryClockForAdmission(admissionId) {
        const plan = plans.find(
          (p) =>
            p.digest.admissionId === admissionId &&
            p.digest.kind === "aide_poc" &&
            p.digest.nextSupervisoryDueAt !== null,
        );
        return plan === undefined ? null : clockRowOf(plan);
      },
      async overdueSupervisoryClocks(scope) {
        return plans
          .filter((p) => p.digest.nextSupervisoryDueAt !== null)
          .map(clockRowOf)
          .filter((row) => inScope(row, scope));
      },
      async complianceCounts(_scope) {
        return seed.complianceCounts ?? EMPTY_COUNTS;
      },
      async volunteerHourTotals(providerEntityId, fiscalYear) {
        const row = (seed.hourTotals ?? []).find(
          (t) => t.providerEntityId === providerEntityId && t.fiscalYear === fiscalYear,
        );
        return {
          volunteerHourMinutes: row?.volunteerHourMinutes ?? 0,
          staffPatientCareMinutes: row?.staffPatientCareMinutes ?? null,
          // no seeded row ⇒ never computed; a seeded row without a stamp ⇒ the inline (non-staleness) case.
          staffPatientCareComputedAt:
            row === undefined ? null : (row.staffPatientCareComputedAt ?? undefined),
        };
      },
    },
  };
}
