import type { BereavementAugmentationColumns } from "@wardenx/bereavement";
// apps/backend/src/modules/16-bereavement/seams/store.ts — M16-T05, the data PORT the seven §4.6 published
// seams compose over, plus an in-memory slice for tests / boot-without-DB. The providers (./providers.ts) are
// pure orchestration over this port; production injects a Drizzle-backed store reading M16's
// `bereavement_plan` / `bereaved_contact` / `bereavement_outreach` / `bereavement_risk_score` /
// `bereavement_plan_closure` rows under the CONSUMER's `withOrgContext` — the providers never switch tenants;
// RLS scopes every read by `app.org_id` (§3.5). Mirrors the M9…M15/M17/M18 read-seam store precedents.
//
// Three shapes deliberately do NOT match their seam DTO, and each is a rule about where a derivation lives:
//
//   • the port returns plan FACTS, not a `BereavementPlanView` — `windowEndsAt` is D4 arithmetic
//     (`death_date + 396 days`), and a SQL adapter that computed it would be a second implementation of the
//     13-month clock. `@wardenx/bereavement`'s `bereavementWindowEnd` is the only one; the provider projects.
//   • the port returns the CoP numerator/denominator pair, never a rate — M30's CMS small-N suppression needs
//     the denominator itself, and a store that pre-divided would strand it (the M15-T05 / M30 measure-input
//     lesson, now written into the `BereavementCopComplianceCounts` contract itself).
//   • the port returns the latest score's raw columns, not a `BereavementDeterministicScore` — the 0..100
//     integer `rule_score` is unscaled back to the contract's [0,1] weighted score by `ruleScoreToWeighted`,
//     the same function `weightedScoreToRuleScore` scaled it with (§4.3.3).
//
// SIX of the seven seams are pure reads. The ONE write is `BereavementRiskFactorsProvider.registerAugmentation`
// (M32's Layer-2 write-back), and it is an APPEND: `bereavement_risk_score` is immutable (§3.3.3 / D8 — the M4
// trigger refuses UPDATE outright), so the port's write method inserts a NEW row and can never mutate the
// deterministic tier a cadence decision was made on. The Drizzle adapter runs that insert inside the M4-audited
// transaction the M16-T06 service layer owns.
import type {
  AdmissionId,
  BereavedContactId,
  BereavedContactView,
  BereavedPortalAccountId,
  BereavementConfidenceBand,
  BereavementCopComplianceCounts,
  BereavementDataCompleteness,
  BereavementExternalSourceMetadata,
  BereavementOutreachStatus,
  BereavementOutreachStatusCounts,
  BereavementOutreachView,
  BereavementPlanClosureReason,
  BereavementPlanId,
  BereavementPlanStatus,
  BereavementRiskFactorInputs,
  BereavementRiskScoreId,
  BereavementRiskTier,
  BereavementRiskTierDistribution,
  BereavementScope,
  DocumentId,
  IsoInstant,
  LocalDate,
  LocationId,
  M16OutreachStats,
  MembershipId,
  PatientId,
  ProviderEntityId,
} from "@wardenx/types";

/**
 * The `bereavement_plan` columns every plan-shaped seam read projects from. Deliberately the ROW, not the
 * `BereavementPlanView`: `windowEndsAt` is derived from `deathDate` by the one pure D4 function, so a store
 * adapter has no way to answer a window question with its own arithmetic.
 */
export interface BereavementPlanFacts {
  readonly planId: BereavementPlanId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId | null;
  readonly status: BereavementPlanStatus;
  readonly deathDate: LocalDate;
  readonly openedAt: IsoInstant | null;
  readonly closedAt: IsoInstant | null;
  readonly assignedCounselorUserId: MembershipId | null;
  readonly assignedVolunteerUserId: MembershipId | null;
  readonly currentRiskTier: BereavementRiskTier | null;
  readonly externalSource: BereavementExternalSourceMetadata | null;
}

/** The `bereavement_plan_closure` facts `summarize` folds into the §7.11 / §7.15 rollup. */
export interface BereavementClosureFacts {
  readonly reason: BereavementPlanClosureReason;
  readonly closureDocumentId: DocumentId | null;
}

/**
 * The latest `bereavement_risk_score` row for a contact, as columns. `ruleScore` is the 0..100 INTEGER the
 * table stores; the provider unscales it to the contract's [0,1] weighted score rather than the store doing
 * two different kinds of arithmetic on the same number.
 */
export interface BereavementRiskScoreFacts {
  readonly scoreId: BereavementRiskScoreId;
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId | null;
  readonly assessedAt: IsoInstant;
  readonly factors: BereavementRiskFactorInputs;
  readonly pg13Score: number | null;
  readonly ipgrScore: number | null;
  /** §7.13 — the 42 CFR Part 2 categories M15's reader filtered upstream; empty when nothing was withheld. */
  readonly redactedCategories: readonly string[];
  readonly ruleScore: number;
  readonly ruleTier: BereavementRiskTier;
  readonly dataCompleteness: BereavementDataCompleteness;
  readonly confidenceBand: BereavementConfidenceBand;
}

/**
 * The APPEND the Layer-2 write-back produces (§4.6 `registerAugmentation`). The deterministic columns are
 * copied VERBATIM off the row being augmented and the M32 result may only reach `columns` — which is why the
 * draft carries the two shapes separately instead of one flat row an adapter could cross-wire.
 */
export interface BereavementAugmentedScoreDraft {
  readonly planId: BereavementPlanId;
  readonly contactId: BereavedContactId;
  readonly providerEntityId: ProviderEntityId;
  readonly locationId: LocationId | null;
  readonly assessedAt: IsoInstant;
  /** The immutable row this augmentation narrates (D8's chain — never updated in place). */
  readonly amendedFromScoreId: BereavementRiskScoreId;
  readonly ruleScore: number;
  readonly ruleTier: BereavementRiskTier;
  readonly dataCompleteness: BereavementDataCompleteness;
  readonly confidenceBand: BereavementConfidenceBand;
  readonly factors: BereavementRiskFactorInputs;
  readonly redactedCategories: readonly string[];
  readonly columns: BereavementAugmentationColumns;
}

/** One bereaved contact an M31 portal account resolves to, with the plan it hangs off (the window fact). */
export interface BereavedPortalRow {
  readonly contact: BereavedContactView;
  readonly plan: BereavementPlanFacts;
}

/** The outreach statuses that satisfy the CoP 418.64(d) numerator — a touchpoint that REACHED the family
 *  in some form. `declined` counts: the agency made the contact and the survivor exercised a choice.
 *  ONE definition, shared by the seam store and the route-31 supervisor dashboard, so M30 and M33 can
 *  never be shown two different bereavement-compliance rates for the same scope. */
export const COP_NUMERATOR_STATUSES: readonly BereavementOutreachStatus[] = [
  "completed",
  "declined",
];
/** The denominator: every touchpoint the schedule OWED, whether or not it landed. Cancelled rows are
 *  excluded because an opt-out / pause removes the obligation rather than failing it. */
export const COP_DENOMINATOR_STATUSES: readonly BereavementOutreachStatus[] = [
  "completed",
  "declined",
  "no_response",
  "missed",
  "in_progress",
  "scheduled",
];

/** The per-status volume with every status present; a status with no rows is `0`, not absent. */
export const EMPTY_OUTREACH_STATUS_COUNTS: BereavementOutreachStatusCounts = {
  scheduled: 0,
  in_progress: 0,
  completed: 0,
  declined: 0,
  no_response: 0,
  missed: 0,
  cancelled: 0,
} as const;

/** Every closure reason present at zero — a reason with no closures is a real 0, not a gap in the chart. */
export const EMPTY_CLOSURE_COUNTS: { readonly [K in BereavementPlanClosureReason]: number } = {
  thirteen_month_completion: 0,
  all_contacts_declined: 0,
  patient_opt_out_pre_death: 0,
  patient_opt_out_post_creation: 0,
  tenant_offboarding: 0,
  all_bereaved_deceased: 0,
  geographic_relocation: 0,
  family_legal_action: 0,
  other_early: 0,
} as const;

/** Every tier present at zero (the D3 four-tier ladder, including the D8-only `complicated`). */
export const EMPTY_TIER_DISTRIBUTION: BereavementRiskTierDistribution = {
  low: 0,
  moderate: 0,
  high: 0,
  complicated: 0,
} as const;

const ZERO_COUNTS: BereavementCopComplianceCounts = { numerator: 0, denominator: 0 };

/**
 * The data port the §4.6 seam providers compose over. Reads key on the subject id / a scope — the org is
 * already pinned by RLS — and answer empty/null when the subject has no visible rows under the consumer's
 * tenant, which is the honest "not in this tenant" answer and never a fabricated pass.
 */
export interface BereavementSeamStore {
  // ── plan reads (BereavementPlanProvider + BereavementAssignmentReader) ────────────────────────────────
  planById(planId: BereavementPlanId): Promise<BereavementPlanFacts | null>;
  planByAdmissionId(admissionId: AdmissionId): Promise<BereavementPlanFacts | null>;
  plansForCounselor(counselorUserId: MembershipId): Promise<readonly BereavementPlanFacts[]>;
  contactsForPlan(planId: BereavementPlanId): Promise<readonly BereavedContactView[]>;
  outreachStatsForPlan(planId: BereavementPlanId): Promise<M16OutreachStats>;
  closureForPlan(planId: BereavementPlanId): Promise<BereavementClosureFacts | null>;

  // ── outreach reads (BereavementOutreachProvider) ──────────────────────────────────────────────────────
  /** EVERY touchpoint on the plan; the §4.6 filter set is applied by the provider so its semantics have one
   *  implementation whichever adapter is bound (the SQL store may narrow first — the provider re-filters). */
  outreachForPlan(planId: BereavementPlanId): Promise<readonly BereavementOutreachView[]>;
  outreachStatusCounts(scope: BereavementScope): Promise<BereavementOutreachStatusCounts>;

  // ── compliance rollups (BereavementOutreachProvider + BereavementComplianceProvider) ──────────────────
  /** The CoP 418.64(d) tallies. ONE store method backs BOTH seams that expose this measure, so M30 and M33
   *  can never be shown two different bereavement-compliance rates for the same scope. */
  copOutreachCounts(scope: BereavementScope): Promise<BereavementCopComplianceCounts>;
  /** D17 — contacts with a non-`minimal` risk screen ÷ contacts owed one. `minimal` rows are excluded from
   *  the DENOMINATOR by the SQL, so a tenant with many external-source deaths is not penalized for evidence
   *  nobody could have gathered. */
  riskScreeningCompletenessCounts(scope: BereavementScope): Promise<BereavementCopComplianceCounts>;
  planClosureCounts(
    scope: BereavementScope,
  ): Promise<{ readonly [K in BereavementPlanClosureReason]: number }>;

  // ── risk reads + the ONE write (BereavementRiskFactorsProvider + BereavementRiskTierProvider) ─────────
  /** The latest score row for the contact at or before `asOfIso` — the append-only ledger read backwards. */
  latestScoreForContact(
    contactId: BereavedContactId,
    asOfIso: IsoInstant,
  ): Promise<BereavementRiskScoreFacts | null>;
  /** APPEND a Layer-2 row (never an UPDATE — §3.3.3 / D8). Returns the new row's id. */
  appendAugmentedScore(draft: BereavementAugmentedScoreDraft): Promise<BereavementRiskScoreId>;
  tierCounts(scope: BereavementScope): Promise<BereavementRiskTierDistribution>;

  // ── portal scope (BereavedPortalScopeProvider) ────────────────────────────────────────────────────────
  contactsForPortalAccount(
    portalAccountId: BereavedPortalAccountId,
  ): Promise<readonly BereavedPortalRow[]>;
}

/** The slice's seed. Everything optional — an unseeded store answers empty/null. */
export interface BereavementSeamSeed {
  readonly plans?: readonly BereavementPlanFacts[];
  readonly contacts?: readonly BereavedContactView[];
  readonly outreach?: readonly BereavementOutreachView[];
  readonly stats?: readonly (M16OutreachStats & { readonly planId: BereavementPlanId })[];
  readonly closures?: readonly (BereavementClosureFacts & {
    readonly planId: BereavementPlanId;
  })[];
  readonly scores?: readonly BereavementRiskScoreFacts[];
  readonly portalAccounts?: readonly {
    readonly portalAccountId: BereavedPortalAccountId;
    readonly contactIds: readonly BereavedContactId[];
  }[];
  readonly outreachStatusCounts?: BereavementOutreachStatusCounts;
  readonly copCounts?: BereavementCopComplianceCounts;
  readonly screeningCounts?: BereavementCopComplianceCounts;
  readonly closureCounts?: { readonly [K in BereavementPlanClosureReason]: number };
  readonly tierCounts?: BereavementRiskTierDistribution;
}

const EMPTY_STATS: M16OutreachStats = {
  completedCount: 0,
  missedCount: 0,
  contactsActiveCount: 0,
  contactsOptedOutCount: 0,
};

/** A plan is in a rollup scope when its denormalized PE / location columns match (§3.3.1's rollup index). */
const planInScope = (plan: BereavementPlanFacts, scope: BereavementScope): boolean =>
  (scope.providerEntityId === undefined || plan.providerEntityId === scope.providerEntityId) &&
  (scope.locationId === undefined || plan.locationId === scope.locationId);

/**
 * The in-memory slice (tests / boot-without-DB). Production replaces it with a Drizzle-backed store; the
 * providers are identical either way. The slice never invents rows: an unseeded read answers empty/null, and
 * the appended augmentation lands in the slice's own ledger so `latestScoreForContact` sees it next.
 */
export function createInMemoryBereavementSeamStore(seed: BereavementSeamSeed = {}): {
  store: BereavementSeamStore;
  /** Every row the slice appended, in order — the T05 tests assert the APPEND, not an update. */
  appended: BereavementAugmentedScoreDraft[];
} {
  const plans = [...(seed.plans ?? [])];
  const contacts = [...(seed.contacts ?? [])];
  const outreach = [...(seed.outreach ?? [])];
  const scores = [...(seed.scores ?? [])];
  const appended: BereavementAugmentedScoreDraft[] = [];
  let appendSeq = 0;

  const byPlanId = new Map(plans.map((p) => [p.planId, p]));
  const planOf = (contactId: BereavedContactId): BereavementPlanFacts | undefined => {
    const contact = contacts.find((c) => c.contactId === contactId);
    return contact === undefined ? undefined : byPlanId.get(contact.planId);
  };

  return {
    appended,
    store: {
      async planById(planId) {
        return byPlanId.get(planId) ?? null;
      },
      async planByAdmissionId(admissionId) {
        return plans.find((p) => p.admissionId === admissionId) ?? null;
      },
      async plansForCounselor(counselorUserId) {
        return plans.filter((p) => p.assignedCounselorUserId === counselorUserId);
      },
      async contactsForPlan(planId) {
        return contacts.filter((c) => c.planId === planId);
      },
      async outreachStatsForPlan(planId) {
        return (seed.stats ?? []).find((s) => s.planId === planId) ?? EMPTY_STATS;
      },
      async closureForPlan(planId) {
        return (seed.closures ?? []).find((c) => c.planId === planId) ?? null;
      },
      async outreachForPlan(planId) {
        return outreach.filter((o) => o.planId === planId);
      },
      async outreachStatusCounts(_scope) {
        return seed.outreachStatusCounts ?? EMPTY_OUTREACH_STATUS_COUNTS;
      },
      async copOutreachCounts(_scope) {
        return seed.copCounts ?? ZERO_COUNTS;
      },
      async riskScreeningCompletenessCounts(_scope) {
        return seed.screeningCounts ?? ZERO_COUNTS;
      },
      async planClosureCounts(_scope) {
        return seed.closureCounts ?? EMPTY_CLOSURE_COUNTS;
      },
      async latestScoreForContact(contactId, asOfIso) {
        const asOf = Date.parse(asOfIso);
        const eligible = scores
          .filter((s) => s.contactId === contactId && Date.parse(s.assessedAt) <= asOf)
          .sort((a, b) => Date.parse(b.assessedAt) - Date.parse(a.assessedAt));
        return eligible[0] ?? null;
      },
      async appendAugmentedScore(draft) {
        appended.push(draft);
        appendSeq += 1;
        const scoreId = `augmented-${appendSeq}`;
        // The APPEND is visible to the next read, exactly as the immutable ledger behaves: the deterministic
        // columns ride along untouched, so a later `deterministicScore` still answers the rubric's tier.
        scores.push({
          scoreId,
          planId: draft.planId,
          contactId: draft.contactId,
          providerEntityId: draft.providerEntityId,
          locationId: draft.locationId,
          assessedAt: draft.assessedAt,
          factors: draft.factors,
          pg13Score: null,
          ipgrScore: null,
          redactedCategories: draft.redactedCategories,
          ruleScore: draft.ruleScore,
          ruleTier: draft.ruleTier,
          dataCompleteness: draft.dataCompleteness,
          confidenceBand: draft.confidenceBand,
        });
        return scoreId;
      },
      async tierCounts(scope) {
        if (seed.tierCounts !== undefined) return seed.tierCounts;
        const tally = { ...EMPTY_TIER_DISTRIBUTION };
        for (const contact of contacts) {
          const plan = byPlanId.get(contact.planId);
          if (plan === undefined || !planInScope(plan, scope)) continue;
          if (contact.currentRiskTier === null) continue;
          tally[contact.currentRiskTier] += 1;
        }
        return tally;
      },
      async contactsForPortalAccount(portalAccountId) {
        const seeded = (seed.portalAccounts ?? []).find(
          (a) => a.portalAccountId === portalAccountId,
        );
        const ids =
          seeded?.contactIds ??
          contacts.filter((c) => c.portalAccountId === portalAccountId).map((c) => c.contactId);
        const rows: BereavedPortalRow[] = [];
        for (const id of ids) {
          const contact = contacts.find((c) => c.contactId === id);
          const plan = planOf(id);
          if (contact === undefined || plan === undefined) continue;
          rows.push({ contact, plan });
        }
        return rows;
      },
    },
  };
}
