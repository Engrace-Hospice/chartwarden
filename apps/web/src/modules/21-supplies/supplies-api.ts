// apps/web/src/modules/21-supplies — the M21 read/write access layer the §5 screens share
// (Track B / ADR-0030, ADR-0032).
//
// The wire shapes below MIRROR the server's response DTOs
// (apps/backend/src/modules/21-supplies/routes/read-service.ts + write-service.ts). They are declared
// here — not imported — because apps/web may never compile-import the backend (dependency-cruiser); the
// generated client (`packages/ui/src/core/api`) is the contract. M21's routes are enriched with their §4.2
// request bodies/queries, so every CALL is typed; the RESPONSE bodies are not TypeBox-published, so each
// read is cast at exactly one place — here — instead of being re-cast ad hoc in ten screens.
//
// THREE SERVER CONTRACTS EVERY WRITE HELPER HONOURS.
//
//   • ADR-0021 — a mutating route requires an `Idempotency-Key`. Every helper mints a fresh one per attempt.
//   • §7.2 — a state transition requires `If-Match`, and M21's ETag is the row's **`updated_at` as an ISO
//     string**, NOT an integer version: §3.1 gives M21's tables `updated_at` and no counter (unlike M16's
//     `bereavement_plan.version`). A 412 means the row moved under you — reload, never retry blind.
//   • §4.2 — every quantity that reaches a `numeric` column travels as a decimal STRING. A 0.1 mL of a CII
//     solution that round-trips through a JS float is not the quantity the DEA perpetual log recorded, so
//     nothing in this file types a dispatched / returned / disposed quantity as `number`.
//
// The server stays the only authorization point: nothing here decides what a caller may see. An
// out-of-scope row is a 404 from the server, never a frontend hide.
import type { ApiClient } from "@wardenx/ui";

// ── wire shapes (mirror of the §4.1 response DTOs) ─────────────────────────────────────────────────────

/** §4.1's paginated envelope (`{data, next_cursor, has_more}`) — offset pagination is refused (SD-052). */
export interface CursorPage<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
  total_count?: number;
}

/** Rows 2 / 3 — one supply request on the dashboard list. Carries NO free text: the D13 delivery
 *  instructions live on the DETAIL DTO only, which is the difference between a coordinator opening one
 *  request and a list endpoint spraying home-access instructions for a whole Location into a browser cache. */
export interface SupplyRequestListItem {
  supplyRequestId: string;
  patientId: string;
  locationId: string;
  kind: string;
  status: string;
  assignedVendorId: string | null;
  vendorOrderReference: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  orderedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /** The `If-Match` value a transition on this row must echo (§7.2) — an ISO instant, not a counter. */
  updatedAt: string;
}

/** The frozen D4 routing record — the answer to "why this vendor", preserved for the life of the row. */
export interface RoutingRuleResolved {
  resolverVersion: string;
  resolvedAt: string;
  precedenceLevelUsed: string;
  matchedRuleId: string | null;
  assignedVendorId: string | null;
  assignedFulfillmentMode: string;
  defaultPharmacyDispatchMode: string | null;
  candidatesEvaluated: {
    precedenceLevel: string;
    ruleId: string | null;
    matched: boolean;
    reason: string;
  }[];
  routingPolicyDigest: string;
}

/** Row 3 — the full request, with the D13 free text and the frozen D4 routing record. */
export interface SupplyRequestDetail extends SupplyRequestListItem {
  admissionId: string;
  providerEntityId: string;
  sourceOrderId: string | null;
  sourceReplenishmentEventId: string | null;
  requestedByMembershipId: string | null;
  /** The per-kind D1 payload. `unknown` on the wire because the §3.4 per-kind TypeBox is not published to
   *  the client — the screen renders it as data, and never pretends to know a field it cannot type. */
  data: unknown;
  routingRuleResolved: RoutingRuleResolved | null;
  pharmacyPartnerId: string | null;
  documentId: string | null;
  deliveryInstructions: string | null;
  deliveryMethod: string | null;
  deliveredByMembershipId: string | null;
  deliveryEvidenceDocumentId: string | null;
  receivedConfirmedAt: string | null;
  receivedConfirmedActor: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationPendingAt: string | null;
  cancellationReason: string | null;
  shippedAt: string | null;
  invoiceTotalCents: number | null;
  invoiceAccruedAt: string | null;
  invoiceReconciledAt: string | null;
  invoiceVarianceCents: number | null;
  /** The dispatch this request produced, when it is a kit kind (§2.5). */
  dispatchId: string | null;
}

/** Rows 11 / 13 — a catalog SKU. Platform rows have no org; the overlay rows are tenant-scoped (D11). */
export interface SupplyItemView {
  supplyItemId: string;
  isPlatform: boolean;
  hcpcs: string | null;
  rxnorm: string | null;
  ndc: string | null;
  name: string;
  skuClass: string;
  defaultUnit: string;
  isBillable: boolean;
  isActive: boolean;
  /** NULLABLE on purpose: "unclassified" and "definitely not controlled" are different facts, and the
   *  dispatch path must tell them apart before deciding whether a lot number is mandatory. */
  isControlledSubstance: boolean | null;
  requiresLotTracking: boolean | null;
  requiresExpirationTracking: boolean | null;
  isSerializedAsset: boolean | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  localSkuCode: string | null;
  updatedAt: string;
}

/** One line of a §2.3 comfort-kit template. */
export interface TemplateMedicationView {
  templateMedicationId: string;
  rxnorm: string;
  ndc: string | null;
  drugName: string;
  strength: string;
  dosageForm: string;
  routeOfAdministration: string;
  isControlledSubstance: boolean;
  controlledSubstanceSchedule: string | null;
  expectedQuantity: string;
  expectedUnit: string;
  replenishmentThresholdPct: string;
  systemLocked: boolean;
  displayOrder: number;
}

/** Row 17 — a comfort-kit template with its lines (the D3 floor row included when asked for). */
export interface ComfortKitTemplateView {
  comfortKitTemplateId: string;
  name: string;
  isPlatformFloor: boolean;
  systemLocked: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  replacesTemplateId: string | null;
  medications: TemplateMedicationView[];
  updatedAt: string;
}

/** Rows 21 / 22 — one comfort-kit dispatch on the list. No free text (see the request note). */
export interface DispatchListItem {
  dispatchId: string;
  supplyRequestId: string;
  patientId: string;
  locationId: string;
  comfortKitTemplateId: string;
  kitSerialNumber: string;
  deploymentSite: string;
  dispatchStatus: string;
  ipuRoomId: string | null;
  dispatchedAt: string;
  deployedAtPatientAt: string | null;
  containsControlledSubstance: boolean;
  updatedAt: string;
}

/** One dispatched line — the OUTBOUND half of the DEA 21 CFR §1304 perpetual log. */
export interface DispatchedContentView {
  dispatchedContentId: string;
  comfortKitTemplateMedicationId: string;
  medicationOrderId: string | null;
  rxnorm: string;
  ndc: string | null;
  drugName: string;
  strength: string;
  dosageForm: string;
  routeOfAdministration: string;
  isControlledSubstance: boolean;
  controlledSubstanceSchedule: string | null;
  dispatchedQuantity: string;
  dispatchedUnit: string;
  lotNumber: string | null;
  expirationDate: string | null;
  manufacturerNdc: string | null;
  replenishmentThresholdPct: number;
}

/** Row 22 — the full dispatch, including the per-line outbound manifest. */
export interface DispatchDetail extends DispatchListItem {
  admissionId: string;
  providerEntityId: string;
  dispatchSource: string;
  pharmacyDispatchMode: string;
  pharmacyPartnerId: string | null;
  dispatchedByMembershipId: string;
  deployedByMembershipId: string | null;
  bolDocumentId: string | null;
  m13DeploymentId: string | null;
  controlledSubstanceHandlingPolicyDigest: string;
  facilityIdentifier: unknown;
  specialHandlingNotes: string | null;
  contents: DispatchedContentView[];
}

/** Rows 25 / 26 — one comfort-kit return on the reconciliation worklist. */
export interface ReturnListItem {
  returnId: string;
  dispatchId: string;
  patientId: string;
  locationId: string;
  state: string;
  returnRequiredAt: string;
  returnDueAt: string;
  assignedRetrievingMembershipId: string | null;
  reconciledAt: string | null;
  containsControlledSubstance: boolean;
  /** Computed at READ time from `return_due_at`, never stored (0 when not yet due). */
  daysOverdue: number;
  updatedAt: string;
}

/** One reconciled line. The three D8 quantities are TRIGGER-computed — read here, never sent back. */
export interface ReturnedLineView {
  returnedContentId: string;
  dispatchedContentId: string;
  drugName: string;
  lotNumber: string | null;
  isControlledSubstance: boolean;
  controlledSubstanceSchedule: string | null;
  dispatchedQuantity: string;
  quantityReturned: string;
  quantityDisposedAtHome: string;
  quantityUnaccounted: string;
  discrepancyPct: string;
  discrepancyFlagged: boolean;
}

/** Row 26 — the full return with its per-line accounting and the disposal record. */
export interface ReturnDetail extends ReturnListItem {
  admissionId: string;
  providerEntityId: string;
  m13DeploymentId: string;
  retrievingAt: string | null;
  retrievedAt: string | null;
  returnedToHubAt: string | null;
  disposalMethod: string | null;
  disposalWitnessMembershipId: string | null;
  disposalMethodJurisdictionPolicyDigest: string | null;
  reconciledByMembershipId: string | null;
  receiptDocumentId: string | null;
  disposalNotes: string | null;
  discrepancyNotes: string | null;
  unreturnableReason: string | null;
  unreturnableAttestedByMembershipId: string | null;
  lines: ReturnedLineView[];
  /** True when ANY line crossed D8 — computed from the lines by the server, never a stored flag. */
  discrepancyDetected: boolean;
}

/** Row 28 — a D4 routing rule. */
export interface VendorRoutingRuleView {
  ruleId: string;
  isPlatform: boolean;
  scopeKind: string;
  scopeId: string | null;
  skuClassPattern: string | null;
  assignedVendorId: string | null;
  assignedFulfillmentMode: string;
  defaultPharmacyDispatchMode: string | null;
  precedencePriority: number;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedAt: string;
}

/** Row 32 — one shelf row plus its DERIVED band. */
export interface ParStockView {
  parStockId: string;
  locationId: string;
  skuId: string | null;
  tenantSkuExtensionId: string | null;
  skuName: string;
  currentQuantity: string;
  unit: string;
  reorderPoint: string;
  reorderQuantity: string;
  minSafetyStock: string;
  severity: "ok" | "below_threshold" | "critical_low" | "depleted";
  isActive: boolean;
  lastParReviewAt: string | null;
  lastParReviewedByMembershipId: string | null;
  reorderNotes: string | null;
  updatedAt: string;
}

/** §8.1 — one APPEND-ONLY entry of the DEA 21 CFR §1304 perpetual log. `balanceAfterQuantity` is the
 *  balance AS RECORDED, not one derived at read time: a recomputed balance silently absorbs a missing
 *  entry, which is the exact discrepancy the log exists to expose. */
export interface PerpetualLogEntry {
  transactionKind: string;
  quantityDelta: string;
  balanceAfterQuantity: string;
  unit: string;
  recordedByMembershipId: string;
  witnessMembershipId: string | null;
  occurredAt: string;
  sourceReference: string | null;
}

export interface PerpetualLogLineView {
  dispatchedContentId: string;
  drugName: string;
  lotNumber: string | null;
  controlledSubstanceSchedule: string | null;
  dispatchedQuantity: string;
  dispatchedUnit: string;
  expirationDate: string | null;
  entries: PerpetualLogEntry[];
}

/** §8.1 — the whole kit's log, which is the unit an inspector actually asks for. */
export interface PerpetualLogView {
  dispatchId: string;
  kitSerialNumber: string;
  dispatchedAt: string;
  dispatchedByMembershipId: string;
  lines: PerpetualLogLineView[];
}

// ── request-side shapes (mirror of the §4.2 TypeBox bodies) ────────────────────────────────────────────

/** D7 / §4.2.1 — the delivery-address snapshot frozen onto the request. */
export interface DeliveryAddressInput {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

/** One dispatched line on the way IN (§4.2). `lotNumber` / `expirationDate` are optional HERE on purpose:
 *  §3.1.9's CHECK requires them on a controlled line, and the DOMAIN raises the typed refusal
 *  (`M21_LOT_NUMBER_REQUIRED`) rather than the boundary raising a generic 422. */
export interface DispatchLineInput {
  comfortKitTemplateMedicationId: string;
  medicationOrderId?: string;
  dispatchedQuantity: string;
  dispatchedUnit: string;
  lotNumber?: string;
  expirationDate?: string;
  manufacturerNdc?: string;
}

/** One reconciled line on the way IN. `consumedQuantity` is deliberately absent — there is no column to
 *  write it to, and accepting it would let a reconciler believe they had EXPLAINED a shortfall they had
 *  only described (§4.2.2). */
export interface ReconcileLineInput {
  dispatchedContentId: string;
  quantityReturned: string;
  quantityDisposedAtHome: string;
  discrepancyExplanation?: string;
}

/** One template medication on the way IN. */
export interface TemplateMedicationInput {
  rxnorm: string;
  ndc?: string;
  drugName: string;
  strength: string;
  dosageForm: string;
  routeOfAdministration: string;
  isControlledSubstance: boolean;
  controlledSubstanceSchedule?: string;
  expectedQuantity: string;
  expectedUnit: string;
  replenishmentThresholdPct?: string;
  displayOrder?: number;
  notes?: string;
}

// ── request helpers ────────────────────────────────────────────────────────────────────────────────────

/** ADR-0021 — a fresh client idempotency key per mutation attempt. */
export function idemKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `m21-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

/**
 * §7.2 — the mutation headers. `If-Match` carries the row `updated_at` the caller READ, as an exact ISO
 * string. Passing `undefined` is for the two creates that have no row to have read (`POST /supply-requests`,
 * `POST /comfort-kit-dispatches`); every transition passes the stamp, and omitting it is a 428, not a
 * silent last-write-wins — for a controlled-substance count, "last write wins" means one of the two counts
 * is silently gone.
 */
export function writeHeaders(updatedAt?: string | null): Record<string, string> {
  const header: Record<string, string> = { "Idempotency-Key": idemKey() };
  if (updatedAt) header["If-Match"] = updatedAt;
  return header;
}

/**
 * Turn a failed response into the sentence a coordinator can act on. The server's problem+json body is the
 * source of truth; the status-derived fallbacks name the contracts a screen can actually violate (412 = the
 * row moved, 428 = a blind write, 403 = a §4.4 predicate refused) rather than a generic failure.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const body = error as { title?: string; detail?: string; code?: string; status?: number } | null;
  if (body?.detail) return body.detail;
  if (body?.title) return body.title;
  if (body?.status === 412)
    return "This record changed while you were working on it. Reload and re-apply your edit.";
  if (body?.status === 428) return "This edit is missing its version stamp. Reload the record and try again.";
  if (body?.status === 403)
    return "You do not hold the authority this action requires for this record.";
  return fallback;
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

/** Row 2 — the supply-request worklist. The server scopes it; a request out of reach is simply absent. */
export async function listSupplyRequests(
  client: ApiClient,
  query: {
    patientId?: string;
    status?: string;
    kind?: string;
    locationId?: string;
    openOnly?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<SupplyRequestListItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/supply-requests", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<SupplyRequestListItem>, error: null };
}

/** Row 3 — the full request. A 404 is "absent OR out of reach", deliberately indistinguishable. */
export async function getSupplyRequest(
  client: ApiClient,
  supplyRequestId: string,
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/supply-requests/{supplyRequestId}", {
    params: { path: { supplyRequestId } },
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 11 — the SKU catalog: platform rows UNION the tenant overlay, one browsable list. */
export async function listSupplyItems(
  client: ApiClient,
  query: {
    skuClass?: string;
    q?: string;
    includeRetired?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<SupplyItemView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/supply-items", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<SupplyItemView>, error: null };
}

/** Row 13 — one SKU, platform or overlay (the id space is disjoint, so one route serves both). */
export async function getSupplyItem(
  client: ApiClient,
  id: string,
): Promise<{ item: SupplyItemView | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/supply-items/{id}", {
    params: { path: { id } },
  } as never);
  if (res.error) return { item: null, error: res.error };
  return { item: res.data as unknown as SupplyItemView, error: null };
}

/** Row 17 — the comfort-kit templates. `includePlatformFloor` defaults ON server-side, which is what the
 *  admin screen wants (the D3 floor row visible and locked); a picker passes `false`. */
export async function listComfortKitTemplates(
  client: ApiClient,
  query: {
    includePlatformFloor?: boolean;
    includeSuperseded?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<ComfortKitTemplateView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/comfort-kit-templates", {
    params: { query },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<ComfortKitTemplateView>, error: null };
}

/** Row 21 — dispatches, per patient / per Location / per IPU room (the D17 stock-kit view). */
export async function listDispatches(
  client: ApiClient,
  query: {
    patientId?: string;
    locationId?: string;
    ipuRoomId?: string;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<DispatchListItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/comfort-kit-dispatches", {
    params: { query },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<DispatchListItem>, error: null };
}

/** Row 22 — the dispatch with its full per-line manifest. */
export async function getDispatch(
  client: ApiClient,
  dispatchId: string,
): Promise<{ dispatch: DispatchDetail | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/comfort-kit-dispatches/{dispatchId}", {
    params: { path: { dispatchId } },
  } as never);
  if (res.error) return { dispatch: null, error: res.error };
  return { dispatch: res.data as unknown as DispatchDetail, error: null };
}

/** §8.1 — the DEA perpetual log for one kit. Its OWN permission key (`comfort_kit.perpetual_log.read`): a
 *  coordinator who may file requests must not thereby acquire the lot-level custody chain. */
export async function getPerpetualLog(
  client: ApiClient,
  dispatchId: string,
): Promise<{ log: PerpetualLogView | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/comfort-kit-dispatches/{dispatchId}/perpetual-log", {
    params: { path: { dispatchId } },
  } as never);
  if (res.error) return { log: null, error: res.error };
  return { log: res.data as unknown as PerpetualLogView, error: null };
}

/** Row 25 — the reconciliation worklist, OLDEST due first: the point of the list is what is most overdue. */
export async function listReturns(
  client: ApiClient,
  query: {
    patientId?: string;
    openOnly?: boolean;
    overdueOnly?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<ReturnListItem> | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/comfort-kit-returns", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<ReturnListItem>, error: null };
}

/** Row 26 — the return with its per-line accounting and the disposal record. */
export async function getReturn(
  client: ApiClient,
  returnId: string,
): Promise<{ ret: ReturnDetail | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/comfort-kit-returns/{returnId}", {
    params: { path: { returnId } },
  } as never);
  if (res.error) return { ret: null, error: res.error };
  return { ret: res.data as unknown as ReturnDetail, error: null };
}

/** Row 28 — the D4 ladder, most-specific first. Platform-scope rows come back for every tenant via the
 *  table's own floor-plus-overlay RLS policy; this call asks for no such thing. */
export async function listVendorRoutingRules(
  client: ApiClient,
  query: { scopeKind?: string; includeRetired?: boolean; cursor?: string; limit?: number } = {},
): Promise<{ page: CursorPage<VendorRoutingRuleView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/vendor-routing-rules", {
    params: { query },
  } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<VendorRoutingRuleView>, error: null };
}

/** Row 32 — the hub shelf, with `severity` DERIVED per row by the server. */
export async function listParStock(
  client: ApiClient,
  query: {
    locationId?: string;
    belowThresholdOnly?: boolean;
    cursor?: string;
    limit?: number;
  } = {},
): Promise<{ page: CursorPage<ParStockView> | null; error: unknown }> {
  const res = await client.GET("/api/v1/supplies/par-stock", { params: { query } } as never);
  if (res.error) return { page: null, error: res.error };
  return { page: res.data as unknown as CursorPage<ParStockView>, error: null };
}

// ── supply-request writes (rows 1, 4–10) ───────────────────────────────────────────────────────────────

/** Row 1 — create a request. No `If-Match`: there is no row to have read. The §4.4 dispatcher predicate is
 *  applied CONDITIONALLY by the route (only when `kindPayload.kind = comfort_kit_deploy`). */
export async function createSupplyRequest(
  client: ApiClient,
  body: {
    patientId: string;
    admissionId: string;
    locationId: string;
    sourceOrderId?: string;
    deliveryAddress: DeliveryAddressInput;
    deliveryInstructions?: string;
    kindPayload: { kind: string; [k: string]: unknown };
  },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 4 — the D4 vendor override. The ladder still runs; the override is recorded ON TOP of its trace, so
 *  the record shows both the rules evaluated and the human decision that overrode them. */
export async function assignVendor(
  client: ApiClient,
  supplyRequestId: string,
  updatedAt: string,
  body: {
    vendorId: string | null;
    fulfillmentMode: string;
    pharmacyDispatchMode?: string;
    overrideReason?: string;
  },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests/{supplyRequestId}/assign-vendor", {
    params: { path: { supplyRequestId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 5 — the vendor accepted (Phase-1 portal/email/fax entry; Phase-2 the EDI 855 ack). */
export async function markOrdered(
  client: ApiClient,
  supplyRequestId: string,
  updatedAt: string,
  body: { vendorOrderReference: string },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests/{supplyRequestId}/mark-ordered", {
    params: { path: { supplyRequestId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 6 — shipment identifiers (Phase-1 manual, Phase-2 the EDI 856 ASN). */
export async function markInTransit(
  client: ApiClient,
  supplyRequestId: string,
  updatedAt: string,
  body: { trackingNumber: string; carrier: string },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests/{supplyRequestId}/mark-in-transit", {
    params: { path: { supplyRequestId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 7 — the D7 courier attestation. `deliveredByMembershipId` is NOT in the body: the server stamps the
 *  acting membership from the session. A courier who could name someone else has attested to nothing. */
export async function markDelivered(
  client: ApiClient,
  supplyRequestId: string,
  updatedAt: string,
  body: { deliveredAt: string; deliveryMethod: string; evidenceDocumentId?: string },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests/{supplyRequestId}/mark-delivered", {
    params: { path: { supplyRequestId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 8 — caregiver / clinician confirms receipt. `system_auto_confirm` is NOT reachable from here — it is
 *  the 72h fallback the §4.6 worker writes. */
export async function confirmReceived(
  client: ApiClient,
  supplyRequestId: string,
  updatedAt: string,
  body: { actor: string; confirmedAt: string },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests/{supplyRequestId}/confirm-received", {
    params: { path: { supplyRequestId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 9 — cancel. ONE route for both §2.2 cancellation edges: the service picks the immediate edge before
 *  `ordered` and the two-phase one after, so the screen never has to know which side of the vendor
 *  handshake the row sits on. */
export async function cancelSupplyRequest(
  client: ApiClient,
  supplyRequestId: string,
  updatedAt: string,
  body: { reason: string },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests/{supplyRequestId}/cancel", {
    params: { path: { supplyRequestId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

/** Row 10 — initiate an equipment return (the §2.2 DME pickup branch). */
export async function returnSupplyRequest(
  client: ApiClient,
  supplyRequestId: string,
  updatedAt: string,
  body: { reason: string },
): Promise<{ request: SupplyRequestDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-requests/{supplyRequestId}/return", {
    params: { path: { supplyRequestId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { request: null, error: res.error };
  return { request: res.data as unknown as SupplyRequestDetail, error: null };
}

// ── catalog + template writes (rows 12, 14–16, 18, 19) ─────────────────────────────────────────────────

/** Row 12 — create a canonical HCPCS-keyed SKU. PLATFORM-ONLY: `supply_item` carries no organization_id, so
 *  the permission is the first gate and the `wardenx_admin`-only RLS write policy is the backstop. */
export async function createSupplyItem(
  client: ApiClient,
  body: {
    hcpcs?: string;
    rxnorm?: string;
    ndc?: string;
    name: string;
    skuClass: string;
    defaultUnit: string;
    isBillable?: boolean;
    isControlledSubstance?: boolean;
    requiresLotTracking?: boolean;
    requiresExpirationTracking?: boolean;
    isSerializedAsset?: boolean;
  },
): Promise<{ item: SupplyItemView | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-items", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { item: null, error: res.error };
  return { item: res.data as unknown as SupplyItemView, error: null };
}

/** Row 14 — retire a canonical SKU. Effective-dating, never deletion: a retired HCPCS code must keep
 *  resolving for every historical `supply_request` written against it. */
export async function retireSupplyItem(
  client: ApiClient,
  id: string,
  body: { effectiveTo: string; reason?: string },
): Promise<{ item: SupplyItemView | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/supply-items/{id}/retire", {
    params: { path: { id } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { item: null, error: res.error };
  return { item: res.data as unknown as SupplyItemView, error: null };
}

/** Row 15 — create the tenant-local, non-billable overlay item (D11's tenant half). */
export async function createTenantSupplyItem(
  client: ApiClient,
  body: {
    name: string;
    localSkuCode: string;
    defaultUnit: string;
    isBillable?: boolean;
    isActive?: boolean;
  },
): Promise<{ item: SupplyItemView | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/tenant-supply-items", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { item: null, error: res.error };
  return { item: res.data as unknown as SupplyItemView, error: null };
}

/** Row 16 — edit a tenant-local item. */
export async function updateTenantSupplyItem(
  client: ApiClient,
  id: string,
  body: {
    name: string;
    localSkuCode: string;
    defaultUnit: string;
    isBillable?: boolean;
    isActive?: boolean;
  },
): Promise<{ item: SupplyItemView | null; error: unknown }> {
  const res = await client.PUT("/api/v1/supplies/tenant-supply-items/{id}", {
    params: { path: { id } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { item: null, error: res.error };
  return { item: res.data as unknown as SupplyItemView, error: null };
}

/** Row 18 — author a tenant template. The D3 floor validation runs BEFORE anything is written, so a
 *  template that drops below the four-medication floor never exists even transiently. */
export async function createComfortKitTemplate(
  client: ApiClient,
  body: { name: string; medications: TemplateMedicationInput[] },
): Promise<{ template: ComfortKitTemplateView | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/comfort-kit-templates", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { template: null, error: res.error };
  return { template: res.data as unknown as ComfortKitTemplateView, error: null };
}

/** Row 19 — supersede a template. `PUT`, but it INSERTS a new row pointing back through
 *  `replaces_template_id` and closes the predecessor's window: a dispatch from three months ago must still
 *  resolve the recipe it actually used. That is why the body is the FULL new definition, not a patch. */
export async function supersedeComfortKitTemplate(
  client: ApiClient,
  templateId: string,
  body: { name: string; medications: TemplateMedicationInput[]; effectiveFrom?: string },
): Promise<{ template: ComfortKitTemplateView | null; error: unknown }> {
  const res = await client.PUT("/api/v1/supplies/comfort-kit-templates/{templateId}", {
    params: { path: { templateId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { template: null, error: res.error };
  return { template: res.data as unknown as ComfortKitTemplateView, error: null };
}

// ── comfort-kit dispatch / return writes (rows 20, 23, 24, 27 + the three §2.6 edges) ──────────────────

/** Row 20 — dispatch a kit. Carries the §4.4 `controlled_substance_dispatcher_eligible` predicate AND a
 *  step-up gate: this is a DEA-attributable signature on a scheduled drug. */
export async function createDispatch(
  client: ApiClient,
  body: {
    supplyRequestId: string;
    comfortKitTemplateId: string;
    locationId: string;
    deploymentSite: string;
    ipuRoomId?: string;
    facilityIdentifier?: { facilityName: string; facilityNpi?: string; roomNumber?: string };
    dispatchSource: string;
    pharmacyDispatchMode: string;
    pharmacyPartnerId?: string;
    kitSerialNumber: string;
    contents: DispatchLineInput[];
    specialHandlingNotes?: string;
  },
): Promise<{ dispatch: DispatchDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/comfort-kit-dispatches", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { dispatch: null, error: res.error };
  return { dispatch: res.data as unknown as DispatchDetail, error: null };
}

/** Row 23 — the kit is physically at the patient. This is the event M13 builds its deployment rows FROM. */
export async function deployAtPatient(
  client: ApiClient,
  dispatchId: string,
  updatedAt: string,
  body: { deployedAt: string },
): Promise<{ dispatch: DispatchDetail | null; error: unknown }> {
  const res = await client.POST(
    "/api/v1/supplies/comfort-kit-dispatches/{dispatchId}/deploy-at-patient",
    {
      params: { path: { dispatchId } },
      headers: writeHeaders(updatedAt),
      body,
    } as never,
  );
  if (res.error) return { dispatch: null, error: res.error };
  return { dispatch: res.data as unknown as DispatchDetail, error: null };
}

/** Row 24 — open a return obligation. Refused when M13 has not yet acked the deployment: a return with
 *  nothing to close is a record of a count nobody can reconcile. */
export async function createReturn(
  client: ApiClient,
  body: { dispatchId: string; returnReason: string; returnRequiredAt?: string },
): Promise<{ ret: ReturnDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/comfort-kit-returns", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { ret: null, error: res.error };
  return { ret: res.data as unknown as ReturnDetail, error: null };
}

/** §2.6 — assign the supply-team member who will physically retrieve. §4.4's separation-of-duties clause
 *  compares the retriever against the witness, so somebody has to be able to set it. */
export async function assignRetriever(
  client: ApiClient,
  returnId: string,
  updatedAt: string,
  body: { retrievingMembershipId: string },
): Promise<{ ret: ReturnDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/comfort-kit-returns/{returnId}/assign-retriever", {
    params: { path: { returnId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { ret: null, error: res.error };
  return { ret: res.data as unknown as ReturnDetail, error: null };
}

/** Row 27 — reconcile. The D8 discrepancy is COMPUTED by the server from the quantities and never accepted
 *  from the body: a flag the reconciler can set is one they can clear, and §7.3 is explicit that only an
 *  M30 investigation closure marks a discrepancy explained. */
export async function reconcileReturn(
  client: ApiClient,
  returnId: string,
  updatedAt: string,
  body: {
    disposalMethod: string;
    disposalWitnessMembershipId?: string;
    perMedicationReconciliation: ReconcileLineInput[];
    disposalNotes?: string;
    discrepancyNotes?: string;
  },
): Promise<{ ret: ReturnDetail | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/comfort-kit-returns/{returnId}/reconcile", {
    params: { path: { returnId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { ret: null, error: res.error };
  return { ret: res.data as unknown as ReturnDetail, error: null };
}

/** §2.6 — the 90-day assumption of loss. Deliberately NOT folded into `reconcile`: writing off a kit that
 *  held a CII solution is a different authority from counting one that came back. */
export async function declareUnreturnable(
  client: ApiClient,
  returnId: string,
  updatedAt: string,
  body: { reason: string },
): Promise<{ ret: ReturnDetail | null; error: unknown }> {
  const res = await client.POST(
    "/api/v1/supplies/comfort-kit-returns/{returnId}/declare-unreturnable",
    {
      params: { path: { returnId } },
      headers: writeHeaders(updatedAt),
      body,
    } as never,
  );
  if (res.error) return { ret: null, error: res.error };
  return { ret: res.data as unknown as ReturnDetail, error: null };
}

// ── operations writes (rows 29–31, 33, 34) ─────────────────────────────────────────────────────────────

/** Row 29 — author a routing rule. `platform` scope is absent from the union by design. */
export async function createVendorRoutingRule(
  client: ApiClient,
  body: {
    scopeKind: string;
    scopeId?: string;
    skuClassPattern?: string;
    assignedVendorId: string | null;
    assignedFulfillmentMode: string;
    defaultPharmacyDispatchMode?: string;
    precedencePriority?: number;
  },
): Promise<{ rule: VendorRoutingRuleView | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/vendor-routing-rules", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { rule: null, error: res.error };
  return { rule: res.data as unknown as VendorRoutingRuleView, error: null };
}

/** Row 30 — edit a rule. */
export async function updateVendorRoutingRule(
  client: ApiClient,
  ruleId: string,
  body: {
    scopeKind: string;
    scopeId?: string;
    skuClassPattern?: string;
    assignedVendorId: string | null;
    assignedFulfillmentMode: string;
    defaultPharmacyDispatchMode?: string;
    precedencePriority?: number;
  },
): Promise<{ rule: VendorRoutingRuleView | null; error: unknown }> {
  const res = await client.PUT("/api/v1/supplies/vendor-routing-rules/{ruleId}", {
    params: { path: { ruleId } },
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { rule: null, error: res.error };
  return { rule: res.data as unknown as VendorRoutingRuleView, error: null };
}

/** Row 31 — RETIRE a rule. The verb is DELETE because §4.1's table says so, but the row survives
 *  (`is_active = false`, `effective_to = now`): every historical `routing_rule_resolved_jsonb` names this
 *  rule id, and a survey asking "which rule sent this bed to Apria" must still resolve it. */
export async function retireVendorRoutingRule(
  client: ApiClient,
  ruleId: string,
): Promise<{ rule: VendorRoutingRuleView | null; error: unknown }> {
  const res = await client.DELETE("/api/v1/supplies/vendor-routing-rules/{ruleId}", {
    params: { path: { ruleId } },
    headers: writeHeaders(),
  } as never);
  if (res.error) return { rule: null, error: res.error };
  return { rule: res.data as unknown as VendorRoutingRuleView, error: null };
}

/** Row 33 — edit the par thresholds. The boundary mirrors §3.1.6's ordering CHECK, so an inverted pair is a
 *  field-anchored 422 rather than a 500 out of PostgreSQL. */
export async function updateParStock(
  client: ApiClient,
  parStockId: string,
  updatedAt: string,
  body: {
    reorderPoint?: string;
    reorderQuantity?: string;
    minSafetyStock?: string;
    isActive?: boolean;
    reorderNotes?: string;
  },
): Promise<{ par: ParStockView | null; error: unknown }> {
  const res = await client.PUT("/api/v1/supplies/par-stock/{parStockId}", {
    params: { path: { parStockId } },
    headers: writeHeaders(updatedAt),
    body,
  } as never);
  if (res.error) return { par: null, error: res.error };
  return { par: res.data as unknown as ParStockView, error: null };
}

/** Row 34 — record an on-hand count. The observation SETS the quantity; it does not adjust it. A hub worker
 *  counting a shelf knows what is on it, not what changed since the last count. */
export async function observeParStock(
  client: ApiClient,
  body: {
    parStockId: string;
    observedQuantity: string;
    observedAt?: string;
    reorderNotes?: string;
  },
): Promise<{ par: ParStockView | null; error: unknown }> {
  const res = await client.POST("/api/v1/supplies/par-stock/observe", {
    headers: writeHeaders(),
    body,
  } as never);
  if (res.error) return { par: null, error: res.error };
  return { par: res.data as unknown as ParStockView, error: null };
}
