// apps/backend/src/modules/16-bereavement/seams/providers.ts — M16-T05, the §4.6 / D13 seam implementations:
// pure orchestration over an injected {@link BereavementSeamStore} plus `@wardenx/bereavement`'s pure policy.
// Each returns the leaf-typed seam interface (`@wardenx/types`) the M1 registry validates and
// M28/M30/M31/M32/M33/M36 resolve. The providers add NO tenant logic — RLS scopes every store read by the
// consumer's `app.org_id` (§3.5) — and NO second copy of the domain rules:
//
//   • the 13-month window answers through `isWithinBereavementWindow` / `bereavementWindowEnd`, so D4's
//     `[death_date, death_date + 396d)` has ONE implementation whether it is read as a plan header
//     (`windowEndsAt`), an authorization question (`isInBereavementWindow`) or a portal capability;
//   • the Layer-2 write-back goes through `mergeAugmentation`, which is the structural reason an M32
//     narrative cannot move `rule_tier` (AI Governance §7.4) — the merged columns are the only thing that
//     changes, and the deterministic tier is copied off the row being narrated;
//   • the D9 90-day rescind capability answers through `isWithinOptOutRescindWindow`, so the portal button
//     and the M16-T06 route agree by construction.
//
// FAIL POSTURE, per seam, deliberately asymmetric — the same rule as M15-T05: pick the direction by what the
// consumer DOES with the answer.
//   • `isInBereavementWindow` is read as an AUTHORIZATION fact (M3's `bereavement_window` predicate, M36's
//     channel-membership check, the M31 portal). It NEVER throws and answers `false` on an unreadable store
//     or an absent plan: "we could not find out" must deny, not grant. A closed plan is likewise outside the
//     window even mid-13-months — the program ended, and the channel goes with it.
//   • Every other read PROPAGATES a store failure. Their contracts use `null` / `[]` for "no such row under
//     this tenant"; swallowing an outage into that would tell M30 a plan has no outreach and tell the
//     closeout doc a roster is empty. An error is the honest degraded answer for a reporting surface.
//   • `registerAugmentation` propagates AND refuses to invent a base row: with no deterministic score to
//     narrate it raises `RISK_SCORE_NOT_FOUND` rather than appending an `llm_augmented` row whose
//     `rule_tier` came from nowhere.
import {
  bereavementWindowEnd,
  isClosedPlanStatus,
  isWithinBereavementWindow,
  isWithinOptOutRescindWindow,
  mergeAugmentation,
  ruleScoreToWeighted,
} from "@wardenx/bereavement";
import type {
  BereavedContactId,
  BereavedPortalScope,
  BereavedPortalScopeProvider,
  BereavementAssignment,
  BereavementAssignmentReader,
  BereavementComplianceProvider,
  BereavementDeterministicScore,
  BereavementOutreachFilters,
  BereavementOutreachProvider,
  BereavementOutreachView,
  BereavementPlanId,
  BereavementPlanProvider,
  BereavementPlanView,
  BereavementRiskFactorsProvider,
  BereavementRiskFactorsSnapshot,
  BereavementRiskTierProvider,
  IsoInstant,
} from "@wardenx/types";
import { BereavementStateError } from "../lifecycle/index";
import type {
  BereavementPlanFacts,
  BereavementRiskScoreFacts,
  BereavementSeamStore,
} from "./store";

/** The clock the providers derive "now" from — injected so every seam read is deterministic under test. */
export type BereavementSeamClock = () => IsoInstant;

/**
 * Project the `bereavement_plan` facts onto the §4.6 header. `windowEndsAt` is computed HERE, from the D4
 * pure function, and never read off a column: the 13-month clock the CoP is measured on must not be able to
 * disagree with itself between a store adapter and the domain.
 */
export function planViewOf(facts: BereavementPlanFacts): BereavementPlanView {
  return {
    planId: facts.planId,
    patientId: facts.patientId,
    admissionId: facts.admissionId,
    providerEntityId: facts.providerEntityId,
    locationId: facts.locationId,
    status: facts.status,
    deathDate: facts.deathDate,
    openedAt: facts.openedAt,
    closedAt: facts.closedAt,
    assignedCounselorUserId: facts.assignedCounselorUserId,
    assignedVolunteerUserId: facts.assignedVolunteerUserId,
    currentRiskTier: facts.currentRiskTier,
    externalSource: facts.externalSource,
    windowEndsAt: bereavementWindowEnd(facts.deathDate) as IsoInstant,
  };
}

/**
 * D4 — is the plan inside its bereavement window at `asOfIso`? Both conditions matter: the 396-day clock has
 * not run out AND the program has not been closed. A closed plan is outside its window on the day it closes,
 * which is what stops M36 from keeping a bereavement channel alive after a family declined.
 */
export function isPlanInWindow(facts: BereavementPlanFacts, asOfIso: IsoInstant): boolean {
  if (isClosedPlanStatus(facts.status)) return false;
  return isWithinBereavementWindow(facts.deathDate, asOfIso);
}

/** §4.6 — apply the `listForPlan` filter set. One implementation, so a SQL adapter that pre-narrows and the
 *  in-memory slice that does not both answer the same set. */
export function applyOutreachFilters(
  rows: readonly BereavementOutreachView[],
  filters: BereavementOutreachFilters,
): readonly BereavementOutreachView[] {
  const from = filters.dueFromIso === undefined ? null : Date.parse(filters.dueFromIso);
  const to = filters.dueToIso === undefined ? null : Date.parse(filters.dueToIso);
  return rows.filter((row) => {
    if (filters.contactId !== undefined && row.contactId !== filters.contactId) return false;
    if (filters.status !== undefined && !filters.status.includes(row.status)) return false;
    if (filters.kind !== undefined && !filters.kind.includes(row.kind)) return false;
    const dueAt = Date.parse(row.dueAt);
    if (from !== null && dueAt < from) return false;
    if (to !== null && dueAt > to) return false;
    return true;
  });
}

/**
 * §4.6 `BereavementPlanProvider` — the plan read path M28 (FHIR `CarePlan`), M30 (HQRP), M31 (portal), M33
 * (dashboards) and M36 (bereavement-channel membership) consume instead of importing M16's schema.
 *
 * `isInBereavementWindow` is the one method that swallows a store failure, and only because it is read as an
 * authorization fact: it answers `false` when the plan cannot be read at all (fail-CLOSED). The other four
 * propagate.
 */
export function createBereavementPlanProvider(
  store: BereavementSeamStore,
): BereavementPlanProvider {
  return {
    async planById(_orgId, planId) {
      const facts = await store.planById(planId);
      return facts === null ? null : planViewOf(facts);
    },
    async planByAdmissionId(_orgId, admissionId) {
      const facts = await store.planByAdmissionId(admissionId);
      return facts === null ? null : planViewOf(facts);
    },
    async isInBereavementWindow(_orgId, planId, asOfIso) {
      const facts = await store.planById(planId).catch(() => null);
      // No plan, or no answer: both deny. An access decision must never be granted by an outage.
      return facts === null ? false : isPlanInWindow(facts, asOfIso);
    },
    async contactsForPlan(_orgId, planId) {
      return store.contactsForPlan(planId);
    },
    async summarize(_orgId, planId) {
      const facts = await store.planById(planId);
      if (facts === null) return null;
      const [contacts, stats, closure] = await Promise.all([
        store.contactsForPlan(planId),
        store.outreachStatsForPlan(planId),
        store.closureForPlan(planId),
      ]);
      return {
        plan: planViewOf(facts),
        contacts,
        stats,
        closureReason: closure?.reason ?? null,
        closureDocumentId: closure?.closureDocumentId ?? null,
      };
    },
  };
}

/**
 * §4.6 `BereavementOutreachProvider` — the touchpoint reads M30's CoP rate and M33's operational dashboard
 * consume. `copComplianceCounts` and {@link createBereavementComplianceProvider}'s `copOutreachCounts` route
 * to the SAME store method on purpose: one CoP 418.64(d) definition, two consumers, no drift.
 *
 * Counts, never a rate (§4.6): M30's CMS small-N suppression needs the denominator, and dividing here would
 * throw it away — a 0/0 scope would come back as a fabricated 0% nobody could suppress.
 */
export function createBereavementOutreachProvider(
  store: BereavementSeamStore,
): BereavementOutreachProvider {
  return {
    async listForPlan(_orgId, planId, filters) {
      return applyOutreachFilters(await store.outreachForPlan(planId), filters);
    },
    async countByStatus(scope) {
      return store.outreachStatusCounts(scope);
    },
    async copComplianceCounts(scope) {
      return store.copOutreachCounts(scope);
    },
  };
}

/** Project the latest score row onto the §4.6 factor snapshot M32 narrates from. */
function snapshotOf(
  facts: BereavementRiskScoreFacts,
  asOfIso: IsoInstant,
): BereavementRiskFactorsSnapshot {
  return {
    contactId: facts.contactId,
    planId: facts.planId,
    asOf: asOfIso,
    factors: facts.factors,
    pg13Score: facts.pg13Score,
    ipgrScore: facts.ipgrScore,
    dataCompleteness: facts.dataCompleteness,
    confidenceBand: facts.confidenceBand,
    redactedCategories: facts.redactedCategories,
  };
}

/** Project the latest score row onto the §4.6 deterministic read; the 0..100 integer column is unscaled back
 *  to the contract's [0,1] weighted score by the inverse of what wrote it (§4.3.3). */
function deterministicScoreOf(facts: BereavementRiskScoreFacts): BereavementDeterministicScore {
  return {
    scoreId: facts.scoreId,
    score: ruleScoreToWeighted(facts.ruleScore),
    tier: facts.ruleTier,
    dataCompleteness: facts.dataCompleteness,
    confidenceBand: facts.confidenceBand,
    assessedAt: facts.assessedAt,
  };
}

/**
 * §4.6 `BereavementRiskFactorsProvider` — the factor snapshot M32 reads before composing a Layer-2 narrative,
 * the deterministic score M30/M33 read, and the ONE write in M16's published surface.
 *
 * `registerAugmentation` APPENDS (§3.3.3 / D8 — the M4 trigger refuses UPDATE on this table outright) and
 * routes through `mergeAugmentation`, so the M32 result can only reach the `augmented_*` columns while
 * `rule_score` / `rule_tier` are copied verbatim off the row being narrated. There is no code path by which
 * the narrative moves the tier a cadence decision was made on (AI Governance §7.4).
 *
 * A `null` augmented score or a missing model ref degrades to the deterministic columns rather than
 * producing a row the §3.3.3 `berv_risk_llm_requires_rule` CHECK would reject — `mergeAugmentation` owns that
 * degradation, and this seam does not second-guess it.
 */
export function createBereavementRiskFactorsProvider(
  store: BereavementSeamStore,
  clock: BereavementSeamClock,
): BereavementRiskFactorsProvider {
  const latest = async (contactId: BereavedContactId, asOfIso: IsoInstant) =>
    store.latestScoreForContact(contactId, asOfIso);

  return {
    async factorsForContact(_orgId, contactId, asOfIso) {
      const facts = await latest(contactId, asOfIso);
      return facts === null ? null : snapshotOf(facts, asOfIso);
    },
    async deterministicScore(_orgId, contactId) {
      const facts = await latest(contactId, clock());
      return facts === null ? null : deterministicScoreOf(facts);
    },
    async registerAugmentation(_orgId, contactId, augmentation) {
      const assessedAt = clock();
      const base = await latest(contactId, assessedAt);
      if (base === null) {
        throw new BereavementStateError(
          "RISK_SCORE_NOT_FOUND",
          `no deterministic bereavement risk score exists for contact ${contactId} to augment`,
        );
      }
      const merged = mergeAugmentation(base.ruleTier, augmentation);
      return store.appendAugmentedScore({
        planId: base.planId,
        contactId: base.contactId,
        providerEntityId: base.providerEntityId,
        locationId: base.locationId,
        assessedAt,
        amendedFromScoreId: base.scoreId,
        // Copied off the base row — `merged.tier` IS `base.ruleTier`, and asserting that here is what makes
        // "the LLM moved the tier" unrepresentable rather than merely discouraged.
        ruleScore: base.ruleScore,
        ruleTier: merged.tier,
        dataCompleteness: base.dataCompleteness,
        confidenceBand: base.confidenceBand,
        factors: base.factors,
        redactedCategories: base.redactedCategories,
        columns: merged.columns,
      });
    },
  };
}

/**
 * §4.6 / D13 `BereavementAssignmentReader` — who is on the hook for a plan (M36's recipient resolver, M3's
 * `bereavement_window` predicate) and the counselor's caseload. Derived from the plan row rather than a
 * second store read, so the assignment a consumer sees is always the assignment the plan header shows.
 */
export function createBereavementAssignmentReader(
  store: BereavementSeamStore,
): BereavementAssignmentReader {
  return {
    async assignmentForPlan(_orgId, planId) {
      const facts = await store.planById(planId);
      if (facts === null) return null;
      const assignment: BereavementAssignment = {
        planId: facts.planId,
        counselorUserId: facts.assignedCounselorUserId,
        volunteerUserId: facts.assignedVolunteerUserId,
        status: facts.status,
      };
      return assignment;
    },
    async plansForCounselor(_orgId, counselorUserId) {
      const facts = await store.plansForCounselor(counselorUserId);
      return facts.map(planViewOf);
    },
  };
}

/**
 * §4.6 / D13 `BereavedPortalScopeProvider` — what an M31 bereaved-family session may see. Deliberately narrow
 * (§1.2 / D10): the contact's own row, whether the program is still open to them, and the two opt-out
 * capabilities. Never the roster, never another survivor, never the decedent's clinical record.
 *
 * `mayOptOut` requires an OPEN window — opting out of a program that already ended is a no-op the portal
 * should not offer — and `mayRescindOptOut` additionally requires the D9 90-day self-service window, after
 * which re-enrollment is counselor-driven with fresh M39 consent.
 */
export function createBereavedPortalScopeProvider(
  store: BereavementSeamStore,
  clock: BereavementSeamClock,
): BereavedPortalScopeProvider {
  return {
    async scopeForPortalAccount(_orgId, portalAccountId) {
      const now = clock();
      const rows = await store.contactsForPortalAccount(portalAccountId);
      return rows.map(({ contact, plan }): BereavedPortalScope => {
        const inWindow = isPlanInWindow(plan, now);
        const optedOut = contact.status === "opted_out";
        return {
          contactId: contact.contactId,
          planId: contact.planId,
          status: contact.status,
          inBereavementWindow: inWindow,
          mayOptOut: inWindow && !optedOut,
          mayRescindOptOut:
            inWindow &&
            optedOut &&
            contact.optedOutAt !== null &&
            isWithinOptOutRescindWindow(contact.optedOutAt, now),
        };
      });
    },
  };
}

/**
 * §4.6 / D13 `BereavementComplianceProvider` — the M30 HQRP measure inputs + the M33 rollups. Counts, never
 * rates: a zero denominator has to stay visible so CMS small-N suppression downstream is honest, and the
 * screening measure's `minimal`-row exclusion happens in the DENOMINATOR (D17) rather than by zeroing a
 * numerator, so a tenant with many external-source deaths is not scored on evidence nobody could gather.
 */
export function createBereavementComplianceProvider(
  store: BereavementSeamStore,
): BereavementComplianceProvider {
  return {
    async copOutreachCounts(scope) {
      // Same store method as BereavementOutreachProvider.copComplianceCounts — one CoP definition.
      return store.copOutreachCounts(scope);
    },
    async riskScreeningCompletenessCounts(scope) {
      return store.riskScreeningCompletenessCounts(scope);
    },
    async planClosureCounts(scope) {
      return store.planClosureCounts(scope);
    },
  };
}

/** §4.6 / D13 `BereavementRiskTierProvider` — the tier distribution M30's chart and M33's dashboard read.
 *  Already counts by construction; every tier is present, so a tier with no survivors reads as a real 0. */
export function createBereavementRiskTierProvider(
  store: BereavementSeamStore,
): BereavementRiskTierProvider {
  return {
    async tierDistribution(scope) {
      return store.tierCounts(scope);
    },
  };
}
