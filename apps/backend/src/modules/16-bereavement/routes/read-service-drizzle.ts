// apps/backend/src/modules/16-bereavement/routes/read-service-drizzle.ts — the Drizzle-backed M16 READ
// service (§4.1 routes 1, 2, 10, 19, 29, 30, 31).
//
// Every method opens `withOrgContext(db, {organizationId, userId}, tx => …)` so Postgres RLS scopes each
// statement to the acting org (§3.5) — the service never filters by org in the WHERE clause and never
// switches tenants. Paging is keyset, never OFFSET.
//
// Three postures worth naming, because each is a decision rather than a detail:
//
//   • REACH. `actorMayReachPlan` is the read-side twin of the §4.8 `bereavement_window` predicate, and it
//     is deliberately WIDER in exactly one direction: a CLOSED plan is outside the window but must stay
//     readable by its own counselor and by oversight, or route 10 (the closure record the surveyor reads)
//     would 404 the moment the program it documents ended. Everything else is the same rule.
//   • REDACTION IS SHAPE, NOT STATUS. §7.13 and the D10 volunteer scope remove FIELDS; they never 403.
//     A withheld tier is ABSENT from the DTO (not `null`), and `redacted_categories` names the gate — so
//     "no score computed yet" and "not disclosed to you" can never be confused by a UI.
//   • COUNTS, NEVER RATES. Both dashboards report the CoP 418.64(d) numerator and denominator separately,
//     matching the §4.6 seam contract, so a 0/0 scope stays visibly 0/0 rather than becoming a fabricated
//     0% that CMS small-N suppression downstream can no longer catch.
import {
  bereavementWindowEnd,
  evaluateExternalSourceGate,
  isClosedPlanStatus,
  isWithinOptOutRescindWindow,
} from "@wardenx/bereavement";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  BereavementExternalSourceMetadata,
  BereavementOutreachKind,
  BereavementOutreachStatus,
  BereavementPlanClosureReason,
  BereavementPlanStatus,
  BereavementRiskTier,
  IsoInstant,
  M16OutreachStats,
  MembershipId,
} from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { BEREAVEMENT_OVERSIGHT_ROLES } from "../abac-predicates";
import { COP_DENOMINATOR_STATUSES, COP_NUMERATOR_STATUSES } from "../seams/store";
import type { M16ReadActor } from "./actor";
import {
  type CursorPage,
  M16_PAGE_SIZES,
  type PageSizePolicy,
  clampLimit,
  decodeCursor,
  toCursorPage,
} from "./concurrency";
import {
  type BereavementDisclosureDecision,
  type BereavementDisclosurePort,
  isBereavementVolunteer,
  resolveBereavementDisclosure,
  seamBereavementDisclosurePort,
} from "./disclosure";
import type {
  CounselorDashboardQuery,
  OutreachListQuery,
  PlanListQuery,
  RiskScoreListQuery,
  SupervisorDashboardQuery,
} from "./m16-typebox";
import type {
  BereavedContactRowView,
  BereavementClosureView,
  BereavementOutreachRowView,
  BereavementPlanDetail,
  BereavementPlanListItem,
  BereavementRiskScoreView,
  CounselorDashboardView,
  M16ReadService,
  SupervisorDashboardView,
} from "./read-service";
import { unreachableProposalOf } from "./read-service";

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
/** `date` columns come back as `YYYY-MM-DD` strings from the pg driver; keep them as-is. */
const localDate = (d: string | Date): string =>
  typeof d === "string" ? d : d.toISOString().slice(0, 10);

const MS_PER_DAY = 86_400_000;

/** Every plan status present at zero (a status with no plans is a real 0, not a gap in the chart). */
const EMPTY_PLAN_STATUS_COUNTS: { [K in BereavementPlanStatus]: number } = {
  eligible: 0,
  initiating: 0,
  active: 0,
  paused: 0,
  closed_completed: 0,
  closed_declined: 0,
  closed_early: 0,
  closed_legal_hold_extended: 0,
};

const EMPTY_OUTREACH_STATUS_COUNTS: { [K in BereavementOutreachStatus]: number } = {
  scheduled: 0,
  in_progress: 0,
  completed: 0,
  declined: 0,
  no_response: 0,
  missed: 0,
  cancelled: 0,
};

const EMPTY_TIER_COUNTS: { [K in BereavementRiskTier]: number } = {
  low: 0,
  moderate: 0,
  high: 0,
  complicated: 0,
};

const EMPTY_CLOSURE_COUNTS: { [K in BereavementPlanClosureReason]: number } = {
  thirteen_month_completion: 0,
  all_contacts_declined: 0,
  patient_opt_out_pre_death: 0,
  patient_opt_out_post_creation: 0,
  tenant_offboarding: 0,
  all_bereaved_deceased: 0,
  geographic_relocation: 0,
  family_legal_action: 0,
  other_early: 0,
};

// The CoP 418.64(d) numerator/denominator status sets moved to `../seams/store` (ONE definition, shared
// with the §4.6 seam store) so the dashboard and the M30/M33 seam reads can never disagree on a scope.

/** Deps the composition root may override (tests inject deterministic clocks + an in-memory M39 port). */
export interface M16ReadDeps {
  readonly now?: () => IsoInstant;
  readonly disclosure?: BereavementDisclosurePort;
}

export function buildDrizzleM16ReadService(db: DbClient, deps: M16ReadDeps = {}): M16ReadService {
  const PLAN = schema.bereavementPlan;
  const CONTACT = schema.bereavedContact;
  const OUTREACH = schema.bereavementOutreach;
  const SCORE = schema.bereavementRiskScore;
  const CLOSURE = schema.bereavementPlanClosure;
  const OPT_OUT = schema.bereavementOptOut;
  const GATE_OVERRIDE = schema.tenantBereavementExternalSourceGateOverride;

  const now = deps.now ?? (() => new Date().toISOString() as IsoInstant);
  const disclosurePort = deps.disclosure ?? seamBereavementDisclosurePort;

  const scope = (actor: M16ReadActor) => ({
    organizationId: actor.organizationId,
    userId: actor.userId,
  });

  const hasOversight = (actor: M16ReadActor): boolean =>
    BEREAVEMENT_OVERSIGHT_ROLES.some((role) => actor.roles.includes(role));

  /**
   * The read-side reach rule (see the module header). Oversight reads everything in the tenant; everyone
   * else must be the plan's own assigned counselor or volunteer. Unlike `bereavement_window` this does NOT
   * require the plan to be open, because the closure record only exists after it closed.
   */
  const actorMayReachPlan = (actor: M16ReadActor, plan: typeof PLAN.$inferSelect): boolean => {
    if (hasOversight(actor)) return true;
    if (actor.membershipId === null) return false;
    return (
      plan.assignedCounselorUserId === actor.membershipId ||
      plan.assignedVolunteerUserId === actor.membershipId
    );
  };

  const externalSourceOf = (
    row: typeof PLAN.$inferSelect,
  ): BereavementExternalSourceMetadata | null =>
    (row.externalSourceMetadata as BereavementExternalSourceMetadata | null) ?? null;

  const allowedKindsOf = (raw: unknown): BereavementOutreachKind[] => {
    const kinds = (raw as { allowed_kinds?: unknown } | null)?.allowed_kinds;
    return Array.isArray(kinds)
      ? kinds.filter((k): k is BereavementOutreachKind => typeof k === "string")
      : [];
  };

  const toOutreachRow = (r: typeof OUTREACH.$inferSelect): BereavementOutreachRowView => ({
    outreachId: r.id,
    planId: r.planId,
    contactId: r.bereavedContactId,
    kind: r.kind,
    status: r.status,
    anniversaryMark: r.anniversaryMark ?? null,
    dueAt: iso(r.dueAt) as IsoInstant,
    lateGraceUntil: iso(r.lateGraceUntil) as IsoInstant,
    startedAt: isoN(r.startedAt) as IsoInstant | null,
    completedAt: isoN(r.completedAt) as IsoInstant | null,
    cancelledAt: isoN(r.cancelledAt) as IsoInstant | null,
    assigneeUserId: r.assigneeUserId ?? null,
    renderedDocumentId: r.renderedDocumentId ?? null,
    sourceEncounterId: null,
    version: r.version,
  });

  const toContactRow = (
    r: typeof CONTACT.$inferSelect,
    gate: BereavementDisclosureDecision,
    openOptOutAt: string | null,
    asOf: IsoInstant,
  ): BereavedContactRowView => ({
    contactId: r.id,
    planId: r.planId,
    status: r.status,
    displayName: r.displayName,
    relationshipCode: r.relationshipCode,
    preferredLanguageIso639: r.preferredLanguageIso639,
    portalAccountId: r.portalAccountId ?? null,
    consentRecordId: r.consentRecordId ?? null,
    allowedOutreachKinds: allowedKindsOf(r.outreachPreferencesJsonb),
    volunteerVisibleOnly: r.volunteerVisibleOnly,
    confirmedAt: isoN(r.confirmedAt) as IsoInstant | null,
    optedOutAt: isoN(r.optedOutAt) as IsoInstant | null,
    unreachableAt: isoN(r.unreachableAt) as IsoInstant | null,
    ...unreachableProposalOf(r),
    deceasedAt: isoN(r.deceasedAt) as IsoInstant | null,
    mayRescindOptOut:
      r.status === "opted_out" &&
      openOptOutAt !== null &&
      isWithinOptOutRescindWindow(openOptOutAt, asOf),
    ...(gate.clinicalRiskAllowed ? { currentRiskTier: r.currentRiskTier ?? null } : {}),
    version: r.version,
  });

  /** Load a plan row + assert the caller may reach it. `null` becomes the route's 404. */
  async function loadReachablePlan(
    actor: M16ReadActor,
    planId: string,
  ): Promise<typeof PLAN.$inferSelect | null> {
    const row = await withOrgContext(db, scope(actor), async (tx) => {
      const [found] = await tx.select().from(PLAN).where(eq(PLAN.id, planId)).limit(1);
      return found ?? null;
    });
    if (!row) return null;
    return actorMayReachPlan(actor, row) ? row : null;
  }

  const pageLimit = (limit: unknown, policy: PageSizePolicy): number => clampLimit(limit, policy);

  return {
    // ── 1 — plan worklist (keyset on `updated_at DESC, id DESC`) ─────────────────────────────────────
    async listPlans(actor, query: PlanListQuery) {
      const limit = pageLimit(query.limit, M16_PAGE_SIZES.plans);
      const cursor = decodeCursor(query.cursor);
      const asOf = now();
      // §4.1 — "counselor caseload by default". A caller WITHOUT oversight sees only the plans they hold,
      // and the narrowing is a SQL predicate rather than a post-filter, so the page size is honest.
      const ownScope = !hasOversight(actor);

      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [
          query.patientId ? eq(PLAN.patientId, query.patientId) : undefined,
          query.admissionId ? eq(PLAN.admissionId, query.admissionId) : undefined,
          query.status ? eq(PLAN.status, query.status) : undefined,
          query.riskTier ? eq(PLAN.currentRiskTier, query.riskTier) : undefined,
          query.counselorUserId
            ? eq(PLAN.assignedCounselorUserId, query.counselorUserId)
            : undefined,
          ownScope && actor.membershipId !== null
            ? or(
                eq(PLAN.assignedCounselorUserId, actor.membershipId),
                eq(PLAN.assignedVolunteerUserId, actor.membershipId),
              )
            : undefined,
          // A caller with neither oversight nor a membership holds no caseload at all.
          ownScope && actor.membershipId === null ? sql`false` : undefined,
          cursor
            ? or(
                lt(PLAN.updatedAt, new Date(cursor.a)),
                and(eq(PLAN.updatedAt, new Date(cursor.a)), lt(PLAN.id, cursor.id)),
              )
            : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);

        return tx
          .select()
          .from(PLAN)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(desc(PLAN.updatedAt), desc(PLAN.id))
          .limit(limit + 1);
      });

      const planIds = rows.map((r) => r.id);
      const [activeCounts, dueRows] = await withOrgContext(db, scope(actor), async (tx) => {
        if (planIds.length === 0) return [new Map<string, number>(), []] as const;
        const contacts = await tx
          .select({ planId: CONTACT.planId, n: sql<number>`count(*)::int` })
          .from(CONTACT)
          .where(and(inArray(CONTACT.planId, planIds), eq(CONTACT.status, "active")))
          .groupBy(CONTACT.planId);
        const due = await tx
          .select({
            planId: OUTREACH.planId,
            nextDueAt: sql<Date | null>`min(${OUTREACH.dueAt}) filter (where ${OUTREACH.status} = 'scheduled')`,
            overdue: sql<number>`count(*) filter (where ${OUTREACH.status} = 'missed')::int`,
          })
          .from(OUTREACH)
          .where(inArray(OUTREACH.planId, planIds))
          .groupBy(OUTREACH.planId);
        return [new Map(contacts.map((c) => [c.planId, c.n])), due] as const;
      });
      const dueByPlan = new Map(dueRows.map((d) => [d.planId, d]));

      // The D10 volunteer scope is an ACTOR fact, not a per-plan one, so it is decided once per page
      // rather than per row — a volunteer never sees a tier, whichever decedent's plan it hangs off. The
      // Part 2 half of the gate is per-DECEDENT and only bears on the factor vector (route 29), so the
      // list route does not pay for a consent round-trip per row.
      const clinicalRiskAllowed = !isBereavementVolunteer(actor);

      return toCursorPage(
        rows,
        limit,
        (r) => ({ a: iso(r.updatedAt), id: r.id }),
        (r): BereavementPlanListItem => {
          const due = dueByPlan.get(r.id);
          const external = externalSourceOf(r);
          return {
            planId: r.id,
            patientId: r.patientId,
            admissionId: r.admissionId,
            status: r.status,
            deathDate: localDate(r.deathDate),
            windowEndsAt: bereavementWindowEnd(localDate(r.deathDate)) as IsoInstant,
            assignedCounselorUserId: r.assignedCounselorUserId ?? null,
            assignedVolunteerUserId: r.assignedVolunteerUserId ?? null,
            ...(clinicalRiskAllowed ? { currentRiskTier: r.currentRiskTier ?? null } : {}),
            contactsActiveCount: activeCounts.get(r.id) ?? 0,
            nextOutreachDueAt: due?.nextDueAt ? (iso(due.nextDueAt) as IsoInstant) : null,
            overdueOutreachCount: due?.overdue ?? 0,
            externalSourceCosignPending: external?.cosignStatus === "pending",
            version: r.version,
            updatedAt: iso(r.updatedAt) as IsoInstant,
          };
        },
      ) satisfies CursorPage<BereavementPlanListItem>;
    },

    // ── 2 — plan detail + roster + the D18 first-contact verdict ─────────────────────────────────────
    async getPlan(actor, planId) {
      const plan = await loadReachablePlan(actor, planId);
      if (plan === null) return null;
      const gate = await resolveBereavementDisclosure(actor, plan.patientId, disclosurePort);
      const asOf = now();

      return withOrgContext(db, scope(actor), async (tx) => {
        const contacts = await tx
          .select()
          .from(CONTACT)
          .where(eq(CONTACT.planId, planId))
          .orderBy(asc(CONTACT.createdAt), asc(CONTACT.id));

        const openOptOuts = await tx
          .select({ contactId: OPT_OUT.bereavedContactId, optedOutAt: OPT_OUT.optedOutAt })
          .from(OPT_OUT)
          .where(and(eq(OPT_OUT.planId, planId), isNull(OPT_OUT.rescindedAt)));
        const optOutAt = new Map(openOptOuts.map((o) => [o.contactId, iso(o.optedOutAt)]));

        const [stats] = await tx
          .select({
            completedCount: sql<number>`count(*) filter (where ${OUTREACH.status} in ('completed','declined'))::int`,
            missedCount: sql<number>`count(*) filter (where ${OUTREACH.status} = 'missed')::int`,
          })
          .from(OUTREACH)
          .where(eq(OUTREACH.planId, planId));

        const [override] = await tx.select().from(GATE_OVERRIDE).limit(1);

        const external = externalSourceOf(plan);
        // D18 — the SAME pure decision the route-33 service enforces, surfaced as a read so the UI can
        // disable the first-contact button instead of letting the counselor discover the 409 by clicking.
        const verdict = evaluateExternalSourceGate(
          external,
          override
            ? {
                requireDeathCertificateUploaded: override.requireDeathCertificateUploaded,
                requireCoordinatorAcknowledgment: override.requireCoordinatorAcknowledgment,
              }
            : null,
          { hasDeathCertificate: false, hasCoordinatorAcknowledgment: false },
        );

        const contactsActiveCount = contacts.filter((c) => c.status === "active").length;
        const contactsOptedOutCount = contacts.filter((c) => c.status === "opted_out").length;
        const outreachStats: M16OutreachStats = {
          completedCount: stats?.completedCount ?? 0,
          missedCount: stats?.missedCount ?? 0,
          contactsActiveCount,
          contactsOptedOutCount,
        };

        const detail: BereavementPlanDetail = {
          planId: plan.id,
          patientId: plan.patientId,
          admissionId: plan.admissionId,
          providerEntityId: plan.providerEntityId,
          locationId: plan.locationId ?? null,
          status: plan.status,
          deathDate: localDate(plan.deathDate),
          deathTime: isoN(plan.deathTime) as IsoInstant | null,
          windowEndsAt: bereavementWindowEnd(localDate(plan.deathDate)) as IsoInstant,
          openedAt: isoN(plan.openedAt) as IsoInstant | null,
          pausedAt: isoN(plan.pausedAt) as IsoInstant | null,
          pauseKind: plan.pauseKind ?? null,
          closedAt: isoN(plan.closedAt) as IsoInstant | null,
          assignedCounselorUserId: plan.assignedCounselorUserId ?? null,
          assignedCounselorAssignedAt: isoN(plan.assignedCounselorAssignedAt) as IsoInstant | null,
          assignedVolunteerUserId: plan.assignedVolunteerUserId ?? null,
          assignedVolunteerAssignedAt: isoN(plan.assignedVolunteerAssignedAt) as IsoInstant | null,
          externalSource: external,
          firstContactAllowed: verdict.allowed,
          firstContactGateReason: verdict.allowed ? null : verdict.code,
          contacts: contacts.map((c) => toContactRow(c, gate, optOutAt.get(c.id) ?? null, asOf)),
          stats: outreachStats,
          ...(gate.clinicalRiskAllowed
            ? {
                currentRiskTier: plan.currentRiskTier ?? null,
                currentRiskComputedAt: isoN(plan.currentRiskComputedAt) as IsoInstant | null,
              }
            : {}),
          legalHoldId: plan.legalHoldId ?? null,
          earlyCloseRequest:
            plan.earlyCloseReason && plan.earlyCloseRequestedAt && plan.earlyCloseRequestedByUserId
              ? {
                  reason: plan.earlyCloseReason,
                  requestedAt: iso(plan.earlyCloseRequestedAt) as IsoInstant,
                  requestedByUserId: plan.earlyCloseRequestedByUserId as MembershipId,
                }
              : null,
          version: plan.version,
          updatedAt: iso(plan.updatedAt) as IsoInstant,
          redactedCategories: gate.redactedCategories,
        };
        return detail;
      });
    },

    // ── 10 — the §3.3.7 closure record ──────────────────────────────────────────────────────────────
    async getClosure(actor, planId) {
      const plan = await loadReachablePlan(actor, planId);
      if (plan === null) return null;
      return withOrgContext(db, scope(actor), async (tx) => {
        const [row] = await tx.select().from(CLOSURE).where(eq(CLOSURE.planId, planId)).limit(1);
        if (!row) return null;
        const view: BereavementClosureView = {
          closureId: row.id,
          planId: row.planId,
          reason: row.reason,
          closeKind: row.closeKind,
          closedAt: iso(row.closedAt) as IsoInstant,
          closedByUserId: row.closedByUserId ?? null,
          cosignedByUserId: row.cosignedByUserId ?? null,
          cosignedAt: isoN(row.cosignedAt) as IsoInstant | null,
          stats: {
            completedCount: row.outreachCompletedCount,
            missedCount: row.outreachMissedCount,
            contactsActiveCount: row.contactsActiveCount,
            contactsOptedOutCount: row.contactsOptedOutCount,
          },
          bereavementSummaryDocumentId: row.bereavementSummaryDocumentId ?? null,
        };
        return view;
      });
    },

    // ── 19 — the plan's touchpoints (keyset on `due_at ASC, id ASC`) ─────────────────────────────────
    async listOutreach(actor, planId, query: OutreachListQuery) {
      const plan = await loadReachablePlan(actor, planId);
      if (plan === null) return null;
      const limit = pageLimit(query.limit, M16_PAGE_SIZES.outreach);
      const cursor = decodeCursor(query.cursor);
      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [
          eq(OUTREACH.planId, planId),
          query.contactId ? eq(OUTREACH.bereavedContactId, query.contactId) : undefined,
          query.status ? eq(OUTREACH.status, query.status) : undefined,
          query.kind ? eq(OUTREACH.kind, query.kind) : undefined,
          query.dueFrom ? gte(OUTREACH.dueAt, new Date(query.dueFrom)) : undefined,
          query.dueTo ? lte(OUTREACH.dueAt, new Date(query.dueTo)) : undefined,
          cursor
            ? or(
                sql`${OUTREACH.dueAt} > ${new Date(cursor.a)}`,
                and(eq(OUTREACH.dueAt, new Date(cursor.a)), sql`${OUTREACH.id} > ${cursor.id}`),
              )
            : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return tx
          .select()
          .from(OUTREACH)
          .where(and(...filters))
          .orderBy(asc(OUTREACH.dueAt), asc(OUTREACH.id))
          .limit(limit + 1);
      });
      return toCursorPage(rows, limit, (r) => ({ a: iso(r.dueAt), id: r.id }), toOutreachRow);
    },

    // ── 29 — the append-only score ledger (keyset on `assessed_at DESC, id DESC`) ────────────────────
    async listRiskScores(actor, planId, query: RiskScoreListQuery) {
      const plan = await loadReachablePlan(actor, planId);
      if (plan === null) return null;
      const gate = await resolveBereavementDisclosure(actor, plan.patientId, disclosurePort);
      const limit = pageLimit(query.limit, M16_PAGE_SIZES.riskScores);
      const cursor = decodeCursor(query.cursor);
      const rows = await withOrgContext(db, scope(actor), async (tx) => {
        const filters = [
          eq(SCORE.planId, planId),
          query.contactId ? eq(SCORE.bereavedContactId, query.contactId) : undefined,
          cursor
            ? or(
                lt(SCORE.assessedAt, new Date(cursor.a)),
                and(eq(SCORE.assessedAt, new Date(cursor.a)), lt(SCORE.id, cursor.id)),
              )
            : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        return tx
          .select()
          .from(SCORE)
          .where(and(...filters))
          .orderBy(desc(SCORE.assessedAt), desc(SCORE.id))
          .limit(limit + 1);
      });

      return toCursorPage(
        rows,
        limit,
        (r) => ({ a: iso(r.assessedAt), id: r.id }),
        (r): BereavementRiskScoreView => {
          const payload = (r.riskFactorsJsonb ?? {}) as {
            factors?: Record<string, boolean | "unknown">;
            pg13Score?: number | null;
            ipgrScore?: number | null;
            deterministicTier?: BereavementRiskTier;
            evidenceDegraded?: boolean;
          };
          // §7.13 — the `active_substance_use` slot is Part 2 content. An uncleared reader does not get a
          // `false` for it (that would read as a documented negative); the whole vector is withheld and the
          // category is named, which is the only answer that cannot be mistaken for a clinical finding.
          const factorsVisible = gate.clinicalRiskAllowed && gate.sudAllowed;
          return {
            scoreId: r.id,
            planId: r.planId,
            contactId: r.bereavedContactId ?? null,
            scoreKind: r.scoreKind,
            assessedAt: iso(r.assessedAt) as IsoInstant,
            assessedByUserId: r.assessedByUserId ?? null,
            tier: r.ruleTier,
            deterministicTier: payload.deterministicTier ?? r.ruleTier,
            ruleScore: r.ruleScore,
            dataCompleteness: r.dataCompleteness,
            confidenceBand: r.confidenceBand,
            ...(factorsVisible && payload.factors ? { factors: payload.factors } : {}),
            pg13Score: payload.pg13Score ?? null,
            ipgrScore: payload.ipgrScore ?? null,
            evidenceDegraded: payload.evidenceDegraded === true,
            redactedCategories: gate.redactedCategories,
          };
        },
      );
    },

    // ── 30 — the counselor's own caseload + what is coming due ───────────────────────────────────────
    async counselorDashboard(actor, query: CounselorDashboardQuery) {
      const dueWithinDays = query.dueWithinDays ?? 14;
      const limit = pageLimit(query.limit, M16_PAGE_SIZES.dashboard);
      const asOf = now();
      const horizon = new Date(Date.parse(asOf) + dueWithinDays * MS_PER_DAY);
      const membershipId = actor.membershipId;
      if (membershipId === null) {
        // A session with no workforce membership holds no caseload. Answering zeros is the honest shape;
        // 403-ing here would be the guard's job, and the guard already ran.
        return {
          counselorUserId: "" as CounselorDashboardView["counselorUserId"],
          caseloadCount: 0,
          dueWithinDays,
          dueSoon: [],
          overdue: [],
          tierDistribution: { ...EMPTY_TIER_COUNTS },
          externalSourceCosignPendingCount: 0,
        };
      }

      return withOrgContext(db, scope(actor), async (tx) => {
        const plans = await tx
          .select()
          .from(PLAN)
          .where(
            and(
              eq(PLAN.assignedCounselorUserId, membershipId),
              inArray(PLAN.status, ["eligible", "initiating", "active", "paused"]),
            ),
          );
        const planIds = plans.map((p) => p.id);

        const [dueSoon, overdue, tiers] =
          planIds.length === 0
            ? [[], [], []]
            : await Promise.all([
                tx
                  .select()
                  .from(OUTREACH)
                  .where(
                    and(
                      inArray(OUTREACH.planId, planIds),
                      eq(OUTREACH.status, "scheduled"),
                      lte(OUTREACH.dueAt, horizon),
                    ),
                  )
                  .orderBy(asc(OUTREACH.dueAt), asc(OUTREACH.id))
                  .limit(limit),
                tx
                  .select()
                  .from(OUTREACH)
                  .where(and(inArray(OUTREACH.planId, planIds), eq(OUTREACH.status, "missed")))
                  .orderBy(asc(OUTREACH.dueAt), asc(OUTREACH.id))
                  .limit(limit),
                tx
                  .select({
                    tier: CONTACT.currentRiskTier,
                    n: sql<number>`count(*)::int`,
                  })
                  .from(CONTACT)
                  .where(and(inArray(CONTACT.planId, planIds), eq(CONTACT.status, "active")))
                  .groupBy(CONTACT.currentRiskTier),
              ]);

        const tierDistribution = { ...EMPTY_TIER_COUNTS };
        for (const row of tiers) {
          if (row.tier !== null) tierDistribution[row.tier] = row.n;
        }

        const view: CounselorDashboardView = {
          counselorUserId: membershipId as CounselorDashboardView["counselorUserId"],
          caseloadCount: plans.length,
          dueWithinDays,
          dueSoon: dueSoon.map(toOutreachRow),
          overdue: overdue.map(toOutreachRow),
          tierDistribution,
          externalSourceCosignPendingCount: plans.filter(
            (p) => externalSourceOf(p)?.cosignStatus === "pending",
          ).length,
        };
        return view;
      });
    },

    // ── 31 — full-tenant rollups (COUNTS, never rates) ───────────────────────────────────────────────
    async supervisorDashboard(actor, query: SupervisorDashboardQuery) {
      return withOrgContext(db, scope(actor), async (tx) => {
        const planScope = [
          query.providerEntityId ? eq(PLAN.providerEntityId, query.providerEntityId) : undefined,
          query.locationId ? eq(PLAN.locationId, query.locationId) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);
        const outreachScope = [
          query.providerEntityId
            ? eq(OUTREACH.providerEntityId, query.providerEntityId)
            : undefined,
          query.locationId ? eq(OUTREACH.locationId, query.locationId) : undefined,
        ].filter((f): f is NonNullable<typeof f> => f !== undefined);

        const planRows = await tx
          .select({ status: PLAN.status, n: sql<number>`count(*)::int` })
          .from(PLAN)
          .where(planScope.length > 0 ? and(...planScope) : undefined)
          .groupBy(PLAN.status);

        const outreachRows = await tx
          .select({ status: OUTREACH.status, n: sql<number>`count(*)::int` })
          .from(OUTREACH)
          .where(outreachScope.length > 0 ? and(...outreachScope) : undefined)
          .groupBy(OUTREACH.status);

        const tierRows = await tx
          .select({ tier: CONTACT.currentRiskTier, n: sql<number>`count(*)::int` })
          .from(CONTACT)
          .where(
            and(
              eq(CONTACT.status, "active"),
              ...(query.providerEntityId
                ? [eq(CONTACT.providerEntityId, query.providerEntityId)]
                : []),
              ...(query.locationId ? [eq(CONTACT.locationId, query.locationId)] : []),
            ),
          )
          .groupBy(CONTACT.currentRiskTier);

        const closureRows = await tx
          .select({ reason: CLOSURE.reason, n: sql<number>`count(*)::int` })
          .from(CLOSURE)
          .where(
            query.providerEntityId
              ? eq(CLOSURE.providerEntityId, query.providerEntityId)
              : undefined,
          )
          .groupBy(CLOSURE.reason);

        const [unassigned] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(PLAN)
          .where(
            and(
              isNull(PLAN.assignedCounselorUserId),
              inArray(PLAN.status, ["eligible", "initiating"]),
              ...planScope,
            ),
          );

        const [pendingCosign] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(PLAN)
          .where(
            and(
              sql`${PLAN.externalSourceMetadata} IS NOT NULL`,
              sql`${PLAN.externalSourceMetadata}->>'cosignStatus' = 'pending'`,
              ...planScope,
            ),
          );

        const planCountsByStatus = { ...EMPTY_PLAN_STATUS_COUNTS };
        for (const row of planRows) planCountsByStatus[row.status] = row.n;
        const outreachCountsByStatus = { ...EMPTY_OUTREACH_STATUS_COUNTS };
        for (const row of outreachRows) outreachCountsByStatus[row.status] = row.n;
        const tierDistribution = { ...EMPTY_TIER_COUNTS };
        for (const row of tierRows) if (row.tier !== null) tierDistribution[row.tier] = row.n;
        const closureCountsByReason = { ...EMPTY_CLOSURE_COUNTS };
        for (const row of closureRows) closureCountsByReason[row.reason] = row.n;

        const sumOf = (statuses: readonly BereavementOutreachStatus[]): number =>
          statuses.reduce((total, s) => total + outreachCountsByStatus[s], 0);

        const view: SupervisorDashboardView = {
          planCountsByStatus,
          outreachCountsByStatus,
          copCounts: {
            numerator: sumOf(COP_NUMERATOR_STATUSES),
            denominator: sumOf(COP_DENOMINATOR_STATUSES),
          },
          tierDistribution,
          closureCountsByReason,
          unassignedPlanCount: unassigned?.n ?? 0,
          externalSourceCosignPendingCount: pendingCosign?.n ?? 0,
        };
        return view;
      });
    },
  };
}

/** Re-exported so the write service can reuse the ONE reach rule rather than restating it. */
export { isClosedPlanStatus };
