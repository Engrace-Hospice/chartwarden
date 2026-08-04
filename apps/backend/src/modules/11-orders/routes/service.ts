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
  type OrderCosignPolicy,
  computeVerbalDeadline,
  disciplineCanOrder,
  planCosignAttest,
  planStandingCreation,
  planStandingDiscontinuation,
  planStandingSpawn,
  resolveCosignRequirement,
  signerEligible,
  transitionOrder,
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
import { NotFoundError } from "@wardenx/types";

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
  readonly receivedAt: string;
  readonly orderingPhysicianMdmId: string;
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

/** The resolver the §4.7 ABAC predicates read order facts through (the slice implements it in-memory). */
export interface OrderAbacResolver {
  loadOrder(organizationId: string, orderId: string): Promise<OrderAbacFacts | null>;
}

/** The §4.1 route service contract (the routes compose over it; in-mem slice + prod Drizzle both implement). */
export interface OrderRouteService extends OrderAbacResolver {
  listOrders(
    organizationId: string,
    filter: { patientId?: string; admissionId?: string; kind?: string; status?: string },
  ): Promise<{ orders: OrderView[] }>;
  getOrder(organizationId: string, id: string): Promise<OrderView>;
  createDraft(organizationId: string, userId: string, args: CreateOrderArgs): Promise<OrderView>;
  editDraft(
    organizationId: string,
    id: string,
    data: unknown,
    priority?: OrderPriority,
  ): Promise<OrderView>;
  requestSignature(
    organizationId: string,
    id: string,
    args: RequestSignatureArgs,
  ): Promise<OrderView>;
  signOrder(organizationId: string, userId: string, id: string, args: SignArgs): Promise<OrderView>;
  signOnBehalf(
    organizationId: string,
    userId: string,
    id: string,
    args: SignOnBehalfArgs,
  ): Promise<OrderView>;
  recordVerbal(
    organizationId: string,
    userId: string,
    id: string,
    args: RecordVerbalArgs,
  ): Promise<OrderView>;
  cosignOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: CosignArgs,
  ): Promise<OrderView>;
  discontinueOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: DiscontinueArgs,
  ): Promise<OrderView>;
  correctOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: CreateOrderArgs,
  ): Promise<OrderView>;
  completeOrder(
    organizationId: string,
    userId: string,
    id: string,
    reason?: string,
  ): Promise<OrderView>;
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
    patch: { maxSpawns?: number },
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
  ): Promise<{ orderId: string }>;
  getVerbalPolicy(organizationId: string): Promise<VerbalPolicyView>;
  putVerbalPolicy(organizationId: string, args: VerbalPolicyArgs): Promise<VerbalPolicyView>;
  regenerateVerbalTimer(organizationId: string, id: string): Promise<OrderView>;
  /** Drain (and clear) the §4.4 outbox events recorded since the last call (test/relay seam). */
  drainEvents(): RecordedOrderEvent[];
}

// ── in-memory records (the slice mutates these; the view DTOs are the read-only projections) ────────────
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface OrderRecord extends Mutable<OrderView> {
  organizationId: string;
  data: unknown;
  cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director" | null;
}
interface StandingRecord extends Mutable<StandingOrderView> {
  organizationId: string;
  signerDiscipline: string;
  data: unknown;
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
      discontinuationReason: null,
      replacesOrderId: null,
      triggeringAssessmentId: null,
      triggeringHopeAssessmentId: null,
      signedAt: null,
      signedBy: null,
      completedAt: null,
      createdAt: now(),
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
      data: {},
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
    const { organizationId: _o, data: _d, cosignerRoleNeeded: _c, ...v } = r;
    return v;
  };
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
    async getOrder(organizationId, id) {
      return view(find(organizationId, id));
    },

    async createDraft(organizationId, userId, args) {
      // §2.1 / §4.7 author floor (defense-in-depth on top of the route's `discipline_can_order` ABAC).
      if (!disciplineCanOrder(args.drafterDiscipline, args.kind))
        throw new NotFoundError(
          `discipline '${args.drafterDiscipline}' may not author a '${args.kind}' order`,
        );
      await bindCrossModuleRefs(organizationId, args);
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
        data: args.data,
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
      return view(rec);
    },

    async editDraft(organizationId, id, data, priority) {
      const r = find(organizationId, id);
      if (r.status !== "draft")
        throw new NotFoundError(`order ${id} is not a draft and cannot be edited`);
      r.data = data;
      if (priority) r.priority = priority;
      r.version += 1;
      return view(r);
    },

    async requestSignature(organizationId, id, args) {
      const r = find(organizationId, id);
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
      return view(r);
    },

    async signOrder(organizationId, userId, id, args) {
      return signInternal(
        organizationId,
        userId,
        id,
        args.signerDiscipline,
        args.signedAtClient,
        false,
      );
    },
    async signOnBehalf(organizationId, userId, id, args) {
      const v = await signInternal(
        organizationId,
        userId,
        id,
        args.signerDiscipline,
        args.signedAtClient,
        true,
      );
      emit(
        "m11.order.signed_on_behalf",
        { orderId: id, onBehalfOf: args.onBehalfOf, reason: args.reason },
        `${id}:signed_on_behalf`,
      );
      return v;
    },

    async recordVerbal(organizationId, userId, id, args) {
      const r = find(organizationId, id);
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
      emit(
        "m11.order.verbal_received",
        { orderId: id, deadlineAt: r.verbalDeadlineAt },
        `${id}:verbal_received`,
      );
      return view(r);
    },

    async cosignOrder(organizationId, userId, id, args) {
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
      return view(r);
    },

    async discontinueOrder(organizationId, userId, id, args) {
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
      return view(r);
    },

    async correctOrder(organizationId, userId, id, args) {
      const original = find(organizationId, id);
      const correction = await this.createDraft(organizationId, userId, {
        ...args,
        replacesOrderId: id,
      });
      original.version += 1;
      emit(
        "m11.order.corrected",
        { newOrderId: correction.id, replacesOrderId: id },
        `${correction.id}:corrected`,
      );
      return correction;
    },

    async completeOrder(organizationId, userId, id, _reason) {
      const r = find(organizationId, id);
      const t = transitionOrder(r.status, { type: "complete", criterionMet: true });
      r.status = t.to;
      r.completedAt = now();
      emit("m11.order.completed", { orderId: id, completedBy: userId }, `${id}:completed`);
      return view(r);
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
      planStandingCreation({ kind: args.kind, signerDiscipline: args.signerDiscipline }); // §2.4 D5 eligibility guards.
      const id = nextId();
      const rec: StandingRecord = {
        id,
        organizationId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        kind: args.kind,
        cadence: args.cadence,
        status: "active",
        nextSpawnAt: null,
        spawnCount: 0,
        maxSpawns: args.maxSpawns ?? null,
        signerDiscipline: args.signerDiscipline,
        data: args.data,
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
    async spawnStandingOrder(organizationId, userId, id) {
      const r = findSt(organizationId, id);
      if (r.status !== "active")
        throw new NotFoundError(
          `standing order ${id} is ${r.status}; only an active template may spawn`,
        );
      const plan = planStandingSpawn({
        kind: r.kind,
        cadence: r.cadence,
        cadenceDetail: {},
        spawnedBy: "clinician_request",
        now: now(),
        timeZone: tz,
      });
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
        orderingPhysicianMdmId: "00000000-0000-4000-8000-0000000000ff",
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
        data: r.data,
      });
      r.spawnCount += 1;
      emit(
        "m11.order.standing_spawned",
        { standingOrderId: id, orderId },
        `${orderId}:standing_spawned`,
      );
      emit("m11.order.signed", { orderId, kind: r.kind }, `${orderId}:signed`);
      return { orderId };
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
    async regenerateVerbalTimer(organizationId, id) {
      const r = find(organizationId, id);
      if (r.status !== "verbal_pending")
        throw new NotFoundError(`order ${id} is not verbal_pending`);
      r.verbalDeadlineAt = computeVerbalDeadline(now(), {
        windowHours: policy.windowHours,
        businessHoursOnly: policy.businessHoursOnly,
        timeZone: tz,
        policyVersion: policy.policyVersion,
      });
      emit(
        "m11.order.verbal_received",
        { orderId: id, deadlineAt: r.verbalDeadlineAt, regenerated: true },
        `${id}:regenerated:${now()}`,
      );
      return view(r);
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
  ): Promise<OrderView> {
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
    emit(
      "m11.order.signed",
      { orderId: id, kind: r.kind, signedBy: userId, onBehalf },
      `${id}:signed`,
    );
    return Promise.resolve(view(r));
  }
}
