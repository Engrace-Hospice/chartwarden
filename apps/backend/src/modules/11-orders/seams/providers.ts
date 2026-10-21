// apps/backend/src/modules/11-orders/seams/providers.ts — M11-T05 the §2.8 D14 / §4.3 seam
// implementations: pure orchestration over an injected {@link OrderSeamStore}. Each returns the leaf-typed
// seam interface (@chartwarden/types) the M1 registry validates and M12/M14/M23/M30/M7 resolve. The providers
// add NO tenant logic — RLS scopes every store read/write by the consumer's `app.org_id` (§3.6); they
// compute the deadline + decide the resulting lifecycle status and project store DTOs.
//
// `createOrderSignatureProvider` is the one MUTATE seam (M11 owns the signature primitive; M12 writes
// medication-order signatures through it without importing M11 — D4 / §2.8). It stamps the server-side
// signature timestamp authoritatively, computes the verbal-order 48-hour deadline via the pure
// `@chartwarden/orders` window math, and — for a LOCAL `order_record` target — drives the lifecycle status
// transition through the store (a med-order target records the primitive only; M12 owns its lifecycle).
import { assertVerbalReceivedAtPlausible, computeVerbalDeadline } from "@chartwarden/orders";
import type {
  CosignOrderInput,
  DiscontinueOrderInput,
  IsoInstant,
  OrderKind,
  OrderProvider,
  OrderRecordDto,
  OrderSignatureProvider,
  OrderStatus,
  RecordVerbalOrderInput,
  SignOrderTargetInput,
} from "@chartwarden/types";
import type { OrderSeamStore, VerbalTimeliness } from "./store";

/** A clock the signature primitive reads for the authoritative server-side timestamp (never the client
 * clock). Injectable so tests are deterministic; production omits it and uses the wall clock. */
export type Clock = () => IsoInstant;

/** The default authoritative server clock (the real wall clock). */
const wallClock: Clock = () => new Date().toISOString();

/** Filter helper: does an order match the optional status / kind narrowing the read accepts. */
function matches(
  order: OrderRecordDto,
  status: readonly OrderStatus[] | undefined,
  kinds: readonly OrderKind[] | undefined,
): boolean {
  if (status !== undefined && !status.includes(order.status)) return false;
  if (kinds !== undefined && !kinds.includes(order.kind)) return false;
  return true;
}

/**
 * §2.8 D14 OrderSignatureProvider over the store — the polymorphic clinical-signature WRITE primitive M12
 * routes medication-order signatures through. `signOrderTarget` records the signature with a server-stamped
 * timestamp and, for a local `order_record` target in a signable state, transitions it to `active` (a
 * verbal_pending order's open verbal row is resolved to signed_in_time / expired_unsigned at the same time).
 * `recordVerbalOrder` computes `deadline_at = received_at + window` under the org's real `order_verbal_policy`
 * (the 48h platform floor when the org has never tightened it — `store.verbalPolicyForOrg`) and moves a
 * local order to `verbal_pending`. `cosignOrder` / `discontinueOrder` record their own rows (D13).
 * A `medication_order` target records the primitive only — M12 owns that lifecycle (no local M11 row).
 * `now` is the authoritative server clock (injectable for deterministic tests; defaults to the wall clock).
 */
export function createOrderSignatureProvider(
  store: OrderSeamStore,
  now: Clock = wallClock,
): OrderSignatureProvider {
  return {
    async signOrderTarget(input: SignOrderTargetInput) {
      const signedAt = now();
      const signatureId = await store.insertSignature({
        targetKind: input.targetKind,
        targetId: input.targetId,
        signerMembershipId: input.signerMembershipId,
        signerDiscipline: input.signerDiscipline,
        signatureKind: input.signatureKind,
        signedAt,
      });
      let orderStatusAfter: OrderStatus = "active";
      if (input.targetKind === "order") {
        const post = await store.applyOrderStatus(input.targetId, "active", signedAt);
        if (post !== null) orderStatusAfter = post;
      }
      return { signatureId, orderStatusAfter };
    },

    async recordVerbalOrder(input: RecordVerbalOrderInput) {
      // The tenant's real §2.3 D3 policy (tighten-only floor), not the platform default alone — a hospice
      // that has tightened its window gets the same math through this seam as through M11's own route.
      // GAP-017 -- the seam M12 records its verbal orders through bounds the clock start the same way M11's
      // own routes do: against the server's clock, never the caller's.
      assertVerbalReceivedAtPlausible(input.receivedAt, now());
      const policy = await store.verbalPolicyForOrg();
      const deadlineAt = computeVerbalDeadline(input.receivedAt, policy);
      const verbalOrderId = await store.insertVerbalOrder({
        targetKind: input.targetKind,
        targetId: input.targetId,
        recordingMembershipId: input.recordingMembershipId,
        orderingPhysicianMdmId: input.orderingPhysicianMdmId,
        verbalAttestation: input.verbalAttestation,
        effectiveAt: input.receivedAt,
        receivedAt: input.receivedAt,
        deadlineAt,
        deadlinePolicyVersion: policy.policyVersion,
      });
      if (input.targetKind === "order") {
        await store.applyOrderStatus(input.targetId, "verbal_pending", null);
      }
      return { verbalOrderId, deadlineAt };
    },

    async cosignOrder(input: CosignOrderInput) {
      const cosignatureId = await store.insertCosignature({
        targetKind: input.targetKind,
        targetId: input.targetId,
        cosignerMembershipId: input.cosignerMembershipId,
        cosignerRole: input.cosignerRole,
        attestationText: input.attestationText,
      });
      return { cosignatureId };
    },

    async discontinueOrder(input: DiscontinueOrderInput) {
      const discontinuationId = await store.insertDiscontinuation({
        targetKind: input.targetKind,
        targetId: input.targetId,
        actorMembershipId: input.actorMembershipId,
        reason: input.reason,
        effectiveAt: input.effectiveAt,
      });
      if (input.targetKind === "order") {
        await store.applyOrderStatus(input.targetId, "discontinued", null);
      }
      return { discontinuationId };
    },
  };
}

/** A verbal order signed on/before its `deadline_at` (or already terminal `signed_in_time`) is on time. */
function isOnTime(v: VerbalTimeliness): boolean {
  if (v.status === "signed_in_time") return true;
  if (v.status === "expired_unsigned") return false;
  return v.signedAt !== null && v.signedAt <= v.deadlineAt;
}

/**
 * §4.3 OrderProvider over the store — the read-side counterpart M14 (orders since last IDG), M23 (the
 * "every billed line has a covering order" claim rule), M30 (order-completion + verbal-timeliness measures)
 * and M7 (care-plan intervention → order back-ref) consume. Pure projection + the optional status/kind/span
 * narrowing; RLS pins the tenant. `getVerbalOrderTimeliness` derives `onTime` from the stored timeliness row.
 */
export function createOrderProvider(store: OrderSeamStore): OrderProvider {
  return {
    getOrder(input) {
      return store.getOrder(input.orderId);
    },
    async linkSummary(organizationId, id) {
      // Fail closed: no tenant or no id means no answer.
      if (!organizationId?.trim()) throw new Error("linkSummary: organizationId required");
      if (!id?.trim()) throw new Error("linkSummary: id required");
      return store.linkSummary(organizationId, id);
    },
    async findActiveOrder(input) {
      const all = await store.ordersForPatient(input.patientId);
      const covers = (o: OrderRecordDto): boolean =>
        input.spans === undefined || o.createdAt <= input.spans[1];
      return all.find((o) => o.kind === input.kind && o.status === "active" && covers(o)) ?? null;
    },
    async listByPatient(input) {
      const all = await store.ordersForPatient(input.patientId);
      const filtered = all.filter((o) => matches(o, input.status, input.kinds));
      return input.limit !== undefined ? filtered.slice(0, input.limit) : filtered;
    },
    async listByAdmission(input) {
      const all = await store.ordersForAdmission(input.admissionId);
      return all.filter((o) => matches(o, input.status, input.kinds));
    },
    async getOrdersSince(input) {
      const all = await store.ordersForPatient(input.patientId);
      return all
        .filter((o) => o.createdAt >= input.since)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    getDiscontinuationReason(input) {
      return store.discontinuationForOrder(input.orderId);
    },
    async getVerbalTimelinessCountsForOrg(organizationId, window) {
      return store.verbalTimelinessCountsForOrg(organizationId, window);
    },
    async getVerbalOrderTimeliness(input) {
      const v = await store.verbalForOrder(input.orderId);
      if (v === null) return null;
      return {
        deadlineAt: v.deadlineAt,
        signedAt: v.signedAt,
        status: v.status,
        onTime: isOnTime(v),
      };
    },
    async findByTriggeringAssessment(assessmentId: string) {
      return [...(await store.ordersForTriggeringAssessment(assessmentId))];
    },
    findByCarePlanIntervention(interventionId: string): Promise<OrderRecordDto | null> {
      return store.orderForCarePlanIntervention(interventionId);
    },
  };
}
