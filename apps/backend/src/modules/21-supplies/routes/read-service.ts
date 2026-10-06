// apps/backend/src/modules/21-supplies/routes/read-service.ts — the M21 READ port + its response DTOs
// (§4.1's GET rows). The Drizzle implementation is ./read-service-drizzle.ts; tests bind an in-memory one.
//
// DTO RULE (the M30-T?? "wire enum published as Type.String() is a silent lie" lesson): every enum-shaped
// field below is typed to the FROZEN `@wardenx/types` union, not to `string`. A DTO that widens an enum
// compiles, ships, and then lets a screen render a value the column can never hold — or, worse, lets a
// client send one back. The unions here are the same ones `packages/db/src/enums.ts` declares.
//
// PHI POSTURE. Two D13-denylisted free-text columns are deliberately NOT on any list DTO:
// `supply_request.delivery_instructions` ("leave with the daughter at the blue house") and
// `comfort_kit_dispatch.special_handling_notes`. They appear on the DETAIL DTOs only, which is what makes
// the difference between a coordinator opening one request and a list endpoint spraying home-access
// instructions for a whole Location into a browser cache. `comfort_kit_return.disposal_notes` /
// `discrepancy_notes` follow the same rule.
import type {
  ComfortKitDeploymentSite,
  ComfortKitDispatchId,
  ComfortKitDispatchSource,
  ComfortKitDispatchStatus,
  ComfortKitDispatchedContentPayload,
  ComfortKitDisposalMethod,
  ComfortKitReturnId,
  ComfortKitReturnState,
  ComfortKitTemplateId,
  ControlledSubstanceSchedule,
  DeaPerpetualLogEntry,
  IsoInstant,
  LocalDate,
  LocationId,
  MembershipId,
  ParStockId,
  PatientId,
  PharmacyDispatchMode,
  RoutingRuleResolved,
  SupplyCaregiverSignatureCaptureMethod,
  SupplyCaregiverSignatureEvidence,
  SupplyDeliveryMethod,
  SupplyFulfillmentMode,
  SupplyItemId,
  HospiceCoverage,
  SupplyReceivedConfirmedActor,
  SupplyRequestId,
  SupplyRequestKind,
  SupplyRequestStatus,
  SupplySkuClass,
  VendorRoutingRuleId,
  VendorRoutingScopeKind,
} from "@wardenx/types";
import type { M21ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

/** §4.1 rows 2 / 3 — one supply request on the dashboard list. No free text (see the header). */
export interface SupplyRequestListItem {
  readonly supplyRequestId: SupplyRequestId;
  readonly patientId: PatientId;
  readonly locationId: LocationId;
  readonly kind: SupplyRequestKind;
  readonly status: SupplyRequestStatus;
  readonly assignedVendorId: string | null;
  readonly vendorOrderReference: string | null;
  readonly trackingNumber: string | null;
  readonly carrier: string | null;
  readonly orderedAt: IsoInstant | null;
  readonly deliveredAt: IsoInstant | null;
  readonly createdAt: IsoInstant;
  /** The `If-Match` value a transition on this row must echo (§7.2). */
  readonly updatedAt: IsoInstant;
  /** COP27 — the hospice coverage determination (the list badge; the reason is detail-only free text). */
  readonly hospiceCoverage: HospiceCoverage;
}

/** §4.1 row 3 — the full request. Carries the D13 free text and the frozen D4 routing record. */
export interface SupplyRequestDetail extends SupplyRequestListItem {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly sourceOrderId: string | null;
  readonly sourceReplenishmentEventId: string | null;
  readonly requestedByMembershipId: MembershipId | null;
  readonly data: unknown;
  readonly routingRuleResolved: RoutingRuleResolved | null;
  readonly pharmacyPartnerId: string | null;
  readonly documentId: string | null;
  readonly deliveryInstructions: string | null;
  readonly deliveryMethod: SupplyDeliveryMethod | null;
  readonly deliveredByMembershipId: MembershipId | null;
  readonly deliveryEvidenceDocumentId: string | null;
  readonly receivedConfirmedAt: IsoInstant | null;
  readonly receivedConfirmedActor: SupplyReceivedConfirmedActor | null;
  readonly completedAt: IsoInstant | null;
  readonly cancelledAt: IsoInstant | null;
  readonly cancellationPendingAt: IsoInstant | null;
  readonly cancellationReason: string | null;
  readonly shippedAt: IsoInstant | null;
  readonly invoiceTotalCents: number | null;
  readonly invoiceAccruedAt: IsoInstant | null;
  readonly invoiceReconciledAt: IsoInstant | null;
  readonly invoiceVarianceCents: number | null;
  /** The dispatch this request produced, when it is a kit kind (§2.5). */
  readonly dispatchId: ComfortKitDispatchId | null;
  /** F-193 (#248) — M21's own caregiver-signature capture. `null` until captured; always optional. */
  readonly caregiverSignatureCaptureMethod: SupplyCaregiverSignatureCaptureMethod | null;
  readonly caregiverSignatureCapturedAt: IsoInstant | null;
  readonly caregiverSignatureCapturedByMembershipId: MembershipId | null;
  readonly caregiverSignatureEvidenceDocumentId: string | null;
  readonly caregiverSignatureEvidence: SupplyCaregiverSignatureEvidence | null;
  /** COP27 (42 CFR 418.24(c)) — the patient-facing reason; required when not covered. */
  readonly coverageReason: string | null;
  /** `null` = never explicitly determined (presumed related — the migration default). */
  readonly coverageDeterminedAt: IsoInstant | null;
  /** The determining MEMBERSHIP id (session-derived). */
  readonly coverageDeterminedBy: MembershipId | null;
}

/** §4.1 rows 11 / 13 — a catalog SKU. Platform rows have no org; the overlay rows are tenant-scoped. */
export interface SupplyItemView {
  readonly supplyItemId: SupplyItemId;
  readonly isPlatform: boolean;
  readonly hcpcs: string | null;
  readonly rxnorm: string | null;
  readonly ndc: string | null;
  readonly name: string;
  readonly skuClass: SupplySkuClass;
  readonly defaultUnit: string;
  readonly isBillable: boolean;
  readonly isActive: boolean;
  readonly isControlledSubstance: boolean | null;
  readonly requiresLotTracking: boolean | null;
  readonly requiresExpirationTracking: boolean | null;
  readonly isSerializedAsset: boolean | null;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
  /** Set only on a tenant-overlay row (D11): the agency's own shelf code. */
  readonly localSkuCode: string | null;
  readonly updatedAt: IsoInstant;
}

/** One line of a §2.3 comfort-kit template. */
export interface ComfortKitTemplateMedicationView {
  readonly templateMedicationId: string;
  readonly rxnorm: string;
  readonly ndc: string | null;
  readonly drugName: string;
  readonly strength: string;
  readonly dosageForm: string;
  readonly routeOfAdministration: string;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
  readonly expectedQuantity: string;
  readonly expectedUnit: string;
  readonly replenishmentThresholdPct: string;
  readonly systemLocked: boolean;
  readonly displayOrder: number;
}

/** §4.1 row 17 — a comfort-kit template with its lines (the D3 floor row included when asked for). */
export interface ComfortKitTemplateView {
  readonly comfortKitTemplateId: ComfortKitTemplateId;
  readonly name: string;
  readonly isPlatformFloor: boolean;
  readonly systemLocked: boolean;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
  readonly replacesTemplateId: ComfortKitTemplateId | null;
  readonly medications: readonly ComfortKitTemplateMedicationView[];
  readonly updatedAt: IsoInstant;
}

/** §4.1 rows 21 / 22 — one comfort-kit dispatch on the list. No free text (see the header). */
export interface DispatchListItem {
  readonly dispatchId: ComfortKitDispatchId;
  readonly supplyRequestId: SupplyRequestId;
  readonly patientId: PatientId;
  readonly locationId: LocationId;
  readonly comfortKitTemplateId: ComfortKitTemplateId;
  readonly kitSerialNumber: string;
  readonly deploymentSite: ComfortKitDeploymentSite;
  readonly dispatchStatus: ComfortKitDispatchStatus;
  readonly ipuRoomId: string | null;
  readonly dispatchedAt: IsoInstant;
  readonly deployedAtPatientAt: IsoInstant | null;
  readonly containsControlledSubstance: boolean;
  readonly updatedAt: IsoInstant;
}

/** §4.1 row 22 — the full dispatch, including the per-line DEA 1304 outbound manifest. */
export interface DispatchDetail extends DispatchListItem {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly dispatchSource: ComfortKitDispatchSource;
  readonly pharmacyDispatchMode: PharmacyDispatchMode;
  readonly pharmacyPartnerId: string | null;
  readonly dispatchedByMembershipId: MembershipId;
  readonly deployedByMembershipId: MembershipId | null;
  readonly bolDocumentId: string | null;
  readonly m13DeploymentId: string | null;
  readonly controlledSubstanceHandlingPolicyDigest: string;
  readonly facilityIdentifier: unknown;
  readonly specialHandlingNotes: string | null;
  readonly contents: readonly ComfortKitDispatchedContentPayload[];
}

/** §4.1 rows 25 / 26 — one comfort-kit return on the reconciliation worklist. */
export interface ComfortKitReturnListItem {
  readonly returnId: ComfortKitReturnId;
  readonly dispatchId: ComfortKitDispatchId;
  readonly patientId: PatientId;
  readonly locationId: LocationId;
  readonly state: ComfortKitReturnState;
  readonly returnRequiredAt: IsoInstant;
  readonly returnDueAt: IsoInstant;
  readonly assignedRetrievingMembershipId: MembershipId | null;
  readonly reconciledAt: IsoInstant | null;
  readonly containsControlledSubstance: boolean;
  /** Computed, never stored: days past `return_due_at` at read time (0 when not yet due). */
  readonly daysOverdue: number;
  readonly updatedAt: IsoInstant;
}

/** One reconciled line, as stored (the D8 discrepancy columns are trigger-computed — read, never sent). */
export interface ComfortKitReturnedLineView {
  readonly returnedContentId: string;
  readonly dispatchedContentId: string;
  readonly drugName: string;
  readonly lotNumber: string | null;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
  readonly dispatchedQuantity: string;
  readonly quantityReturned: string;
  readonly quantityDisposedAtHome: string;
  readonly quantityUnaccounted: string;
  readonly discrepancyPct: string;
  readonly discrepancyFlagged: boolean;
}

/** §4.1 row 26 — the full return with its per-line accounting and the disposal record. */
export interface ComfortKitReturnDetail extends ComfortKitReturnListItem {
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly m13DeploymentId: string;
  readonly retrievingAt: IsoInstant | null;
  readonly retrievedAt: IsoInstant | null;
  readonly returnedToHubAt: IsoInstant | null;
  readonly disposalMethod: ComfortKitDisposalMethod | null;
  readonly disposalWitnessMembershipId: MembershipId | null;
  readonly disposalMethodJurisdictionPolicyDigest: string | null;
  readonly reconciledByMembershipId: MembershipId | null;
  readonly receiptDocumentId: string | null;
  readonly disposalNotes: string | null;
  readonly discrepancyNotes: string | null;
  readonly unreturnableReason: string | null;
  readonly unreturnableAttestedByMembershipId: MembershipId | null;
  readonly lines: readonly ComfortKitReturnedLineView[];
  /** True when ANY line crossed the D8 5% threshold — computed from the lines, never a stored flag. */
  readonly discrepancyDetected: boolean;
}

/** §4.1 row 28 — a D4 routing rule. */
export interface VendorRoutingRuleView {
  readonly ruleId: VendorRoutingRuleId;
  readonly isPlatform: boolean;
  readonly scopeKind: VendorRoutingScopeKind;
  readonly scopeId: string | null;
  readonly skuClassPattern: string | null;
  readonly assignedVendorId: string | null;
  readonly assignedFulfillmentMode: SupplyFulfillmentMode;
  readonly defaultPharmacyDispatchMode: PharmacyDispatchMode | null;
  readonly precedencePriority: number;
  readonly isActive: boolean;
  readonly effectiveFrom: IsoInstant;
  readonly effectiveTo: IsoInstant | null;
  readonly updatedAt: IsoInstant;
}

/** §4.1 row 32 — one shelf row plus its DERIVED band (`ok` / `below_threshold` / `critical_low` /
 *  `depleted`). The band is never stored: a stored severity goes stale the moment a threshold is edited,
 *  and the screen reading it would show a green shelf that is actually empty (§3.1.6 header). */
export interface ParStockView {
  readonly parStockId: ParStockId;
  readonly locationId: LocationId;
  readonly skuId: SupplyItemId | null;
  readonly tenantSkuExtensionId: string | null;
  readonly skuName: string;
  readonly currentQuantity: string;
  readonly unit: string;
  readonly reorderPoint: string;
  readonly reorderQuantity: string;
  readonly minSafetyStock: string;
  readonly severity: "ok" | "below_threshold" | "critical_low" | "depleted";
  readonly isActive: boolean;
  readonly lastParReviewAt: IsoInstant | null;
  readonly lastParReviewedByMembershipId: MembershipId | null;
  readonly reorderNotes: string | null;
  readonly updatedAt: IsoInstant;
}

/** §8.1 — the DEA 21 CFR §1304 perpetual log for one dispatched line, oldest entry first. */
export interface PerpetualLogLineView {
  readonly dispatchedContentId: string;
  readonly drugName: string;
  readonly lotNumber: string | null;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
  readonly dispatchedQuantity: string;
  readonly dispatchedUnit: string;
  readonly expirationDate: LocalDate | null;
  readonly entries: readonly DeaPerpetualLogEntry[];
}

/** §8.1 — the whole kit's perpetual log, which is the unit an inspector actually asks for. */
export interface PerpetualLogView {
  readonly dispatchId: ComfortKitDispatchId;
  readonly kitSerialNumber: string;
  readonly dispatchedAt: IsoInstant;
  readonly dispatchedByMembershipId: MembershipId;
  readonly lines: readonly PerpetualLogLineView[];
}

/** Filters the list reads accept (already validated by the route's TypeBox query schema). */
export interface SupplyRequestFilters {
  readonly patientId?: string;
  readonly status?: SupplyRequestStatus;
  readonly kind?: SupplyRequestKind;
  readonly locationId?: string;
  readonly openOnly?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DispatchFilters {
  readonly patientId?: string;
  readonly locationId?: string;
  readonly ipuRoomId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ReturnFilters {
  readonly patientId?: string;
  readonly openOnly?: boolean;
  readonly overdueOnly?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CatalogFilters {
  readonly skuClass?: SupplySkuClass;
  readonly q?: string;
  readonly includeRetired?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TemplateFilters {
  readonly includePlatformFloor?: boolean;
  readonly includeSuperseded?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface RoutingRuleFilters {
  readonly scopeKind?: VendorRoutingScopeKind;
  readonly includeRetired?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ParStockFilters {
  readonly locationId?: string;
  readonly belowThresholdOnly?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

/** The §4.1 READ surface. Every method opens its own `withOrgContext` (RLS scopes each statement). */
export interface M21ReadService {
  listSupplyRequests(
    actor: M21ReadActor,
    filters: SupplyRequestFilters,
  ): Promise<CursorPage<SupplyRequestListItem>>;
  getSupplyRequest(actor: M21ReadActor, supplyRequestId: string): Promise<SupplyRequestDetail>;

  listSupplyItems(
    actor: M21ReadActor,
    filters: CatalogFilters,
  ): Promise<CursorPage<SupplyItemView>>;
  getSupplyItem(actor: M21ReadActor, supplyItemId: string): Promise<SupplyItemView>;

  listComfortKitTemplates(
    actor: M21ReadActor,
    filters: TemplateFilters,
  ): Promise<CursorPage<ComfortKitTemplateView>>;
  /** One template with its lines. Separate from the list so a write-through read is O(1), not a page scan
   *  that would 404 the 501st template an org authored. */
  getComfortKitTemplate(actor: M21ReadActor, templateId: string): Promise<ComfortKitTemplateView>;

  listDispatches(
    actor: M21ReadActor,
    filters: DispatchFilters,
  ): Promise<CursorPage<DispatchListItem>>;
  getDispatch(actor: M21ReadActor, dispatchId: string): Promise<DispatchDetail>;

  listReturns(
    actor: M21ReadActor,
    filters: ReturnFilters,
  ): Promise<CursorPage<ComfortKitReturnListItem>>;
  getReturn(actor: M21ReadActor, returnId: string): Promise<ComfortKitReturnDetail>;

  listVendorRoutingRules(
    actor: M21ReadActor,
    filters: RoutingRuleFilters,
  ): Promise<CursorPage<VendorRoutingRuleView>>;
  /** One routing rule, retired or not (the write-through read; see the template note). */
  getVendorRoutingRule(actor: M21ReadActor, ruleId: string): Promise<VendorRoutingRuleView>;

  listParStock(actor: M21ReadActor, filters: ParStockFilters): Promise<CursorPage<ParStockView>>;
  /** One par row with its DERIVED severity (the write-through read; see the template note). */
  getParStock(actor: M21ReadActor, parStockId: string): Promise<ParStockView>;

  /** §8.1 — the DEA perpetual log for one dispatch (`comfort_kit.perpetual_log.read`). */
  getPerpetualLog(actor: M21ReadActor, dispatchId: string): Promise<PerpetualLogView>;
}
