// apps/backend/src/modules/21-supplies/routes/write-service.ts — the M21 WRITE port + its command inputs
// (§4.1's POST/PUT/DELETE rows). The Drizzle implementation is ./write-service-drizzle.ts.
//
// SHAPE OF EVERY COMMAND, without exception: open `withOrgContext` (RLS pins app.org_id) → load the
// aggregate row → run the PURE §2.2–§2.7 decision (`../lifecycle`) over already-resolved cross-module facts
// → execute the transition's DECLARED side effects (`./effects-runner`) and apply the row change under the
// §7.2 optimistic-concurrency guard → emit the §4.5.2 outbox event on the SAME tx. No business rule lives
// in SQL, and no event can outlive a rolled-back write (§2.11).
//
// THE ACTING MEMBERSHIP IS NEVER AN INPUT. Every command takes an `M21WriteActor` the route extracted from
// `request.context`, and every attribution column is stamped from it. The ONE membership id a caller may
// supply is `disposalWitnessMembershipId` — a witness is by definition a second person — and the §3.1.10
// CHECK plus the §4.4 predicate are what keep that honest. See routes/actor.ts for the full argument.
//
// THE M4 WRITE-AUDIT TRIGGERS (migration 0106) record every mutation with the per-table D13 denylist, so
// this layer never hand-writes an audit row — the denylisted free-text columns (`delivery_instructions`,
// `cancellation_reason`, `special_handling_notes`, `disposal_notes`, `discrepancy_notes`, `reorder_notes`)
// are scrubbed at the trigger, which is why they may be written here in full.
import type {
  ComfortKitDeploymentSite,
  ComfortKitDispatchSource,
  ComfortKitDisposalMethod,
  CreateDirectSupplyRequestInput,
  HospiceCoverage,
  IsoInstant,
  M21EventName,
  MembershipId,
  PharmacyDispatchMode,
  RoutingRuleResolved,
  SupplyCaregiverSignatureCaptureMethod,
  SupplyDeliveryMethod,
  SupplyFulfillmentMode,
  SupplyReceivedConfirmedActor,
  SupplyRequestKind,
  SupplySkuClass,
  VendorRoutingScopeKind,
} from "@wardenx/types";
import type { M21WriteActor } from "./actor";
import type {
  ComfortKitReturnDetail,
  ComfortKitTemplateView,
  DispatchDetail,
  ParStockView,
  SupplyItemView,
  SupplyRequestDetail,
  VendorRoutingRuleView,
} from "./read-service";

/**
 * The transactional-outbox emission the write service publishes on the mutation's own tx (§4.5.2).
 *
 * `organizationId` is on the envelope AND repeated inside most payloads, and both are deliberate:
 * `outbox_event.organization_id` is NOT NULL and is what the dispatcher's RLS scopes delivery by, while
 * the payload copy is what M33's projector and M36's alert router read when they have the payload alone
 * (the §4.5.2 `M21PatientScopedEventBase` note). Omitting the envelope field would make every publish fail
 * the column constraint at commit — inside the mutation's own transaction, so the mutation would roll back
 * too.
 */
export interface OutboxEmission {
  readonly eventName: M21EventName;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The catalog-validating publisher the composition root binds (`callerModule` pinned to `m21`). */
export interface WriteOutboxPort {
  publish(tx: unknown, emission: OutboxEmission): Promise<void>;
}

/** The §4.7 typed M36 alert port. Best-effort and outside the transaction's failure path. */
export interface AlertPort {
  emit(input: {
    organizationId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/** Every state-transition command echoes the `If-Match` stamp it read (§7.2). */
interface Versioned {
  /** The row `updated_at` the caller read, from `If-Match`. A mismatch is 412 `M21_STALE_VERSION`. */
  readonly expectedUpdatedAt?: string;
}

export interface CreateSupplyRequestInput {
  readonly patientId: string;
  readonly admissionId: string;
  readonly locationId: string;
  readonly sourceOrderId?: string;
  readonly deliveryAddress: Record<string, unknown>;
  readonly deliveryInstructions?: string;
  /** The D1 per-kind payload; validated against `SUPPLY_REQUEST_DATA_SCHEMAS` before the row is written. */
  readonly kindPayload: { readonly kind: SupplyRequestKind } & Record<string, unknown>;
}

export interface AssignVendorInput extends Versioned {
  readonly vendorId: string | null;
  readonly fulfillmentMode: SupplyFulfillmentMode;
  readonly pharmacyDispatchMode?: PharmacyDispatchMode;
  readonly overrideReason?: string;
}

export interface MarkOrderedInput extends Versioned {
  readonly vendorOrderReference: string;
}

export interface MarkInTransitInput extends Versioned {
  readonly trackingNumber: string;
  readonly carrier: string;
}

export interface MarkDeliveredInput extends Versioned {
  readonly deliveredAt: IsoInstant;
  readonly deliveryMethod: SupplyDeliveryMethod;
  readonly evidenceDocumentId?: string;
}

/**
 * F-193 (#248) — the M21-owned caregiver-signature capture. Flat, like every other M21 command (the
 * `MarkDeliveredInput` precedent): `captureMethod` picks the branch, and only the fields that method
 * actually uses are read (`../lifecycle/caregiver-signature.ts`'s `caregiverSignatureEvidenceJsonbOf`
 * projects out the rest). NOT `Versioned`/`If-Match` gated at the type level the way a §2.2 transition is
 * — the route still reads `If-Match` (routes/supply-requests.routes.ts), but the guard this command runs
 * is "not yet captured", not "the row changed since I read it", so a stale-but-uncaptured read is not
 * itself a conflict the way a stale status transition is.
 */
export interface CaptureCaregiverSignatureInput extends Versioned {
  readonly captureMethod: SupplyCaregiverSignatureCaptureMethod;
  readonly typedSignatureName?: string;
  readonly witnessName?: string;
  readonly witnessAttestationText?: string;
  readonly evidenceDocumentId?: string;
  readonly declinedReason?: string;
}

/** COP27 (42 CFR 418.24(c)) — set/change a dme/supply request's hospice coverage determination. */
export interface SetCoverageDeterminationInput extends Versioned {
  readonly hospiceCoverage: HospiceCoverage;
  readonly reason?: string | null;
}

export interface ConfirmReceivedInput extends Versioned {
  readonly actor: SupplyReceivedConfirmedActor;
  readonly confirmedAt: IsoInstant;
}

export interface CancelRequestInput extends Versioned {
  readonly reason: string;
}

export interface ReturnRequestInput extends Versioned {
  readonly reason: string;
}

export interface CreateSupplyItemInput {
  readonly hcpcs?: string;
  readonly rxnorm?: string;
  readonly ndc?: string;
  readonly name: string;
  readonly skuClass: SupplySkuClass;
  readonly defaultUnit: string;
  readonly isBillable?: boolean;
  readonly isControlledSubstance?: boolean;
  readonly requiresLotTracking?: boolean;
  readonly requiresExpirationTracking?: boolean;
  readonly isSerializedAsset?: boolean;
}

export interface RetireSupplyItemInput {
  readonly effectiveTo: IsoInstant;
  readonly reason?: string;
}

export interface UpsertTenantSupplyItemInput {
  readonly name: string;
  readonly localSkuCode: string;
  readonly defaultUnit: string;
  readonly isBillable?: boolean;
  readonly isActive?: boolean;
}

export interface TemplateMedicationInput {
  readonly rxnorm: string;
  readonly ndc?: string;
  readonly drugName: string;
  readonly strength: string;
  readonly dosageForm: string;
  readonly routeOfAdministration: string;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule?: "CII" | "CIII" | "CIV" | "CV";
  readonly expectedQuantity: string;
  readonly expectedUnit: string;
  readonly replenishmentThresholdPct?: string;
  readonly displayOrder?: number;
  readonly notes?: string;
}

export interface CreateTemplateInput {
  readonly name: string;
  readonly medications: readonly TemplateMedicationInput[];
  readonly stateLabelingPolicy?: Record<string, unknown>;
  readonly controlledSubstanceHandlingPolicy?: Record<string, unknown>;
}

export interface SupersedeTemplateInput extends CreateTemplateInput {
  readonly effectiveFrom?: IsoInstant;
}

export interface DispatchLineInput {
  readonly comfortKitTemplateMedicationId: string;
  readonly medicationOrderId?: string;
  readonly dispatchedQuantity: string;
  readonly dispatchedUnit: string;
  readonly lotNumber?: string;
  readonly expirationDate?: string;
  readonly manufacturerNdc?: string;
}

export interface CreateDispatchInput {
  readonly supplyRequestId: string;
  readonly comfortKitTemplateId: string;
  readonly locationId: string;
  readonly deploymentSite: ComfortKitDeploymentSite;
  readonly ipuRoomId?: string;
  readonly facilityIdentifier?: Record<string, unknown>;
  readonly dispatchSource: ComfortKitDispatchSource;
  readonly pharmacyDispatchMode: PharmacyDispatchMode;
  readonly pharmacyPartnerId?: string;
  readonly kitSerialNumber: string;
  readonly contents: readonly DispatchLineInput[];
  readonly specialHandlingNotes?: string;
}

export interface DeployAtPatientInput extends Versioned {
  readonly deployedAt: IsoInstant;
}

export interface CreateReturnInput {
  readonly dispatchId: string;
  readonly returnReason: string;
  readonly returnRequiredAt?: IsoInstant;
}

export interface AssignRetrieverInput extends Versioned {
  readonly retrievingMembershipId: MembershipId;
}

export interface ReconcileLineInput {
  readonly dispatchedContentId: string;
  readonly quantityReturned: string;
  readonly quantityDisposedAtHome: string;
  readonly discrepancyExplanation?: string;
}

export interface ReconcileReturnInput extends Versioned {
  readonly disposalMethod: ComfortKitDisposalMethod;
  readonly disposalWitnessMembershipId?: MembershipId;
  readonly perMedicationReconciliation: readonly ReconcileLineInput[];
  readonly disposalNotes?: string;
  readonly discrepancyNotes?: string;
}

export interface DeclareUnreturnableInput extends Versioned {
  readonly reason: string;
}

export interface UpsertRoutingRuleInput {
  readonly scopeKind: VendorRoutingScopeKind;
  readonly scopeId?: string;
  readonly skuClassPattern?: string;
  readonly assignedVendorId: string | null;
  readonly assignedFulfillmentMode: SupplyFulfillmentMode;
  readonly defaultPharmacyDispatchMode?: PharmacyDispatchMode;
  readonly precedencePriority?: number;
}

export interface UpdateParStockInput extends Versioned {
  readonly reorderPoint?: string;
  readonly reorderQuantity?: string;
  readonly minSafetyStock?: string;
  readonly isActive?: boolean;
  readonly reorderNotes?: string;
}

export interface ObserveParStockInput {
  readonly parStockId: string;
  readonly observedQuantity: string;
  readonly observedAt?: IsoInstant;
  readonly reorderNotes?: string;
}

/** §4.2.1's response — the created request plus the D4 resolution the router froze onto it. */
export interface CreateSupplyRequestResult {
  readonly supplyRequestId: string;
  readonly status: "requested";
  readonly routingRuleResolved: RoutingRuleResolved | null;
  readonly updatedAt: IsoInstant;
}

/** §4.2.2's response — the reconciliation verdict, with the per-line accounting the DEA log records. */
export interface ReconcileReturnResult {
  readonly returnId: string;
  readonly state: "reconciled";
  readonly discrepancyDetected: boolean;
  readonly perMedication: ComfortKitReturnDetail["lines"];
  readonly updatedAt: IsoInstant;
}

/** The §4.1 WRITE surface. */
export interface M21WriteService {
  // §2.2 supply-request lifecycle
  createSupplyRequest(
    actor: M21WriteActor,
    input: CreateSupplyRequestInput,
  ): Promise<CreateSupplyRequestResult>;
  assignVendor(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: AssignVendorInput,
  ): Promise<SupplyRequestDetail>;
  markOrdered(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: MarkOrderedInput,
  ): Promise<SupplyRequestDetail>;
  markInTransit(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: MarkInTransitInput,
  ): Promise<SupplyRequestDetail>;
  markDelivered(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: MarkDeliveredInput,
  ): Promise<SupplyRequestDetail>;
  /**
   * F-193 (#248) — M21's own caregiver-signature capture. NOT a §2.2 transition: the row's `status` does
   * not move, and no outbox event is emitted (the capture is synchronous within M21 — nothing else in the
   * system needs to react to it). Requires the row to already be `delivered`; refuses a second capture
   * rather than overwriting or appending (see `../lifecycle/caregiver-signature.ts`).
   */
  captureCaregiverSignature(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: CaptureCaregiverSignatureInput,
  ): Promise<SupplyRequestDetail>;
  /**
   * COP27 (42 CFR 418.24(c)) — set/change the request's hospice coverage determination (`dme` / `supply`
   * kinds only). NOT a §2.2 transition (status does not move) but a real mutation, so `If-Match` applies.
   * Emits `m21.supply_request.coverage_determination_changed` when the determination actually changes.
   */
  setCoverageDetermination(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: SetCoverageDeterminationInput,
  ): Promise<SupplyRequestDetail>;
  confirmReceived(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: ConfirmReceivedInput,
  ): Promise<SupplyRequestDetail>;
  cancelSupplyRequest(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: CancelRequestInput,
  ): Promise<SupplyRequestDetail>;
  returnSupplyRequest(
    actor: M21WriteActor,
    supplyRequestId: string,
    input: ReturnRequestInput,
  ): Promise<SupplyRequestDetail>;

  // D11 catalog
  createSupplyItem(actor: M21WriteActor, input: CreateSupplyItemInput): Promise<SupplyItemView>;
  retireSupplyItem(
    actor: M21WriteActor,
    supplyItemId: string,
    input: RetireSupplyItemInput,
  ): Promise<SupplyItemView>;
  createTenantExtension(
    actor: M21WriteActor,
    input: UpsertTenantSupplyItemInput,
  ): Promise<SupplyItemView>;
  updateTenantExtension(
    actor: M21WriteActor,
    tenantItemId: string,
    input: UpsertTenantSupplyItemInput,
  ): Promise<SupplyItemView>;

  // §2.3 comfort-kit templates
  createComfortKitTemplate(
    actor: M21WriteActor,
    input: CreateTemplateInput,
  ): Promise<ComfortKitTemplateView>;
  supersedeComfortKitTemplate(
    actor: M21WriteActor,
    templateId: string,
    input: SupersedeTemplateInput,
  ): Promise<ComfortKitTemplateView>;

  // §2.5 dispatch
  createDispatch(actor: M21WriteActor, input: CreateDispatchInput): Promise<DispatchDetail>;
  markDeployedAtPatient(
    actor: M21WriteActor,
    dispatchId: string,
    input: DeployAtPatientInput,
  ): Promise<DispatchDetail>;

  // §2.6 return + reconciliation
  createReturn(actor: M21WriteActor, input: CreateReturnInput): Promise<ComfortKitReturnDetail>;
  assignRetriever(
    actor: M21WriteActor,
    returnId: string,
    input: AssignRetrieverInput,
  ): Promise<ComfortKitReturnDetail>;
  reconcileReturn(
    actor: M21WriteActor,
    returnId: string,
    input: ReconcileReturnInput,
  ): Promise<ReconcileReturnResult>;
  declareUnreturnable(
    actor: M21WriteActor,
    returnId: string,
    input: DeclareUnreturnableInput,
  ): Promise<ComfortKitReturnDetail>;

  // §2.4 vendor routing
  createVendorRoutingRule(
    actor: M21WriteActor,
    input: UpsertRoutingRuleInput,
  ): Promise<VendorRoutingRuleView>;
  updateVendorRoutingRule(
    actor: M21WriteActor,
    ruleId: string,
    input: UpsertRoutingRuleInput,
  ): Promise<VendorRoutingRuleView>;
  retireVendorRoutingRule(actor: M21WriteActor, ruleId: string): Promise<VendorRoutingRuleView>;

  // §2.7 par stock
  updateParStock(
    actor: M21WriteActor,
    parStockId: string,
    input: UpdateParStockInput,
  ): Promise<ParStockView>;
  recordObservation(actor: M21WriteActor, input: ObserveParStockInput): Promise<ParStockView>;

  /**
   * §4.8 `SupplyFulfillmentProvider.createDirectSupplyRequest`. NOT a route — the seam binds this so a
   * coordinator's direct entry goes through the SAME creation path (D4 routing freeze, per-kind validation,
   * §4.5.2 emit) as a route and an M11 cascade. The distinguishing behaviour is the event it emits:
   * `created_from_external`, which §7.1 acceptance 3 is explicit the M11 cascade must NOT emit.
   */
  createDirect(input: CreateDirectSupplyRequestInput): Promise<{
    readonly supplyRequestId: string;
    readonly routingRuleResolved: RoutingRuleResolved;
  }>;
}
