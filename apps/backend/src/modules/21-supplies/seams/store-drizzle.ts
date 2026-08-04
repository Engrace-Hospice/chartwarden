// apps/backend/src/modules/21-supplies/seams/store-drizzle.ts — M21-T05, the Drizzle-backed
// {@link SuppliesSeamStore} the three §4.8 published seams read through.
//
// TENANCY. Every read opens `withOrgContextFromRequest`, which pins `app.org_id` from the CONSUMER'S
// ambient request context. That is the whole tenancy story: M21's seams take no orgId argument and the
// providers never switch tenants — M13 asking for a patient's kits gets M13's caller's org, because RLS
// scoped the statement, not because this file compared anything. Called outside a request scope (a platform
// job that forgot `runWithRequestContext`) it THROWS rather than reading unscoped, which is the correct
// direction for a surface that publishes controlled-substance inventory.
//
// PARTITIONED PARENTS. `supply_request` (by `created_at`) and `comfort_kit_dispatch` (by `dispatched_at`)
// are monthly RANGE partitions, so an id-only lookup fans out across every partition. The reads here stay
// id-keyed anyway — a seam consumer has an id and no time window, and inventing one would silently miss a
// kit dispatched last month. The `comfort_kit_dispatch_patient_idx` / `_supply_req_idx` indexes carry the
// per-partition cost; this is the same trade `comfort_kit_dispatched_content.dispatch_partition_dispatched_at`
// exists to let a caller avoid when it DOES have the parent's key in hand.
//
// COST ACCRUAL. The two cost reads sum `supply_request.invoice_total_cents` over rows whose
// `invoice_accrued_at` falls in the window — the D16 accrual instant, NOT `created_at`. A request raised in
// March and invoiced in April belongs to April's cost report, and keying the roll on creation would move
// spend between cost-report periods. `unreconciledRequestCount` counts accrued rows that never got their
// `invoice_reconciled_at`, which is the number a finance reviewer reads as "how much of this is still an
// estimate".
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  ActiveDispatchView,
  ComfortKitDispatchedContentPayload,
  DeaPerpetualLogEntry,
  DispatchDetailView,
  RoutingRuleResolved,
  SupplyReceivedConfirmedActor,
  SupplyRequestStatusView,
} from "@wardenx/types";
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { EMPTY_SUPPLY_COST_TOTALS, type SuppliesSeamStore, type SupplyCostTotals } from "./store";

type DispatchRow = typeof schema.comfortKitDispatch.$inferSelect;
type DispatchedContentRow = typeof schema.comfortKitDispatchedContent.$inferSelect;

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
const dateN = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === "string" ? d : d.toISOString().slice(0, 10);

/**
 * §4.8, verbatim: "Returns only `deployed_at_patient` dispatches that have not been fully reconciled."
 *
 * ONE status, not a set. `partially_returned` is deliberately excluded even though some of the kit is
 * still in the house: once a return is open, the lots are being counted, and surfacing them as bedside
 * inventory invites a second draw against a lot already entered on the closing side of the DEA log.
 */
const ACTIVE_DISPATCH_STATUS = "deployed_at_patient" as const;

/**
 * Project a `comfort_kit_dispatched_content` row onto the published per-line payload (§4.5.2 / §4.8).
 *
 * `replenishmentThresholdPct` lives on the TEMPLATE line, not on the dispatched row, so it is passed in
 * from a joined read rather than defaulted. A default here would be a fabricated clinical threshold: M13
 * fires `m13.comfort_kit.replenishment_needed` when a lot crosses it, so a wrong number either floods the
 * supply team or lets a kit run dry. An unresolvable template line yields `null`, and the caller decides.
 */
function contentPayloadOf(
  row: DispatchedContentRow,
  replenishmentThresholdPct: number | null,
): ComfortKitDispatchedContentPayload {
  return {
    dispatchedContentId: row.id,
    comfortKitTemplateMedicationId: row.comfortKitTemplateMedicationId,
    medicationOrderId: row.medicationOrderId ?? null,
    rxnorm: row.rxnorm,
    ndc: row.ndc ?? null,
    drugName: row.drugName,
    strength: row.strength,
    dosageForm: row.dosageForm,
    routeOfAdministration: row.routeOfAdministration,
    isControlledSubstance: row.isControlledSubstance,
    controlledSubstanceSchedule: row.controlledSubstanceSchedule ?? null,
    dispatchedQuantity: row.dispatchedQuantity,
    dispatchedUnit: row.dispatchedUnit,
    lotNumber: row.lotNumber ?? null,
    expirationDate: dateN(row.expirationDate),
    manufacturerNdc: row.manufacturerNdc ?? null,
    replenishmentThresholdPct,
  } as ComfortKitDispatchedContentPayload;
}

/** Project a dispatch row + its lines onto the §4.8 detail view. */
function dispatchDetailOf(
  row: DispatchRow,
  lines: readonly DispatchedContentRow[],
  thresholdByTemplateMedicationId: ReadonlyMap<string, number>,
): DispatchDetailView {
  const contents = lines.map((line) =>
    contentPayloadOf(
      line,
      thresholdByTemplateMedicationId.get(line.comfortKitTemplateMedicationId) ?? null,
    ),
  );
  return {
    dispatchId: row.id,
    supplyRequestId: row.supplyRequestId,
    orgId: row.organizationId,
    patientId: row.patientId,
    comfortKitTemplateId: row.comfortKitTemplateId,
    kitSerialNumber: row.kitSerialNumber,
    deploymentSite: row.deploymentSite,
    ipuRoomId: row.ipuRoomId ?? null,
    dispatchStatus: row.dispatchStatus,
    dispatchedAt: iso(row.dispatchedAt) as DispatchDetailView["dispatchedAt"],
    m13DeploymentId: row.m13DeploymentId ?? null,
    containsControlledSubstance: contents.some((c) => c.isControlledSubstance),
    dispatchSource: row.dispatchSource,
    pharmacyDispatchMode: row.pharmacyDispatchMode,
    pharmacyPartnerId: row.pharmacyPartnerId ?? null,
    dispatchedByMembershipId:
      row.dispatchedByMembershipId as DispatchDetailView["dispatchedByMembershipId"],
    bolDocumentId: row.bolDocumentId ?? null,
    controlledSubstanceHandlingPolicyDigest: row.controlledSubstanceHandlingPolicyDigest,
    contents,
  } as DispatchDetailView;
}

/** Project a dispatch detail onto the narrower bedside view M13 lists. */
const activeViewOf = (d: DispatchDetailView): ActiveDispatchView => ({
  dispatchId: d.dispatchId,
  supplyRequestId: d.supplyRequestId,
  orgId: d.orgId,
  patientId: d.patientId,
  comfortKitTemplateId: d.comfortKitTemplateId,
  kitSerialNumber: d.kitSerialNumber,
  deploymentSite: d.deploymentSite,
  ipuRoomId: d.ipuRoomId,
  dispatchStatus: d.dispatchStatus,
  dispatchedAt: d.dispatchedAt,
  m13DeploymentId: d.m13DeploymentId,
  containsControlledSubstance: d.containsControlledSubstance,
});

/** Build the Drizzle-backed §4.8 seam store. */
export function buildDrizzleSuppliesSeamStore(db: DbClient): SuppliesSeamStore {
  const REQUEST = schema.supplyRequest;
  const DISPATCH = schema.comfortKitDispatch;
  const DISPATCHED = schema.comfortKitDispatchedContent;
  const RETURN = schema.comfortKitReturn;
  const TEMPLATE_MEDICATION = schema.comfortKitTemplateMedication;

  /** Load a set of dispatches with their lines + template thresholds in THREE round-trips, never N+1. */
  async function detailsFor(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    rows: readonly DispatchRow[],
  ): Promise<DispatchDetailView[]> {
    if (rows.length === 0) return [];
    const lines = await tx
      .select()
      .from(DISPATCHED)
      .where(
        inArray(
          DISPATCHED.dispatchId,
          rows.map((r) => r.id),
        ),
      );
    const byDispatch = new Map<string, DispatchedContentRow[]>();
    for (const line of lines) {
      const bucket = byDispatch.get(line.dispatchId) ?? [];
      bucket.push(line);
      byDispatch.set(line.dispatchId, bucket);
    }
    // Third round-trip, not an N+1: the D3 replenishment threshold is a template fact and the dispatched
    // rows only carry the template-line id.
    const templateMedicationIds = [...new Set(lines.map((l) => l.comfortKitTemplateMedicationId))];
    const thresholds = templateMedicationIds.length
      ? await tx
          .select({
            id: TEMPLATE_MEDICATION.id,
            pct: TEMPLATE_MEDICATION.replenishmentThresholdPct,
          })
          .from(TEMPLATE_MEDICATION)
          .where(inArray(TEMPLATE_MEDICATION.id, templateMedicationIds))
      : [];
    const thresholdById = new Map(thresholds.map((t) => [t.id, Number(t.pct)] as const));
    return rows.map((r) => dispatchDetailOf(r, byDispatch.get(r.id) ?? [], thresholdById));
  }

  /** The shared cost roll — one scan, the per-kind split done in SQL so a large org does not stream rows. */
  async function costTotals(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    where: ReturnType<typeof and>,
  ): Promise<SupplyCostTotals> {
    const [row] = await tx
      .select({
        dme: sql<string>`coalesce(sum(case when ${REQUEST.kind} = 'dme' then ${REQUEST.invoiceTotalCents} else 0 end), 0)`,
        supply: sql<string>`coalesce(sum(case when ${REQUEST.kind} = 'supply' then ${REQUEST.invoiceTotalCents} else 0 end), 0)`,
        kit: sql<string>`coalesce(sum(case when ${REQUEST.kind} in ('comfort_kit_deploy','comfort_kit_replenish') then ${REQUEST.invoiceTotalCents} else 0 end), 0)`,
        accrued: sql<string>`count(*)`,
        unreconciled: sql<string>`count(*) filter (where ${REQUEST.invoiceReconciledAt} is null)`,
        patients: sql<string>`count(distinct ${REQUEST.patientId})`,
      })
      .from(REQUEST)
      .where(where);
    if (!row) return EMPTY_SUPPLY_COST_TOTALS;
    const n = (v: string | number | null): number => Number(v ?? 0);
    return {
      dmeTotalCents: n(row.dme),
      supplyTotalCents: n(row.supply),
      comfortKitTotalCents: n(row.kit),
      accruedRequestCount: n(row.accrued),
      unreconciledRequestCount: n(row.unreconciled),
      patientCount: n(row.patients),
      requestCount: n(row.accrued),
    };
  }

  return {
    async requestStatus(supplyRequestId) {
      return withOrgContextFromRequest(db, async (tx): Promise<SupplyRequestStatusView | null> => {
        const [row] = await tx
          .select()
          .from(REQUEST)
          .where(eq(REQUEST.id, supplyRequestId))
          .limit(1);
        if (!row) return null;
        return {
          supplyRequestId: row.id,
          orgId: row.organizationId,
          patientId: row.patientId,
          admissionId: row.admissionId,
          kind: row.kind,
          status: row.status,
          sourceOrderId: row.sourceOrderId ?? null,
          assignedVendorId: row.assignedVendorId ?? null,
          routingRuleResolved: (row.routingRuleResolvedJsonb ?? null) as RoutingRuleResolved | null,
          vendorOrderReference: row.vendorOrderReference ?? null,
          trackingNumber: row.trackingNumber ?? null,
          carrier: row.carrier ?? null,
          orderedAt: isoN(row.orderedAt),
          deliveredAt: isoN(row.deliveredAt),
          receivedConfirmedAt: isoN(row.receivedConfirmedAt),
          receivedConfirmedActor: (row.receivedConfirmedActor ??
            null) as SupplyReceivedConfirmedActor | null,
          completedAt: isoN(row.completedAt),
          cancelledAt: isoN(row.cancelledAt),
          createdAt: iso(row.createdAt),
        } as SupplyRequestStatusView;
      });
    },

    async activeDispatchesForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly ActiveDispatchView[]> => {
        const rows = await tx
          .select()
          .from(DISPATCH)
          .where(
            and(
              eq(DISPATCH.patientId, patientId),
              eq(DISPATCH.dispatchStatus, ACTIVE_DISPATCH_STATUS),
            ),
          )
          .orderBy(desc(DISPATCH.dispatchedAt));
        // §4.8: "not yet FULLY reconciled". A kit whose `comfort_kit_return` reached `reconciled` is
        // closed even if the dispatch row still reads `deployed_at_patient` — the return is the closing
        // record, and showing a reconciled kit as bedside inventory would invite a second count of a lot
        // that is already accounted for.
        const reconciled = rows.length
          ? await tx
              .select({ dispatchId: RETURN.dispatchId })
              .from(RETURN)
              .where(
                and(
                  inArray(
                    RETURN.dispatchId,
                    rows.map((r) => r.id),
                  ),
                  eq(RETURN.state, "reconciled"),
                ),
              )
          : [];
        const closed = new Set(reconciled.map((r) => r.dispatchId));
        const open = rows.filter((r) => !closed.has(r.id));
        return (await detailsFor(tx, open)).map(activeViewOf);
      });
    },

    async dispatchDetail(dispatchId) {
      return withOrgContextFromRequest(db, async (tx): Promise<DispatchDetailView | null> => {
        const [row] = await tx.select().from(DISPATCH).where(eq(DISPATCH.id, dispatchId)).limit(1);
        if (!row) return null;
        const [detail] = await detailsFor(tx, [row]);
        return detail ?? null;
      });
    },

    async ipuRoomDispatches(locationId, ipuRoomId) {
      return withOrgContextFromRequest(db, async (tx): Promise<readonly DispatchDetailView[]> => {
        const rows = await tx
          .select()
          .from(DISPATCH)
          .where(
            and(
              eq(DISPATCH.locationId, locationId),
              eq(DISPATCH.ipuRoomId, ipuRoomId),
              eq(DISPATCH.deploymentSite, "ipu_room"),
              eq(DISPATCH.dispatchStatus, ACTIVE_DISPATCH_STATUS),
            ),
          )
          .orderBy(desc(DISPATCH.dispatchedAt));
        return detailsFor(tx, rows);
      });
    },

    async appendPerpetualLogEntry(dispatchedContentId, entry) {
      return withOrgContextFromRequest(db, async (tx): Promise<boolean> => {
        // APPEND, in SQL, on the row itself — `jsonb || jsonb` under an UPDATE ... WHERE id, so two
        // concurrent drawdowns cannot lose one another the way a read-modify-write in this process would.
        // `coalesce` seeds the array on the first entry (the column is nullable until a unit moves).
        const updated = await tx
          .update(DISPATCHED)
          .set({
            deaPerpetualLogJsonb: sql`coalesce(${DISPATCHED.deaPerpetualLogJsonb}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
          })
          .where(eq(DISPATCHED.id, dispatchedContentId))
          .returning({ id: DISPATCHED.id });
        return updated.length > 0;
      });
    },

    async patientCostTotals({ patientId, fromDate, toDate }) {
      return withOrgContextFromRequest(db, (tx) =>
        costTotals(
          tx,
          and(
            eq(REQUEST.patientId, patientId),
            isNotNull(REQUEST.invoiceAccruedAt),
            gte(REQUEST.invoiceAccruedAt, new Date(`${fromDate}T00:00:00.000Z`)),
            lte(REQUEST.invoiceAccruedAt, new Date(`${toDate}T23:59:59.999Z`)),
          ),
        ),
      );
    },

    async orgCostTotals({ fromDate, toDate }) {
      return withOrgContextFromRequest(db, (tx) =>
        costTotals(
          tx,
          and(
            isNotNull(REQUEST.invoiceAccruedAt),
            gte(REQUEST.invoiceAccruedAt, new Date(`${fromDate}T00:00:00.000Z`)),
            lte(REQUEST.invoiceAccruedAt, new Date(`${toDate}T23:59:59.999Z`)),
          ),
        ),
      );
    },
  };
}

/** Re-exported so the composition root imports the entry type from one place. */
export type { DeaPerpetualLogEntry };
