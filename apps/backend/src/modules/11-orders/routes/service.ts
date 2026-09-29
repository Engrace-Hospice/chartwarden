// apps/backend/src/modules/11-orders/routes/service.ts — M11-T06 the §4.1 route service over an in-memory
// backend (the M8-T09 / M9-T05 / M10-T06 in-mem-slice precedent; Drizzle in prod under `withOrgContext` so
// RLS backstops every read). The service composes the PURE M11 domain (`@wardenx/orders`): the §2.2 D2
// order lifecycle machine (`transitionOrder`), the §2.5 cosignature rules (`resolveCosignRequirement` /
// `planCosignAttest`), the §2.2/§4.7 author / signer eligibility predicates, the §2.3 verbal-deadline math
// (`computeVerbalDeadline`), and the §2.4 standing-order plans. Every state change records the §4.4 outbox
// event the relay publishes (drainable for tests).
//
// It "binds" the §4.1 cross-module terminology / master-data surfaces through INJECTED validators (the M40
// `MdmEntityProvider` for the ordering physician / DME vendor, the M38 `TerminologyProvider` for the
// lab/HCPCS/CPT code on the order payload). Both are resolved from the M1 seam registry at boot
// (seams/index.ts) and injected here; when absent (the in-mem slice default) the binding is skipped so the
// write path never blocks on an external dependency (the M10 §7.13 fail-open convention).
import {
  DEFAULT_COSIGN_POLICY,
  type LevelOfCare,
  ORDER_KIND_VERSION,
  type OrderCosignPolicy,
  assertSpawnAllowed,
  computeNextSpawnAt,
  computeVerbalDeadline,
  disciplineCanOrder,
  hoursOverdue,
  planCosignAttest,
  planStandingCreation,
  planStandingDiscontinuation,
  planStandingSpawn,
  resolveCosignRequirement,
  signerEligible,
  transitionOrder,
  validateOrderData,
  validateVerbalWindowHours,
} from "@wardenx/orders";
import type {
  OrderDiscontinuationReason,
  OrderKind,
  OrderPriority,
  OrderStatus,
  StandingOrderCadence,
  StandingOrderStatus,
} from "@wardenx/types";
import { ConflictError, NotFoundError, ValidationError } from "@wardenx/types";
import {
  type RecoveryAttestation,
  classifyOrmResend,
  classifyTransmissionRecovery,
} from "../orm-request/orm-resend";

/** Minimal M40 `MdmEntityProvider` subset the order service binds (physician / DME-vendor resolution). */
export interface OrderMdmValidator {
  resolvePhysician(input: { organizationId: string; mdmId: string }): Promise<{
    active: boolean;
  } | null>;
  resolveDmeVendor?(input: { organizationId: string; mdmId: string }): Promise<{
    active: boolean;
  } | null>;
}

/** Minimal M38 `TerminologyProvider` subset the order service binds (LOINC/HCPCS/CPT validity, as-of). */
export interface OrderTerminologyValidator {
  isValidCode(input: {
    system: "LOINC" | "HCPCS" | "CPT";
    code: string;
    asOf?: string;
  }): Promise<boolean>;
}

// ── §4.4 outbox events the service records (the relay wraps them in the M1 envelope) ────────────────────
export interface RecordedOrderEvent {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
}

// ── view DTOs (read projections; never the raw Drizzle row) ──────────────────────────────────────────────
export interface OrderView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly kind: OrderKind;
  readonly status: OrderStatus;
  readonly priority: OrderPriority;
  readonly version: number;
  readonly drafterMembershipId: string;
  readonly drafterDiscipline: string;
  readonly orderingPhysicianMdmId: string;
  readonly cosignRequired: boolean;
  readonly cosignStatus: "pending" | "attached" | null;
  readonly transmissionStatus: string;
  readonly resultsStatus: string;
  readonly verbalDeadlineAt: string | null;
  readonly discontinuationReason: OrderDiscontinuationReason | null;
  readonly replacesOrderId: string | null;
  readonly triggeringAssessmentId: string | null;
  readonly triggeringHopeAssessmentId: string | null;
  readonly signedAt: string | null;
  readonly signedBy: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

/** PHI-bearing payload projection returned only by the single-order detail read. */
export interface OrderDetailView extends OrderView {
  readonly kindVersion: string;
  readonly data: unknown;
  /** Detail-only verbal-order evidence. Present only when this order was recorded verbally. */
  readonly verbalOrder: {
    readonly status: string;
    readonly receivedAt: string;
    readonly effectiveAt: string;
    readonly deadlineAt: string;
    readonly signedAt: string | null;
    readonly readBackVerified: boolean;
    readonly attestation: string;
  } | null;
  readonly requirements: readonly OrderRequirement[];
  readonly allowedActions: OrderAllowedActions;
}

/** Detail-only workflow projection. It is deliberately never persisted. */
export interface OrderRequirement {
  readonly code: "clinical_details" | "rn_cosignature" | "physician_signature" | "verbal_signature";
  readonly label: string;
  readonly status: "not_required" | "pending" | "satisfied";
  readonly deadlineAt?: string;
}
export interface OrderAllowedActions {
  readonly edit: boolean;
  readonly request_signature: boolean;
  readonly record_verbal: boolean;
  readonly sign: boolean;
  readonly cosign: boolean;
  readonly complete: boolean;
  readonly discontinue: boolean;
  readonly correct: boolean;
}
/** A server-assembled snapshot; never accepted from an HTTP body or query. */
export interface OrderDetailActor {
  readonly membershipId: string;
  readonly roles: readonly string[];
  readonly disciplines: readonly string[];
  readonly permissions: ReadonlySet<string>;
}

/** Non-HTTP callers may omit a projection actor; this is deliberately unprivileged. */
export const EMPTY_ORDER_DETAIL_ACTOR: OrderDetailActor = Object.freeze({
  membershipId: "",
  roles: [],
  disciplines: [],
  permissions: new Set<string>(),
});

export function buildOrderWorkflowProjection(
  order: Pick<
    OrderDetailView,
    | "kind"
    | "kindVersion"
    | "data"
    | "status"
    | "cosignRequired"
    | "cosignStatus"
    | "verbalDeadlineAt"
    | "drafterMembershipId"
    | "signedAt"
  >,
  actor: OrderDetailActor,
  cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director" | null,
): Pick<OrderDetailView, "requirements" | "allowedActions"> {
  const clinical = validateOrderData(order.kind, order.kindVersion, order.data).length === 0;
  const signatureApplies = ["pending_signature", "verbal_pending"].includes(order.status);
  const verbal = order.status === "verbal_pending";
  const lowerRoles = actor.roles.map((x) => x.toLowerCase());
  const canCosignRole =
    cosignerRoleNeeded === "medical_director"
      ? lowerRoles.includes("medical_director")
      : lowerRoles.some((x) => x === "rn_case_manager" || x === "clinical_supervisor");
  const canSign = actor.disciplines.some((d) => signerEligible(d, order.kind));
  const has = (permission: string) => actor.permissions.has(permission);
  return {
    requirements: [
      {
        code: "clinical_details",
        label: "Clinical details",
        status: clinical ? "satisfied" : "pending",
      },
      {
        code: "rn_cosignature",
        label: "Required cosignature",
        status: !order.cosignRequired
          ? "not_required"
          : order.cosignStatus === "attached"
            ? "satisfied"
            : "pending",
      },
      {
        code: "physician_signature",
        label: "Required signature",
        // A verbal order has its own deadline-bound authentication requirement below. Rendering both
        // rows says the same thing twice and hides the clinically material distinction (the verbal
        // deadline and receipt evidence).
        status:
          !signatureApplies || verbal ? "not_required" : order.signedAt ? "satisfied" : "pending",
      },
      {
        code: "verbal_signature",
        label: "Verbal-order signature",
        status: !verbal ? "not_required" : order.signedAt ? "satisfied" : "pending",
        ...(verbal && order.verbalDeadlineAt ? { deadlineAt: order.verbalDeadlineAt } : {}),
      },
    ],
    allowedActions: {
      edit: order.status === "draft" && has("orders.draft"),
      request_signature: order.status === "draft" && clinical && has("orders.draft"),
      record_verbal: order.status === "pending_signature" && has("orders.verbal.record"),
      sign: signatureApplies && order.cosignStatus !== "pending" && canSign && has("orders.sign"),
      cosign:
        order.cosignRequired &&
        order.cosignStatus === "pending" &&
        order.drafterMembershipId !== actor.membershipId &&
        canCosignRole &&
        has("orders.cosign"),
      complete: order.status === "active" && has("orders.complete"),
      discontinue:
        ["pending_signature", "verbal_pending", "active"].includes(order.status) &&
        has("orders.discontinue"),
      correct: order.status === "active" && has("orders.amend"),
    },
  };
}

export interface StandingOrderView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly kind: OrderKind;
  readonly cadence: StandingOrderCadence;
  readonly status: StandingOrderStatus;
  readonly nextSpawnAt: string | null;
  readonly spawnCount: number;
  readonly maxSpawns: number | null;
}

export interface VerbalPolicyView {
  readonly windowHours: number;
  readonly businessHoursOnly: boolean;
  readonly lpnCosignRequiredKinds: readonly OrderKind[];
  readonly npCosignRequiredKinds: readonly OrderKind[];
  readonly platformFloorWindowHours: number;
  readonly policyVersion: string;
}

// ── input args ───────────────────────────────────────────────────────────────────────────────────────────
export interface CreateOrderArgs {
  readonly patientId: string;
  readonly admissionId: string;
  readonly kind: OrderKind;
  readonly drafterDiscipline: string;
  readonly data: unknown;
  readonly priority?: OrderPriority;
  readonly orderingPhysicianMdmId: string;
  readonly sourceEncounterId?: string;
  readonly triggeringAssessmentId?: string;
  readonly triggeringHopeAssessmentId?: string;
  readonly replacesOrderId?: string;
}
export interface RequestSignatureArgs {
  readonly signerDiscipline: string;
  readonly levelChange?: { fromLevel: LevelOfCare; toLevel: LevelOfCare };
}
export interface SignArgs {
  readonly signerDiscipline: string;
  readonly signedAtClient: string;
}
export interface SignOnBehalfArgs extends SignArgs {
  readonly onBehalfOf: string;
  readonly reason: string;
}
export interface RecordVerbalArgs {
  readonly recorderDiscipline: string;

  readonly verbalAttestation: string;

  readonly readBackVerified: boolean;

  readonly effectiveAt: string;

  readonly receivedAt: string;

  readonly orderingPhysicianMdmId: string;
}
export interface CreateVerbalOrderArgs {
  readonly order: CreateOrderArgs;
  readonly verbal: RecordVerbalArgs;
}
export interface CosignArgs {
  readonly cosignerRole: "rn_case_manager" | "clinical_supervisor" | "medical_director";
  readonly attestationText: string;
}
export interface DiscontinueArgs {
  readonly reason: OrderDiscontinuationReason;
  readonly effectiveAt: string;
  readonly notes?: string;
}
export interface CreateStandingArgs {
  readonly patientId: string;
  readonly admissionId: string;
  readonly kind: OrderKind;
  readonly signerDiscipline: string;
  readonly cadence: StandingOrderCadence;
  readonly data: unknown;
  /** M40 physician identity carried by every spawned Order; never synthesize a placeholder. */
  readonly orderingPhysicianMdmId: string;
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string;
  readonly maxSpawns?: number;
}
export interface VerbalPolicyArgs {
  readonly windowHours: number;
  readonly businessHoursOnly?: boolean;
  readonly lpnCosignRequiredKinds?: readonly OrderKind[];
  readonly npCosignRequiredKinds?: readonly OrderKind[];
}

/** The §4.7 ABAC facts the order resolver loads for a target order id (for `signer_eligible` / `m11.cosigner_role_match`). */
export interface OrderAbacFacts {
  readonly kind: OrderKind;
  readonly drafterMembershipId: string;
  readonly cosignerRoleNeeded:
    | "rn_case_manager"
    | "clinical_supervisor"
    | "medical_director"
    | null;
  readonly cosignRequired: boolean;
  readonly alreadyCosigned: boolean;
}

/**
 * F-182 (#248) — the outcome of re-running a refused lab ORM. `requested`: every fact resolved this time, the
 * `m11.order.hl7_orm_requested` was published in the same transaction and `transmission_status` is back to
 * `pending`. `still_refused`: a fact is still missing — the order stays `failed` with the (possibly new) refusal
 * reason and nothing was published. `refusalReason` is a fixed producer token (never PHI).
 */
export interface ResendLabTransmissionResult {
  readonly outcome: "requested" | "still_refused";
  readonly refusalReason: string | null;
  readonly order: OrderDetailView;
}

/**
 * F-184 (#248) — the outcome of an operator's ATTESTED recovery of a lab order whose transmission ended in an M29
 * terminal failure. `redispatched`: the operator attested the lab did NOT receive it; the producer re-ran, ONE
 * `m11.order.hl7_orm_requested` (carrying the attestation id) was published in the same transaction and
 * `transmission_status` is back to `pending`. `marked_transmitted`: the operator attested the lab DID receive it;
 * nothing was sent and the order is `transmitted`. `still_refused`: a fact the ORM needs is missing NOW, so it
 * cannot be rebuilt — the order is left EXACTLY as it was (still `failed` with its M29 reason, never rewritten to an
 * `orm_refused:*` that would make the plain resend — and its duplicate risk — reachable). `refusalReason` is a fixed
 * producer token (never PHI).
 */
export interface RecoverLabTransmissionResult {
  readonly outcome: "redispatched" | "marked_transmitted" | "still_refused";
  readonly refusalReason: string | null;
  readonly order: OrderDetailView;
}

/** The resolver the §4.7 ABAC predicates read order facts through (the slice implements it in-memory). */
export interface OrderAbacResolver {
  loadOrder(organizationId: string, orderId: string): Promise<OrderAbacFacts | null>;
}

/** The §4.1 route service contract (the routes compose over it; in-mem slice + prod Drizzle both implement). */
export interface OrderRouteService extends OrderAbacResolver {
  listOrders(
    organizationId: string,
    filter: {
      patientId?: string;
      admissionId?: string;
      kind?: string;
      status?: string;
    },
  ): Promise<{ orders: OrderView[] }>;
  getOrder(organizationId: string, id: string, actor?: OrderDetailActor): Promise<OrderDetailView>;
  createDraft(
    organizationId: string,
    userId: string,
    args: CreateOrderArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  createVerbalOrder(
    organizationId: string,
    userId: string,
    args: CreateVerbalOrderArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  editDraft(
    organizationId: string,
    id: string,
    data: unknown,
    priority?: OrderPriority,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  requestSignature(
    organizationId: string,
    id: string,
    args: RequestSignatureArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  signOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: SignArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  signOnBehalf(
    organizationId: string,
    userId: string,
    id: string,
    args: SignOnBehalfArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  recordVerbal(
    organizationId: string,
    userId: string,
    id: string,
    args: RecordVerbalArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  cosignOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: CosignArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  discontinueOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: DiscontinueArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  correctOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: CreateOrderArgs,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  completeOrder(
    organizationId: string,
    userId: string,
    id: string,
    reason?: string,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  /**
   * F-182 (#248) — re-run the outbound lab-ORM producer for a signed lab order whose ORM request was REFUSED
   * (`transmission_failure_reason = 'orm_refused:*'`). `auditUserId` is the Better Auth user id the M4 write-audit
   * trigger stamps as `actor_user_id` (a membership id would violate that FK); omit for a system caller.
   */
  resendLabTransmission(
    organizationId: string,
    membershipId: string,
    id: string,
    actor?: OrderDetailActor,
    auditUserId?: string,
  ): Promise<ResendLabTransmissionResult>;
  /**
   * F-184 (#248) — the operator's ATTESTED recovery of a lab order that failed AFTER a message was built
   * (`dlq_exhausted` incl. F-183's "held, delivery unverified", or `application_reject`). `attestation` is what the
   * operator established WITH THE LAB: `not_received_by_lab` re-dispatches once, `received_by_lab` marks the order
   * transmitted without sending. Recorded in the order's write-audit diff under `auditUserId`.
   */
  recoverLabTransmission(
    organizationId: string,
    membershipId: string,
    id: string,
    attestation: RecoveryAttestation,
    actor?: OrderDetailActor,
    auditUserId?: string,
  ): Promise<RecoverLabTransmissionResult>;
  pendingSignature(organizationId: string): Promise<{ orders: OrderView[] }>;
  verbalExpiring(organizationId: string): Promise<{ orders: OrderView[] }>;
  cosignPending(organizationId: string): Promise<{ orders: OrderView[] }>;
  resultsPendingReview(organizationId: string): Promise<{ orders: OrderView[] }>;
  suggestions(
    organizationId: string,
    patientId: string,
  ): Promise<{
    patientId: string;
    suggestions: ReadonlyArray<{ kind: OrderKind; reason: string }>;
  }>;
  listStandingOrders(
    organizationId: string,
    patientId?: string,
  ): Promise<{ standingOrders: StandingOrderView[] }>;
  getStandingOrder(organizationId: string, id: string): Promise<StandingOrderView>;
  createStandingOrder(
    organizationId: string,
    userId: string,
    args: CreateStandingArgs,
  ): Promise<StandingOrderView>;
  editStandingOrder(
    organizationId: string,
    id: string,
    patch: { data?: unknown; effectiveUntil?: string; maxSpawns?: number },
  ): Promise<StandingOrderView>;
  pauseStandingOrder(organizationId: string, id: string): Promise<StandingOrderView>;
  resumeStandingOrder(organizationId: string, id: string): Promise<StandingOrderView>;
  discontinueStandingOrder(
    organizationId: string,
    id: string,
    alsoDiscontinueInstances: boolean,
  ): Promise<StandingOrderView>;
  spawnStandingOrder(
    organizationId: string,
    userId: string,
    id: string,
    trigger?: "clinician_request" | "system",
    scheduledFor?: string,
  ): Promise<{ orderId: string }>;
  spawnDueStandingOrders(
    organizationId: string,
    now?: string,
  ): Promise<{ spawnedOrderIds: string[] }>;
  /**
   * §2.3 D3 / §4.8 `orders.verbal_timer` — scan the polymorphic `verbal_order` table for every `pending`
   * receipt whose `deadline_at` has passed and flip each to `expired_unsigned`, emitting
   * `m11.order.verbal_expired_unsigned` (§2.8 D14: `targetKind='order'` for M11's own `order_record`,
   * `targetKind='medication_order'` for an M12 row — M11 owns the ONE timer for both, per the module's own
   * "why M12 has no parallel timer" design). One bad/raced row must not stop the rest of the sweep.
   */
  expireOverdueVerbals(
    organizationId: string,
    at?: string,
  ): Promise<{ expiredVerbalOrderIds: string[] }>;
  getVerbalPolicy(organizationId: string): Promise<VerbalPolicyView>;
  putVerbalPolicy(organizationId: string, args: VerbalPolicyArgs): Promise<VerbalPolicyView>;
  regenerateVerbalTimer(
    organizationId: string,
    id: string,
    actor?: OrderDetailActor,
  ): Promise<OrderDetailView>;
  /** Drain (and clear) the §4.4 outbox events recorded since the last call (test/relay seam). */
  drainEvents(): RecordedOrderEvent[];
}

// ── in-memory records (the slice mutates these; the view DTOs are the read-only projections) ────────────
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface OrderRecord extends Mutable<Omit<OrderDetailView, "requirements" | "allowedActions">> {
  organizationId: string;
  cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director" | null;
}
interface StandingRecord extends Mutable<StandingOrderView> {
  organizationId: string;
  signerDiscipline: string;
  orderingPhysicianMdmId: string;
  data: unknown;
  kindVersion: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
}

export interface OrderRouteSeed {
  readonly orders?: ReadonlyArray<
    Partial<OrderRecord> & {
      id: string;
      organizationId: string;
      patientId: string;
      admissionId: string;
      kind: OrderKind;
    }
  >;
  readonly standingOrders?: ReadonlyArray<
    Partial<StandingRecord> & {
      id: string;
      organizationId: string;
      patientId: string;
      admissionId: string;
      kind: OrderKind;
      cadence: StandingOrderCadence;
    }
  >;
  readonly now?: () => string;
  readonly timeZone?: string;
  /** Injected M40 master-data validator (absent ⇒ physician/vendor binding skipped). */
  readonly mdm?: OrderMdmValidator;
  /** Injected M38 terminology validator (absent ⇒ code binding skipped). */
  readonly terminology?: OrderTerminologyValidator;
}

let idCounter = 0x110a0000;
function nextId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

/** The §4.2 lab/HCPCS/CPT code lifted from a per-kind order payload (best-effort; binding is skipped if absent). */
function codeOf(
  kind: OrderKind,
  data: unknown,
): { system: "LOINC" | "HCPCS" | "CPT"; code: string } | null {
  if (data == null || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (kind === "lab" && typeof d.loinc === "string") return { system: "LOINC", code: d.loinc };
  if (
    (kind === "dme" || kind === "supply" || kind === "comfort_kit") &&
    typeof d.hcpcs === "string"
  )
    return { system: "HCPCS", code: d.hcpcs };
  if (kind === "ancillary_service" && typeof d.cpt === "string")
    return { system: "CPT", code: d.cpt };
  return null;
}

/** Construct the in-memory M11 route backend (the slice). Returns the service (also the ABAC resolver). */
export function createInMemoryOrderBackend(seed: OrderRouteSeed = {}): OrderRouteService {
  const now = seed.now ?? (() => new Date().toISOString());
  const tz = seed.timeZone ?? "UTC";
  const orders = new Map<string, OrderRecord>();
  const standings = new Map<string, StandingRecord>();
  const events: RecordedOrderEvent[] = [];
  const mdm = seed.mdm;
  const terminology = seed.terminology;
  let policy: VerbalPolicyView = {
    windowHours: 48,
    businessHoursOnly: false,
    lpnCosignRequiredKinds: DEFAULT_COSIGN_POLICY.lpnCosignRequiredKinds,
    npCosignRequiredKinds: DEFAULT_COSIGN_POLICY.npCosignRequiredKinds,
    platformFloorWindowHours: 48,
    policyVersion: "v1",
  };

  for (const s of seed.orders ?? [])
    orders.set(s.id, {
      status: "draft",
      priority: "routine",
      version: 1,
      drafterMembershipId: "system",
      drafterDiscipline: "rn_case_manager",
      orderingPhysicianMdmId: "00000000-0000-4000-8000-0000000000ff",
      cosignRequired: false,
      cosignStatus: null,
      cosignerRoleNeeded: null,
      transmissionStatus: "not_applicable",
      resultsStatus: "not_applicable",
      verbalDeadlineAt: null,
      verbalOrder: null,
      discontinuationReason: null,
      replacesOrderId: null,
      triggeringAssessmentId: null,
      triggeringHopeAssessmentId: null,
      signedAt: null,
      signedBy: null,
      completedAt: null,
      createdAt: now(),
      kindVersion: `${s.kind}.v1`,
      data: {},
      ...s,
    } as OrderRecord);
  for (const s of seed.standingOrders ?? [])
    standings.set(s.id, {
      status: "active",
      nextSpawnAt: null,
      spawnCount: 0,
      maxSpawns: null,
      signerDiscipline: "rn_case_manager",
      orderingPhysicianMdmId: "00000000-0000-4000-8000-0000000000ff",
      data: {},
      kindVersion: ORDER_KIND_VERSION[s.kind],
      effectiveFrom: now(),
      effectiveUntil: null,
      ...s,
    } as StandingRecord);

  const emit = (
    eventName: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): void => {
    events.push({ eventName, payload, idempotencyKey });
  };
  const view = (r: OrderRecord): OrderView => {
    const { organizationId: _o, data: _d, kindVersion: _k, cosignerRoleNeeded: _c, ...v } = r;
    return v;
  };
  const detailView = (r: OrderRecord, actor: OrderDetailActor): OrderDetailView => ({
    ...view(r),
    kindVersion: r.kindVersion,
    data: r.data,
    // `view()`'s declared return type (`OrderView`) omits `verbalOrder` (it's detail-only, per
    // `OrderDetailView`'s own doc comment) even though the destructure leaves it on the runtime
    // object — forwarded explicitly here, mirroring `orders-route-service-db.ts`'s
    // `toOrderDetailView` doing the identical re-add.
    verbalOrder: r.verbalOrder,
    ...buildOrderWorkflowProjection(r, actor, r.cosignerRoleNeeded),
  });
  const viewSt = (r: StandingRecord): StandingOrderView => {
    const { organizationId: _o, signerDiscipline: _s, data: _d, ...v } = r;
    return v;
  };
  const find = (organizationId: string, id: string): OrderRecord => {
    const r = orders.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError(`order ${id} not found`);
    return r;
  };
  const findSt = (organizationId: string, id: string): StandingRecord => {
    const r = standings.get(id);
    if (!r || r.organizationId !== organizationId)
      throw new NotFoundError(`standing order ${id} not found`);
    return r;
  };

  const cosignPolicy = (): OrderCosignPolicy => ({
    lpnCosignRequiredKinds: policy.lpnCosignRequiredKinds,
    npCosignRequiredKinds: policy.npCosignRequiredKinds,
  });

  /** §4.1 bind — validate the ordering physician (M40) + the lab/HCPCS/CPT code (M38) when bound (skip if absent). */
  async function bindCrossModuleRefs(organizationId: string, args: CreateOrderArgs): Promise<void> {
    if (mdm) {
      const phys = await mdm.resolvePhysician({
        organizationId,
        mdmId: args.orderingPhysicianMdmId,
      });
      if (phys && !phys.active)
        throw new NotFoundError(
          `ordering physician ${args.orderingPhysicianMdmId} is not an active master-data record`,
        );
    }
    if (terminology) {
      const c = codeOf(args.kind, args.data);
      if (c) {
        const ok = await terminology.isValidCode({ ...c, asOf: now() });
        if (!ok)
          throw new NotFoundError(`${c.system} code '${c.code}' is not valid as-of ${now()}`);
      }
    }
  }

  return {
    async listOrders(organizationId, filter) {
      const all = [...orders.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          (!filter.patientId || r.patientId === filter.patientId) &&
          (!filter.admissionId || r.admissionId === filter.admissionId) &&
          (!filter.kind || r.kind === filter.kind) &&
          (!filter.status || r.status === filter.status),
      );
      return { orders: all.map(view) };
    },
    async getOrder(organizationId, id, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      return detailView(r, actor);
    },

    async createDraft(organizationId, userId, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      // §2.1 / §4.7 author floor (defense-in-depth on top of the route's `discipline_can_order` ABAC).
      if (!disciplineCanOrder(args.drafterDiscipline, args.kind))
        throw new NotFoundError(
          `discipline '${args.drafterDiscipline}' may not author a '${args.kind}' order`,
        );
      await bindCrossModuleRefs(organizationId, args);
      // Drafts may retain partial clinical details; signature request is the completion gate.
      const id = nextId();
      const rec: OrderRecord = {
        id,
        organizationId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        kind: args.kind,
        status: "draft",
        priority: args.priority ?? "routine",
        version: 1,
        drafterMembershipId: userId,
        drafterDiscipline: args.drafterDiscipline,
        orderingPhysicianMdmId: args.orderingPhysicianMdmId,
        cosignRequired: false,
        cosignStatus: null,
        cosignerRoleNeeded: null,
        transmissionStatus: args.kind === "lab" ? "pending" : "not_applicable",
        resultsStatus: args.kind === "lab" ? "awaiting_results" : "not_applicable",
        verbalDeadlineAt: null,
        discontinuationReason: null,
        replacesOrderId: args.replacesOrderId ?? null,
        triggeringAssessmentId: args.triggeringAssessmentId ?? null,
        triggeringHopeAssessmentId: args.triggeringHopeAssessmentId ?? null,
        signedAt: null,
        signedBy: null,
        completedAt: null,
        createdAt: now(),
        kindVersion: `${args.kind}.v1`,
        data: args.data,
        verbalOrder: null,
      };
      orders.set(id, rec);
      emit(
        "m11.order.draft_created",
        {
          orderId: id,
          patientId: args.patientId,
          admissionId: args.admissionId,
          kind: args.kind,
          drafterMembershipId: userId,
        },
        `${id}:draft_created`,
      );
      return detailView(rec, actor);
    },

    async createVerbalOrder(organizationId, userId, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      if (!disciplineCanOrder(args.order.drafterDiscipline, args.order.kind))
        throw new NotFoundError(
          `discipline '${args.order.drafterDiscipline}' may not author a '${args.order.kind}' order`,
        );
      await bindCrossModuleRefs(organizationId, args.order);
      const findings = validateOrderData(args.order.kind, `${args.order.kind}.v1`, args.order.data);
      if (findings.length)
        throw new ValidationError(
          "Order is not ready for signature",
          findings.map((finding) => ({
            field: `data.${finding.field}`,
            code: "INVALID",
            message: finding.message,
          })),
        );
      if (!args.verbal.readBackVerified)
        throw Object.assign(new Error("Verbal order must be read back and verified"), {
          code: "VERBAL_READ_BACK_REQUIRED",
          statusCode: 422,
        });
      const id = nextId();
      const requirement = resolveCosignRequirement({
        kind: args.order.kind,
        drafterDiscipline: args.order.drafterDiscipline,
        signerDiscipline: args.order.drafterDiscipline,
        policy: cosignPolicy(),
      });
      transitionOrder("draft", {
        type: "requestSignature",
        requiredFieldsComplete: true,
        cosignRequired: requirement != null,
        cosignerRoleNeeded: requirement?.cosignerRoleNeeded,
      });
      transitionOrder("pending_signature", {
        type: "recordVerbal",
        kind: args.order.kind,
        attestationRecorded: args.verbal.verbalAttestation.length >= 100,
        recorderEligible: true,
      });
      const deadlineAt = computeVerbalDeadline(args.verbal.receivedAt, {
        windowHours: policy.windowHours,
        businessHoursOnly: policy.businessHoursOnly,
        timeZone: tz,
        policyVersion: policy.policyVersion,
      });
      const rec: OrderRecord = {
        id,
        organizationId,
        patientId: args.order.patientId,
        admissionId: args.order.admissionId,
        kind: args.order.kind,
        kindVersion: `${args.order.kind}.v1`,
        data: args.order.data,
        status: "verbal_pending",
        priority: args.order.priority ?? "routine",
        version: 2,
        drafterMembershipId: userId,
        drafterDiscipline: args.order.drafterDiscipline,
        orderingPhysicianMdmId: args.verbal.orderingPhysicianMdmId,
        cosignRequired: requirement != null,
        cosignStatus: requirement != null ? "pending" : "attached",
        cosignerRoleNeeded: requirement?.cosignerRoleNeeded ?? null,
        transmissionStatus: args.order.kind === "lab" ? "pending" : "not_applicable",
        resultsStatus: args.order.kind === "lab" ? "awaiting_results" : "not_applicable",
        verbalDeadlineAt: deadlineAt,
        discontinuationReason: null,
        replacesOrderId: null,
        triggeringAssessmentId: args.order.triggeringAssessmentId ?? null,
        triggeringHopeAssessmentId: args.order.triggeringHopeAssessmentId ?? null,
        signedAt: null,
        signedBy: null,
        completedAt: null,
        createdAt: now(),
        // Mirrors `orders-route-service-db.ts`'s `verbal_orders` insert shape exactly (organizationId,
        // status "pending", readBackVerified already gated true above, signedAt null until the sign
        // path completes it — see `signInternal` below).
        verbalOrder: {
          status: "pending",
          receivedAt: args.verbal.receivedAt,
          effectiveAt: args.verbal.effectiveAt,
          deadlineAt,
          signedAt: null,
          readBackVerified: args.verbal.readBackVerified,
          attestation: args.verbal.verbalAttestation,
        },
      };
      orders.set(id, rec);
      emit(
        "m11.order.draft_created",
        {
          orderId: id,
          patientId: rec.patientId,
          admissionId: rec.admissionId,
          kind: rec.kind,
          drafterMembershipId: userId,
        },
        `${id}:draft_created`,
      );
      emit(
        "m11.order.signature_requested",
        { orderId: id, cosignRequired: rec.cosignRequired },
        `${id}:signature_requested`,
      );
      if (requirement)
        emit(
          "m11.order.cosign_requested",
          { orderId: id, cosignerRoleNeeded: requirement.cosignerRoleNeeded },
          `${id}:cosign_requested`,
        );
      emit("m11.order.verbal_received", { orderId: id, deadlineAt }, `${id}:verbal_received`);
      return detailView(rec, actor);
    },

    async editDraft(organizationId, id, data, priority, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      if (r.status !== "draft")
        throw new NotFoundError(`order ${id} is not a draft and cannot be edited`);
      r.data = data;
      if (priority) r.priority = priority;
      r.version += 1;
      return detailView(r, actor);
    },

    async requestSignature(organizationId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      const findings = validateOrderData(r.kind, r.kindVersion, r.data);
      if (findings.length)
        throw new ValidationError(
          "Order is not ready for signature",
          findings.map((finding) => ({
            field: `data.${finding.field}`,
            code: "INVALID",
            message: finding.message,
          })),
        );
      const requirement = resolveCosignRequirement({
        kind: r.kind,
        drafterDiscipline: r.drafterDiscipline,
        signerDiscipline: args.signerDiscipline,
        levelChange: args.levelChange,
        policy: cosignPolicy(),
      });
      const t = transitionOrder(r.status, {
        type: "requestSignature",
        requiredFieldsComplete: true,
        cosignRequired: requirement != null,
        cosignerRoleNeeded: requirement?.cosignerRoleNeeded,
      });
      r.status = t.to;
      r.cosignRequired = requirement != null;
      r.cosignStatus = requirement != null ? "pending" : "attached";
      r.cosignerRoleNeeded = requirement?.cosignerRoleNeeded ?? null;
      emit(
        "m11.order.signature_requested",
        { orderId: id, cosignRequired: r.cosignRequired },
        `${id}:signature_requested`,
      );
      if (requirement)
        emit(
          "m11.order.cosign_requested",
          { orderId: id, cosignerRoleNeeded: requirement.cosignerRoleNeeded },
          `${id}:cosign_requested`,
        );
      return detailView(r, actor);
    },

    async signOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      return signInternal(
        organizationId,
        userId,
        id,
        args.signerDiscipline,
        args.signedAtClient,
        false,
        actor,
      );
    },
    async signOnBehalf(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const v = await signInternal(
        organizationId,
        userId,
        id,
        args.signerDiscipline,
        args.signedAtClient,
        true,
        actor,
      );
      emit(
        "m11.order.signed_on_behalf",
        { orderId: id, onBehalfOf: args.onBehalfOf, reason: args.reason },
        `${id}:signed_on_behalf`,
      );
      return v;
    },

    async recordVerbal(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      // Mirrors `orders-route-service-db.ts`'s `recordVerbal` guard exactly.
      if (!args.readBackVerified)
        throw Object.assign(new Error("Verbal order must be read back and verified"), {
          code: "VERBAL_READ_BACK_REQUIRED",
          statusCode: 422,
        });
      const t = transitionOrder(r.status, {
        type: "recordVerbal",
        kind: r.kind,
        attestationRecorded: args.verbalAttestation.length >= 100,
        recorderEligible: true,
      });
      r.status = t.to;
      r.verbalDeadlineAt = computeVerbalDeadline(args.receivedAt, {
        windowHours: policy.windowHours,
        businessHoursOnly: policy.businessHoursOnly,
        timeZone: tz,
        policyVersion: policy.policyVersion,
      });
      r.orderingPhysicianMdmId = args.orderingPhysicianMdmId;
      // The detail-only verbal-order evidence (`OrderDetailView.verbalOrder`) — mirrors the real
      // `verbal_orders` row shape `orders-route-service-db.ts` inserts.
      r.verbalOrder = {
        status: "pending",
        receivedAt: args.receivedAt,
        effectiveAt: args.effectiveAt,
        deadlineAt: r.verbalDeadlineAt,
        signedAt: null,
        readBackVerified: args.readBackVerified,
        attestation: args.verbalAttestation,
      };
      emit(
        "m11.order.verbal_received",
        { orderId: id, deadlineAt: r.verbalDeadlineAt },
        `${id}:verbal_received`,
      );
      return detailView(r, actor);
    },

    async cosignOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      planCosignAttest({
        orderId: id,
        cosignRequired: r.cosignRequired,
        alreadyCosigned: r.cosignStatus === "attached",
        cosignerRole: args.cosignerRole,
        cosignerRoleNeeded: r.cosignerRoleNeeded ?? "rn_case_manager",
        cosignerIsAuthor: r.drafterMembershipId === userId,
      });
      r.cosignStatus = "attached";
      emit(
        "m11.order.cosigned",
        { orderId: id, cosignerRole: args.cosignerRole },
        `${id}:cosigned`,
      );
      return detailView(r, actor);
    },

    async discontinueOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      const t = transitionOrder(r.status, {
        type: "discontinue",
        kind: r.kind,
        reason: args.reason,
        fulfillmentInFlight: false,
      });
      r.status = t.to;
      r.discontinuationReason = args.reason;
      r.version += 1;
      emit(
        "m11.order.discontinued",
        {
          orderId: id,
          reason: args.reason,
          effectiveAt: args.effectiveAt,
          actorMembershipId: userId,
        },
        `${id}:discontinued`,
      );
      return detailView(r, actor);
    },

    async correctOrder(organizationId, userId, id, args, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const original = find(organizationId, id);
      // Match the production supersede trigger: only a correctable active order may be replaced, and
      // the historical original is discontinued rather than edited or deleted.
      transitionOrder(original.status, {
        type: "discontinue",
        kind: original.kind,
        reason: "replaced_by_corrected_order",
        fulfillmentInFlight: false,
      });
      const findings = validateOrderData(args.kind, ORDER_KIND_VERSION[args.kind], args.data);
      if (findings.length)
        throw new ValidationError(
          "Corrected order clinical details are invalid",
          findings.map((finding) => ({
            field: `data.${finding.field}`,
            code: "INVALID",
            message: finding.message,
          })),
        );
      const correction = await this.createDraft(
        organizationId,
        userId,
        {
          ...args,
          replacesOrderId: id,
        },
        actor,
      );
      original.status = "discontinued";
      original.discontinuationReason = "replaced_by_corrected_order";
      original.version += 1;
      emit(
        "m11.order.corrected",
        { newOrderId: correction.id, replacesOrderId: id },
        `${correction.id}:corrected`,
      );
      return correction;
    },

    async resendLabTransmission(organizationId, _membershipId, id) {
      // The in-mem slice has no outbound-ORM producer, so no order here can carry an `orm_refused:*` failure:
      // it applies the SAME eligibility rule as the DB backend and therefore always refuses.
      const r = find(organizationId, id);
      const verdict = classifyOrmResend({
        kind: r.kind,
        status: r.status,
        transmissionStatus: r.transmissionStatus,
        transmissionFailureReason: null,
      });
      throw new ConflictError(
        `ORM resend not allowed (${verdict.ok ? "no_orm_producer" : verdict.code}): ${
          verdict.ok ? "the in-memory service has no outbound ORM producer" : verdict.message
        }`,
      );
    },

    async recoverLabTransmission(organizationId, _membershipId, id, attestation) {
      // Like the resend: the in-mem slice never has an M29 terminal failure to recover, so it applies the SAME
      // eligibility rule as the DB backend and always refuses.
      const r = find(organizationId, id);
      const verdict = classifyTransmissionRecovery(
        {
          kind: r.kind,
          status: r.status,
          transmissionStatus: r.transmissionStatus,
          transmissionFailureReason: null,
        },
        attestation,
      );
      throw new ConflictError(
        `Transmission recovery not allowed (${verdict.ok ? "no_outbound_transport" : verdict.code}): ${
          verdict.ok ? "the in-memory service has no outbound transport" : verdict.message
        }`,
      );
    },

    async completeOrder(organizationId, userId, id, _reason, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      const t = transitionOrder(r.status, {
        type: "complete",
        criterionMet: true,
      });
      r.status = t.to;
      r.completedAt = now();
      emit("m11.order.completed", { orderId: id, completedBy: userId }, `${id}:completed`);
      return detailView(r, actor);
    },

    async pendingSignature(organizationId) {
      return {
        orders: [...orders.values()]
          .filter((r) => r.organizationId === organizationId && r.status === "pending_signature")
          .map(view),
      };
    },
    async verbalExpiring(organizationId) {
      return {
        orders: [...orders.values()]
          .filter((r) => r.organizationId === organizationId && r.status === "verbal_pending")
          .map(view),
      };
    },
    async cosignPending(organizationId) {
      return {
        orders: [...orders.values()]
          .filter((r) => r.organizationId === organizationId && r.cosignStatus === "pending")
          .map(view),
      };
    },
    async resultsPendingReview(organizationId) {
      return {
        orders: [...orders.values()]
          .filter(
            (r) =>
              r.organizationId === organizationId &&
              r.kind === "lab" &&
              r.resultsStatus === "results_received",
          )
          .map(view),
      };
    },
    async suggestions(_organizationId, patientId) {
      return { patientId, suggestions: [] };
    },

    async listStandingOrders(organizationId, patientId) {
      const all = [...standings.values()].filter(
        (r) => r.organizationId === organizationId && (!patientId || r.patientId === patientId),
      );
      return { standingOrders: all.map(viewSt) };
    },
    async getStandingOrder(organizationId, id) {
      return viewSt(findSt(organizationId, id));
    },
    async createStandingOrder(organizationId, userId, args) {
      planStandingCreation({
        kind: args.kind,
        signerDiscipline: args.signerDiscipline,
      }); // §2.4 D5 eligibility guards.
      const id = nextId();
      const effectiveFrom = args.effectiveFrom ?? now();
      const rec: StandingRecord = {
        id,
        organizationId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        kind: args.kind,
        cadence: args.cadence,
        status: "active",
        // The hourly worker queries this durable cursor; PRN templates deliberately have none.
        nextSpawnAt: computeNextSpawnAt(args.cadence, {}, effectiveFrom, tz),
        spawnCount: 0,
        maxSpawns: args.maxSpawns ?? null,
        signerDiscipline: args.signerDiscipline,
        orderingPhysicianMdmId: args.orderingPhysicianMdmId,
        data: args.data,
        kindVersion: ORDER_KIND_VERSION[args.kind],
        effectiveFrom,
        effectiveUntil: args.effectiveUntil ?? null,
      };
      standings.set(id, rec);
      emit(
        "m11.order.standing_created",
        { standingOrderId: id, kind: args.kind, createdBy: userId },
        `${id}:standing_created`,
      );
      return viewSt(rec);
    },
    async editStandingOrder(organizationId, id, patch) {
      const r = findSt(organizationId, id);
      if (patch.data !== undefined) r.data = patch.data;
      if (patch.effectiveUntil !== undefined) r.effectiveUntil = patch.effectiveUntil;
      if (patch.maxSpawns != null) r.maxSpawns = patch.maxSpawns;
      return viewSt(r);
    },
    async pauseStandingOrder(organizationId, id) {
      const r = findSt(organizationId, id);
      r.status = "paused";
      return viewSt(r);
    },
    async resumeStandingOrder(organizationId, id) {
      const r = findSt(organizationId, id);
      r.status = "active";
      return viewSt(r);
    },
    async discontinueStandingOrder(organizationId, id, alsoDiscontinueInstances) {
      const r = findSt(organizationId, id);
      planStandingDiscontinuation(alsoDiscontinueInstances);
      r.status = "discontinued";
      emit(
        "m11.order.standing_discontinued",
        { standingOrderId: id, alsoDiscontinueInstances },
        `${id}:standing_discontinued`,
      );
      return viewSt(r);
    },
    async spawnStandingOrder(organizationId, userId, id, requestedTrigger, scheduledFor) {
      const trigger = requestedTrigger ?? "clinician_request";
      const r = findSt(organizationId, id);
      if (r.status !== "active")
        throw new NotFoundError(
          `standing order ${id} is ${r.status}; only an active template may spawn`,
        );
      assertSpawnAllowed(
        {
          status: r.status,
          isSigned: true,
          effectiveFrom: r.effectiveFrom,
          effectiveUntil: r.effectiveUntil,
          maxSpawns: r.maxSpawns,
          spawnCount: r.spawnCount,
        },
        now(),
      );
      const plan = planStandingSpawn({
        kind: r.kind,
        cadence: r.cadence,
        cadenceDetail: {},
        spawnedBy: trigger,
        now: now(),
        timeZone: tz,
      });
      const findings = validateOrderData(r.kind, r.kindVersion, r.data);
      if (findings.length)
        throw new ValidationError(
          "Standing-order template clinical details are invalid",
          findings.map((finding) => ({
            field: `data.${finding.field}`,
            code: "INVALID",
            message: finding.message,
          })),
        );
      const orderId = nextId();
      orders.set(orderId, {
        id: orderId,
        organizationId,
        patientId: r.patientId,
        admissionId: r.admissionId,
        kind: r.kind,
        status: plan.spawnedOrderStatus,
        priority: "routine",
        version: 1,
        drafterMembershipId: userId,
        drafterDiscipline: r.signerDiscipline,
        orderingPhysicianMdmId: r.orderingPhysicianMdmId,
        cosignRequired: false,
        cosignStatus: "attached",
        cosignerRoleNeeded: null,
        transmissionStatus: r.kind === "lab" ? "pending" : "not_applicable",
        resultsStatus: r.kind === "lab" ? "awaiting_results" : "not_applicable",
        verbalDeadlineAt: null,
        discontinuationReason: null,
        replacesOrderId: null,
        triggeringAssessmentId: null,
        triggeringHopeAssessmentId: null,
        signedAt: now(),
        signedBy: userId,
        completedAt: null,
        createdAt: now(),
        kindVersion: r.kindVersion,
        data: r.data,
        verbalOrder: null,
      });
      r.spawnCount += 1;
      emit(
        "m11.order.standing_spawned",
        {
          standingOrderId: id,
          orderId,
          spawnedBy: trigger,
          ...(scheduledFor ? { scheduledFor } : {}),
        },
        `${orderId}:standing_spawned`,
      );
      emit("m11.order.signed", { orderId, kind: r.kind }, `${orderId}:signed`);
      return { orderId };
    },
    async spawnDueStandingOrders(organizationId, at = now()) {
      const spawnedOrderIds: string[] = [];
      for (const r of standings.values()) {
        if (r.organizationId !== organizationId || !r.nextSpawnAt || r.nextSpawnAt > at) continue;
        try {
          spawnedOrderIds.push(
            (await this.spawnStandingOrder(organizationId, "system", r.id, "system", r.nextSpawnAt))
              .orderId,
          );
        } catch {
          /* one legacy/invalid template must not poison the org sweep */
        }
      }
      return { spawnedOrderIds };
    },

    async expireOverdueVerbals(organizationId, at = now()) {
      const expiredVerbalOrderIds: string[] = [];
      for (const [id, r] of orders) {
        if (r.organizationId !== organizationId) continue;
        if (r.status !== "verbal_pending" || !r.verbalDeadlineAt) continue;
        if (r.verbalDeadlineAt > at) continue;
        // Validates NOT_SYSTEM_ACTOR / VERBAL_DEADLINE_NOT_REACHED / ILLEGAL_ORDER_TRANSITION.
        const t = transitionOrder(r.status, {
          type: "expire",
          isSystemActor: true,
          deadlineReached: true,
        });
        r.status = t.to;
        r.discontinuationReason = "expired_verbal";
        if (r.verbalOrder) r.verbalOrder = { ...r.verbalOrder, status: "expired_unsigned" };
        // The slice models only M11's own `order_record` target (`targetKind='order'`) — it has no
        // polymorphic `verbal_order` table of its own to represent an M12 `medication_order` receipt.
        emit(
          "m11.order.verbal_expired_unsigned",
          {
            orderId: id,
            verbalOrderId: id,
            targetKind: "order",
            expiredAt: at,
            hoursOverdue: hoursOverdue(at, r.verbalDeadlineAt),
            orderingPhysicianMdmId: r.orderingPhysicianMdmId,
          },
          `${id}:verbal_expired_unsigned`,
        );
        expiredVerbalOrderIds.push(id);
      }
      return { expiredVerbalOrderIds };
    },

    async getVerbalPolicy(_organizationId) {
      return policy;
    },
    async putVerbalPolicy(_organizationId, args) {
      validateVerbalWindowHours(args.windowHours); // §2.3 D3 tighten-only floor guard (≤ 48h, ≥ 1h).
      policy = {
        windowHours: args.windowHours,
        businessHoursOnly: args.businessHoursOnly ?? policy.businessHoursOnly,
        lpnCosignRequiredKinds: args.lpnCosignRequiredKinds ?? policy.lpnCosignRequiredKinds,
        npCosignRequiredKinds: args.npCosignRequiredKinds ?? policy.npCosignRequiredKinds,
        platformFloorWindowHours: 48,
        policyVersion: policy.policyVersion,
      };
      return policy;
    },
    async regenerateVerbalTimer(organizationId, id, actor = EMPTY_ORDER_DETAIL_ACTOR) {
      const r = find(organizationId, id);
      if (r.status !== "verbal_pending")
        throw new NotFoundError(`order ${id} is not verbal_pending`);
      if (!r.verbalOrder) throw new NotFoundError(`order ${id} has no verbal-order receipt`);
      r.verbalDeadlineAt = computeVerbalDeadline(now(), {
        windowHours: policy.windowHours,
        businessHoursOnly: policy.businessHoursOnly,
        timeZone: tz,
        policyVersion: policy.policyVersion,
      });
      r.verbalOrder = { ...r.verbalOrder, deadlineAt: r.verbalDeadlineAt };
      emit(
        "m11.order.verbal_received",
        { orderId: id, deadlineAt: r.verbalDeadlineAt, regenerated: true },
        `${id}:regenerated:${now()}`,
      );
      return detailView(r, actor);
    },

    // ── §4.7 ABAC resolver ────────────────────────────────────────────────────────────────────────────
    async loadOrder(organizationId, orderId): Promise<OrderAbacFacts | null> {
      const r = orders.get(orderId);
      if (!r || r.organizationId !== organizationId) return null;
      return {
        kind: r.kind,
        drafterMembershipId: r.drafterMembershipId,
        cosignerRoleNeeded: r.cosignerRoleNeeded,
        cosignRequired: r.cosignRequired,
        alreadyCosigned: r.cosignStatus === "attached",
      };
    },

    drainEvents() {
      const drained = [...events];
      events.length = 0;
      return drained;
    },
  };

  // ── shared sign path (§2.2 sign from pending_signature or verbal_pending) ──────────────────────────────
  function signInternal(
    organizationId: string,
    userId: string,
    id: string,
    signerDiscipline: string,
    _signedAtClient: string,
    onBehalf: boolean,
    actor: OrderDetailActor,
  ): Promise<OrderDetailView> {
    const r = find(organizationId, id);
    if (!signerEligible(signerDiscipline, r.kind)) {
      // surfaced as the §4.7 ABAC floor at the route; defense-in-depth here.
      throw new NotFoundError(
        `discipline '${signerDiscipline}' is not eligible to sign a '${r.kind}' order`,
      );
    }
    const t = transitionOrder(r.status, {
      type: "sign",
      kind: r.kind,
      cosignAttached: r.cosignStatus !== "pending",
      onBehalf,
    });
    r.status = t.to;
    r.signedAt = now();
    r.signedBy = userId;
    r.version += 1;
    // Mirrors `orders-route-service-db.ts`'s verbal-order sign path: a verbal order carries forward
    // its own status/signedAt independent of the order's own transition.
    if (r.verbalOrder) {
      r.verbalOrder = { ...r.verbalOrder, status: "signed_in_time", signedAt: r.signedAt };
      emit(
        "m11.order.verbal_signed_in_time",
        { orderId: id, signedAt: r.signedAt },
        `${id}:verbal_signed_in_time`,
      );
    }
    emit(
      "m11.order.signed",
      { orderId: id, kind: r.kind, signedBy: userId, onBehalf },
      `${id}:signed`,
    );
    // GAP-023 — the §4.4 M22 render handshake, mirroring the Drizzle write path's emission so the slice
    // and production agree on the event stream a sign produces.
    emit(
      "m11.order.document_requested",
      {
        orderId: id,
        formTemplate: "order_record",
        renderPayload: {
          patientId: r.patientId,
          kind: r.kind,
          signedAt: r.signedAt,
        },
      },
      `${id}:document_requested`,
    );
    return Promise.resolve(detailView(r, actor));
  }
}
