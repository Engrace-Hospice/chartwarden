import { type DbClient, schema } from "@wardenx/db";
// apps/backend/src/modules/21-supplies/routes/read-service-drizzle.ts — the Drizzle-backed M21 READ service
// (§4.1's GET rows).
//
// Every read opens its OWN `withOrgContext`, so RLS pins `app.org_id` per statement and a handler can never
// widen its own scope. No read compares an org id in application code: the policy is the enforcement, and
// the `organization_id` column never appears in a WHERE clause here (the M15/M16/M24 read-service
// precedent). Two tables are the exception by design — `supply_item` is genuinely org-less (D11, dual-grant
// RLS: read-all `is_active = true`) and `comfort_kit_template` / `vendor_routing_rule` carry the
// floor-plus-overlay predicate in their own policies, so the platform rows come back for every tenant
// without this file asking for them.
//
// PAGINATION is keyset, never offset (SD-052). The anchor is the row's own sort column plus its id, so a
// page boundary that lands between two rows with the same timestamp cannot repeat or skip one.
//
// THE PARTITIONED PARENTS. `supply_request` and `comfort_kit_dispatch` are monthly RANGE partitions on
// `created_at` / `dispatched_at`. The LIST reads order by exactly those columns, so a page walks partitions
// in order and PostgreSQL prunes; the DETAIL reads are id-only and fan out, which is the right trade for a
// single row (a caller with an id has no window, and inventing one would 404 last month's kit).
import { parStockSeverity } from "@wardenx/supplies";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import type { ComfortKitDispatchedContentPayload, DeaPerpetualLogEntry } from "@wardenx/types";
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { M21ReadActor } from "./actor";
import {
  type CursorPage,
  M21_PAGE_SIZES,
  type PageSizePolicy,
  clampLimit,
  decodeCursor,
  toCursorPage,
} from "./concurrency";
import type {
  CatalogFilters,
  ComfortKitReturnDetail,
  ComfortKitReturnListItem,
  ComfortKitReturnedLineView,
  ComfortKitTemplateView,
  DispatchDetail,
  DispatchFilters,
  DispatchListItem,
  M21ReadService,
  ParStockFilters,
  ParStockView,
  PerpetualLogView,
  ReturnFilters,
  RoutingRuleFilters,
  SupplyItemView,
  SupplyRequestDetail,
  SupplyRequestFilters,
  SupplyRequestListItem,
  TemplateFilters,
  VendorRoutingRuleView,
} from "./read-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const iso = (d: Date | string): string =>
  d instanceof Date ? d.toISOString() : new Date(d).toISOString();
const isoN = (d: Date | string | null): string | null => (d === null ? null : iso(d));
const dateN = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === "string" ? d : d.toISOString().slice(0, 10);

/** §2.2's non-terminal set — what `openOnly=true` means on the dashboard. */
const OPEN_REQUEST_STATUSES = [
  "requested",
  "vendor_assigned",
  "ordered",
  "in_transit",
  "delivered",
  "received_confirmed",
  "cancellation_pending",
] as const;

/** §2.6's open set — what the reconciliation worklist shows (mirrors `comfort_kit_return_overdue_idx`). */
const OPEN_RETURN_STATES = ["requested", "assigned", "retrieving", "retrieved"] as const;

/** Whole days past `dueAt` at `asOf`, floored at 0. Computed at READ time, never stored. */
function daysOverdueAt(dueAt: Date, asOf: Date): number {
  const ms = asOf.getTime() - dueAt.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/** Resolve a page size from the query against the route's policy. */
const pageOf = (limit: number | undefined, policy: PageSizePolicy): number =>
  clampLimit(limit, policy);

/** Deps the composition root binds. */
export interface M21ReadDeps {
  /** Injected clock — `daysOverdue` derives from it, so the worklist is deterministic under test. */
  readonly now?: () => Date;
}

export function buildDrizzleM21ReadService(db: DbClient, deps: M21ReadDeps = {}): M21ReadService {
  const REQUEST = schema.supplyRequest;
  const ITEM = schema.supplyItem;
  const TENANT_ITEM = schema.tenantSupplyItemExtension;
  const TEMPLATE = schema.comfortKitTemplate;
  const TEMPLATE_MED = schema.comfortKitTemplateMedication;
  const DISPATCH = schema.comfortKitDispatch;
  const DISPATCHED = schema.comfortKitDispatchedContent;
  const RETURN = schema.comfortKitReturn;
  const RETURNED = schema.comfortKitReturnedContent;
  const RULE = schema.vendorRoutingRule;
  const PAR = schema.parStock;

  const now = deps.now ?? (() => new Date());

  const scoped = <T>(actor: M21ReadActor, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);

  /** Project a `comfort_kit_dispatched_content` row onto the published per-line payload. */
  const contentOf = (
    row: typeof DISPATCHED.$inferSelect,
    thresholdPct: number | null,
  ): ComfortKitDispatchedContentPayload =>
    ({
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
      replenishmentThresholdPct: thresholdPct,
    }) as ComfortKitDispatchedContentPayload;

  /** Load one dispatch's lines + the D3 thresholds they were dispatched under. */
  async function dispatchContents(
    tx: Tx,
    dispatchId: string,
  ): Promise<ComfortKitDispatchedContentPayload[]> {
    const lines = await tx
      .select()
      .from(DISPATCHED)
      .where(eq(DISPATCHED.dispatchId, dispatchId))
      .orderBy(asc(DISPATCHED.createdAt));
    if (lines.length === 0) return [];
    const thresholds = await tx
      .select({ id: TEMPLATE_MED.id, pct: TEMPLATE_MED.replenishmentThresholdPct })
      .from(TEMPLATE_MED)
      .where(
        inArray(TEMPLATE_MED.id, [...new Set(lines.map((l) => l.comfortKitTemplateMedicationId))]),
      );
    const byId = new Map(thresholds.map((t) => [t.id, Number(t.pct)] as const));
    return lines.map((l) => contentOf(l, byId.get(l.comfortKitTemplateMedicationId) ?? null));
  }

  /** Does this dispatch carry any scheduled line? (Read once per list page, never per row.) */
  async function controlledDispatchIds(
    tx: Tx,
    dispatchIds: readonly string[],
  ): Promise<Set<string>> {
    if (dispatchIds.length === 0) return new Set();
    const rows = await tx
      .selectDistinct({ dispatchId: DISPATCHED.dispatchId })
      .from(DISPATCHED)
      .where(
        and(
          inArray(DISPATCHED.dispatchId, [...dispatchIds]),
          eq(DISPATCHED.isControlledSubstance, true),
        ),
      );
    return new Set(rows.map((r) => r.dispatchId));
  }

  const requestListItemOf = (row: typeof REQUEST.$inferSelect): SupplyRequestListItem => ({
    supplyRequestId: row.id,
    patientId: row.patientId,
    locationId: row.locationId,
    kind: row.kind,
    status: row.status,
    assignedVendorId: row.assignedVendorId ?? null,
    vendorOrderReference: row.vendorOrderReference ?? null,
    trackingNumber: row.trackingNumber ?? null,
    carrier: row.carrier ?? null,
    orderedAt: isoN(row.orderedAt),
    deliveredAt: isoN(row.deliveredAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });

  const dispatchListItemOf = (
    row: typeof DISPATCH.$inferSelect,
    controlled: boolean,
  ): DispatchListItem => ({
    dispatchId: row.id,
    supplyRequestId: row.supplyRequestId,
    patientId: row.patientId,
    locationId: row.locationId,
    comfortKitTemplateId: row.comfortKitTemplateId,
    kitSerialNumber: row.kitSerialNumber,
    deploymentSite: row.deploymentSite,
    dispatchStatus: row.dispatchStatus,
    ipuRoomId: row.ipuRoomId ?? null,
    dispatchedAt: iso(row.dispatchedAt),
    deployedAtPatientAt: isoN(row.deployedAtPatientAt),
    containsControlledSubstance: controlled,
    updatedAt: iso(row.updatedAt),
  });

  const templateViewOf = (
    row: typeof TEMPLATE.$inferSelect,
    meds: readonly (typeof TEMPLATE_MED.$inferSelect)[],
  ): ComfortKitTemplateView => ({
    comfortKitTemplateId: row.id,
    name: row.name,
    isPlatformFloor: row.isPlatformFloor,
    systemLocked: row.systemLocked,
    effectiveFrom: iso(row.effectiveFrom),
    effectiveTo: isoN(row.effectiveTo),
    replacesTemplateId: row.replacesTemplateId ?? null,
    medications: meds.map((m) => ({
      templateMedicationId: m.id,
      rxnorm: m.rxnorm,
      ndc: m.ndc ?? null,
      drugName: m.drugName,
      strength: m.strength,
      dosageForm: m.dosageForm,
      routeOfAdministration: m.routeOfAdministration,
      isControlledSubstance: m.isControlledSubstance,
      controlledSubstanceSchedule: m.controlledSubstanceSchedule ?? null,
      expectedQuantity: m.expectedQuantity,
      expectedUnit: m.expectedUnit,
      replenishmentThresholdPct: m.replenishmentThresholdPct,
      systemLocked: m.systemLocked,
      displayOrder: m.displayOrder,
    })),
    updatedAt: iso(row.updatedAt),
  });

  const routingRuleViewOf = (row: typeof RULE.$inferSelect): VendorRoutingRuleView => ({
    ruleId: row.id,
    isPlatform: row.scopeKind === "platform",
    scopeKind: row.scopeKind,
    scopeId: row.scopeId ?? null,
    skuClassPattern: row.skuClassPattern ?? null,
    assignedVendorId: row.assignedVendorId ?? null,
    assignedFulfillmentMode: row.assignedFulfillmentMode,
    defaultPharmacyDispatchMode: row.defaultPharmacyDispatchMode ?? null,
    precedencePriority: row.precedencePriority,
    isActive: row.isActive,
    effectiveFrom: iso(row.effectiveFrom),
    effectiveTo: isoN(row.effectiveTo),
    updatedAt: iso(row.updatedAt),
  });

  /** The par projection — `severity` is DERIVED here and nowhere else, so the list and the write-through
   *  read can never disagree about whether a shelf is green. */
  const parStockViewOf = ({
    par,
    platformName,
    tenantName,
  }: {
    par: typeof PAR.$inferSelect;
    platformName: string | null;
    tenantName: string | null;
  }): ParStockView => ({
    parStockId: par.id,
    locationId: par.locationId,
    skuId: par.skuId ?? null,
    tenantSkuExtensionId: par.tenantSkuExtensionId ?? null,
    skuName: platformName ?? tenantName ?? "",
    currentQuantity: par.currentQuantity,
    unit: par.unit,
    reorderPoint: par.reorderPoint,
    reorderQuantity: par.reorderQuantity,
    minSafetyStock: par.minSafetyStock,
    severity: parStockSeverity({
      currentQuantity: par.currentQuantity,
      reorderPoint: par.reorderPoint,
      minSafetyStock: par.minSafetyStock,
    }),
    isActive: par.isActive,
    lastParReviewAt: isoN(par.lastParReviewAt),
    lastParReviewedByMembershipId: (par.lastParReviewedByMembershipId ??
      null) as ParStockView["lastParReviewedByMembershipId"],
    reorderNotes: par.reorderNotes ?? null,
    updatedAt: iso(par.updatedAt),
  });

  const returnListItemOf = (
    row: typeof RETURN.$inferSelect,
    controlled: boolean,
    asOf: Date,
  ): ComfortKitReturnListItem => ({
    returnId: row.id,
    dispatchId: row.dispatchId,
    patientId: row.patientId,
    locationId: row.locationId,
    state: row.state,
    returnRequiredAt: iso(row.returnRequiredAt),
    returnDueAt: iso(row.returnDueAt),
    assignedRetrievingMembershipId: (row.assignedRetrievingMembershipId ??
      null) as ComfortKitReturnListItem["assignedRetrievingMembershipId"],
    reconciledAt: isoN(row.reconciledAt),
    containsControlledSubstance: controlled,
    daysOverdue: daysOverdueAt(row.returnDueAt, asOf),
    updatedAt: iso(row.updatedAt),
  });

  return {
    // ── §4.1 rows 2 / 3 — supply requests ──────────────────────────────────────────────────────────
    async listSupplyRequests(actor, filters) {
      const limit = pageOf(filters.limit, M21_PAGE_SIZES.requests);
      const cursor = decodeCursor(filters.cursor);
      return scoped(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(REQUEST)
          .where(
            and(
              filters.patientId ? eq(REQUEST.patientId, filters.patientId) : undefined,
              filters.locationId ? eq(REQUEST.locationId, filters.locationId) : undefined,
              filters.status ? eq(REQUEST.status, filters.status) : undefined,
              filters.kind ? eq(REQUEST.kind, filters.kind) : undefined,
              filters.openOnly ? inArray(REQUEST.status, [...OPEN_REQUEST_STATUSES]) : undefined,
              cursor
                ? or(
                    lt(REQUEST.createdAt, new Date(cursor.a)),
                    and(eq(REQUEST.createdAt, new Date(cursor.a)), lt(REQUEST.id, cursor.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(REQUEST.createdAt), desc(REQUEST.id))
          .limit(limit + 1);
        return toCursorPage(
          rows,
          limit,
          (r) => ({ a: iso(r.createdAt), id: r.id }),
          requestListItemOf,
        ) satisfies CursorPage<SupplyRequestListItem>;
      });
    },

    async getSupplyRequest(actor, supplyRequestId) {
      return scoped(actor, async (tx): Promise<SupplyRequestDetail> => {
        const [row] = await tx
          .select()
          .from(REQUEST)
          .where(eq(REQUEST.id, supplyRequestId))
          .limit(1);
        if (!row) throw new NotFoundError("supply_request");
        const [dispatch] = await tx
          .select({ id: DISPATCH.id })
          .from(DISPATCH)
          .where(eq(DISPATCH.supplyRequestId, supplyRequestId))
          .limit(1);
        return {
          ...requestListItemOf(row),
          admissionId: row.admissionId,
          providerEntityId: row.providerEntityId,
          sourceOrderId: row.sourceOrderId ?? null,
          sourceReplenishmentEventId: row.sourceReplenishmentEventId ?? null,
          requestedByMembershipId: (row.requestedByMembershipId ??
            null) as SupplyRequestDetail["requestedByMembershipId"],
          data: row.data,
          routingRuleResolved: (row.routingRuleResolvedJsonb ??
            null) as SupplyRequestDetail["routingRuleResolved"],
          pharmacyPartnerId: row.pharmacyPartnerId ?? null,
          documentId: row.documentId ?? null,
          deliveryInstructions: row.deliveryInstructions ?? null,
          deliveryMethod: row.deliveryMethod ?? null,
          deliveredByMembershipId: (row.deliveredByMembershipId ??
            null) as SupplyRequestDetail["deliveredByMembershipId"],
          deliveryEvidenceDocumentId: row.deliveryEvidenceDocumentId ?? null,
          receivedConfirmedAt: isoN(row.receivedConfirmedAt),
          receivedConfirmedActor: (row.receivedConfirmedActor ??
            null) as SupplyRequestDetail["receivedConfirmedActor"],
          completedAt: isoN(row.completedAt),
          cancelledAt: isoN(row.cancelledAt),
          cancellationPendingAt: isoN(row.cancellationPendingAt),
          cancellationReason: row.cancellationReason ?? null,
          shippedAt: isoN(row.shippedAt),
          invoiceTotalCents: row.invoiceTotalCents ?? null,
          invoiceAccruedAt: isoN(row.invoiceAccruedAt),
          invoiceReconciledAt: isoN(row.invoiceReconciledAt),
          invoiceVarianceCents: row.invoiceVarianceCents ?? null,
          dispatchId: dispatch?.id ?? null,
        };
      });
    },

    // ── §4.1 rows 11 / 13 — the D11 catalog (platform rows UNION the tenant overlay) ────────────────
    async listSupplyItems(actor, filters) {
      const limit = pageOf(filters.limit, M21_PAGE_SIZES.catalog);
      return scoped(actor, async (tx) => {
        const platform = await tx
          .select()
          .from(ITEM)
          .where(
            and(
              filters.skuClass ? eq(ITEM.skuClass, filters.skuClass) : undefined,
              filters.q ? ilike(ITEM.name, `%${filters.q}%`) : undefined,
              filters.includeRetired ? undefined : isNull(ITEM.effectiveTo),
            ),
          )
          .orderBy(asc(ITEM.name))
          .limit(limit + 1);
        // The tenant overlay is a SEPARATE table (D11) rather than org-scoped rows in `supply_item`, so
        // the catalog read is a UNION in application code. A SQL UNION would need the two shapes aligned
        // and would lose the `localSkuCode` the hub staff actually types.
        const tenant = filters.skuClass
          ? []
          : await tx
              .select()
              .from(TENANT_ITEM)
              .where(
                and(
                  filters.q ? ilike(TENANT_ITEM.name, `%${filters.q}%`) : undefined,
                  filters.includeRetired ? undefined : eq(TENANT_ITEM.isActive, true),
                ),
              )
              .orderBy(asc(TENANT_ITEM.name))
              .limit(limit + 1);

        const views: SupplyItemView[] = [
          ...platform.map(
            (row): SupplyItemView => ({
              supplyItemId: row.id,
              isPlatform: true,
              hcpcs: row.hcpcs ?? null,
              rxnorm: row.rxnorm ?? null,
              ndc: row.ndc ?? null,
              name: row.name,
              skuClass: row.skuClass as SupplyItemView["skuClass"],
              defaultUnit: row.defaultUnit,
              isBillable: row.isBillable,
              isActive: row.isActive,
              isControlledSubstance: row.isControlledSubstance ?? null,
              requiresLotTracking: row.requiresLotTracking ?? null,
              requiresExpirationTracking: row.requiresExpirationTracking ?? null,
              isSerializedAsset: row.isSerializedAsset ?? null,
              effectiveFrom: iso(row.effectiveFrom),
              effectiveTo: isoN(row.effectiveTo),
              localSkuCode: null,
              updatedAt: iso(row.updatedAt),
            }),
          ),
          ...tenant.map(
            (row): SupplyItemView => ({
              supplyItemId: row.id,
              isPlatform: false,
              hcpcs: null,
              rxnorm: null,
              ndc: null,
              name: row.name,
              skuClass: "internal",
              defaultUnit: row.defaultUnit,
              isBillable: row.isBillable,
              isActive: row.isActive,
              // A tenant-local item is never classified as controlled: D11 puts drug-supply items in the
              // PLATFORM catalog (they carry an RxNorm code), and a tenant row that claimed a schedule
              // would be a controlled substance nobody could bill or trace.
              isControlledSubstance: false,
              requiresLotTracking: null,
              requiresExpirationTracking: null,
              isSerializedAsset: null,
              effectiveFrom: iso(row.createdAt),
              effectiveTo: null,
              localSkuCode: row.localSkuCode,
              updatedAt: iso(row.updatedAt),
            }),
          ),
        ].sort((a, b) => a.name.localeCompare(b.name));

        return toCursorPage(
          views,
          limit,
          (v) => ({ a: v.name, id: v.supplyItemId }),
          (v) => v,
        );
      });
    },

    async getSupplyItem(actor, supplyItemId) {
      return scoped(actor, async (tx): Promise<SupplyItemView> => {
        const [row] = await tx.select().from(ITEM).where(eq(ITEM.id, supplyItemId)).limit(1);
        if (row) {
          return {
            supplyItemId: row.id,
            isPlatform: true,
            hcpcs: row.hcpcs ?? null,
            rxnorm: row.rxnorm ?? null,
            ndc: row.ndc ?? null,
            name: row.name,
            skuClass: row.skuClass as SupplyItemView["skuClass"],
            defaultUnit: row.defaultUnit,
            isBillable: row.isBillable,
            isActive: row.isActive,
            isControlledSubstance: row.isControlledSubstance ?? null,
            requiresLotTracking: row.requiresLotTracking ?? null,
            requiresExpirationTracking: row.requiresExpirationTracking ?? null,
            isSerializedAsset: row.isSerializedAsset ?? null,
            effectiveFrom: iso(row.effectiveFrom),
            effectiveTo: isoN(row.effectiveTo),
            localSkuCode: null,
            updatedAt: iso(row.updatedAt),
          };
        }
        const [overlay] = await tx
          .select()
          .from(TENANT_ITEM)
          .where(eq(TENANT_ITEM.id, supplyItemId))
          .limit(1);
        if (!overlay) throw new NotFoundError("supply_item");
        return {
          supplyItemId: overlay.id,
          isPlatform: false,
          hcpcs: null,
          rxnorm: null,
          ndc: null,
          name: overlay.name,
          skuClass: "internal",
          defaultUnit: overlay.defaultUnit,
          isBillable: overlay.isBillable,
          isActive: overlay.isActive,
          isControlledSubstance: false,
          requiresLotTracking: null,
          requiresExpirationTracking: null,
          isSerializedAsset: null,
          effectiveFrom: iso(overlay.createdAt),
          effectiveTo: null,
          localSkuCode: overlay.localSkuCode,
          updatedAt: iso(overlay.updatedAt),
        };
      });
    },

    // ── §4.1 row 17 — comfort-kit templates (D3 floor + tenant overlay) ────────────────────────────
    async listComfortKitTemplates(actor, filters) {
      const limit = pageOf(filters.limit, M21_PAGE_SIZES.catalog);
      return scoped(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(TEMPLATE)
          .where(
            and(
              filters.includePlatformFloor === false
                ? eq(TEMPLATE.isPlatformFloor, false)
                : undefined,
              filters.includeSuperseded ? undefined : isNull(TEMPLATE.effectiveTo),
            ),
          )
          .orderBy(desc(TEMPLATE.isPlatformFloor), asc(TEMPLATE.name))
          .limit(limit + 1);
        const meds = rows.length
          ? await tx
              .select()
              .from(TEMPLATE_MED)
              .where(
                inArray(
                  TEMPLATE_MED.templateId,
                  rows.map((r) => r.id),
                ),
              )
              .orderBy(asc(TEMPLATE_MED.displayOrder))
          : [];
        const byTemplate = new Map<string, typeof meds>();
        for (const m of meds) {
          const bucket = byTemplate.get(m.templateId) ?? [];
          bucket.push(m);
          byTemplate.set(m.templateId, bucket);
        }
        const views = rows.map((row) => templateViewOf(row, byTemplate.get(row.id) ?? []));
        return toCursorPage(
          views,
          limit,
          (v) => ({ a: v.name, id: v.comfortKitTemplateId }),
          (v) => v,
        );
      });
    },

    async getComfortKitTemplate(actor, templateId) {
      return scoped(actor, async (tx): Promise<ComfortKitTemplateView> => {
        const [row] = await tx.select().from(TEMPLATE).where(eq(TEMPLATE.id, templateId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_template");
        const meds = await tx
          .select()
          .from(TEMPLATE_MED)
          .where(eq(TEMPLATE_MED.templateId, templateId))
          .orderBy(asc(TEMPLATE_MED.displayOrder));
        return templateViewOf(row, meds);
      });
    },

    // ── §4.1 rows 21 / 22 — comfort-kit dispatches ────────────────────────────────────────────────
    async listDispatches(actor, filters) {
      const limit = pageOf(filters.limit, M21_PAGE_SIZES.dispatches);
      const cursor = decodeCursor(filters.cursor);
      return scoped(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(DISPATCH)
          .where(
            and(
              filters.patientId ? eq(DISPATCH.patientId, filters.patientId) : undefined,
              filters.locationId ? eq(DISPATCH.locationId, filters.locationId) : undefined,
              filters.ipuRoomId ? eq(DISPATCH.ipuRoomId, filters.ipuRoomId) : undefined,
              cursor
                ? or(
                    lt(DISPATCH.dispatchedAt, new Date(cursor.a)),
                    and(eq(DISPATCH.dispatchedAt, new Date(cursor.a)), lt(DISPATCH.id, cursor.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(DISPATCH.dispatchedAt), desc(DISPATCH.id))
          .limit(limit + 1);
        const controlled = await controlledDispatchIds(
          tx,
          rows.map((r) => r.id),
        );
        return toCursorPage(
          rows,
          limit,
          (r) => ({ a: iso(r.dispatchedAt), id: r.id }),
          (r) => dispatchListItemOf(r, controlled.has(r.id)),
        );
      });
    },

    async getDispatch(actor, dispatchId) {
      return scoped(actor, async (tx): Promise<DispatchDetail> => {
        const [row] = await tx.select().from(DISPATCH).where(eq(DISPATCH.id, dispatchId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_dispatch");
        const contents = await dispatchContents(tx, dispatchId);
        return {
          ...dispatchListItemOf(
            row,
            contents.some((c) => c.isControlledSubstance),
          ),
          admissionId: row.admissionId,
          providerEntityId: row.providerEntityId,
          dispatchSource: row.dispatchSource,
          pharmacyDispatchMode: row.pharmacyDispatchMode,
          pharmacyPartnerId: row.pharmacyPartnerId ?? null,
          dispatchedByMembershipId:
            row.dispatchedByMembershipId as DispatchDetail["dispatchedByMembershipId"],
          deployedByMembershipId: (row.deployedByMembershipId ??
            null) as DispatchDetail["deployedByMembershipId"],
          bolDocumentId: row.bolDocumentId ?? null,
          m13DeploymentId: row.m13DeploymentId ?? null,
          controlledSubstanceHandlingPolicyDigest: row.controlledSubstanceHandlingPolicyDigest,
          facilityIdentifier: row.facilityIdentifierJsonb ?? null,
          specialHandlingNotes: row.specialHandlingNotes ?? null,
          contents,
        };
      });
    },

    // ── §4.1 rows 25 / 26 — comfort-kit returns ───────────────────────────────────────────────────
    async listReturns(actor, filters) {
      const limit = pageOf(filters.limit, M21_PAGE_SIZES.returns);
      const cursor = decodeCursor(filters.cursor);
      const asOf = now();
      return scoped(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(RETURN)
          .where(
            and(
              filters.patientId ? eq(RETURN.patientId, filters.patientId) : undefined,
              filters.openOnly ? inArray(RETURN.state, [...OPEN_RETURN_STATES]) : undefined,
              filters.overdueOnly ? lt(RETURN.returnDueAt, asOf) : undefined,
              cursor
                ? or(
                    gt(RETURN.returnDueAt, new Date(cursor.a)),
                    and(eq(RETURN.returnDueAt, new Date(cursor.a)), gt(RETURN.id, cursor.id)),
                  )
                : undefined,
            ),
          )
          // Ascending: the worklist is "what is most overdue first", which is the OLDEST due date.
          .orderBy(asc(RETURN.returnDueAt), asc(RETURN.id))
          .limit(limit + 1);
        const controlled = await controlledDispatchIds(
          tx,
          rows.map((r) => r.dispatchId),
        );
        return toCursorPage(
          rows,
          limit,
          (r) => ({ a: iso(r.returnDueAt), id: r.id }),
          (r) => returnListItemOf(r, controlled.has(r.dispatchId), asOf),
        );
      });
    },

    async getReturn(actor, returnId) {
      const asOf = now();
      return scoped(actor, async (tx): Promise<ComfortKitReturnDetail> => {
        const [row] = await tx.select().from(RETURN).where(eq(RETURN.id, returnId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_return");
        const lineRows = await tx
          .select({ returned: RETURNED, dispatched: DISPATCHED })
          .from(RETURNED)
          .innerJoin(DISPATCHED, eq(DISPATCHED.id, RETURNED.dispatchedContentId))
          .where(eq(RETURNED.returnId, returnId))
          .orderBy(asc(RETURNED.createdAt));
        const lines: ComfortKitReturnedLineView[] = lineRows.map(({ returned, dispatched }) => ({
          returnedContentId: returned.id,
          dispatchedContentId: returned.dispatchedContentId,
          drugName: dispatched.drugName,
          lotNumber: dispatched.lotNumber ?? null,
          isControlledSubstance: returned.isControlledSubstance,
          controlledSubstanceSchedule: returned.controlledSubstanceSchedule ?? null,
          dispatchedQuantity: dispatched.dispatchedQuantity,
          quantityReturned: returned.quantityReturned,
          quantityDisposedAtHome: returned.quantityDisposedAtHome,
          quantityUnaccounted: returned.quantityUnaccounted,
          discrepancyPct: returned.discrepancyPct,
          discrepancyFlagged: returned.discrepancyFlagged,
        }));
        const controlled = await controlledDispatchIds(tx, [row.dispatchId]);
        return {
          ...returnListItemOf(row, controlled.has(row.dispatchId), asOf),
          admissionId: row.admissionId,
          providerEntityId: row.providerEntityId,
          m13DeploymentId: row.m13DeploymentId,
          retrievingAt: isoN(row.retrievingAt),
          retrievedAt: isoN(row.retrievedAt),
          returnedToHubAt: isoN(row.returnedToHubAt),
          disposalMethod: row.disposalMethod ?? null,
          disposalWitnessMembershipId: (row.disposalWitnessMembershipId ??
            null) as ComfortKitReturnDetail["disposalWitnessMembershipId"],
          disposalMethodJurisdictionPolicyDigest:
            row.disposalMethodJurisdictionPolicyDigest ?? null,
          reconciledByMembershipId: (row.reconciledByMembershipId ??
            null) as ComfortKitReturnDetail["reconciledByMembershipId"],
          receiptDocumentId: row.receiptDocumentId ?? null,
          disposalNotes: row.disposalNotes ?? null,
          discrepancyNotes: row.discrepancyNotes ?? null,
          unreturnableReason: row.unreturnableReason ?? null,
          unreturnableAttestedByMembershipId: (row.unreturnableAttestedByMembershipId ??
            null) as ComfortKitReturnDetail["unreturnableAttestedByMembershipId"],
          lines,
          // COMPUTED from the lines, never a stored flag: a discrepancy the reconciler can set is one
          // they can clear (the M21-T03 rule, held here on the read side too).
          discrepancyDetected: lines.some((l) => l.discrepancyFlagged),
        };
      });
    },

    // ── §4.1 row 28 — D4 routing rules ────────────────────────────────────────────────────────────
    async listVendorRoutingRules(actor, filters) {
      const limit = pageOf(filters.limit, M21_PAGE_SIZES.routingRules);
      return scoped(actor, async (tx) => {
        const rows = await tx
          .select()
          .from(RULE)
          .where(
            and(
              filters.scopeKind ? eq(RULE.scopeKind, filters.scopeKind) : undefined,
              filters.includeRetired
                ? undefined
                : and(eq(RULE.isActive, true), isNull(RULE.effectiveTo)),
            ),
          )
          .orderBy(asc(RULE.scopeKind), asc(RULE.precedencePriority), asc(RULE.id))
          .limit(limit + 1);
        return toCursorPage(rows, limit, (r) => ({ a: r.scopeKind, id: r.id }), routingRuleViewOf);
      });
    },

    async getVendorRoutingRule(actor, ruleId) {
      return scoped(actor, async (tx): Promise<VendorRoutingRuleView> => {
        const [row] = await tx.select().from(RULE).where(eq(RULE.id, ruleId)).limit(1);
        if (!row) throw new NotFoundError("vendor_routing_rule");
        return routingRuleViewOf(row);
      });
    },

    // ── §4.1 row 32 — par stock (severity DERIVED, never stored) ──────────────────────────────────
    async listParStock(actor, filters) {
      const limit = pageOf(filters.limit, M21_PAGE_SIZES.parStock);
      return scoped(actor, async (tx) => {
        const rows = await tx
          .select({
            par: PAR,
            platformName: ITEM.name,
            tenantName: TENANT_ITEM.name,
          })
          .from(PAR)
          .leftJoin(ITEM, eq(ITEM.id, PAR.skuId))
          .leftJoin(TENANT_ITEM, eq(TENANT_ITEM.id, PAR.tenantSkuExtensionId))
          .where(
            and(
              filters.locationId ? eq(PAR.locationId, filters.locationId) : undefined,
              filters.belowThresholdOnly ? lte(PAR.currentQuantity, PAR.reorderPoint) : undefined,
              eq(PAR.isActive, true),
            ),
          )
          .orderBy(asc(PAR.locationId), asc(PAR.id))
          .limit(limit + 1);
        return toCursorPage(
          rows,
          limit,
          (r) => ({ a: r.par.locationId, id: r.par.id }),
          parStockViewOf,
        );
      });
    },

    async getParStock(actor, parStockId) {
      return scoped(actor, async (tx): Promise<ParStockView> => {
        const [row] = await tx
          .select({ par: PAR, platformName: ITEM.name, tenantName: TENANT_ITEM.name })
          .from(PAR)
          .leftJoin(ITEM, eq(ITEM.id, PAR.skuId))
          .leftJoin(TENANT_ITEM, eq(TENANT_ITEM.id, PAR.tenantSkuExtensionId))
          .where(eq(PAR.id, parStockId))
          .limit(1);
        if (!row) throw new NotFoundError("par_stock");
        return parStockViewOf(row);
      });
    },

    // ── §8.1 — the DEA 21 CFR §1304 perpetual log for one kit ─────────────────────────────────────
    async getPerpetualLog(actor, dispatchId) {
      return scoped(actor, async (tx): Promise<PerpetualLogView> => {
        const [row] = await tx.select().from(DISPATCH).where(eq(DISPATCH.id, dispatchId)).limit(1);
        if (!row) throw new NotFoundError("comfort_kit_dispatch");
        const lines = await tx
          .select()
          .from(DISPATCHED)
          .where(eq(DISPATCHED.dispatchId, dispatchId))
          .orderBy(asc(DISPATCHED.createdAt));
        return {
          dispatchId: row.id,
          kitSerialNumber: row.kitSerialNumber,
          dispatchedAt: iso(row.dispatchedAt),
          dispatchedByMembershipId:
            row.dispatchedByMembershipId as PerpetualLogView["dispatchedByMembershipId"],
          lines: lines.map((l) => ({
            dispatchedContentId: l.id,
            drugName: l.drugName,
            lotNumber: l.lotNumber ?? null,
            controlledSubstanceSchedule: l.controlledSubstanceSchedule ?? null,
            dispatchedQuantity: l.dispatchedQuantity,
            dispatchedUnit: l.dispatchedUnit,
            expirationDate: dateN(l.expirationDate),
            // The column is `jsonb`; an absent log is an empty array, NOT a null the screen has to guess
            // at. §1304 makes the log append-only, so the array is returned in insertion order verbatim.
            entries: (l.deaPerpetualLogJsonb ?? []) as readonly DeaPerpetualLogEntry[],
          })),
        };
      });
    },
  };
}
