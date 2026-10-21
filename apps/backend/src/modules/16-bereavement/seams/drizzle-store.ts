// apps/backend/src/modules/16-bereavement/seams/drizzle-store.ts — the Drizzle-backed
// {@link BereavementSeamStore} the seven §4.6 published seams read through (TASK-002; the M21
// `store-drizzle.ts` pattern over M16's tables, migrations 0100–0102).
//
// TENANCY. Reads keyed on a subject id open `withOrgContextFromRequest`, which pins `app.org_id` from the
// CONSUMER'S ambient request context — the providers never switch tenants; RLS scopes every statement
// (§3.5). Called outside a request scope they THROW rather than reading unscoped. The scope-parameter
// rollups carry `scope.orgId` explicitly, so they open `withOrgContext` on that org AND keep an explicit
// `organization_id` predicate as the second wall (the M30/M33 worker callers have no ambient request).
//
// WHAT THIS STORE DOES NOT DO, on purpose (the port doc in ./store.ts):
//   • no D4 window arithmetic — `windowEndsAt` is computed by the provider from `deathDate` through the
//     ONE pure `bereavementWindowEnd`; this adapter returns the row facts;
//   • no rates — the CoP 418.64(d) and D17 screening measures return the numerator/denominator PAIR, so
//     M30's small-N suppression keeps the denominator;
//   • no score arithmetic — `rule_score` crosses as the stored 0..100 integer and the provider unscales;
//   • NO CONTACT CHANNELS. `email_cipher` / `phone_cipher` / `mailing_address_cipher` are DEK-encrypted
//     per-column and are never selected into a seam DTO — `BereavedContactView` carries no channel field,
//     and this store never decrypt-fakes a value and never leaks a cipher across the seam (the same
//     posture as the route layer's `toContactRow`).
//
// THE ONE WRITE. `appendAugmentedScore` APPENDS to the immutable §3.3.3 risk-score ledger (the M4 trigger
// refuses UPDATE on `bereavement_risk_score` outright). It runs under the consumer's ambient RLS context,
// inherits `organization_id` from the base row it narrates (never invents a tenant), and copies the base
// row's `risk_factors_jsonb` provenance verbatim — the M32 result reaches only the `augmented_*` columns
// the provider's `mergeAugmentation` produced.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext, withOrgContextFromRequest } from "@chartwarden/tenancy";
import type {
  BereavedContactView,
  BereavementOutreachKind,
  BereavementOutreachStatus,
  BereavementOutreachView,
  BereavementRiskFactorInputs,
  BereavementRiskTier,
  BereavementScope,
  IsoInstant,
  LocalDate,
  M16OutreachStats,
} from "@chartwarden/types";
import { type AnyColumn, and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { BereavementStateError } from "../lifecycle/index";
import type { RiskFactorsJsonb } from "../risk/score";
import {
  type BereavedPortalRow,
  type BereavementPlanFacts,
  type BereavementRiskScoreFacts,
  type BereavementSeamStore,
  COP_DENOMINATOR_STATUSES,
  COP_NUMERATOR_STATUSES,
  EMPTY_CLOSURE_COUNTS,
  EMPTY_OUTREACH_STATUS_COUNTS,
  EMPTY_TIER_DISTRIBUTION,
} from "./store";

type PlanRow = typeof schema.bereavementPlan.$inferSelect;
type ContactRow = typeof schema.bereavedContact.$inferSelect;
type OutreachRow = typeof schema.bereavementOutreach.$inferSelect;
type ScoreRow = typeof schema.bereavementRiskScore.$inferSelect;

const iso = (d: Date | string): IsoInstant =>
  (d instanceof Date ? d.toISOString() : new Date(d).toISOString()) as IsoInstant;
const isoN = (d: Date | string | null): IsoInstant | null => (d === null ? null : iso(d));
/** `date` columns come back as `YYYY-MM-DD` strings from the pg driver; keep them as-is. */
const localDate = (d: string | Date): LocalDate =>
  (typeof d === "string" ? d : d.toISOString().slice(0, 10)) as LocalDate;

/** D17's explicit third value for every slot — the honest projection of a malformed/legacy
 *  `risk_factors_jsonb` payload; never a silent `false` (that would read as a documented negative). */
const ALL_UNKNOWN_FACTORS: BereavementRiskFactorInputs = {
  ambivalentRelationship: "unknown",
  suddenUnexpectedDeath: "unknown",
  priorUnresolvedLoss: "unknown",
  preExistingMentalHealth: "unknown",
  socialIsolation: "unknown",
  financialStrain: "unknown",
  primaryCaregiverRole: "unknown",
  activeSubstanceUse: "unknown",
} as const;

const allowedKindsOf = (raw: unknown): BereavementOutreachKind[] => {
  const kinds = (raw as { allowed_kinds?: unknown } | null)?.allowed_kinds;
  return Array.isArray(kinds)
    ? kinds.filter((k): k is BereavementOutreachKind => typeof k === "string")
    : [];
};

/** Build the Drizzle-backed §4.6 seam store over M16's tables. */
export function createDrizzleBereavementSeamStore(db: DbClient): BereavementSeamStore {
  const PLAN = schema.bereavementPlan;
  const CONTACT = schema.bereavedContact;
  const OUTREACH = schema.bereavementOutreach;
  const SCORE = schema.bereavementRiskScore;
  const CLOSURE = schema.bereavementPlanClosure;
  const COP_CREDIT = schema.bereavementCopOptOutCredit;

  type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

  const planFactsOf = (r: PlanRow): BereavementPlanFacts => ({
    planId: r.id,
    patientId: r.patientId,
    admissionId: r.admissionId,
    providerEntityId: r.providerEntityId,
    locationId: r.locationId ?? null,
    status: r.status,
    deathDate: localDate(r.deathDate),
    openedAt: isoN(r.openedAt),
    closedAt: isoN(r.closedAt),
    assignedCounselorUserId: (r.assignedCounselorUserId ??
      null) as BereavementPlanFacts["assignedCounselorUserId"],
    assignedVolunteerUserId: (r.assignedVolunteerUserId ??
      null) as BereavementPlanFacts["assignedVolunteerUserId"],
    currentRiskTier: r.currentRiskTier ?? null,
    externalSource: (r.externalSourceMetadata ?? null) as BereavementPlanFacts["externalSource"],
  });

  // The seam roster row: identity + status + reachability facts. The DEK-encrypted channel ciphers are
  // deliberately never selected into this shape (see the module header).
  const contactViewOf = (r: ContactRow): BereavedContactView => ({
    contactId: r.id,
    planId: r.planId,
    status: r.status,
    relationshipCode: r.relationshipCode,
    displayName: r.displayName,
    preferredLanguageIso639: r.preferredLanguageIso639,
    portalAccountId: r.portalAccountId ?? null,
    consentRecordId: r.consentRecordId ?? null,
    currentRiskTier: r.currentRiskTier ?? null,
    volunteerVisibleOnly: r.volunteerVisibleOnly,
    allowedOutreachKinds: allowedKindsOf(r.outreachPreferencesJsonb),
    confirmedAt: isoN(r.confirmedAt),
    optedOutAt: isoN(r.optedOutAt),
  });

  const outreachViewOf = (r: OutreachRow): BereavementOutreachView => ({
    outreachId: r.id,
    planId: r.planId,
    contactId: r.bereavedContactId,
    kind: r.kind,
    status: r.status,
    anniversaryMark: r.anniversaryMark ?? null,
    dueAt: iso(r.dueAt),
    lateGraceUntil: iso(r.lateGraceUntil),
    completedAt: isoN(r.completedAt),
    assigneeUserId: (r.assigneeUserId ?? null) as BereavementOutreachView["assigneeUserId"],
    renderedDocumentId: r.renderedDocumentId ?? null,
    // No source-encounter column exists on the outreach row today — the route layer projects the same
    // `null` (routes/read-service-drizzle.ts `toOutreachRow`); never invented.
    sourceEncounterId: null,
  });

  const scoreFactsOf = (r: ScoreRow): BereavementRiskScoreFacts => {
    const payload = (r.riskFactorsJsonb ?? {}) as Partial<RiskFactorsJsonb>;
    return {
      scoreId: r.id,
      planId: r.planId,
      contactId: r.bereavedContactId as BereavementRiskScoreFacts["contactId"],
      providerEntityId: r.providerEntityId,
      locationId: r.locationId ?? null,
      assessedAt: iso(r.assessedAt),
      factors: payload.factors ?? ALL_UNKNOWN_FACTORS,
      pg13Score: payload.pg13Score ?? null,
      ipgrScore: payload.ipgrScore ?? null,
      redactedCategories: payload.redactedCategories ?? [],
      ruleScore: r.ruleScore,
      ruleTier: r.ruleTier,
      dataCompleteness: r.dataCompleteness,
      confidenceBand: r.confidenceBand,
    };
  };

  /** The org + optional PE/location walls for a scope-parameter rollup (§3.3.1's denormalization). */
  const scopeWalls = (
    cols: { org: AnyColumn; pe: AnyColumn; loc: AnyColumn },
    scope: BereavementScope,
  ) =>
    [
      eq(cols.org, scope.orgId),
      scope.providerEntityId !== undefined ? eq(cols.pe, scope.providerEntityId) : undefined,
      scope.locationId !== undefined ? eq(cols.loc, scope.locationId) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);

  /** Per-status outreach counts for a scope — the ONE query both `outreachStatusCounts` and
   *  `copOutreachCounts` sum over, so the CoP rate and the status chart can never disagree. */
  async function statusCountsFor(
    tx: Tx,
    scope: BereavementScope,
  ): Promise<Record<BereavementOutreachStatus, number>> {
    const filters = [
      ...scopeWalls(
        { org: OUTREACH.organizationId, pe: OUTREACH.providerEntityId, loc: OUTREACH.locationId },
        scope,
      ),
      scope.fromIso !== undefined ? gte(OUTREACH.dueAt, new Date(scope.fromIso)) : undefined,
      scope.toIso !== undefined ? lte(OUTREACH.dueAt, new Date(scope.toIso)) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    const rows = await tx
      .select({ status: OUTREACH.status, n: sql<number>`count(*)::int` })
      .from(OUTREACH)
      .where(and(...filters))
      .groupBy(OUTREACH.status);
    const counts: Record<BereavementOutreachStatus, number> = { ...EMPTY_OUTREACH_STATUS_COUNTS };
    for (const row of rows) counts[row.status] = row.n;
    return counts;
  }

  return {
    // ── plan reads (BereavementPlanProvider + BereavementAssignmentReader) ────────────────────────────
    async planById(planId) {
      return withOrgContextFromRequest(db, async (tx): Promise<BereavementPlanFacts | null> => {
        const [row] = await tx.select().from(PLAN).where(eq(PLAN.id, planId)).limit(1);
        return row === undefined ? null : planFactsOf(row);
      });
    },

    async planByAdmissionId(admissionId) {
      return withOrgContextFromRequest(db, async (tx): Promise<BereavementPlanFacts | null> => {
        const [row] = await tx
          .select()
          .from(PLAN)
          .where(eq(PLAN.admissionId, admissionId))
          .orderBy(desc(PLAN.createdAt), desc(PLAN.id))
          .limit(1);
        return row === undefined ? null : planFactsOf(row);
      });
    },

    async plansForCounselor(counselorUserId) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly BereavementPlanFacts[]> => {
        const rows = await tx
          .select()
          .from(PLAN)
          .where(eq(PLAN.assignedCounselorUserId, counselorUserId))
          .orderBy(desc(PLAN.updatedAt), desc(PLAN.id));
        return rows.map(planFactsOf);
      });
    },

    async contactsForPlan(planId) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly BereavedContactView[]> => {
        const rows = await tx
          .select()
          .from(CONTACT)
          .where(eq(CONTACT.planId, planId))
          .orderBy(asc(CONTACT.createdAt), asc(CONTACT.id));
        return rows.map(contactViewOf);
      });
    },

    async outreachStatsForPlan(planId) {
      return withOrgContextFromRequest(db, async (tx): Promise<M16OutreachStats> => {
        const [outreach] = await tx
          .select({
            completedCount: sql<number>`count(*) filter (where ${OUTREACH.status} in ('completed','declined'))::int`,
            missedCount: sql<number>`count(*) filter (where ${OUTREACH.status} = 'missed')::int`,
          })
          .from(OUTREACH)
          .where(eq(OUTREACH.planId, planId));
        const [contacts] = await tx
          .select({
            active: sql<number>`count(*) filter (where ${CONTACT.status} = 'active')::int`,
            optedOut: sql<number>`count(*) filter (where ${CONTACT.status} = 'opted_out')::int`,
          })
          .from(CONTACT)
          .where(eq(CONTACT.planId, planId));
        return {
          completedCount: outreach?.completedCount ?? 0,
          missedCount: outreach?.missedCount ?? 0,
          contactsActiveCount: contacts?.active ?? 0,
          contactsOptedOutCount: contacts?.optedOut ?? 0,
        };
      });
    },

    async closureForPlan(planId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [row] = await tx
          .select({ reason: CLOSURE.reason, documentId: CLOSURE.bereavementSummaryDocumentId })
          .from(CLOSURE)
          .where(eq(CLOSURE.planId, planId))
          .limit(1);
        return row === undefined
          ? null
          : { reason: row.reason, closureDocumentId: row.documentId ?? null };
      });
    },

    // ── outreach reads (BereavementOutreachProvider) ──────────────────────────────────────────────────
    async outreachForPlan(planId) {
      return withOrgContextFromRequest(
        db,
        async (tx): Promise<readonly BereavementOutreachView[]> => {
          // EVERY touchpoint on the plan — the §4.6 filter set is the provider's (`applyOutreachFilters`),
          // so its semantics have one implementation whichever adapter is bound.
          const rows = await tx
            .select()
            .from(OUTREACH)
            .where(eq(OUTREACH.planId, planId))
            .orderBy(asc(OUTREACH.dueAt), asc(OUTREACH.id));
          return rows.map(outreachViewOf);
        },
      );
    },

    async outreachStatusCounts(scope) {
      return withOrgContext(db, { organizationId: scope.orgId, userId: "" }, async (tx) =>
        statusCountsFor(tx, scope),
      );
    },

    // ── compliance rollups (BereavementOutreachProvider + BereavementComplianceProvider) ──────────────
    async copOutreachCounts(scope) {
      return withOrgContext(db, { organizationId: scope.orgId, userId: "" }, async (tx) => {
        const counts = await statusCountsFor(tx, scope);
        const sumOf = (statuses: readonly BereavementOutreachStatus[]): number =>
          statuses.reduce((total, s) => total + counts[s], 0);

        // F-206 (#248) — a pre-death patient bereavement opt-out (`m16.bereavement.plan_skipped_per_
        // patient_opt_out`, recorded in `bereavement_cop_opt_out_credit`) counts as CoP 418.64(d) coverage
        // SATISFIED: added to BOTH the numerator and the denominator, the same "the agency reached the
        // family and a choice was exercised" shape `declined` already gets in `COP_NUMERATOR_STATUSES`
        // above — a patient's own pre-death directive not to be contacted is that same choice, exercised
        // earlier. Windowed on `death_date` (the only field common to both `bereavement_outreach.due_at`'s
        // "obligation window" concept and this table's payload-only shape), same org/PE/location walls.
        const creditFilters = [
          ...scopeWalls(
            {
              org: COP_CREDIT.organizationId,
              pe: COP_CREDIT.providerEntityId,
              loc: COP_CREDIT.locationId,
            },
            scope,
          ),
          scope.fromIso !== undefined
            ? gte(COP_CREDIT.deathDate, scope.fromIso.slice(0, 10))
            : undefined,
          scope.toIso !== undefined
            ? lte(COP_CREDIT.deathDate, scope.toIso.slice(0, 10))
            : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        const [creditRow] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(COP_CREDIT)
          .where(and(...creditFilters));
        const credits = creditRow?.n ?? 0;

        return {
          numerator: sumOf(COP_NUMERATOR_STATUSES) + credits,
          denominator: sumOf(COP_DENOMINATOR_STATUSES) + credits,
        };
      });
    },

    async riskScreeningCompletenessCounts(scope) {
      return withOrgContext(db, { organizationId: scope.orgId, userId: "" }, async (tx) => {
        // D17 — contacts owed a screen are the ACTIVE roster in scope. Each contact's verdict comes from
        // their LATEST ledger row: none ⇒ owed-but-unscreened (denominator only); latest `minimal` ⇒
        // excluded from the DENOMINATOR (evidence nobody could have gathered — external-source deaths);
        // otherwise screened (numerator + denominator).
        const contacts = await tx
          .select({ id: CONTACT.id })
          .from(CONTACT)
          .where(
            and(
              ...scopeWalls(
                {
                  org: CONTACT.organizationId,
                  pe: CONTACT.providerEntityId,
                  loc: CONTACT.locationId,
                },
                scope,
              ),
              eq(CONTACT.status, "active"),
            ),
          );
        if (contacts.length === 0) return { numerator: 0, denominator: 0 };
        const contactIds = contacts.map((c) => c.id);
        const scoreRows = await tx
          .select({
            contactId: SCORE.bereavedContactId,
            dataCompleteness: SCORE.dataCompleteness,
          })
          .from(SCORE)
          .where(inArray(SCORE.bereavedContactId, contactIds))
          .orderBy(desc(SCORE.assessedAt), desc(SCORE.id));
        const latestByContact = new Map<string, (typeof scoreRows)[number]>();
        for (const row of scoreRows) {
          if (row.contactId !== null && !latestByContact.has(row.contactId)) {
            latestByContact.set(row.contactId, row);
          }
        }
        let numerator = 0;
        let denominator = 0;
        for (const id of contactIds) {
          const latest = latestByContact.get(id);
          if (latest === undefined) {
            denominator += 1;
          } else if (latest.dataCompleteness !== "minimal") {
            numerator += 1;
            denominator += 1;
          }
        }
        return { numerator, denominator };
      });
    },

    async planClosureCounts(scope) {
      return withOrgContext(db, { organizationId: scope.orgId, userId: "" }, async (tx) => {
        const filters = [
          ...scopeWalls(
            { org: CLOSURE.organizationId, pe: CLOSURE.providerEntityId, loc: CLOSURE.locationId },
            scope,
          ),
          scope.fromIso !== undefined ? gte(CLOSURE.closedAt, new Date(scope.fromIso)) : undefined,
          scope.toIso !== undefined ? lte(CLOSURE.closedAt, new Date(scope.toIso)) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        const rows = await tx
          .select({ reason: CLOSURE.reason, n: sql<number>`count(*)::int` })
          .from(CLOSURE)
          .where(and(...filters))
          .groupBy(CLOSURE.reason);
        const counts = { ...EMPTY_CLOSURE_COUNTS };
        for (const row of rows) counts[row.reason] = row.n;
        return counts;
      });
    },

    // ── risk reads + the ONE write (BereavementRiskFactorsProvider + BereavementRiskTierProvider) ─────
    async latestScoreForContact(contactId, asOfIso) {
      return withOrgContextFromRequest(
        db,
        async (tx): Promise<BereavementRiskScoreFacts | null> => {
          const [row] = await tx
            .select()
            .from(SCORE)
            .where(
              and(eq(SCORE.bereavedContactId, contactId), lte(SCORE.assessedAt, new Date(asOfIso))),
            )
            .orderBy(desc(SCORE.assessedAt), desc(SCORE.id))
            .limit(1);
          return row === undefined ? null : scoreFactsOf(row);
        },
      );
    },

    async appendAugmentedScore(draft) {
      return withOrgContextFromRequest(db, async (tx) => {
        // The base row this augmentation narrates — it MUST be visible under the consumer's tenant, and
        // it is where `organization_id` and the jsonb provenance are inherited from. Refusing here (rather
        // than inventing a tenant or an empty provenance) keeps the ledger's chain honest.
        const [base] = await tx
          .select()
          .from(SCORE)
          .where(eq(SCORE.id, draft.amendedFromScoreId))
          .limit(1);
        if (base === undefined) {
          throw new BereavementStateError(
            "RISK_SCORE_NOT_FOUND",
            `bereavement risk score ${draft.amendedFromScoreId} is not visible under this tenant to augment`,
          );
        }
        // Provenance copied VERBATIM off the base row; only the draft-supplied slots move. The M32 result
        // reaches the `augmented_*` columns exclusively (`draft.columns`, built by `mergeAugmentation`).
        const baseJson = (base.riskFactorsJsonb ?? {}) as Partial<RiskFactorsJsonb>;
        const riskFactorsJsonb = {
          ...baseJson,
          factors: draft.factors,
          redactedCategories: [...draft.redactedCategories],
          amendedFromScoreId: draft.amendedFromScoreId,
        };
        const [inserted] = await tx
          .insert(SCORE)
          .values({
            organizationId: base.organizationId,
            providerEntityId: draft.providerEntityId,
            locationId: draft.locationId,
            planId: draft.planId,
            bereavedContactId: draft.contactId,
            scoreKind: draft.columns.scoreKind,
            assessedAt: new Date(draft.assessedAt),
            // A seam append is the M32 system writer, not a workforce member (§3.3.3 — NULL is the
            // cron/system scorer's documented shape).
            assessedByUserId: null,
            riskFactorsJsonb,
            ruleScore: draft.ruleScore,
            ruleTier: draft.ruleTier,
            dataCompleteness: draft.dataCompleteness,
            confidenceBand: draft.confidenceBand,
            augmentedScore: draft.columns.augmentedScore,
            augmentedTier: draft.columns.augmentedTier,
            augmentedNarrativeRedacted: draft.columns.augmentedNarrativeRedacted,
            augmentedModelRef: draft.columns.augmentedModelRef,
            augmentedRequestId: draft.columns.augmentedRequestId,
          })
          .returning({ id: SCORE.id });
        if (inserted === undefined) {
          throw new BereavementStateError(
            "RISK_SCORE_NOT_FOUND",
            "the bereavement risk-score append returned no row",
          );
        }
        return inserted.id;
      });
    },

    async tierCounts(scope) {
      return withOrgContext(db, { organizationId: scope.orgId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ tier: CONTACT.currentRiskTier, n: sql<number>`count(*)::int` })
          .from(CONTACT)
          .where(
            and(
              ...scopeWalls(
                {
                  org: CONTACT.organizationId,
                  pe: CONTACT.providerEntityId,
                  loc: CONTACT.locationId,
                },
                scope,
              ),
              isNotNull(CONTACT.currentRiskTier),
            ),
          )
          .groupBy(CONTACT.currentRiskTier);
        const tally: Record<BereavementRiskTier, number> = { ...EMPTY_TIER_DISTRIBUTION };
        for (const row of rows) if (row.tier !== null) tally[row.tier] = row.n;
        return tally;
      });
    },

    // ── portal scope (BereavedPortalScopeProvider) ────────────────────────────────────────────────────
    async contactsForPortalAccount(portalAccountId) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly BereavedPortalRow[]> => {
        const contacts = await tx
          .select()
          .from(CONTACT)
          .where(eq(CONTACT.portalAccountId, portalAccountId))
          .orderBy(asc(CONTACT.createdAt), asc(CONTACT.id));
        if (contacts.length === 0) return [];
        const planIds = [...new Set(contacts.map((c) => c.planId))];
        const plans = await tx.select().from(PLAN).where(inArray(PLAN.id, planIds));
        const planById = new Map(plans.map((p) => [p.id, planFactsOf(p)]));
        const rows: BereavedPortalRow[] = [];
        for (const contact of contacts) {
          const plan = planById.get(contact.planId);
          if (plan === undefined) continue;
          rows.push({ contact: contactViewOf(contact), plan });
        }
        return rows;
      });
    },
  };
}
