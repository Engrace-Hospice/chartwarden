// apps/backend/src/modules/25-remittance/routes/read-service-drizzle.ts — the Drizzle-backed M25 READ
// service. Every method opens `withOrgContext(db, {organizationId, userId}, tx => …)` so Postgres RLS
// scopes each statement to the acting org; keyset pagination is `(ts DESC, id DESC)` over the resource's
// anchor timestamp. The taxonomy merge layers the per-tenant overlay on the injected M38 terminology
// lookup (the composition root binds the real TerminologyProvider; absent ⇒ category 'unmapped' floor).
import { type DbClient, schema } from "@chartwarden/db";
import { RegulatoryDecimal } from "@chartwarden/shared/money";
import { withOrgContext } from "@chartwarden/tenancy";
import { type SQL, and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  type AgingBucketLabel,
  type AppealTier,
  agingBucketLabel,
  deriveTierDeadline,
} from "../domain";
import type { M25ReadActor } from "./actor";
import { type CursorPage, decodeCursor, encodeCursor } from "./concurrency";
import type {
  AppealDetail,
  AppealSummary,
  DenialMetricsView,
  DenialWorklistFilters,
  DenialWorklistItem,
  M25ReadService,
  PrLedgerRow,
  RemittanceAdviceSummary,
  RemittanceLineSummary,
  TaxonomyMergedView,
} from "./read-service";
import { providerEntityScopeCondition } from "./scope";

/** An injected M38 CARC/RARC lookup (the composition root binds TerminologyProvider; default = floor). */
export interface TerminologyLookupPort {
  lookup(
    carcCode: string,
    rarcCode: string | null,
  ): Promise<{ category: string; plainLanguage: string } | null>;
}

const DENY_TERMINOLOGY: TerminologyLookupPort = {
  async lookup() {
    return null;
  },
};

const iso = (d: Date | string | null): string =>
  d === null ? "" : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

const AGING_LABELS: AgingBucketLabel[] = ["0-7", "8-15", "16-30", "31-60", "61-90", "91+"];

export function buildDrizzleM25ReadService(
  db: DbClient,
  terminology: TerminologyLookupPort = DENY_TERMINOLOGY,
): M25ReadService {
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const DC = schema.denialCase;
  const AC = schema.appealCase;
  const AE = schema.appealCaseEvent;
  const TO = schema.denialTaxonomyOverlay;
  const PR = schema.patientResponsibilityLedger;

  /**
   * GAP-148 — the provider-entity scope condition, from the SERVER-assembled actor. `undefined` scope =
   * unrestricted (org-wide oversight role / service principal): only the caller's optional filter applies. A
   * scoped actor is narrowed to its entities; a filter naming an entity outside the scope, or an empty scope,
   * matches nothing (an out-of-scope row reads as absent, never as forbidden).
   */
  const peScope = (
    column: Parameters<typeof eq>[0],
    actor: M25ReadActor,
    requested?: string,
  ): SQL | undefined => providerEntityScopeCondition(column, actor.providerEntityScope, requested);
  /** The same scope over a remittance LINE, which carries no provider entity of its own (its advice does). */
  const lineScope = (actor: M25ReadActor): SQL | undefined => {
    const adviceScope = peScope(RA.providerEntityId, actor);
    return adviceScope
      ? sql`${RL.remittanceAdviceId} IN (SELECT ${RA.id} FROM ${RA} WHERE ${adviceScope})`
      : undefined;
  };

  return {
    async listAdvices(actor, filters, cursor, limit) {
      const c = decodeCursor(cursor);
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          peScope(RA.providerEntityId, actor, filters.providerEntityId),
          filters.parseStatus
            ? eq(RA.parseStatus, filters.parseStatus as (typeof RA.parseStatus.enumValues)[number])
            : undefined,
          c
            ? or(
                lt(RA.receivedAt, new Date(c.createdAt)),
                and(eq(RA.receivedAt, new Date(c.createdAt)), lt(RA.id, c.id)),
              )
            : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(RA)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(RA.receivedAt), desc(RA.id))
          .limit(limit + 1);
        return page(
          rows,
          limit,
          (r) => ({ createdAt: iso(r.receivedAt), id: r.id }),
          toAdviceSummary,
        );
      });
    },

    async getAdvice(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(RA)
          .where(and(eq(RA.id, id), peScope(RA.providerEntityId, actor)))
          .limit(1);
        return rows[0] ? toAdviceSummary(rows[0]) : null;
      });
    },

    async listLines(actor, filters, cursor, limit) {
      const c = decodeCursor(cursor);
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          lineScope(actor),
          filters.remittanceAdviceId
            ? eq(RL.remittanceAdviceId, filters.remittanceAdviceId)
            : undefined,
          filters.matchState
            ? eq(RL.matchState, filters.matchState as (typeof RL.matchState.enumValues)[number])
            : undefined,
          c
            ? or(
                lt(RL.receivedAt, new Date(c.createdAt)),
                and(eq(RL.receivedAt, new Date(c.createdAt)), lt(RL.id, c.id)),
              )
            : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(RL)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(RL.receivedAt), desc(RL.id))
          .limit(limit + 1);
        return page(
          rows,
          limit,
          (r) => ({ createdAt: iso(r.receivedAt), id: r.id }),
          toLineSummary,
        );
      });
    },

    async getLine(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(RL)
          .where(and(eq(RL.id, id), lineScope(actor)))
          .limit(1);
        return rows[0] ? toLineSummary(rows[0]) : null;
      });
    },

    async listUnmatched(actor, providerEntityId, cursor, limit) {
      const c = decodeCursor(cursor);
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          eq(RL.matchState, "unmatched"),
          providerEntityId
            ? sql`${RL.remittanceAdviceId} IN (SELECT id FROM ${RA} WHERE ${RA.providerEntityId} = ${providerEntityId})`
            : undefined,
          lineScope(actor),
          c
            ? or(
                lt(RL.receivedAt, new Date(c.createdAt)),
                and(eq(RL.receivedAt, new Date(c.createdAt)), lt(RL.id, c.id)),
              )
            : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(RL)
          .where(and(...(conds as [])))
          .orderBy(desc(RL.receivedAt), desc(RL.id))
          .limit(limit + 1);
        return page(
          rows,
          limit,
          (r) => ({ createdAt: iso(r.receivedAt), id: r.id }),
          toLineSummary,
        );
      });
    },

    async denialWorklist(actor, filters, cursor, limit) {
      const c = decodeCursor(cursor);
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          peScope(DC.providerEntityId, actor, filters.providerEntityId),
          filters.assigneeMembershipId
            ? eq(DC.assigneeMembershipId, filters.assigneeMembershipId)
            : undefined,
          filters.state
            ? eq(DC.state, filters.state as (typeof DC.state.enumValues)[number])
            : undefined,
          filters.carcCode ? eq(DC.carcCode, filters.carcCode) : undefined,
          filters.minDollar !== undefined
            ? gte(DC.dollarValue, String(filters.minDollar))
            : undefined,
          c
            ? or(
                lt(DC.openedAt, new Date(c.createdAt)),
                and(eq(DC.openedAt, new Date(c.createdAt)), lt(DC.id, c.id)),
              )
            : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(DC)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(DC.openedAt), desc(DC.id))
          .limit(limit + 1);
        return page(rows, limit, (r) => ({ createdAt: iso(r.openedAt), id: r.id }), toDenialItem);
      });
    },

    async getDenial(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(DC)
          .where(and(eq(DC.id, id), peScope(DC.providerEntityId, actor)))
          .limit(1);
        return rows[0] ? toDenialItem(rows[0]) : null;
      });
    },

    async listAppeals(actor, filters, cursor, limit) {
      const c = decodeCursor(cursor);
      return withOrgContext(db, actor, async (tx) => {
        const conds = [
          filters.state
            ? eq(AC.state, filters.state as (typeof AC.state.enumValues)[number])
            : undefined,
          filters.tier
            ? eq(AC.tier, filters.tier as (typeof AC.tier.enumValues)[number])
            : undefined,
          peScope(AC.providerEntityId, actor),
          c
            ? or(
                lt(AC.createdAt, new Date(c.createdAt)),
                and(eq(AC.createdAt, new Date(c.createdAt)), lt(AC.id, c.id)),
              )
            : undefined,
        ].filter(Boolean);
        const rows = await tx
          .select()
          .from(AC)
          .where(conds.length ? and(...(conds as [])) : undefined)
          .orderBy(desc(AC.createdAt), desc(AC.id))
          .limit(limit + 1);
        return page(
          rows,
          limit,
          (r) => ({ createdAt: iso(r.createdAt), id: r.id }),
          toAppealSummary,
        );
      });
    },

    async getAppeal(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(AC)
          .where(and(eq(AC.id, id), peScope(AC.providerEntityId, actor)))
          .limit(1);
        if (!rows[0]) return null;
        const events = await tx
          .select({ id: AE.id, eventKind: AE.eventKind, occurredAt: AE.occurredAt })
          .from(AE)
          .where(eq(AE.appealCaseId, id))
          .orderBy(desc(AE.occurredAt))
          .limit(200);
        const detail: AppealDetail = {
          ...toAppealSummary(rows[0]),
          appealPacketDocumentId: rows[0].appealPacketDocumentId,
          submittedAt: rows[0].submittedAt ? iso(rows[0].submittedAt) : null,
          decidedAt: rows[0].decidedAt ? iso(rows[0].decidedAt) : null,
          events: events.map((e) => ({
            id: e.id,
            eventKind: e.eventKind,
            occurredAt: iso(e.occurredAt),
          })),
        };
        return detail;
      });
    },

    async taxonomyView(actor, carcCode) {
      const floor = await terminology.lookup(carcCode, null);
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select().from(TO).where(eq(TO.carcCode, carcCode)).limit(1);
        const overlay = rows[0];
        const view: TaxonomyMergedView = {
          carcCode,
          rarcCode: overlay?.rarcCode ?? null,
          category: floor?.category ?? "unmapped",
          plainLanguage: overlay?.plainLanguageOverride ?? floor?.plainLanguage ?? "",
          suggestedAction: overlay?.suggestedAction ?? null,
          ownerRole: overlay?.ownerRole ?? null,
          severity: overlay?.severity ?? null,
          hasOverlay: !!overlay,
          overlayVersion: overlay?.version ?? null,
        };
        return view;
      });
    },

    async denialMetrics(actor) {
      return withOrgContext(db, actor, async (tx) => {
        const open = await tx
          .select({ bucket: DC.agingBucketDays, dollar: DC.dollarValue })
          .from(DC)
          .where(
            and(
              sql`${DC.state} IN ('open','in_progress','escalated')`,
              peScope(DC.providerEntityId, actor),
            ),
          )
          .limit(100000);
        const counts = Object.fromEntries(AGING_LABELS.map((l) => [l, 0])) as Record<
          AgingBucketLabel,
          number
        >;
        // Decimal-exact accumulation (PARAM-003) — `dollar` is a `numeric(12,2)` string; summing via plain
        // float `+=` risks penny drift across up to 100k open denials. `totalDollarOpen` is itself declared
        // a decimal string (never a float) on the response contract.
        let totalDollar = new RegulatoryDecimal(0);
        for (const row of open) {
          counts[agingBucketLabel(row.bucket)] += 1;
          totalDollar = totalDollar.plus(row.dollar);
        }
        return {
          agingBucketCounts: counts,
          openCount: open.length,
          totalDollarOpen: totalDollar.toFixed(2),
        };
      });
    },

    async prLedger(actor, patientId) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select()
          .from(PR)
          .where(patientId ? eq(PR.patientId, patientId) : undefined)
          .orderBy(desc(PR.recordedAt))
          .limit(500);
        return rows.map(
          (r): PrLedgerRow => ({
            id: r.id,
            patientId: r.patientId,
            prAmount: r.prAmount,
            status: r.status,
            recordedAt: iso(r.recordedAt),
          }),
        );
      });
    },
  };

  // ---- row → DTO projectors ----
  function toAdviceSummary(r: typeof RA.$inferSelect): RemittanceAdviceSummary {
    return {
      id: r.id,
      providerEntityId: r.providerEntityId,
      payerId: r.payerId,
      payerKind: r.payerKind,
      paymentMethod: r.paymentMethod,
      totalPaymentAmount: r.totalPaymentAmount,
      parseStatus: r.parseStatus,
      receivedAt: iso(r.receivedAt),
    };
  }
  function toLineSummary(r: typeof RL.$inferSelect): RemittanceLineSummary {
    return {
      id: r.id,
      remittanceAdviceId: r.remittanceAdviceId,
      claimId: r.claimId,
      clp02StatusCode: r.clp02StatusCode,
      clp03TotalChargeAmount: r.clp03TotalChargeAmount,
      clp04TotalPaymentAmount: r.clp04TotalPaymentAmount,
      clp05PatientResponsibilityAmount: r.clp05PatientResponsibilityAmount,
      matchState: r.matchState,
      matchStrategy: r.matchStrategy,
      matchConfidence: r.matchConfidence,
      receivedAt: iso(r.receivedAt),
    };
  }
  function toDenialItem(r: typeof DC.$inferSelect): DenialWorklistItem {
    return {
      id: r.id,
      providerEntityId: r.providerEntityId,
      claimId: r.claimId,
      carcCode: r.carcCode,
      rarcCode: r.rarcCode,
      category: r.category,
      source: r.source,
      state: r.state,
      assigneeMembershipId: r.assigneeMembershipId,
      openedAt: iso(r.openedAt),
      agingBucketDays: r.agingBucketDays,
      agingBucketLabel: agingBucketLabel(r.agingBucketDays),
      dollarValue: r.dollarValue,
      taxonomyStatus: r.taxonomyStatus,
      version: r.version,
    };
  }
  function toAppealSummary(r: typeof AC.$inferSelect): AppealSummary {
    // Rows created before CMS-correct deadlines carry no notice date: show their stored deadline as it was.
    const derived = r.noticeDatedOn
      ? deriveTierDeadline(r.tier as AppealTier, r.noticeDatedOn)
      : null;
    return {
      id: r.id,
      denialCaseId: r.denialCaseId,
      claimId: r.claimId,
      tier: r.tier,
      state: r.state,
      decisionOutcome: r.decisionOutcome,
      tierDeadlineAt: iso(r.tierDeadlineAt),
      noticeDatedOn: r.noticeDatedOn,
      presumedReceiptOn: derived?.presumedReceiptOn ?? null,
      windowDays: derived?.windowDays ?? null,
      lastFilingDay: derived?.lastFilingDay ?? null,
      filedByEscalation: r.filedByEscalation,
      version: r.version,
    };
  }
}

/** Keyset page helper: take `limit+1` rows, derive `nextCursor` from the last kept row. */
function page<TRow, TOut>(
  rows: TRow[],
  limit: number,
  keyOf: (r: TRow) => { createdAt: string; id: string },
  project: (r: TRow) => TOut,
): CursorPage<TOut> {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  return {
    items: kept.map(project),
    nextCursor: hasMore && last ? encodeCursor(keyOf(last)) : null,
  };
}
