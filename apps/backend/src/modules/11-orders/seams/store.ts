// apps/backend/src/modules/11-orders/seams/store.ts — M11-T05 the data PORT the §2.8 D14 /
// §4.3 seam providers (OrderSignatureProvider + OrderProvider) compose over, plus an in-memory slice for
// tests / boot-without-DB. The providers (./providers.ts) are pure orchestration over this port; production
// injects a Drizzle-backed store that writes/reads M11's `order_record` / `order_signature` / `verbal_order`
// / `order_discontinuation` tables under the CONSUMER's `withOrgContext` — the providers never switch
// tenants; RLS scopes every read/write by `app.org_id` (§3.6). Mirrors the M8 EncounterCreator + M10 HOPE
// seams/store.ts precedents (the one MUTATE-seam store in M8, the read-only stores in M9/M10).
//
// The signature primitive is POLYMORPHIC (D4): every write keys on `(targetKind, targetId)` so M12's
// `medication_order` rows write through the SAME path as M11's own `order_record` rows, with NO SQL FK
// across the discriminator. When `targetKind === 'order'` the store also applies the lifecycle status
// transition to the local order row (and flips a `verbal_order` to `signed_in_time` / `expired_unsigned`
// at sign); when `targetKind === 'medication_order'` there is no local M11 row — the signature/verbal row
// is recorded and M12 owns the med-order lifecycle. Reads project read-only DTOs (never Drizzle rows); no
// per-kind `data` jsonb (PHI) crosses the seam.
import type {
  AdmissionId,
  IsoInstant,
  OrderDiscontinuationDto,
  OrderDiscontinuationId,
  OrderDiscontinuationReason,
  OrderKind,
  OrderRecordDto,
  OrderRecordId,
  OrderSignatureId,
  OrderSignatureTargetKind,
  PatientId,
  VerbalOrderId,
  VerbalOrderStatus,
} from "@wardenx/types";

/** The verbal-timeliness projection `OrderProvider.getVerbalOrderTimeliness` reads (sans the derived
 * `onTime`, which the provider computes). One row per order that was ever recorded as a verbal order. */
export interface VerbalTimeliness {
  readonly orderId: OrderRecordId;
  readonly deadlineAt: IsoInstant;
  readonly signedAt: IsoInstant | null;
  readonly status: VerbalOrderStatus;
}

/** The fields a `signOrderTarget` write records (the server stamps `signedAt` authoritatively). */
export interface InsertSignatureInput {
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly signerMembershipId: string;
  readonly signatureKind: "signature" | "cosignature";
  readonly signedAt: IsoInstant;
}

/** The fields a `recordVerbalOrder` write records (the deadline is computed by the provider). */
export interface InsertVerbalOrderInput {
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly recordingMembershipId: string;
  readonly orderingPhysicianMdmId: string;
  readonly receivedAt: IsoInstant;
  readonly deadlineAt: IsoInstant;
}

/** The fields a `cosignOrder` write records. */
export interface InsertCosignatureInput {
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly cosignerMembershipId: string;
  readonly cosignerRole: "rn_case_manager" | "clinical_supervisor" | "medical_director";
}

/** The fields a `discontinueOrder` write records (the command + its own row, D13). */
export interface InsertDiscontinuationInput {
  readonly targetKind: OrderSignatureTargetKind;
  readonly targetId: string;
  readonly actorMembershipId: string;
  readonly reason: OrderDiscontinuationReason;
  readonly effectiveAt: IsoInstant;
}

/**
 * The data port the §2.8 / §4.3 seam providers compose over. Read methods return read-only DTO shapes
 * (never Drizzle rows); the Drizzle adapter projects rows to these under the consumer's RLS context. Write
 * methods mint the row id and (for `targetKind === 'order'`) apply the local lifecycle transition. Reads key
 * on `orderId` / `patientId` / `admissionId` — the org is already pinned by RLS — and return an empty slice
 * / null when the subject has no visible rows under the consumer's tenant.
 */
export interface OrderSeamStore {
  // ── reads (OrderProvider) ──────────────────────────────────────────────────────────────────────────
  getOrder(orderId: OrderRecordId): Promise<OrderRecordDto | null>;
  ordersForPatient(patientId: PatientId): Promise<ReadonlyArray<OrderRecordDto>>;
  ordersForAdmission(admissionId: AdmissionId): Promise<ReadonlyArray<OrderRecordDto>>;
  ordersForTriggeringAssessment(assessmentId: string): Promise<ReadonlyArray<OrderRecordDto>>;
  orderForCarePlanIntervention(interventionId: string): Promise<OrderRecordDto | null>;
  discontinuationForOrder(orderId: OrderRecordId): Promise<OrderDiscontinuationDto | null>;
  verbalForOrder(orderId: OrderRecordId): Promise<VerbalTimeliness | null>;
  // ── writes (OrderSignatureProvider — polymorphic by targetKind, D4) ──────────────────────────────────
  insertSignature(input: InsertSignatureInput): Promise<OrderSignatureId>;
  insertVerbalOrder(input: InsertVerbalOrderInput): Promise<VerbalOrderId>;
  insertCosignature(input: InsertCosignatureInput): Promise<OrderSignatureId>;
  insertDiscontinuation(input: InsertDiscontinuationInput): Promise<OrderDiscontinuationId>;
  /**
   * Apply a lifecycle status to a LOCAL `order_record` row (no-op for a med-order target — M12 owns that
   * lifecycle). Returns the post-transition status, or `null` when no local row exists for `orderId`. On a
   * `signedAt`-bearing transition to `active` an open `verbal_order` for the row is resolved to
   * `signed_in_time` (on/before the deadline) or `expired_unsigned` (after).
   */
  applyOrderStatus(
    orderId: OrderRecordId,
    status: OrderRecordDto["status"],
    signedAt: IsoInstant | null,
  ): Promise<OrderRecordDto["status"] | null>;
}

// ── in-memory slice store ─────────────────────────────────────────────────────────────────────────────

/** A seed verbal-order timeliness row (drives `getVerbalOrderTimeliness` + the sign-time resolution). */
export interface VerbalSeedRow extends VerbalTimeliness {}

/** Deterministic, I/O-free seed for the in-memory {@link OrderSeamStore} (slice + seam tests). */
export interface OrderSeamSeed {
  /** Order rows the reads resolve (any order; filtered/projected per call). */
  readonly orders?: readonly OrderRecordDto[];
  /** Discontinuation rows keyed by their `orderId` (`getDiscontinuationReason`). */
  readonly discontinuations?: readonly OrderDiscontinuationDto[];
  /** Verbal-order timeliness rows keyed by their `orderId` (`getVerbalOrderTimeliness`). */
  readonly verbalOrders?: readonly VerbalSeedRow[];
  /** Care-plan intervention → order back-refs (M7's reverse FK; `findByCarePlanIntervention`). */
  readonly carePlanInterventionLinks?: Readonly<Record<string, OrderRecordId>>;
}

/** Pads `n` to mint a uuid-shaped id so created ids round-trip through uuid-validated bodies (M8 slice). */
function uuidFromCounter(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** An in-memory {@link OrderSeamStore} for the slice/tests — no DB, deterministic, RLS-free. */
export function createInMemoryOrderSeamStore(seed: OrderSeamSeed = {}): { store: OrderSeamStore } {
  const orders = new Map<OrderRecordId, OrderRecordDto>(
    (seed.orders ?? []).map((o) => [o.orderId, o]),
  );
  const discontinuations = new Map<OrderRecordId, OrderDiscontinuationDto>(
    (seed.discontinuations ?? []).map((d) => [d.orderId, d]),
  );
  const verbalOrders = new Map<OrderRecordId, VerbalTimeliness>(
    (seed.verbalOrders ?? []).map((v) => [v.orderId, v]),
  );
  const carePlanLinks = new Map<string, OrderRecordId>(
    Object.entries(seed.carePlanInterventionLinks ?? {}),
  );
  let seq = 0;

  return {
    store: {
      async getOrder(orderId) {
        return orders.get(orderId) ?? null;
      },
      async ordersForPatient(patientId) {
        return [...orders.values()].filter((o) => o.patientId === patientId);
      },
      async ordersForAdmission(admissionId) {
        return [...orders.values()].filter((o) => o.admissionId === admissionId);
      },
      async ordersForTriggeringAssessment(assessmentId) {
        return [...orders.values()].filter(
          (o) =>
            o.triggeringAssessmentId === assessmentId ||
            o.triggeringHopeAssessmentId === assessmentId,
        );
      },
      async orderForCarePlanIntervention(interventionId) {
        const orderId = carePlanLinks.get(interventionId);
        return orderId ? (orders.get(orderId) ?? null) : null;
      },
      async discontinuationForOrder(orderId) {
        return discontinuations.get(orderId) ?? null;
      },
      async verbalForOrder(orderId) {
        return verbalOrders.get(orderId) ?? null;
      },
      async insertSignature(_input) {
        return uuidFromCounter(++seq) as OrderSignatureId;
      },
      async insertVerbalOrder(input) {
        const verbalOrderId = uuidFromCounter(++seq) as VerbalOrderId;
        // Record the timeliness row only for a local order target (the OrderProvider read is M11-order
        // centric; a med-order target's timeliness is M12/M13's surface).
        if (input.targetKind === "order") {
          verbalOrders.set(input.targetId, {
            orderId: input.targetId,
            deadlineAt: input.deadlineAt,
            signedAt: null,
            status: "pending",
          });
        }
        return verbalOrderId;
      },
      async insertCosignature(_input) {
        return uuidFromCounter(++seq) as OrderSignatureId;
      },
      async insertDiscontinuation(input) {
        const discontinuationId = uuidFromCounter(++seq) as OrderDiscontinuationId;
        if (input.targetKind === "order") {
          discontinuations.set(input.targetId, {
            discontinuationId,
            orderId: input.targetId,
            reason: input.reason,
            actorMembershipId: input.actorMembershipId,
            effectiveAt: input.effectiveAt,
          });
        }
        return discontinuationId;
      },
      async applyOrderStatus(orderId, status, signedAt) {
        const order = orders.get(orderId);
        if (order === undefined) return null;
        orders.set(orderId, { ...order, status, signedAt: signedAt ?? order.signedAt });
        // Resolve an open verbal order at sign: on/before the deadline → signed_in_time, else expired.
        if (status === "active" && signedAt !== null) {
          const verbal = verbalOrders.get(orderId);
          if (verbal !== undefined && verbal.status === "pending") {
            verbalOrders.set(orderId, {
              ...verbal,
              signedAt,
              status: signedAt <= verbal.deadlineAt ? "signed_in_time" : "expired_unsigned",
            });
          }
        }
        return status;
      },
    },
  };
}
