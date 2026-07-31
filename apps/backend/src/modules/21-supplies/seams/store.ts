// apps/backend/src/modules/21-supplies/seams/store.ts — M21-T05, the data PORT the three §4.8 published
// seams (`SupplyFulfillmentProvider` · `ComfortKitDispatchProvider` · `SupplyCostProvider`) compose over,
// plus an in-memory slice for tests / boot-without-DB. The providers (./providers.ts) are pure orchestration
// over this port; production injects the Drizzle-backed store (./store-drizzle.ts), which reads M21's
// `supply_request` / `comfort_kit_dispatch` / `comfort_kit_dispatched_content` rows under the CONSUMER's
// ambient request context — the providers never switch tenants; RLS scopes every read by `app.org_id`
// (§3.5). Mirrors the M9…M18 read-seam store precedents.
//
// TWO of the three seams are pure reads. The write-shaped pair are deliberate and narrow:
//
//   • `createDirect` — §4.8's `createDirectSupplyRequest`, a coordinator's entry that did not come through
//     M11. It is NOT implemented here: it needs the D4 routing resolution, the per-kind TypeBox validation
//     and the §4.5.2 outbox emit, all of which the M21-T05 WRITE service already owns. The port takes a
//     `SupplyRequestCreator` the composition root binds to that service, so there is ONE creation path for
//     a request whether it arrives by route, by M11 cascade or by seam. A second implementation here would
//     be a second place for the routing freeze to drift.
//   • `appendPerpetualLogEntry` — D6 / DEA 21 CFR §1304. M13's bedside drawdown APPENDS to the dispatched
//     line's perpetual log. It does not decide a discrepancy: §2.6's reconciliation owns that verdict, and
//     a seam caller must not be able to flag (or clear) one. See {@link DeaPerpetualLogEntry}.
//
// ONE shape deliberately does NOT match its seam DTO: the cost port returns per-KIND cent totals plus the
// two request counts, never a per-patient-day rate. The denominator is what drives CMS small-N suppression
// downstream and a pre-divided number destroys it (the M15-T05 / M30 measure-input lesson).
import type {
  ActiveDispatchView,
  ComfortKitDispatchId,
  ComfortKitDispatchedContentId,
  CreateDirectSupplyRequestInput,
  DeaPerpetualLogEntry,
  DispatchDetailView,
  IpuRoomId,
  LocalDate,
  LocationId,
  OrgId,
  PatientId,
  RoutingRuleResolved,
  SupplyRequestId,
  SupplyRequestStatusView,
} from "@wardenx/types";

/** The per-kind cent totals + request counts the two `SupplyCostProvider` summaries divide nothing by. */
export interface SupplyCostTotals {
  readonly dmeTotalCents: number;
  readonly supplyTotalCents: number;
  readonly comfortKitTotalCents: number;
  readonly accruedRequestCount: number;
  readonly unreconciledRequestCount: number;
  /** Distinct patients with at least one accrued request in the window (org summary only; 0 per-patient). */
  readonly patientCount: number;
  readonly requestCount: number;
}

/** The empty cost roll — returned for a window with no accrued requests (a real zero, not an outage). */
export const EMPTY_SUPPLY_COST_TOTALS: SupplyCostTotals = {
  dmeTotalCents: 0,
  supplyTotalCents: 0,
  comfortKitTotalCents: 0,
  accruedRequestCount: 0,
  unreconciledRequestCount: 0,
  patientCount: 0,
  requestCount: 0,
};

/** The one write the §4.8 seam surface exposes, delegated to the M21 write service (see the header). */
export interface SupplyRequestCreator {
  createDirect(input: CreateDirectSupplyRequestInput): Promise<{
    readonly supplyRequestId: SupplyRequestId;
    readonly routingRuleResolved: RoutingRuleResolved;
  }>;
}

/** The §4.8 data port. Every method is scoped to the CALLER's org by RLS, never by an argument. */
export interface SuppliesSeamStore {
  /** The full §4.8 status projection for one request, or null when the id does not resolve in-org. */
  requestStatus(supplyRequestId: SupplyRequestId): Promise<SupplyRequestStatusView | null>;

  /** Kits live for this patient — `deployed_at_patient` and not yet fully reconciled (§4.8). */
  activeDispatchesForPatient(patientId: PatientId): Promise<readonly ActiveDispatchView[]>;

  /** Full dispatch detail including lots and expirations — what M13 draws down against. */
  dispatchDetail(dispatchId: ComfortKitDispatchId): Promise<DispatchDetailView | null>;

  /** D17 / M37 — the room's stock kit rather than a patient's. Empty list when the room holds none. */
  ipuRoomDispatches(
    locationId: LocationId,
    ipuRoomId: IpuRoomId,
  ): Promise<readonly DispatchDetailView[]>;

  /**
   * D6 / DEA §1304 — APPEND one entry to a dispatched line's perpetual log. Returns false when the line
   * does not resolve in-org (the caller turns that into a typed refusal); never edits an existing entry.
   */
  appendPerpetualLogEntry(
    dispatchedContentId: ComfortKitDispatchedContentId,
    entry: DeaPerpetualLogEntry,
  ): Promise<boolean>;

  /** Accrued supply spend for one patient over `[fromDate, toDate]`, in integer cents. */
  patientCostTotals(input: {
    readonly patientId: PatientId;
    readonly fromDate: LocalDate;
    readonly toDate: LocalDate;
  }): Promise<SupplyCostTotals>;

  /** Accrued supply spend for the whole org over `[fromDate, toDate]`, in integer cents. */
  orgCostTotals(input: {
    readonly fromDate: LocalDate;
    readonly toDate: LocalDate;
  }): Promise<SupplyCostTotals>;
}

/** The rows an in-memory slice is seeded from (tests / boot-without-DB). */
export interface SuppliesSeamSeed {
  readonly requests?: readonly SupplyRequestStatusView[];
  readonly dispatches?: readonly DispatchDetailView[];
  /** Per-patient cost totals, keyed by patient id; the org roll sums them. */
  readonly costByPatient?: Readonly<Record<string, SupplyCostTotals>>;
}

/** The handle a slice hands back so a test can assert on what the seam WROTE (the perpetual log). */
export interface InMemorySuppliesSeamStore {
  readonly store: SuppliesSeamStore;
  /** Every appended perpetual-log entry, in order, keyed by dispatched-content id. */
  readonly perpetualLog: Map<string, DeaPerpetualLogEntry[]>;
}

const projectActive = (d: DispatchDetailView): ActiveDispatchView => ({
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

const sumTotals = (rows: readonly SupplyCostTotals[]): SupplyCostTotals =>
  rows.reduce<SupplyCostTotals>(
    (acc, r) => ({
      dmeTotalCents: acc.dmeTotalCents + r.dmeTotalCents,
      supplyTotalCents: acc.supplyTotalCents + r.supplyTotalCents,
      comfortKitTotalCents: acc.comfortKitTotalCents + r.comfortKitTotalCents,
      accruedRequestCount: acc.accruedRequestCount + r.accruedRequestCount,
      unreconciledRequestCount: acc.unreconciledRequestCount + r.unreconciledRequestCount,
      patientCount: acc.patientCount + (r.requestCount > 0 ? 1 : 0),
      requestCount: acc.requestCount + r.requestCount,
    }),
    EMPTY_SUPPLY_COST_TOTALS,
  );

/**
 * An in-memory {@link SuppliesSeamStore} over a seeded row set. Used by the §9.1 unit tests and by a boot
 * that has no DB client: the seams are then REGISTERED and answer empty/null rather than throwing, which is
 * the honest degraded posture for a read surface — except that `activeDispatchesForPatient` on an unseeded
 * store answers `[]`, and a caller must read that as "this slice has no kits", not "the ward has none".
 * Production binds the Drizzle store.
 */
export function createInMemorySuppliesSeamStore(
  seed: SuppliesSeamSeed = {},
): InMemorySuppliesSeamStore {
  const requests = new Map((seed.requests ?? []).map((r) => [r.supplyRequestId, r] as const));
  const dispatches = new Map((seed.dispatches ?? []).map((d) => [d.dispatchId, d] as const));
  const costByPatient = new Map(Object.entries(seed.costByPatient ?? {}));
  const perpetualLog = new Map<string, DeaPerpetualLogEntry[]>();
  const dispatchedLineOwner = new Map<string, string>();
  for (const d of dispatches.values()) {
    for (const line of d.contents) dispatchedLineOwner.set(line.dispatchedContentId, d.dispatchId);
  }

  const store: SuppliesSeamStore = {
    async requestStatus(supplyRequestId) {
      return requests.get(supplyRequestId) ?? null;
    },
    async activeDispatchesForPatient(patientId) {
      return [...dispatches.values()]
        .filter((d) => d.patientId === patientId && d.dispatchStatus === "deployed_at_patient")
        .map(projectActive);
    },
    async dispatchDetail(dispatchId) {
      return dispatches.get(dispatchId) ?? null;
    },
    async ipuRoomDispatches(locationId, ipuRoomId) {
      return [...dispatches.values()].filter(
        (d) => d.ipuRoomId === ipuRoomId && d.deploymentSite === "ipu_room" && locationId !== "",
      );
    },
    async appendPerpetualLogEntry(dispatchedContentId, entry) {
      if (!dispatchedLineOwner.has(dispatchedContentId)) return false;
      const existing = perpetualLog.get(dispatchedContentId) ?? [];
      existing.push(entry);
      perpetualLog.set(dispatchedContentId, existing);
      return true;
    },
    async patientCostTotals({ patientId }) {
      return costByPatient.get(patientId) ?? EMPTY_SUPPLY_COST_TOTALS;
    },
    async orgCostTotals() {
      return sumTotals([...costByPatient.values()]);
    },
  };

  return { store, perpetualLog };
}

/** Re-exported for the Drizzle adapter + the providers (keeps the id aliases in one import site). */
export type { OrgId };
