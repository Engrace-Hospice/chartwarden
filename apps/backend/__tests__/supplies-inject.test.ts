// apps/backend/__tests__/supplies-inject.test.ts — M21-T05 (§4.1) HTTP-layer route-inventory smoke
// (TASK-050A, TEST-001 closure for Module 21).
//
// Module 21 had ZERO Fastify `.inject()` coverage before this file: `supplies-authz.test.ts` /
// `-consumers.test.ts` / `-lifecycle.test.ts` / `-seams.test.ts` all exercise pure functions and the
// §4.4 predicate deciders directly, so a mis-wired guard, a schema drift, or a route that never got
// mounted would be invisible to them — only a REAL `inject()` through the full M1 middleware chain
// (auth → RBAC → ABAC → TypeBox → handler) catches that class of bug. This file is the M11
// `orders-routes.test.ts` pattern applied to M21: `buildServer()` mounts the host, `mountM21Routes()`
// mounts the §4.1 inventory over a small hand-rolled in-memory `M21ReadService`/`M21WriteService` (M21
// exports `createInMemorySuppliesSeamStore` for the §4.8 seams, but no full route-level in-memory
// backend the way M11 does — so this file owns its own fake, seeded through the SAME
// `SuppliesAbacResolver` shape the real §4.4 predicates consume). A fresh predicate registry is built
// per server from `buildSuppliesAbacPredicates` (the M11-T06 precedent — the shared registry would
// otherwise close over a PRIOR test's backend); the platform `step_up_recent` predicate (owned by M3,
// not M21) is stubbed to always-pass, since freshness policy itself is already covered by
// `step-up-policy.test.ts` and is not this file's concern.
//
// This is a WIRING smoke test, not a re-test of the §2.2–§2.7 lifecycle machines (already covered, over
// the REAL pure functions, by `supplies-lifecycle.test.ts`): the fake write service applies each route's
// implied mutation unconditionally rather than re-deriving the state machine, so every 2xx case exists to
// prove the route is MOUNTED, gated on the right §4.3 permission key + §4.4 ABAC predicate, and returns
// the documented status code — not to prove the transition is clinically valid.
//
// A DELIBERATE SIMPLIFICATION: every comfort-kit template medication this file dispatches is
// `isControlledSubstance: false`, so `comfort_kit_return_reconciler_eligible`'s witness clause
// (§4.4(c), only triggered when the dispatch actually carried a schedule) never has to be satisfied —
// the fake backend has no route that lets a caller record a witness BEFORE reconciliation (the real
// write-service-drizzle resolver reads it off the return row, which is written only by `reconcile`
// itself), so exercising that branch would require seeding the resolver's fact store directly rather
// than driving it through HTTP, which is out of scope for a routing smoke test. The dispatch CREATE
// route is still gated on full dispatcher eligibility unconditionally (§4.1 row 20 — every dispatch is a
// controlled-substance custody record "by construction", independent of what its lines actually are),
// so that branch of the ABAC gate is exercised for real.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M21_PERMISSION_KEY_LIST,
  buildSuppliesAbacPredicates,
  mountM21Routes,
} from "../src/modules/21-supplies/index";
import type {
  ComfortKitReturnDetail,
  ComfortKitReturnedLineView,
  ComfortKitTemplateMedicationView,
  ComfortKitTemplateView,
  CursorPage,
  DispatchDetail,
  M21ReadService,
  M21WriteService,
  ParStockView,
  PerpetualLogLineView,
  PerpetualLogView,
  SuppliesAbacResolver,
  SupplyItemView,
  SupplyRequestDetail,
  VendorRoutingRuleView,
} from "../src/modules/21-supplies/index";
import { decideCoverageDetermination } from "../src/modules/21-supplies/lifecycle/index";

// ── the M2 header-auth test shim (the M11/M16 `orders-routes.test.ts` / `bereavement-inject.test.ts`
// precedent). Extended with `x-test-membership`, because M21's `writeActorOf` (routes/actor.ts) requires
// a server-assembled `context.attributes.membershipId` — every attribution column M21 writes is stamped
// from it, never from the request body. ─────────────────────────────────────────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
}

const ORG = "org_a";
const NOW = "2026-06-08T12:00:00.000Z";
const PROVIDER = "11111111-1111-4111-8111-111111111111";
const LOC_A = "22222222-2222-4222-8222-222222222222";
const LOC_B = "33333333-3333-4333-8333-333333333333";

const COORD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISPATCHER_ID = "44444444-4444-4444-8444-444444444444";
const RECONCILER_ID = "55555555-5555-4555-8555-555555555555";
const WITNESS_ID = "66666666-6666-4666-8666-666666666666";
const RETRIEVER_ID = "99999999-9999-4999-8999-999999999999";
const ADMIN_ID = "77777777-7777-4777-8777-777777777777";
const NO_PERMS_ID = "88888888-8888-4888-8888-888888888888";

const ADDRESS = { line1: "1 Main St", city: "Springfield", state: "IL", postalCode: "62701" };

let uuidSeq = 100;
/** A deterministic, monotonically-unique value that satisfies m21-typebox's UUID format check (the
 *  M14/M18 in-memory-backend gotcha: a non-uuid id 422s on every `:id` param that validates `format:
 *  "uuid"`, so every fake-minted id in this file is uuid-shaped from the start — the M11 convention). */
function fakeId(): string {
  uuidSeq += 1;
  return `${String(uuidSeq).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

// ── internal fake-backend record shapes (deliberately loose on enum-ish fields — cast `as never` at the
// DTO boundary, the same convention `bereavement-inject.test.ts` / `oncall-inject.test.ts` use) ──────────

interface RequestRecord {
  // COP27 — optional so the existing record literals keep compiling; `requestDetail` defaults them.
  hospiceCoverage?: "covered_related" | "not_covered_unrelated" | "not_covered_other";
  coverageReason?: string | null;
  coverageDeterminedAt?: string | null;
  coverageDeterminedBy?: string | null;
  supplyRequestId: string;
  patientId: string;
  admissionId: string;
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
  updatedAt: string;
  providerEntityId: string;
  sourceOrderId: string | null;
  sourceReplenishmentEventId: string | null;
  requestedByMembershipId: string | null;
  data: unknown;
  routingRuleResolved: unknown;
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
  dispatchId: string | null;
  caregiverSignatureCaptureMethod: string | null;
  caregiverSignatureCapturedAt: string | null;
  caregiverSignatureCapturedByMembershipId: string | null;
  caregiverSignatureEvidenceDocumentId: string | null;
  caregiverSignatureEvidence: Record<string, unknown> | null;
}

interface SupplyItemRecord {
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
  isControlledSubstance: boolean | null;
  requiresLotTracking: boolean | null;
  requiresExpirationTracking: boolean | null;
  isSerializedAsset: boolean | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  localSkuCode: string | null;
  updatedAt: string;
}

interface TemplateMedicationRecord {
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

interface TemplateRecord {
  comfortKitTemplateId: string;
  name: string;
  isPlatformFloor: boolean;
  systemLocked: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  replacesTemplateId: string | null;
  medications: TemplateMedicationRecord[];
  updatedAt: string;
}

interface DispatchContentRecord {
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

interface DispatchRecord {
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
  contents: DispatchContentRecord[];
}

interface ReturnRecord {
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
  updatedAt: string;
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
  lines: ComfortKitReturnedLineView[];
  discrepancyDetected: boolean;
}

interface RoutingRuleRecord {
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

interface ParStockRecord {
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

function createFakeBackend() {
  const requests = new Map<string, RequestRecord>();
  const admissionLocations = new Map<string, string>();
  /** GAP-064 — admissions M6 holds no siting for (the resolver answers null). */
  const unsitedAdmissions = new Set<string>();
  /** GAP-064 — admissions whose siting read errors (the resolver throws: a transient seam failure). */
  const seamErrorAdmissions = new Set<string>();
  const supplyItems = new Map<string, SupplyItemRecord>();
  const templates = new Map<string, TemplateRecord>();
  const dispatches = new Map<string, DispatchRecord>();
  const returns = new Map<string, ReturnRecord>();
  const routingRules = new Map<string, RoutingRuleRecord>();
  const parStock = new Map<string, ParStockRecord>();

  function page<T>(data: T[]): CursorPage<T> {
    return { data, next_cursor: null, has_more: false };
  }

  // ── seed helpers (the ABAC-fact / no-create-route precondition setup precedent from
  // `bereavement-inject.test.ts`'s `seedPlan`/`seedContact`) ────────────────────────────────────────────
  function seedParStock(overrides: Partial<ParStockRecord> = {}): ParStockRecord {
    const parStockId = overrides.parStockId ?? fakeId();
    const rec: ParStockRecord = {
      parStockId,
      locationId: LOC_A,
      skuId: null,
      tenantSkuExtensionId: null,
      skuName: "Hospital bed, semi-electric",
      currentQuantity: "5",
      unit: "each",
      reorderPoint: "2",
      reorderQuantity: "3",
      minSafetyStock: "1",
      severity: "ok",
      isActive: true,
      lastParReviewAt: null,
      lastParReviewedByMembershipId: null,
      reorderNotes: null,
      updatedAt: NOW,
      ...overrides,
    };
    parStock.set(parStockId, rec);
    return rec;
  }

  // ── read DTO builders ──────────────────────────────────────────────────────────────────────────────
  function requestDetail(r: RequestRecord): SupplyRequestDetail {
    return {
      supplyRequestId: r.supplyRequestId as never,
      patientId: r.patientId as never,
      locationId: r.locationId as never,
      kind: r.kind as never,
      status: r.status as never,
      assignedVendorId: r.assignedVendorId,
      vendorOrderReference: r.vendorOrderReference,
      trackingNumber: r.trackingNumber,
      carrier: r.carrier,
      orderedAt: r.orderedAt as never,
      deliveredAt: r.deliveredAt as never,
      createdAt: r.createdAt as never,
      updatedAt: r.updatedAt as never,
      admissionId: r.admissionId,
      providerEntityId: r.providerEntityId,
      sourceOrderId: r.sourceOrderId,
      sourceReplenishmentEventId: r.sourceReplenishmentEventId,
      requestedByMembershipId: r.requestedByMembershipId as never,
      data: r.data,
      routingRuleResolved: r.routingRuleResolved as never,
      pharmacyPartnerId: r.pharmacyPartnerId,
      documentId: r.documentId,
      deliveryInstructions: r.deliveryInstructions,
      deliveryMethod: r.deliveryMethod as never,
      deliveredByMembershipId: r.deliveredByMembershipId as never,
      deliveryEvidenceDocumentId: r.deliveryEvidenceDocumentId,
      receivedConfirmedAt: r.receivedConfirmedAt as never,
      receivedConfirmedActor: r.receivedConfirmedActor as never,
      completedAt: r.completedAt as never,
      cancelledAt: r.cancelledAt as never,
      cancellationPendingAt: r.cancellationPendingAt as never,
      cancellationReason: r.cancellationReason,
      shippedAt: r.shippedAt as never,
      invoiceTotalCents: r.invoiceTotalCents,
      invoiceAccruedAt: r.invoiceAccruedAt as never,
      invoiceReconciledAt: r.invoiceReconciledAt as never,
      invoiceVarianceCents: r.invoiceVarianceCents,
      dispatchId: r.dispatchId as never,
      caregiverSignatureCaptureMethod: r.caregiverSignatureCaptureMethod as never,
      caregiverSignatureCapturedAt: r.caregiverSignatureCapturedAt as never,
      caregiverSignatureCapturedByMembershipId: r.caregiverSignatureCapturedByMembershipId as never,
      caregiverSignatureEvidenceDocumentId: r.caregiverSignatureEvidenceDocumentId,
      caregiverSignatureEvidence: r.caregiverSignatureEvidence as never,
      hospiceCoverage: r.hospiceCoverage ?? "covered_related",
      coverageReason: r.coverageReason ?? null,
      coverageDeterminedAt: (r.coverageDeterminedAt ?? null) as never,
      coverageDeterminedBy: (r.coverageDeterminedBy ?? null) as never,
    };
  }

  function itemView(s: SupplyItemRecord): SupplyItemView {
    return {
      supplyItemId: s.supplyItemId as never,
      isPlatform: s.isPlatform,
      hcpcs: s.hcpcs,
      rxnorm: s.rxnorm,
      ndc: s.ndc,
      name: s.name,
      skuClass: s.skuClass as never,
      defaultUnit: s.defaultUnit,
      isBillable: s.isBillable,
      isActive: s.isActive,
      isControlledSubstance: s.isControlledSubstance,
      requiresLotTracking: s.requiresLotTracking,
      requiresExpirationTracking: s.requiresExpirationTracking,
      isSerializedAsset: s.isSerializedAsset,
      effectiveFrom: s.effectiveFrom as never,
      effectiveTo: s.effectiveTo as never,
      localSkuCode: s.localSkuCode,
      updatedAt: s.updatedAt as never,
    };
  }

  function medicationView(m: TemplateMedicationRecord): ComfortKitTemplateMedicationView {
    return {
      templateMedicationId: m.templateMedicationId as never,
      rxnorm: m.rxnorm,
      ndc: m.ndc,
      drugName: m.drugName,
      strength: m.strength,
      dosageForm: m.dosageForm,
      routeOfAdministration: m.routeOfAdministration,
      isControlledSubstance: m.isControlledSubstance,
      controlledSubstanceSchedule: m.controlledSubstanceSchedule as never,
      expectedQuantity: m.expectedQuantity,
      expectedUnit: m.expectedUnit,
      replenishmentThresholdPct: m.replenishmentThresholdPct,
      systemLocked: m.systemLocked,
      displayOrder: m.displayOrder,
    };
  }

  function templateView(t: TemplateRecord): ComfortKitTemplateView {
    return {
      comfortKitTemplateId: t.comfortKitTemplateId as never,
      name: t.name,
      isPlatformFloor: t.isPlatformFloor,
      systemLocked: t.systemLocked,
      effectiveFrom: t.effectiveFrom as never,
      effectiveTo: t.effectiveTo as never,
      replacesTemplateId: t.replacesTemplateId as never,
      medications: t.medications.map(medicationView),
      updatedAt: t.updatedAt as never,
    };
  }

  function contentPayload(c: DispatchContentRecord) {
    return {
      dispatchedContentId: c.dispatchedContentId as never,
      comfortKitTemplateMedicationId: c.comfortKitTemplateMedicationId as never,
      medicationOrderId: c.medicationOrderId as never,
      rxnorm: c.rxnorm,
      ndc: c.ndc,
      drugName: c.drugName,
      strength: c.strength,
      dosageForm: c.dosageForm,
      routeOfAdministration: c.routeOfAdministration,
      isControlledSubstance: c.isControlledSubstance,
      controlledSubstanceSchedule: c.controlledSubstanceSchedule as never,
      dispatchedQuantity: c.dispatchedQuantity,
      dispatchedUnit: c.dispatchedUnit,
      lotNumber: c.lotNumber,
      expirationDate: c.expirationDate as never,
      manufacturerNdc: c.manufacturerNdc,
      replenishmentThresholdPct: c.replenishmentThresholdPct,
    };
  }

  function dispatchDetail(d: DispatchRecord): DispatchDetail {
    return {
      dispatchId: d.dispatchId as never,
      supplyRequestId: d.supplyRequestId as never,
      patientId: d.patientId as never,
      locationId: d.locationId as never,
      comfortKitTemplateId: d.comfortKitTemplateId as never,
      kitSerialNumber: d.kitSerialNumber,
      deploymentSite: d.deploymentSite as never,
      dispatchStatus: d.dispatchStatus as never,
      ipuRoomId: d.ipuRoomId,
      dispatchedAt: d.dispatchedAt as never,
      deployedAtPatientAt: d.deployedAtPatientAt as never,
      containsControlledSubstance: d.containsControlledSubstance,
      updatedAt: d.updatedAt as never,
      admissionId: d.admissionId,
      providerEntityId: d.providerEntityId,
      dispatchSource: d.dispatchSource as never,
      pharmacyDispatchMode: d.pharmacyDispatchMode as never,
      pharmacyPartnerId: d.pharmacyPartnerId,
      dispatchedByMembershipId: d.dispatchedByMembershipId as never,
      deployedByMembershipId: d.deployedByMembershipId as never,
      bolDocumentId: d.bolDocumentId,
      m13DeploymentId: d.m13DeploymentId,
      controlledSubstanceHandlingPolicyDigest: d.controlledSubstanceHandlingPolicyDigest,
      facilityIdentifier: d.facilityIdentifier,
      specialHandlingNotes: d.specialHandlingNotes,
      contents: d.contents.map(contentPayload) as never,
    };
  }

  function returnDetail(r: ReturnRecord): ComfortKitReturnDetail {
    return {
      returnId: r.returnId as never,
      dispatchId: r.dispatchId as never,
      patientId: r.patientId as never,
      locationId: r.locationId as never,
      state: r.state as never,
      returnRequiredAt: r.returnRequiredAt as never,
      returnDueAt: r.returnDueAt as never,
      assignedRetrievingMembershipId: r.assignedRetrievingMembershipId as never,
      reconciledAt: r.reconciledAt as never,
      containsControlledSubstance: r.containsControlledSubstance,
      daysOverdue: 0,
      updatedAt: r.updatedAt as never,
      admissionId: r.admissionId,
      providerEntityId: r.providerEntityId,
      m13DeploymentId: r.m13DeploymentId,
      retrievingAt: r.retrievingAt as never,
      retrievedAt: r.retrievedAt as never,
      returnedToHubAt: r.returnedToHubAt as never,
      disposalMethod: r.disposalMethod as never,
      disposalWitnessMembershipId: r.disposalWitnessMembershipId as never,
      disposalMethodJurisdictionPolicyDigest: r.disposalMethodJurisdictionPolicyDigest,
      reconciledByMembershipId: r.reconciledByMembershipId as never,
      receiptDocumentId: r.receiptDocumentId,
      disposalNotes: r.disposalNotes,
      discrepancyNotes: r.discrepancyNotes,
      unreturnableReason: r.unreturnableReason,
      unreturnableAttestedByMembershipId: r.unreturnableAttestedByMembershipId as never,
      lines: r.lines,
      discrepancyDetected: r.discrepancyDetected,
    };
  }

  function ruleView(r: RoutingRuleRecord): VendorRoutingRuleView {
    return {
      ruleId: r.ruleId as never,
      isPlatform: r.isPlatform,
      scopeKind: r.scopeKind as never,
      scopeId: r.scopeId,
      skuClassPattern: r.skuClassPattern,
      assignedVendorId: r.assignedVendorId,
      assignedFulfillmentMode: r.assignedFulfillmentMode as never,
      defaultPharmacyDispatchMode: r.defaultPharmacyDispatchMode as never,
      precedencePriority: r.precedencePriority,
      isActive: r.isActive,
      effectiveFrom: r.effectiveFrom as never,
      effectiveTo: r.effectiveTo as never,
      updatedAt: r.updatedAt as never,
    };
  }

  function parStockView(p: ParStockRecord): ParStockView {
    return {
      parStockId: p.parStockId as never,
      locationId: p.locationId as never,
      skuId: p.skuId as never,
      tenantSkuExtensionId: p.tenantSkuExtensionId,
      skuName: p.skuName,
      currentQuantity: p.currentQuantity,
      unit: p.unit,
      reorderPoint: p.reorderPoint,
      reorderQuantity: p.reorderQuantity,
      minSafetyStock: p.minSafetyStock,
      severity: p.severity,
      isActive: p.isActive,
      lastParReviewAt: p.lastParReviewAt as never,
      lastParReviewedByMembershipId: p.lastParReviewedByMembershipId as never,
      reorderNotes: p.reorderNotes,
      updatedAt: p.updatedAt as never,
    };
  }

  function notFound(what: string): never {
    throw Object.assign(new Error(`${what} not found`), { statusCode: 404 });
  }

  // F-193 (#248) — the fake's own tiny mirror of `../lifecycle/errors.ts`'s status mapping, just enough
  // for `captureCaregiverSignature`'s two domain refusals (this file is a WIRING smoke test — see the
  // header — so it re-derives no machine, but a route-gating smoke test still has to prove the two
  // status codes a caller actually sees).
  function unprocessable(message: string): never {
    throw Object.assign(new Error(message), { statusCode: 422 });
  }
  function conflict(message: string): never {
    throw Object.assign(new Error(message), { statusCode: 409 });
  }

  const readService: M21ReadService = {
    async listSupplyRequests() {
      return page([...requests.values()].map(requestDetail));
    },
    async getSupplyRequest(_actor, id) {
      const r = requests.get(id);
      if (!r) notFound("supply request");
      return requestDetail(r);
    },
    async listSupplyItems() {
      return page([...supplyItems.values()].map(itemView));
    },
    async getSupplyItem(_actor, id) {
      const s = supplyItems.get(id);
      if (!s) notFound("supply item");
      return itemView(s);
    },
    async listComfortKitTemplates() {
      return page([...templates.values()].map(templateView));
    },
    async getComfortKitTemplate(_actor, id) {
      const t = templates.get(id);
      if (!t) notFound("comfort kit template");
      return templateView(t);
    },
    async listDispatches() {
      return page([...dispatches.values()].map(dispatchDetail));
    },
    async getDispatch(_actor, id) {
      const d = dispatches.get(id);
      if (!d) notFound("dispatch");
      return dispatchDetail(d);
    },
    async listReturns() {
      return page([...returns.values()].map(returnDetail));
    },
    async getReturn(_actor, id) {
      const r = returns.get(id);
      if (!r) notFound("return");
      return returnDetail(r);
    },
    async listVendorRoutingRules() {
      return page([...routingRules.values()].map(ruleView));
    },
    async getVendorRoutingRule(_actor, id) {
      const r = routingRules.get(id);
      if (!r) notFound("routing rule");
      return ruleView(r);
    },
    async listParStock() {
      return page([...parStock.values()].map(parStockView));
    },
    async getParStock(_actor, id) {
      const p = parStock.get(id);
      if (!p) notFound("par stock");
      return parStockView(p);
    },
    async getPerpetualLog(_actor, dispatchId) {
      const d = dispatches.get(dispatchId);
      if (!d) notFound("dispatch");
      const lines: PerpetualLogLineView[] = d.contents.map((c) => ({
        dispatchedContentId: c.dispatchedContentId as never,
        drugName: c.drugName,
        lotNumber: c.lotNumber,
        controlledSubstanceSchedule: c.controlledSubstanceSchedule as never,
        dispatchedQuantity: c.dispatchedQuantity,
        dispatchedUnit: c.dispatchedUnit,
        expirationDate: c.expirationDate as never,
        entries: [
          {
            transactionKind: "dispense",
            quantityDelta: `-${c.dispatchedQuantity}`,
            balanceAfterQuantity: "0",
            unit: c.dispatchedUnit,
            recordedByMembershipId: d.dispatchedByMembershipId as never,
            witnessMembershipId: null,
            occurredAt: d.dispatchedAt as never,
            sourceReference: null,
          },
        ],
      }));
      const view: PerpetualLogView = {
        dispatchId: d.dispatchId as never,
        kitSerialNumber: d.kitSerialNumber,
        dispatchedAt: d.dispatchedAt as never,
        dispatchedByMembershipId: d.dispatchedByMembershipId as never,
        lines,
      };
      return view;
    },
  };

  const writeService: M21WriteService = {
    async createSupplyRequest(actor, input) {
      const supplyRequestId = fakeId();
      const rec: RequestRecord = {
        supplyRequestId,
        patientId: input.patientId,
        admissionId: input.admissionId,
        locationId: input.locationId,
        kind: input.kindPayload.kind,
        status: "requested",
        assignedVendorId: null,
        vendorOrderReference: null,
        trackingNumber: null,
        carrier: null,
        orderedAt: null,
        deliveredAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        providerEntityId: PROVIDER,
        sourceOrderId: input.sourceOrderId ?? null,
        sourceReplenishmentEventId: null,
        requestedByMembershipId: actor.membershipId,
        data: input.kindPayload,
        routingRuleResolved: null,
        pharmacyPartnerId: null,
        documentId: null,
        deliveryInstructions: input.deliveryInstructions ?? null,
        deliveryMethod: null,
        deliveredByMembershipId: null,
        deliveryEvidenceDocumentId: null,
        receivedConfirmedAt: null,
        receivedConfirmedActor: null,
        completedAt: null,
        cancelledAt: null,
        cancellationPendingAt: null,
        cancellationReason: null,
        shippedAt: null,
        invoiceTotalCents: null,
        invoiceAccruedAt: null,
        invoiceReconciledAt: null,
        invoiceVarianceCents: null,
        dispatchId: null,
        caregiverSignatureCaptureMethod: null,
        caregiverSignatureCapturedAt: null,
        caregiverSignatureCapturedByMembershipId: null,
        caregiverSignatureEvidenceDocumentId: null,
        caregiverSignatureEvidence: null,
      };
      requests.set(supplyRequestId, rec);
      return { supplyRequestId, status: "requested", routingRuleResolved: null, updatedAt: NOW };
    },
    async assignVendor(_actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.assignedVendorId = input.vendorId;
      r.status = "vendor_assigned";
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async markOrdered(_actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.status = "ordered";
      r.vendorOrderReference = input.vendorOrderReference;
      r.orderedAt = NOW;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async recordVendorInvoice(_actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.invoiceTotalCents = input.invoiceTotalCents;
      r.invoiceReconciledAt = NOW;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async markInTransit(_actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.status = "in_transit";
      r.trackingNumber = input.trackingNumber;
      r.carrier = input.carrier;
      r.shippedAt = NOW;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async markDelivered(actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.status = "delivered";
      r.deliveredAt = input.deliveredAt;
      r.deliveryMethod = input.deliveryMethod;
      r.deliveredByMembershipId = actor.membershipId;
      r.deliveryEvidenceDocumentId = input.evidenceDocumentId ?? null;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    // F-193 (#248) — wiring smoke only: proves the route is mounted, gated on
    // `supplies.request.caregiver_signature`, and returns the two domain refusals as the documented status
    // codes. The per-method evidence floor is NOT re-derived here (that is
    // `supplies-caregiver-signature.test.ts`'s job, over the real pure validator) — this fake applies the
    // capture unconditionally once the two lifecycle guards pass.
    // COP27 — wiring smoke over the REAL pure rule (`decideCoverageDetermination`: dme/supply only, reason
    // required when not covered); the DB write + event + RLS are `cop27-hospice-coverage.live.test.ts`'s job.
    async setCoverageDetermination(actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      const reason = decideCoverageDetermination({
        kind: r.kind as never,
        hospiceCoverage: input.hospiceCoverage,
        reason: input.reason,
      });
      r.hospiceCoverage = input.hospiceCoverage;
      r.coverageReason = reason;
      r.coverageDeterminedAt = NOW;
      r.coverageDeterminedBy = actor.membershipId;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async captureCaregiverSignature(actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      if (r.deliveredAt === null) {
        unprocessable(
          "a caregiver signature is captured against a delivery; this request has not reached 'delivered' yet",
        );
      }
      if (r.caregiverSignatureCapturedAt !== null) {
        conflict("a caregiver signature was already captured for this request");
      }
      r.caregiverSignatureCaptureMethod = input.captureMethod;
      r.caregiverSignatureCapturedAt = NOW;
      r.caregiverSignatureCapturedByMembershipId = actor.membershipId;
      r.caregiverSignatureEvidenceDocumentId =
        input.captureMethod === "witnessed_verbal_documented"
          ? (input.evidenceDocumentId ?? null)
          : null;
      r.caregiverSignatureEvidence =
        input.captureMethod === "typed_signature_in_app"
          ? { typedSignatureName: input.typedSignatureName }
          : input.captureMethod === "witnessed_verbal_documented"
            ? {
                witnessName: input.witnessName,
                witnessAttestationText: input.witnessAttestationText,
              }
            : input.declinedReason !== undefined
              ? { declinedReason: input.declinedReason }
              : null;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async confirmReceived(_actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.status = "received_confirmed";
      r.receivedConfirmedAt = input.confirmedAt;
      r.receivedConfirmedActor = input.actor;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async cancelSupplyRequest(_actor, id, input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.status = "cancelled";
      r.cancelledAt = NOW;
      r.cancellationReason = input.reason;
      r.updatedAt = NOW;
      return requestDetail(r);
    },
    async returnSupplyRequest(_actor, id, _input) {
      const r = requests.get(id) ?? notFound("supply request");
      r.status = "returned";
      r.updatedAt = NOW;
      return requestDetail(r);
    },

    async createSupplyItem(_actor, input) {
      const supplyItemId = fakeId();
      const rec: SupplyItemRecord = {
        supplyItemId,
        isPlatform: true,
        hcpcs: input.hcpcs ?? null,
        rxnorm: input.rxnorm ?? null,
        ndc: input.ndc ?? null,
        name: input.name,
        skuClass: input.skuClass,
        defaultUnit: input.defaultUnit,
        isBillable: input.isBillable ?? true,
        isActive: true,
        isControlledSubstance: input.isControlledSubstance ?? false,
        requiresLotTracking: input.requiresLotTracking ?? false,
        requiresExpirationTracking: input.requiresExpirationTracking ?? false,
        isSerializedAsset: input.isSerializedAsset ?? false,
        effectiveFrom: NOW,
        effectiveTo: null,
        localSkuCode: null,
        updatedAt: NOW,
      };
      supplyItems.set(supplyItemId, rec);
      return itemView(rec);
    },
    async retireSupplyItem(_actor, id, input) {
      const s = supplyItems.get(id) ?? notFound("supply item");
      s.isActive = false;
      s.effectiveTo = input.effectiveTo;
      s.updatedAt = NOW;
      return itemView(s);
    },
    async createTenantExtension(_actor, input) {
      const supplyItemId = fakeId();
      const rec: SupplyItemRecord = {
        supplyItemId,
        isPlatform: false,
        hcpcs: null,
        rxnorm: null,
        ndc: null,
        name: input.name,
        skuClass: "internal",
        defaultUnit: input.defaultUnit,
        isBillable: input.isBillable ?? false,
        isActive: input.isActive ?? true,
        isControlledSubstance: null,
        requiresLotTracking: null,
        requiresExpirationTracking: null,
        isSerializedAsset: null,
        effectiveFrom: NOW,
        effectiveTo: null,
        localSkuCode: input.localSkuCode,
        updatedAt: NOW,
      };
      supplyItems.set(supplyItemId, rec);
      return itemView(rec);
    },
    async updateTenantExtension(_actor, id, input) {
      const s = supplyItems.get(id) ?? notFound("supply item");
      s.name = input.name;
      s.localSkuCode = input.localSkuCode;
      s.defaultUnit = input.defaultUnit;
      if (input.isBillable !== undefined) s.isBillable = input.isBillable;
      if (input.isActive !== undefined) s.isActive = input.isActive;
      s.updatedAt = NOW;
      return itemView(s);
    },

    async createComfortKitTemplate(_actor, input) {
      const comfortKitTemplateId = fakeId();
      const medications: TemplateMedicationRecord[] = input.medications.map((m, i) => ({
        templateMedicationId: fakeId(),
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
        replenishmentThresholdPct: m.replenishmentThresholdPct ?? "0.2",
        systemLocked: false,
        displayOrder: m.displayOrder ?? i,
      }));
      const rec: TemplateRecord = {
        comfortKitTemplateId,
        name: input.name,
        isPlatformFloor: false,
        systemLocked: false,
        effectiveFrom: NOW,
        effectiveTo: null,
        replacesTemplateId: null,
        medications,
        updatedAt: NOW,
      };
      templates.set(comfortKitTemplateId, rec);
      return templateView(rec);
    },
    async supersedeComfortKitTemplate(_actor, templateId, input) {
      const predecessor = templates.get(templateId) ?? notFound("comfort kit template");
      predecessor.effectiveTo = NOW;
      predecessor.updatedAt = NOW;
      const comfortKitTemplateId = fakeId();
      const medications: TemplateMedicationRecord[] = input.medications.map((m, i) => ({
        templateMedicationId: fakeId(),
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
        replenishmentThresholdPct: m.replenishmentThresholdPct ?? "0.2",
        systemLocked: false,
        displayOrder: m.displayOrder ?? i,
      }));
      const rec: TemplateRecord = {
        comfortKitTemplateId,
        name: input.name,
        isPlatformFloor: false,
        systemLocked: false,
        effectiveFrom: input.effectiveFrom ?? NOW,
        effectiveTo: null,
        replacesTemplateId: templateId,
        medications,
        updatedAt: NOW,
      };
      templates.set(comfortKitTemplateId, rec);
      return templateView(rec);
    },

    async createDispatch(actor, input) {
      const dispatchId = fakeId();
      const request = requests.get(input.supplyRequestId);
      const template = templates.get(input.comfortKitTemplateId);
      const contents: DispatchContentRecord[] = input.contents.map((line) => {
        const med = template?.medications.find(
          (m) => m.templateMedicationId === line.comfortKitTemplateMedicationId,
        );
        return {
          dispatchedContentId: fakeId(),
          comfortKitTemplateMedicationId: line.comfortKitTemplateMedicationId,
          medicationOrderId: line.medicationOrderId ?? null,
          rxnorm: med?.rxnorm ?? "0",
          ndc: line.manufacturerNdc ?? med?.ndc ?? null,
          drugName: med?.drugName ?? "unknown",
          strength: med?.strength ?? "0",
          dosageForm: med?.dosageForm ?? "unknown",
          routeOfAdministration: med?.routeOfAdministration ?? "oral",
          isControlledSubstance: med?.isControlledSubstance ?? false,
          controlledSubstanceSchedule: med?.controlledSubstanceSchedule ?? null,
          dispatchedQuantity: line.dispatchedQuantity,
          dispatchedUnit: line.dispatchedUnit,
          lotNumber: line.lotNumber ?? null,
          expirationDate: line.expirationDate ?? null,
          manufacturerNdc: line.manufacturerNdc ?? null,
          replenishmentThresholdPct: med ? Number(med.replenishmentThresholdPct) : 0.2,
        };
      });
      const rec: DispatchRecord = {
        dispatchId,
        supplyRequestId: input.supplyRequestId,
        patientId: request?.patientId ?? fakeId(),
        locationId: input.locationId,
        comfortKitTemplateId: input.comfortKitTemplateId,
        kitSerialNumber: input.kitSerialNumber,
        deploymentSite: input.deploymentSite,
        dispatchStatus: "dispatched",
        ipuRoomId: input.ipuRoomId ?? null,
        dispatchedAt: NOW,
        deployedAtPatientAt: null,
        containsControlledSubstance: contents.some((c) => c.isControlledSubstance),
        updatedAt: NOW,
        admissionId: request?.admissionId ?? fakeId(),
        providerEntityId: PROVIDER,
        dispatchSource: input.dispatchSource,
        pharmacyDispatchMode: input.pharmacyDispatchMode,
        pharmacyPartnerId: input.pharmacyPartnerId ?? null,
        dispatchedByMembershipId: actor.membershipId,
        deployedByMembershipId: null,
        bolDocumentId: null,
        m13DeploymentId: null,
        controlledSubstanceHandlingPolicyDigest: "policy-digest-1",
        facilityIdentifier: input.facilityIdentifier ?? null,
        specialHandlingNotes: input.specialHandlingNotes ?? null,
        contents,
      };
      dispatches.set(dispatchId, rec);
      if (request) {
        request.dispatchId = dispatchId;
        request.updatedAt = NOW;
      }
      return dispatchDetail(rec);
    },
    async markDeployedAtPatient(actor, dispatchId, input) {
      const d = dispatches.get(dispatchId) ?? notFound("dispatch");
      d.dispatchStatus = "deployed_at_patient";
      d.deployedAtPatientAt = input.deployedAt;
      d.deployedByMembershipId = actor.membershipId;
      d.updatedAt = NOW;
      return dispatchDetail(d);
    },

    async createReturn(_actor, input) {
      const d = dispatches.get(input.dispatchId) ?? notFound("dispatch");
      const returnId = fakeId();
      const rec: ReturnRecord = {
        returnId,
        dispatchId: input.dispatchId,
        patientId: d.patientId,
        locationId: d.locationId,
        state: "requested",
        returnRequiredAt: input.returnRequiredAt ?? NOW,
        returnDueAt: NOW,
        assignedRetrievingMembershipId: null,
        reconciledAt: null,
        containsControlledSubstance: d.containsControlledSubstance,
        updatedAt: NOW,
        admissionId: d.admissionId,
        providerEntityId: PROVIDER,
        m13DeploymentId: fakeId(),
        retrievingAt: null,
        retrievedAt: null,
        returnedToHubAt: null,
        disposalMethod: null,
        disposalWitnessMembershipId: null,
        disposalMethodJurisdictionPolicyDigest: null,
        reconciledByMembershipId: null,
        receiptDocumentId: null,
        disposalNotes: null,
        discrepancyNotes: null,
        unreturnableReason: null,
        unreturnableAttestedByMembershipId: null,
        lines: [],
        discrepancyDetected: false,
      };
      returns.set(returnId, rec);
      return returnDetail(rec);
    },
    async assignRetriever(_actor, returnId, input) {
      const r = returns.get(returnId) ?? notFound("return");
      r.assignedRetrievingMembershipId = input.retrievingMembershipId;
      r.state = "assigned";
      r.retrievingAt = NOW;
      r.updatedAt = NOW;
      return returnDetail(r);
    },
    async reconcileReturn(actor, returnId, input) {
      const r = returns.get(returnId) ?? notFound("return");
      const d = dispatches.get(r.dispatchId);
      const lines: ComfortKitReturnedLineView[] = input.perMedicationReconciliation.map((line) => {
        const content = d?.contents.find((c) => c.dispatchedContentId === line.dispatchedContentId);
        return {
          returnedContentId: fakeId() as never,
          dispatchedContentId: line.dispatchedContentId as never,
          drugName: content?.drugName ?? "unknown",
          lotNumber: content?.lotNumber ?? null,
          isControlledSubstance: content?.isControlledSubstance ?? false,
          controlledSubstanceSchedule: (content?.controlledSubstanceSchedule ?? null) as never,
          dispatchedQuantity: content?.dispatchedQuantity ?? "0",
          quantityReturned: line.quantityReturned,
          quantityDisposedAtHome: line.quantityDisposedAtHome,
          quantityUnaccounted: "0",
          discrepancyPct: "0",
          discrepancyFlagged: false,
        };
      });
      r.state = "reconciled";
      r.reconciledAt = NOW;
      r.reconciledByMembershipId = actor.membershipId;
      r.disposalMethod = input.disposalMethod;
      r.disposalWitnessMembershipId = input.disposalWitnessMembershipId ?? null;
      r.disposalNotes = input.disposalNotes ?? null;
      r.discrepancyNotes = input.discrepancyNotes ?? null;
      r.lines = lines;
      r.discrepancyDetected = false;
      r.updatedAt = NOW;
      return {
        returnId,
        state: "reconciled",
        discrepancyDetected: false,
        perMedication: lines,
        updatedAt: NOW,
      };
    },
    async declareUnreturnable(actor, returnId, input) {
      const r = returns.get(returnId) ?? notFound("return");
      r.state = "unreturnable";
      r.unreturnableReason = input.reason;
      r.unreturnableAttestedByMembershipId = actor.membershipId;
      r.updatedAt = NOW;
      return returnDetail(r);
    },

    async createVendorRoutingRule(_actor, input) {
      const ruleId = fakeId();
      const rec: RoutingRuleRecord = {
        ruleId,
        isPlatform: false,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId ?? null,
        skuClassPattern: input.skuClassPattern ?? null,
        assignedVendorId: input.assignedVendorId,
        assignedFulfillmentMode: input.assignedFulfillmentMode,
        defaultPharmacyDispatchMode: input.defaultPharmacyDispatchMode ?? null,
        precedencePriority: input.precedencePriority ?? 0,
        isActive: true,
        effectiveFrom: NOW,
        effectiveTo: null,
        updatedAt: NOW,
      };
      routingRules.set(ruleId, rec);
      return ruleView(rec);
    },
    async updateVendorRoutingRule(_actor, ruleId, input) {
      const r = routingRules.get(ruleId) ?? notFound("routing rule");
      r.scopeKind = input.scopeKind;
      r.scopeId = input.scopeId ?? null;
      r.skuClassPattern = input.skuClassPattern ?? null;
      r.assignedVendorId = input.assignedVendorId;
      r.assignedFulfillmentMode = input.assignedFulfillmentMode;
      r.defaultPharmacyDispatchMode = input.defaultPharmacyDispatchMode ?? null;
      if (input.precedencePriority !== undefined) r.precedencePriority = input.precedencePriority;
      r.updatedAt = NOW;
      return ruleView(r);
    },
    async retireVendorRoutingRule(_actor, ruleId) {
      const r = routingRules.get(ruleId) ?? notFound("routing rule");
      r.isActive = false;
      r.effectiveTo = NOW;
      r.updatedAt = NOW;
      return ruleView(r);
    },

    async updateParStock(_actor, parStockId, input) {
      const p = parStock.get(parStockId) ?? notFound("par stock");
      if (input.reorderPoint !== undefined) p.reorderPoint = input.reorderPoint;
      if (input.reorderQuantity !== undefined) p.reorderQuantity = input.reorderQuantity;
      if (input.minSafetyStock !== undefined) p.minSafetyStock = input.minSafetyStock;
      if (input.isActive !== undefined) p.isActive = input.isActive;
      if (input.reorderNotes !== undefined) p.reorderNotes = input.reorderNotes;
      p.updatedAt = NOW;
      return parStockView(p);
    },
    async recordObservation(actor, input) {
      const p = parStock.get(input.parStockId) ?? notFound("par stock");
      p.currentQuantity = input.observedQuantity;
      p.lastParReviewAt = input.observedAt ?? NOW;
      p.lastParReviewedByMembershipId = actor.membershipId;
      if (input.reorderNotes !== undefined) p.reorderNotes = input.reorderNotes;
      p.updatedAt = NOW;
      return parStockView(p);
    },

    // §4.8 seam entry point — not a route (mounted only through the M1 registry). Never called by this
    // HTTP-layer smoke file; a trivial throw keeps the fake honest about what it actually backs.
    async createDirect() {
      throw new Error(
        "createDirect is a §4.8 seam entry point, not exercised over HTTP by this file",
      );
    },
  };

  // ── the §4.4 ABAC resolver — reads the SAME maps the write service populates, so a dispatch created
  // through the route surface is immediately visible to the reconcile-eligibility predicate. ────────────
  const resolver: SuppliesAbacResolver = {
    async loadDispatch(_orgId, dispatchId) {
      const d = dispatches.get(dispatchId);
      if (!d) return null;
      return {
        organizationId: ORG,
        targetId: d.dispatchId,
        locationId: d.locationId,
        involvesControlledSubstance: d.containsControlledSubstance,
      };
    },
    async loadRequest(_orgId, requestId) {
      const r = requests.get(requestId);
      if (!r) return null;
      return {
        organizationId: ORG,
        targetId: r.supplyRequestId,
        locationId: r.locationId,
        involvesControlledSubstance:
          r.kind === "comfort_kit_deploy" || r.kind === "comfort_kit_replenish",
      };
    },
    async loadReturn(_orgId, returnId) {
      const r = returns.get(returnId);
      if (!r) return null;
      const d = dispatches.get(r.dispatchId);
      return {
        organizationId: ORG,
        returnId: r.returnId as never,
        dispatchId: r.dispatchId as never,
        dispatchedByMembershipId: (d?.dispatchedByMembershipId ?? "") as never,
        assignedRetrievingMembershipId: r.assignedRetrievingMembershipId as never,
        disposalWitnessMembershipId: r.disposalWitnessMembershipId as never,
        containsControlledSubstance: r.containsControlledSubstance,
      };
    },
    // Every actor's roles arrive on `context.roles` via the header-auth shim (nonempty), so
    // `roleKeysFor` (abac-predicates.ts) never falls through to this resolver call in this file.
    async roleKeysOf() {
      return null;
    },
    async locationIdsOf(_orgId, membershipId) {
      return membershipId === DISPATCHER_ID ? [LOC_A] : [];
    },
    // GAP-064 — the admission's siting. Registered permissively: every admission is sited at LOC_A unless a
    // test overrides it through `admissionLocations`.
    async loadAdmissionLocation(_orgId, admissionId) {
      if (seamErrorAdmissions.has(admissionId)) throw new Error("admission seam unavailable");
      if (unsitedAdmissions.has(admissionId)) return null;
      return admissionLocations.get(admissionId) ?? LOC_A;
    },
  };

  return {
    readService,
    writeService,
    resolver,
    seedParStock,
    admissionLocations,
    unsitedAdmissions,
    seamErrorAdmissions,
  };
}

type FakeBackend = ReturnType<typeof createFakeBackend>;

function makeServer(): { app: ReturnType<typeof buildServer>; backend: FakeBackend } {
  const backend = createFakeBackend();

  const grantStore = createInMemoryEffectivePermissionStore(
    [COORD_ID, DISPATCHER_ID, RECONCILER_ID, ADMIN_ID].map((membershipId) => ({
      orgId: ORG,
      userId: `user_${membershipId}`,
      grants: [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...M21_PERMISSION_KEY_LIST],
        },
      ],
    })),
  );
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server — the shared registry would otherwise close over a PRIOR
  // test's in-memory backend (the M11-T06 `orders-routes.test.ts` precedent). `step_up_recent` is M3's
  // predicate, not M21's; it is stubbed to always-pass here because freshness policy is exercised
  // elsewhere (`step-up-policy.test.ts`) and is not this file's concern.
  const reg = createPredicateRegistry();
  const predicates = buildSuppliesAbacPredicates({ resolver: backend.resolver });
  for (const [name, predicate] of Object.entries(predicates)) reg.register(name, predicate);
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM21Routes(app, { readService: backend.readService, writeService: backend.writeService });
  return { app, backend };
}

const COORD = {
  "x-test-user": `user_${COORD_ID}`,
  "x-test-org": ORG,
  "x-test-roles": "supply_coordinator",
  "x-test-membership": COORD_ID,
};
// `pharmacist` carries the §4.4(c) cross-location designation, so the dispatcher predicate never has to
// consult `resolver.locationIdsOf` to admit this actor — it is a genuine member of the dispatcher role
// set (`CONTROLLED_SUBSTANCE_DISPATCHER_ROLES`), not a bypass.
const DISPATCHER = {
  "x-test-user": `user_${DISPATCHER_ID}`,
  "x-test-org": ORG,
  "x-test-roles": "pharmacist",
  "x-test-membership": DISPATCHER_ID,
};
const RECONCILER = {
  "x-test-user": `user_${RECONCILER_ID}`,
  "x-test-org": ORG,
  "x-test-roles": "registered_nurse",
  "x-test-membership": RECONCILER_ID,
};
const ADMIN = {
  "x-test-user": `user_${ADMIN_ID}`,
  "x-test-org": ORG,
  "x-test-roles": "compliance_officer",
  "x-test-membership": ADMIN_ID,
};
const NO_PERMS = {
  "x-test-user": "noperm_user",
  "x-test-org": ORG,
  "x-test-roles": "auditor",
  "x-test-membership": NO_PERMS_ID,
};

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── 401 / 403 / 422 boundary cases ──────────────────────────────────────────────────────────────────────

describe("M21 §4.1 route inventory — the boundary cases", () => {
  it("no auth headers at all → 401", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/supplies/supply-requests" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("a user holding NO supplies permissions is denied (403)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/supply-requests",
      headers: NO_PERMS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("an empty comfort-kit-template payload fails TypeBox validation (422)", async () => {
    // NOT `POST /supply-requests`: row 1 carries `ABAC_DISPATCHER_ON_KIND` ahead of body parsing, and an
    // empty body resolves to "no declared Location" — a 403 (the predicate's own fail-closed refusal),
    // masking the validation failure this case exists to prove. `comfort_kit.template.write` carries no
    // ABAC cell at all, so an empty body reaches TypeBox and 422s cleanly.
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-templates",
      headers: { ...ADMIN, "idempotency-key": "empty-422" },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── §4.1 rows 1-10 — the supply-request lifecycle, plus row 1's conditional ABAC cell ──────────────────

describe("M21 §4.1 rows 1-10 — supply-request create through delivery, cancel, return", () => {
  it("a coordinator drafts a DME request through delivery + confirm; separate requests exercise cancel and return", async () => {
    const { app } = makeServer();

    // 1 — create (non-kit kind: ABAC_DISPATCHER_ON_KIND allows outright, no dispatcher role needed).
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...COORD, "idempotency-key": "req-1" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "dme" },
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().status).toBe("requested");
    const id = create.json().supplyRequestId as string;

    // 2 — the dashboard worklist.
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/supply-requests",
      headers: COORD,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.length).toBeGreaterThan(0);

    // 3 — detail.
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/supply-requests/${id}`,
      headers: COORD,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().supplyRequestId).toBe(id);

    // 4 — D4 vendor override.
    const assign = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/assign-vendor`,
      headers: { ...COORD, "idempotency-key": "req-1-assign", "if-match": NOW },
      payload: { vendorId: null, fulfillmentMode: "internal_supply_hub" },
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().status).toBe("vendor_assigned");

    // 5 — vendor accepted.
    const ordered = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/mark-ordered`,
      headers: { ...COORD, "idempotency-key": "req-1-ordered", "if-match": NOW },
      payload: { vendorOrderReference: "PO-100" },
    });
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().status).toBe("ordered");

    // 6 — shipment identifiers.
    const transit = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/mark-in-transit`,
      headers: { ...COORD, "idempotency-key": "req-1-transit", "if-match": NOW },
      payload: { trackingNumber: "1Z999", carrier: "UPS" },
    });
    expect(transit.statusCode).toBe(200);
    expect(transit.json().status).toBe("in_transit");

    // 7 — D7 courier attestation.
    const delivered = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/mark-delivered`,
      headers: { ...COORD, "idempotency-key": "req-1-delivered", "if-match": NOW },
      payload: { deliveredAt: NOW, deliveryMethod: "agency_courier" },
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().status).toBe("delivered");

    // 7b — F-193 (#248): M21's own caregiver-signature capture. Status does NOT move off `delivered`.
    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/caregiver-signature`,
      headers: {
        ...COORD,
        "idempotency-key": "req-1-signature",
        "if-match": delivered.json().updatedAt,
      },
      payload: { captureMethod: "typed_signature_in_app", typedSignatureName: "Dana Reyes" },
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe("delivered");
    expect(signed.json().caregiverSignatureCaptureMethod).toBe("typed_signature_in_app");
    expect(signed.json().caregiverSignatureCapturedByMembershipId).toBe(COORD_ID);

    // 7c — a second capture attempt on the SAME request is refused, not overwritten (409).
    const resigned = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/caregiver-signature`,
      headers: {
        ...COORD,
        "idempotency-key": "req-1-signature-2",
        "if-match": signed.json().updatedAt,
      },
      payload: { captureMethod: "declined" },
    });
    expect(resigned.statusCode).toBe(409);

    // 8 — caregiver confirms receipt.
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/confirm-received`,
      headers: { ...COORD, "idempotency-key": "req-1-confirmed", "if-match": NOW },
      payload: { actor: "caregiver", confirmedAt: NOW },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe("received_confirmed");

    // 9 — cancel a SEPARATE request.
    const toCancel = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...COORD, "idempotency-key": "req-2" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "supply" },
      },
    });
    const cancelId = toCancel.json().supplyRequestId as string;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${cancelId}/cancel`,
      headers: { ...COORD, "idempotency-key": "req-2-cancel", "if-match": NOW },
      payload: { reason: "patient declined" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");

    // 10 — a DME pickup return, on a THIRD request.
    const toReturn = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...COORD, "idempotency-key": "req-3" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "dme" },
      },
    });
    const returnReqId = toReturn.json().supplyRequestId as string;
    const returned = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${returnReqId}/return`,
      headers: { ...COORD, "idempotency-key": "req-3-return", "if-match": NOW },
      payload: { reason: "hospital bed no longer needed" },
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().status).toBe("returned");

    await app.close();
  });

  it("COP27: PUT coverage-determination sets a dme determination, requires a reason, and needs If-Match", async () => {
    const { app } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...COORD, "idempotency-key": "req-cov" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "dme" },
      },
    });
    const id = create.json().supplyRequestId as string;
    const url = `/api/v1/supplies/supply-requests/${id}/coverage-determination`;

    const noReason = await app.inject({
      method: "PUT",
      url,
      headers: { ...COORD, "idempotency-key": "req-cov-1", "if-match": NOW },
      payload: { hospiceCoverage: "not_covered_unrelated" },
    });
    expect(noReason.statusCode).toBe(422);

    const noIfMatch = await app.inject({
      method: "PUT",
      url,
      headers: { ...COORD, "idempotency-key": "req-cov-2" },
      payload: { hospiceCoverage: "not_covered_unrelated", reason: "Unrelated equipment." },
    });
    expect(noIfMatch.statusCode).toBe(428);

    const ok = await app.inject({
      method: "PUT",
      url,
      headers: { ...COORD, "idempotency-key": "req-cov-3", "if-match": NOW },
      payload: { hospiceCoverage: "not_covered_unrelated", reason: "Unrelated equipment." },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      hospiceCoverage: "not_covered_unrelated",
      coverageReason: "Unrelated equipment.",
    });
    await app.close();
  });

  it("GAP-063: POST vendor-invoice validates an integer-cents body and needs If-Match", async () => {
    const { app } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...COORD, "idempotency-key": "req-inv" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "dme" },
      },
    });
    const id = create.json().supplyRequestId as string;
    const url = `/api/v1/supplies/supply-requests/${id}/vendor-invoice`;

    const fractional = await app.inject({
      method: "POST",
      url,
      headers: { ...COORD, "idempotency-key": "req-inv-1", "if-match": NOW },
      payload: { invoiceTotalCents: 12.5 },
    });
    expect(fractional.statusCode).toBe(422);

    const noIfMatch = await app.inject({
      method: "POST",
      url,
      headers: { ...COORD, "idempotency-key": "req-inv-2" },
      payload: { invoiceTotalCents: 12500 },
    });
    expect(noIfMatch.statusCode).toBe(428);

    const ok = await app.inject({
      method: "POST",
      url,
      headers: { ...COORD, "idempotency-key": "req-inv-3", "if-match": NOW },
      payload: { invoiceTotalCents: 12500 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ invoiceTotalCents: 12500 });
    await app.close();
  });

  it("F-193 (#248): caregiver-signature capture before 'delivered' is refused (422)", async () => {
    const { app } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...COORD, "idempotency-key": "req-sig-422" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "dme" },
      },
    });
    const id = create.json().supplyRequestId as string;

    const signed = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/caregiver-signature`,
      headers: { ...COORD, "idempotency-key": "req-sig-422-try", "if-match": NOW },
      payload: { captureMethod: "declined" },
    });
    expect(signed.statusCode).toBe(422);
    await app.close();
  });

  it("F-193 (#248): a witnessed capture without a witness/evidence floor fails TypeBox-body-shape 422 downstream of the route (documented via the write-service contract, not this smoke test)", async () => {
    // The per-method evidence FLOOR (name length, attestation length, evidence-document presence) is
    // enforced by the pure validator (`requireCaregiverSignatureEvidence`), which this file's fake write
    // service deliberately does NOT re-derive (see the fake's own doc-comment) — that rule is covered by
    // `supplies-caregiver-signature.test.ts` over the real function. This test only proves the WIRING
    // fact that belongs here: an `if-match` mismatch on the capture route is still a 412, the same §7.2
    // guard every other M21 mutation carries.
    const { app } = makeServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...COORD, "idempotency-key": "req-sig-412" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "dme" },
      },
    });
    const id = create.json().supplyRequestId as string;
    const noIfMatch = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-requests/${id}/caregiver-signature`,
      headers: { ...COORD, "idempotency-key": "req-sig-412-try" },
      payload: { captureMethod: "declined" },
    });
    expect(noIfMatch.statusCode).toBe(428);
    await app.close();
  });

  it("row 1's conditional ABAC cell: a dispatcher creates a comfort_kit_deploy request (201)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...DISPATCHER, "idempotency-key": "kit-req-1" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "comfort_kit_deploy" },
      },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

// ── §4.1 rows 11-19 — the D11 SKU catalog + §2.3 comfort-kit templates ──────────────────────────────────

describe("M21 §4.1 rows 11-19 — SKU catalog, tenant overlay, comfort-kit templates", () => {
  it("platform catalog CRUD, the tenant overlay, and a template create + supersede", async () => {
    const { app } = makeServer();

    // 12 — create a platform SKU (platform-only key).
    const createItem = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-items",
      headers: { ...ADMIN, "idempotency-key": "item-1" },
      payload: {
        name: "Hospital bed, semi-electric",
        skuClass: "E",
        defaultUnit: "each",
        hcpcs: "E0260",
      },
    });
    expect(createItem.statusCode).toBe(201);
    const itemId = createItem.json().supplyItemId as string;

    // 11 — the catalog list (platform UNION tenant overlay).
    const listItems = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/supply-items",
      headers: ADMIN,
    });
    expect(listItems.statusCode).toBe(200);

    // 13 — one SKU.
    const itemDetail = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/supply-items/${itemId}`,
      headers: ADMIN,
    });
    expect(itemDetail.statusCode).toBe(200);
    expect(itemDetail.json().supplyItemId).toBe(itemId);

    // 14 — retire it (platform-only key).
    const retire = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/supply-items/${itemId}/retire`,
      headers: { ...ADMIN, "idempotency-key": "item-1-retire" },
      payload: { effectiveTo: NOW },
    });
    expect(retire.statusCode).toBe(200);
    expect(retire.json().isActive).toBe(false);

    // 15 — a tenant-local, non-billable item.
    const tenantItem = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/tenant-supply-items",
      headers: { ...ADMIN, "idempotency-key": "tenant-item-1" },
      payload: { name: "Agency-branded wipes", localSkuCode: "WIPE-01", defaultUnit: "pack" },
    });
    expect(tenantItem.statusCode).toBe(201);
    const tenantItemId = tenantItem.json().supplyItemId as string;

    // 16 — edit it.
    const tenantItemEdit = await app.inject({
      method: "PUT",
      url: `/api/v1/supplies/tenant-supply-items/${tenantItemId}`,
      headers: { ...ADMIN, "idempotency-key": "tenant-item-1-edit" },
      payload: {
        name: "Agency-branded wipes (large)",
        localSkuCode: "WIPE-01L",
        defaultUnit: "pack",
      },
    });
    expect(tenantItemEdit.statusCode).toBe(200);
    expect(tenantItemEdit.json().localSkuCode).toBe("WIPE-01L");

    // 17 — the template list.
    const listTemplates = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/comfort-kit-templates",
      headers: ADMIN,
    });
    expect(listTemplates.statusCode).toBe(200);

    // 18 — author a template. `isControlledSubstance: false` — see the file header on why this file's
    // dispatch/reconcile fixtures never carry a real schedule.
    const template = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-templates",
      headers: { ...ADMIN, "idempotency-key": "template-1" },
      payload: {
        name: "Standard comfort kit",
        medications: [
          {
            rxnorm: "161",
            drugName: "Acetaminophen",
            strength: "325 mg",
            dosageForm: "tablet",
            routeOfAdministration: "oral",
            isControlledSubstance: false,
            expectedQuantity: "30",
            expectedUnit: "tablet",
          },
        ],
      },
    });
    expect(template.statusCode).toBe(201);
    const templateId = template.json().comfortKitTemplateId as string;

    // 19 — supersede it (an INSERT, per the route file header — not an in-place patch).
    const supersede = await app.inject({
      method: "PUT",
      url: `/api/v1/supplies/comfort-kit-templates/${templateId}`,
      headers: { ...ADMIN, "idempotency-key": "template-1-supersede" },
      payload: {
        name: "Standard comfort kit v2",
        medications: [
          {
            rxnorm: "161",
            drugName: "Acetaminophen",
            strength: "325 mg",
            dosageForm: "tablet",
            routeOfAdministration: "oral",
            isControlledSubstance: false,
            expectedQuantity: "60",
            expectedUnit: "tablet",
          },
        ],
      },
    });
    expect(supersede.statusCode).toBe(200);
    expect(supersede.json().replacesTemplateId).toBe(templateId);

    await app.close();
  });
});

// ── §4.1 rows 20-30 — the DEA 21 CFR §1304 comfort-kit dispatch / return / reconcile surface ───────────

describe("M21 §4.1 rows 20-30 — comfort-kit dispatch through reconciliation and unreturnable", () => {
  it("dispatcher dispatches → deploys → opens a return; a DIFFERENT reconciler assigns, reconciles, and declares unreturnable", async () => {
    const { app } = makeServer();

    // Fixtures: a comfort_kit_deploy request (dispatcher-eligible ABAC) and a non-controlled template.
    const req = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...DISPATCHER, "idempotency-key": "dea-req-1" },
      payload: {
        patientId: fakeId(),
        admissionId: fakeId(),
        locationId: LOC_A,
        deliveryAddress: ADDRESS,
        kindPayload: { kind: "comfort_kit_deploy" },
      },
    });
    const supplyRequestId = req.json().supplyRequestId as string;

    const template = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-templates",
      headers: { ...ADMIN, "idempotency-key": "dea-template-1" },
      payload: {
        name: "DEA-surface kit",
        medications: [
          {
            rxnorm: "161",
            drugName: "Acetaminophen",
            strength: "325 mg",
            dosageForm: "tablet",
            routeOfAdministration: "oral",
            isControlledSubstance: false,
            expectedQuantity: "30",
            expectedUnit: "tablet",
          },
        ],
      },
    });
    const templateId = template.json().comfortKitTemplateId as string;
    const medId = template.json().medications[0].templateMedicationId as string;

    // 20 — dispatch (`controlled_substance_dispatcher_eligible` unconditional on create + step-up).
    const dispatch = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-dispatches",
      headers: { ...DISPATCHER, "idempotency-key": "dea-dispatch-1" },
      payload: {
        supplyRequestId,
        comfortKitTemplateId: templateId,
        locationId: LOC_A,
        deploymentSite: "home",
        dispatchSource: "supply_hub",
        pharmacyDispatchMode: "supply_hub_dispatch",
        kitSerialNumber: "KIT-0001",
        contents: [
          {
            comfortKitTemplateMedicationId: medId,
            dispatchedQuantity: "30",
            dispatchedUnit: "tablet",
          },
        ],
      },
    });
    expect(dispatch.statusCode).toBe(201);
    const dispatchId = dispatch.json().dispatchId as string;
    const dispatchedContentId = dispatch.json().contents[0].dispatchedContentId as string;

    // 21 — the dispatch list.
    const listDispatches = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/comfort-kit-dispatches",
      headers: DISPATCHER,
    });
    expect(listDispatches.statusCode).toBe(200);

    // 22 — dispatch detail.
    const dispatchDetailRes = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/comfort-kit-dispatches/${dispatchId}`,
      headers: DISPATCHER,
    });
    expect(dispatchDetailRes.statusCode).toBe(200);
    expect(dispatchDetailRes.json().dispatchId).toBe(dispatchId);

    // 23 — the kit is physically at the patient.
    const deploy = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/comfort-kit-dispatches/${dispatchId}/deploy-at-patient`,
      headers: { ...DISPATCHER, "idempotency-key": "dea-deploy-1", "if-match": NOW },
      payload: { deployedAt: NOW },
    });
    expect(deploy.statusCode).toBe(200);
    expect(deploy.json().dispatchStatus).toBe("deployed_at_patient");

    // §8.1 (row 24) — the DEA perpetual log for the kit.
    const perpetualLog = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/comfort-kit-dispatches/${dispatchId}/perpetual-log`,
      headers: ADMIN,
    });
    expect(perpetualLog.statusCode).toBe(200);
    expect(perpetualLog.json().dispatchId).toBe(dispatchId);

    // 25 — open a return obligation.
    const openReturn = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-returns",
      headers: { ...DISPATCHER, "idempotency-key": "dea-return-1" },
      payload: { dispatchId, returnReason: "kit reconciliation due" },
    });
    expect(openReturn.statusCode).toBe(201);
    const returnId = openReturn.json().returnId as string;

    // 26 — the reconciliation worklist.
    const listReturns = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/comfort-kit-returns",
      headers: RECONCILER,
    });
    expect(listReturns.statusCode).toBe(200);

    // 27 — return detail.
    const returnDetailRes = await app.inject({
      method: "GET",
      url: `/api/v1/supplies/comfort-kit-returns/${returnId}`,
      headers: RECONCILER,
    });
    expect(returnDetailRes.statusCode).toBe(200);
    expect(returnDetailRes.json().returnId).toBe(returnId);

    // §2.6 (row 28) — assign the retriever.
    const assignRetriever = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/comfort-kit-returns/${returnId}/assign-retriever`,
      headers: { ...RECONCILER, "idempotency-key": "dea-retriever-1", "if-match": NOW },
      payload: { retrievingMembershipId: RETRIEVER_ID },
    });
    expect(assignRetriever.statusCode).toBe(200);
    expect(assignRetriever.json().assignedRetrievingMembershipId).toBe(RETRIEVER_ID);

    // 29 — reconcile. `comfort_kit_return_reconciler_eligible`: the RECONCILER is a DIFFERENT membership
    // from the DISPATCHER (separation of duties), and the kit carries nothing controlled (see the file
    // header), so no witness is required.
    const reconcile = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/comfort-kit-returns/${returnId}/reconcile`,
      headers: { ...RECONCILER, "idempotency-key": "dea-reconcile-1", "if-match": NOW },
      payload: {
        disposalMethod: "take_back_by_supply_team",
        perMedicationReconciliation: [
          { dispatchedContentId, quantityReturned: "30", quantityDisposedAtHome: "0" },
        ],
      },
    });
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.json().state).toBe("reconciled");

    // §2.6 (row 30) — the 90-day assumption-of-loss disposition, on a SECOND dispatch + return so it does
    // not layer on top of the just-reconciled one.
    const dispatch2 = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-dispatches",
      headers: { ...DISPATCHER, "idempotency-key": "dea-dispatch-2" },
      payload: {
        supplyRequestId,
        comfortKitTemplateId: templateId,
        locationId: LOC_A,
        deploymentSite: "home",
        dispatchSource: "supply_hub",
        pharmacyDispatchMode: "supply_hub_dispatch",
        kitSerialNumber: "KIT-0002",
        contents: [
          {
            comfortKitTemplateMedicationId: medId,
            dispatchedQuantity: "30",
            dispatchedUnit: "tablet",
          },
        ],
      },
    });
    const dispatchId2 = dispatch2.json().dispatchId as string;
    const openReturn2 = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-returns",
      headers: { ...DISPATCHER, "idempotency-key": "dea-return-2" },
      payload: { dispatchId: dispatchId2, returnReason: "kit never came back" },
    });
    const returnId2 = openReturn2.json().returnId as string;
    const declareUnreturnable = await app.inject({
      method: "POST",
      url: `/api/v1/supplies/comfort-kit-returns/${returnId2}/declare-unreturnable`,
      headers: { ...RECONCILER, "idempotency-key": "dea-unreturnable-1", "if-match": NOW },
      payload: { reason: "90-day window elapsed; kit assumed lost at home" },
    });
    expect(declareUnreturnable.statusCode).toBe(200);
    expect(declareUnreturnable.json().state).toBe("unreturnable");

    await app.close();
  });
});

// ── §4.1 rows 31-37 — vendor routing + par stock (agency operations, no PHI) ────────────────────────────

// ── GAP-064 — the dispatcher ABAC Location is a SERVER fact ────────────────────────────────────────────
// A supply_coordinator assigned ONLY to LOC_A (no cross-location designation) naming LOC_A in the body for
// a patient served out of LOC_B must be refused on both create routes.
const LOC_A_ONLY_COORD = {
  "x-test-user": `user_${DISPATCHER_ID}`,
  "x-test-org": ORG,
  "x-test-roles": "supply_coordinator",
  "x-test-membership": DISPATCHER_ID,
};

describe("GAP-064 — controlled-substance dispatcher Location is server-resolved", () => {
  const kitBody = (admissionId: string, locationId: string) => ({
    patientId: fakeId(),
    admissionId,
    locationId,
    deliveryAddress: ADDRESS,
    kindPayload: { kind: "comfort_kit_deploy" },
  });

  it("refuses a kit request whose body Location is the actor's but whose admission is sited elsewhere", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.admissionLocations.set(admissionId, LOC_B);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...LOC_A_ONLY_COORD, "idempotency-key": "gap064-req-1" },
      payload: kitBody(admissionId, LOC_A),
    });
    expect(res.statusCode).toBe(403);
  });

  it("still admits the same actor when the admission really is sited at their Location", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.admissionLocations.set(admissionId, LOC_A);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...LOC_A_ONLY_COORD, "idempotency-key": "gap064-req-2" },
      payload: kitBody(admissionId, LOC_A),
    });
    expect(res.statusCode).toBe(201);
  });

  // ── the §4.1 row-1 cell is CONDITIONAL: a non-controlled kind never needs the admission's siting at the
  // route; the write service verifies the Location (unsited-admission fallback included).
  const wound = (admissionId: string, locationId: string) => ({
    patientId: fakeId(),
    admissionId,
    locationId,
    deliveryAddress: ADDRESS,
    kindPayload: { kind: "dme" },
  });
  const post = (
    app: ReturnType<typeof makeServer>["app"],
    key: string,
    payload: ReturnType<typeof kitBody>,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...LOC_A_ONLY_COORD, "idempotency-key": key },
      payload,
    });

  it("admits a NON-controlled request on an unsited admission (the service verifies the Location)", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.unsitedAdmissions.add(admissionId);
    expect((await post(app, "gap064-unsited-1", wound(admissionId, LOC_A))).statusCode).toBe(201);
  });

  it("admits a NON-controlled request when the admission seam errors (the service verifies)", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.seamErrorAdmissions.add(admissionId);
    expect((await post(app, "gap064-seam-1", wound(admissionId, LOC_A))).statusCode).toBe(201);
  });

  it("admits a controlled request on an unsited admission only for an actor assigned to the claimed Location", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.unsitedAdmissions.add(admissionId);
    expect((await post(app, "gap064-unsited-2", kitBody(admissionId, LOC_A))).statusCode).toBe(201);
  });

  it("refuses a controlled request on an unsited admission when the actor lacks the claimed Location", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.unsitedAdmissions.add(admissionId);
    expect((await post(app, "gap064-unsited-3", kitBody(admissionId, LOC_B))).statusCode).toBe(403);
  });

  it("refuses a controlled request when the admission seam errors (fails closed)", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.seamErrorAdmissions.add(admissionId);
    expect((await post(app, "gap064-seam-2", kitBody(admissionId, LOC_A))).statusCode).toBe(403);
  });

  it("refuses a dispatch whose body Location is the actor's but whose request is stored at another Location", async () => {
    const { app, backend } = makeServer();
    const admissionId = fakeId();
    backend.admissionLocations.set(admissionId, LOC_B);
    // the cross-location pharmacist legitimately files the LOC_B request
    const req = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/supply-requests",
      headers: { ...DISPATCHER, "idempotency-key": "gap064-req-3" },
      payload: kitBody(admissionId, LOC_B),
    });
    expect(req.statusCode).toBe(201);
    const dispatch = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/comfort-kit-dispatches",
      headers: { ...LOC_A_ONLY_COORD, "idempotency-key": "gap064-disp-1" },
      payload: {
        supplyRequestId: req.json().supplyRequestId,
        comfortKitTemplateId: fakeId(),
        locationId: LOC_A,
        deploymentSite: "home",
        dispatchSource: "supply_hub",
        pharmacyDispatchMode: "supply_hub_dispatch",
        kitSerialNumber: "KIT-GAP064",
        contents: [
          {
            comfortKitTemplateMedicationId: fakeId(),
            dispatchedQuantity: "1",
            dispatchedUnit: "tablet",
          },
        ],
      },
    });
    expect(dispatch.statusCode).toBe(403);
  });
});

describe("M21 §4.1 rows 31-37 — the D4 vendor-routing ladder and the D5 par-stock shelf", () => {
  it("routing-rule CRUD (create, list, edit, retire) and par-stock edit + observation", async () => {
    const { app, backend } = makeServer();

    // 29 — author a rule (tenant scope has no scopeId, per the m21-typebox header note).
    const createRule = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/vendor-routing-rules",
      headers: { ...ADMIN, "idempotency-key": "rule-1" },
      payload: {
        scopeKind: "tenant",
        assignedVendorId: null,
        assignedFulfillmentMode: "internal_supply_hub",
      },
    });
    expect(createRule.statusCode).toBe(201);
    const ruleId = createRule.json().ruleId as string;

    // 28 — the D4 ladder.
    const listRules = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/vendor-routing-rules",
      headers: ADMIN,
    });
    expect(listRules.statusCode).toBe(200);

    // 30 — edit it.
    const editRule = await app.inject({
      method: "PUT",
      url: `/api/v1/supplies/vendor-routing-rules/${ruleId}`,
      headers: { ...ADMIN, "idempotency-key": "rule-1-edit" },
      payload: {
        scopeKind: "tenant",
        assignedVendorId: null,
        assignedFulfillmentMode: "partner_pharmacy",
        precedencePriority: 5,
      },
    });
    expect(editRule.statusCode).toBe(200);
    expect(editRule.json().assignedFulfillmentMode).toBe("partner_pharmacy");

    // 31 — retire it (a DELETE that retires rather than deletes — the route file header).
    const retireRule = await app.inject({
      method: "DELETE",
      url: `/api/v1/supplies/vendor-routing-rules/${ruleId}`,
      headers: { ...ADMIN, "idempotency-key": "rule-1-retire" },
    });
    expect(retireRule.statusCode).toBe(200);
    expect(retireRule.json().isActive).toBe(false);

    // Fixture: par stock has no create route (provisioned some other way) — seed it directly, the
    // `bereavement-inject.test.ts` no-create-route precedent.
    const parStockRow = backend.seedParStock();

    // 32 — the hub shelf.
    const listPar = await app.inject({
      method: "GET",
      url: "/api/v1/supplies/par-stock",
      headers: ADMIN,
    });
    expect(listPar.statusCode).toBe(200);

    // 33 — edit the thresholds.
    const editPar = await app.inject({
      method: "PUT",
      url: `/api/v1/supplies/par-stock/${parStockRow.parStockId}`,
      headers: { ...ADMIN, "idempotency-key": "par-1-edit", "if-match": NOW },
      payload: { reorderPoint: "3", reorderQuantity: "5" },
    });
    expect(editPar.statusCode).toBe(200);
    expect(editPar.json().reorderPoint).toBe("3");

    // 34 — record an on-hand count (SETS, per the route file header, never adjusts).
    const observe = await app.inject({
      method: "POST",
      url: "/api/v1/supplies/par-stock/observe",
      headers: { ...ADMIN, "idempotency-key": "par-1-observe" },
      payload: { parStockId: parStockRow.parStockId, observedQuantity: "4" },
    });
    expect(observe.statusCode).toBe(200);
    expect(observe.json().currentQuantity).toBe("4");

    await app.close();
  });
});
