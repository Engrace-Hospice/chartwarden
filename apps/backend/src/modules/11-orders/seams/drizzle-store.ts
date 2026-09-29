// apps/backend/src/modules/11-orders/seams/drizzle-store.ts — the FULL Drizzle {@link OrderSeamStore}.
//
// Formerly a partial overlay (spread the in-memory slice, override the one live aggregate read); now every
// method answers from M11's tables — no method answers from the in-memory Map. This one store backs BOTH
// published seams: `OrderProvider` (the read-side counterpart M14/M23/M30/M7 consume) and
// `OrderSignatureProvider` — the polymorphic §2.8 D14 clinical-signature WRITE primitive M12/M19 route
// medication-order signatures and triage verbal orders through.
//
// TENANCY. Methods WITHOUT an `organizationId` parameter run under the CONSUMER'S ambient request context
// via `withOrgContextFromRequest` — a seam read/write executes in the caller's request scope, RLS-scoped by
// `app.org_id` (§3.6); called outside a request scope it THROWS rather than touching PHI unscoped. The one
// org-parameterized read (`verbalTimelinessCountsForOrg`, M30's measure input) SELF-SCOPES via an explicit
// `withOrgContext` + `organization_id` predicate (second wall), because its consumer is a recompute job on
// its own pooled connection, not a request.
//
// WRITE LIFECYCLE. The §3.4 migration (0037/0131) triggers do the state work this store must NOT duplicate
// (the same contract `orders-route-service-db.ts` builds on — its proven guard/insert fragments are copied
// here because its helpers are closures inside `createDbOrderBackend`, not importable):
//   * inserting a `verbal_order` for an order target fires `verbal_order_set_target_pending_trg`
//     (pending_signature → verbal_pending, RAISES `TARGET_NOT_PENDING_SIGNATURE` otherwise);
//   * inserting a primary `signature` fires `order_signature_apply_to_target_trg` (→ `active` + `signed_at`
//     WHERE cosign prerequisites are met — SILENT on an unmet cosign, so the pure `transitionOrder` guard
//     here is the real refusal, run BEFORE the insert so the one-primary-signature unique index is never
//     consumed by a signature that did not apply);
//   * `applyOrderStatus` therefore never forces a trigger-owned transition — it reports the actual
//     post-transition row status and resolves the open verbal receipt when the sign really applied.
// Every read a write depends on runs WITHIN the same `tx` (a nested store read would re-enter the pool and
// see stale pre-commit data — the M11 write-lifecycle gotcha), and the cosigner axis is RE-DERIVED
// server-side from the persisted drafter/kind/policy facts, never trusted from input.
import { type DbClient, schema } from "@wardenx/db";
import {
  DEFAULT_COSIGN_POLICY,
  DEFAULT_VERBAL_POLICY,
  type OrderCosignPolicy,
  type VerbalDeadlinePolicy,
  lpnCosignRequired,
  planCosignAttest,
  transitionOrder,
} from "@wardenx/orders";
import { requireRequestContext, withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import {
  type AdmissionId,
  type IsoInstant,
  NotFoundError,
  type OrderDiscontinuationDto,
  type OrderDiscontinuationId,
  type OrderDiscontinuationReason,
  type OrderKind,
  type OrderPriority,
  type OrderRecordDto,
  type OrderRecordId,
  type OrderResultsStatus,
  type OrderSignatureId,
  type OrderStatus,
  type OrderTransmissionStatus,
  type PatientId,
  type VerbalOrderId,
  type VerbalOrderStatus,
} from "@wardenx/types";
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { OrderSeamStore, VerbalTimeliness } from "./store";

const OR = schema.orderRecords;
const OS = schema.orderSignatures;
const V = schema.verbalOrders;
const OD = schema.orderDiscontinuations;
const VP = schema.orderVerbalPolicies;
/** M7's `intervention` row carries the intervention → order soft-ref (`linked_order_id`); M11, as the
 * producer of the order fact, owns this cross-module join on the read side (the M13↔M9 D6 precedent) —
 * the alternative is M7 importing M11's schema, which architecture §11 blocks. */
const CPI = schema.interventions;

/** A transaction handle as `withOrgContext*` hands it out (the full Drizzle query API). */
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The actor id the org-parameterized read's withOrgContext envelope carries — an aggregate read has no
 * acting user. */
const ORDER_READER_SYSTEM_USER_ID = "";

const iso = (d: Date): IsoInstant => d.toISOString() as IsoInstant;
const isoN = (d: Date | null): IsoInstant | null => (d === null ? null : iso(d));

/** The columns `OrderRecordDto` projects (never a full Drizzle row across the seam). */
const DTO_COLUMNS = {
  id: OR.id,
  patientId: OR.patientId,
  admissionId: OR.admissionId,
  kind: OR.kind,
  status: OR.status,
  priority: OR.priority,
  orderingPhysicianMdmId: OR.orderingPhysicianMdmId,
  transmissionStatus: OR.transmissionStatus,
  resultsStatus: OR.resultsStatus,
  triggeringAssessmentId: OR.triggeringAssessmentId,
  triggeringHopeAssessmentId: OR.triggeringHopeAssessmentId,
  replacesOrderId: OR.replacesOrderId,
  version: OR.version,
  signedAt: OR.signedAt,
  createdAt: OR.createdAt,
} as const;

type OrderDtoRow = {
  id: string;
  patientId: string;
  admissionId: string;
  kind: string;
  status: string;
  priority: string | null;
  orderingPhysicianMdmId: string | null;
  transmissionStatus: string;
  resultsStatus: string;
  triggeringAssessmentId: string | null;
  triggeringHopeAssessmentId: string | null;
  replacesOrderId: string | null;
  version: number;
  signedAt: Date | null;
  createdAt: Date;
};

const toDto = (r: OrderDtoRow): OrderRecordDto => ({
  orderId: r.id as OrderRecordId,
  patientId: r.patientId as PatientId,
  admissionId: r.admissionId as AdmissionId,
  kind: r.kind as OrderKind,
  status: r.status as OrderStatus,
  priority: (r.priority as OrderPriority | null) ?? null,
  orderingPhysicianMdmId: r.orderingPhysicianMdmId,
  transmissionStatus: r.transmissionStatus as OrderTransmissionStatus,
  resultsStatus: r.resultsStatus as OrderResultsStatus,
  triggeringAssessmentId: r.triggeringAssessmentId,
  triggeringHopeAssessmentId: r.triggeringHopeAssessmentId,
  replacesOrderId: r.replacesOrderId as OrderRecordId | null,
  version: Number(r.version),
  signedAt: isoN(r.signedAt),
  createdAt: iso(r.createdAt),
});

/**
 * Build the production Drizzle-backed {@link OrderSeamStore} — the ONE store both published M11 seams
 * (`OrderProvider` + `OrderSignatureProvider`) compose over. Injected via `registerOrderSeams({ store })`
 * from the composition root's db branch.
 *
 * `verbalTimelinessCountsForOrg` counts verbal orders RECEIVED in `[from, to)` and, of those, the ones
 * signed on or before their deadline. Two facts make this the honest denominator: the window keys on
 * `received_at` (not `signed_at`), so an order recorded in the window but never signed still counts
 * AGAINST timeliness rather than vanishing; and the numerator requires `signed_at <= deadline_at`, so a
 * late signature is not silently forgiven. Returns the PAIR, never a rate — M30's kernel suppresses a
 * measure whose denominator is under the CMS reportable floor, and an empty window (0/0) must suppress
 * rather than score perfect timeliness.
 */
export function createDrizzleOrderSeamStore(db: DbClient): OrderSeamStore {
  /** The DTO-projected order select — parent partition (RANGE by created_at; the parent read fans out). */
  const selectDto = (tx: Tx) => tx.select(DTO_COLUMNS).from(OR);

  /** Load the write-guard slice of one order row WITHIN the caller's tx, or the non-leaking 404. */
  async function orderRowForWrite(tx: Tx, id: string) {
    const [r] = await tx
      .select({
        id: OR.id,
        kind: OR.kind,
        status: OR.status,
        version: OR.version,
        drafterMembershipId: OR.drafterMembershipId,
        drafterDiscipline: OR.drafterDiscipline,
        cosignRequired: OR.cosignRequired,
        cosignStatus: OR.cosignStatus,
      })
      .from(OR)
      .where(eq(OR.id, id))
      .limit(1);
    if (!r) throw new NotFoundError(`order ${id} not found`);
    return r;
  }

  /** The per-org cosign-policy projection (default-filled when unseeded) — same-tx, RLS pins the org.
   * Copied from `orders-route-service-db.ts` (its helper is a closure inside `createDbOrderBackend`). */
  async function cosignPolicyOf(tx: Tx): Promise<OrderCosignPolicy> {
    const [r] = (await tx
      .select({ lpn: VP.lpnCosignRequiredKinds, np: VP.npCosignRequiredKinds })
      .from(VP)
      .limit(1)) as { lpn: unknown; np: unknown }[];
    if (!r) return DEFAULT_COSIGN_POLICY;
    return {
      lpnCosignRequiredKinds:
        (r.lpn as OrderKind[]) ?? DEFAULT_COSIGN_POLICY.lpnCosignRequiredKinds,
      npCosignRequiredKinds: (r.np as OrderKind[]) ?? [],
    };
  }

  /** The per-org verbal-deadline policy projection (default-filled when unseeded) — same-tx, RLS pins the
   * org. Copied from `orders-route-service-db.ts`'s `verbalPolicyOf` (its helper is a closure inside
   * `createDbOrderBackend`) so a seam caller (M12/M19) computes the identical deadline M11's own route
   * would for the same org, rather than a second, platform-default-only computation. */
  async function verbalPolicyOf(tx: Tx): Promise<VerbalDeadlinePolicy> {
    const [r] = (await tx
      .select({
        windowHours: VP.windowHours,
        businessHoursOnly: VP.businessHoursOnly,
        policyVersion: VP.policyVersion,
      })
      .from(VP)
      .limit(1)) as { windowHours: number; businessHoursOnly: boolean; policyVersion: string }[];
    if (!r) return DEFAULT_VERBAL_POLICY;
    return {
      windowHours: Number(r.windowHours),
      businessHoursOnly: r.businessHoursOnly,
      policyVersion: r.policyVersion,
    };
  }

  return {
    // ── reads (OrderProvider) — consumer's ambient request scope, RLS pins the tenant ─────────────────
    async getOrder(orderId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [r] = await selectDto(tx).where(eq(OR.id, orderId)).limit(1);
        return r ? toDto(r) : null;
      });
    },

    async ordersForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await selectDto(tx)
          .where(eq(OR.patientId, patientId))
          .orderBy(desc(OR.createdAt), desc(OR.id));
        return rows.map(toDto);
      });
    },

    async ordersForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await selectDto(tx)
          .where(eq(OR.admissionId, admissionId))
          .orderBy(desc(OR.createdAt), desc(OR.id));
        return rows.map(toDto);
      });
    },

    async ordersForTriggeringAssessment(assessmentId) {
      // Either triggering axis matches (M9 assessment OR M10 HOPE) — the in-memory slice's semantics.
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await selectDto(tx)
          .where(
            or(
              eq(OR.triggeringAssessmentId, assessmentId),
              eq(OR.triggeringHopeAssessmentId, assessmentId),
            ),
          )
          .orderBy(desc(OR.createdAt), desc(OR.id));
        return rows.map(toDto);
      });
    },

    async orderForCarePlanIntervention(interventionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [link] = await tx
          .select({ linkedOrderId: CPI.linkedOrderId })
          .from(CPI)
          .where(eq(CPI.id, interventionId))
          .limit(1);
        if (!link?.linkedOrderId) return null; // no intervention, or one that never linked an order
        const [r] = await selectDto(tx).where(eq(OR.id, link.linkedOrderId)).limit(1);
        return r ? toDto(r) : null;
      });
    },

    async discontinuationForOrder(orderId) {
      return withOrgContextFromRequest(db, async (tx): Promise<OrderDiscontinuationDto | null> => {
        // No uniqueness on order_record_id (a cascade and a clinician row can coexist) — the latest row
        // is the operative reason, mirroring the route service's single-row detail read.
        // `target_kind = 'order'` (mig 0156) pins the read to M11 order rows: this is the
        // OrderProvider's by-ORDER read, and since the ledger now also files `medication_order`
        // discontinuations (whose `order_record_id` holds an M12 uuid), the discriminator keeps the
        // read's pre-0156 semantics exact rather than trusting uuid disjointness across two tables.
        const [r] = await tx
          .select({
            id: OD.id,
            orderRecordId: OD.orderRecordId,
            reason: OD.reason,
            actorMembershipId: OD.actorMembershipId,
            effectiveAt: OD.effectiveAt,
          })
          .from(OD)
          .where(and(eq(OD.orderRecordId, orderId), eq(OD.targetKind, "order")))
          .orderBy(desc(OD.createdAt))
          .limit(1);
        if (!r) return null;
        return {
          discontinuationId: r.id as OrderDiscontinuationId,
          orderId: r.orderRecordId as OrderRecordId,
          reason: r.reason as OrderDiscontinuationReason,
          actorMembershipId: r.actorMembershipId,
          effectiveAt: iso(r.effectiveAt),
        };
      });
    },

    async verbalForOrder(orderId) {
      return withOrgContextFromRequest(db, async (tx): Promise<VerbalTimeliness | null> => {
        const [r] = await tx
          .select({ deadlineAt: V.deadlineAt, signedAt: V.signedAt, status: V.status })
          .from(V)
          .where(and(eq(V.targetKind, "order"), eq(V.targetId, orderId)))
          .limit(1); // one verbal receipt per target (verbal_order_target_uq)
        if (!r) return null;
        return {
          orderId,
          deadlineAt: iso(r.deadlineAt),
          signedAt: isoN(r.signedAt),
          status: r.status as VerbalOrderStatus,
        };
      });
    },

    verbalTimelinessCountsForOrg(organizationId, window) {
      // SELF-SCOPES on `organizationId`: the M30 recompute job's own pooled connection carries no ambient
      // RLS context, and the explicit `organization_id` predicate is the second wall.
      return withOrgContext(
        db,
        { organizationId, userId: ORDER_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              denominator: sql<number>`count(*)::int`,
              numerator: sql<number>`count(*) filter (where ${V.signedAt} is not null and ${V.signedAt} <= ${V.deadlineAt})::int`,
            })
            .from(V)
            .where(
              and(
                eq(V.organizationId, organizationId),
                gte(V.receivedAt, new Date(window.from)),
                lt(V.receivedAt, new Date(window.to)),
              ),
            );
          return {
            numerator: Number(row?.numerator) || 0,
            denominator: Number(row?.denominator) || 0,
          };
        },
      );
    },

    async verbalPolicyForOrg() {
      return withOrgContextFromRequest(db, async (tx) => verbalPolicyOf(tx));
    },

    // ── writes (OrderSignatureProvider — polymorphic by targetKind, D4; caller's request scope) ────────
    async insertSignature(input) {
      const { organizationId } = requireRequestContext();
      return withOrgContextFromRequest(db, async (tx) => {
        if (input.targetKind === "order" && input.signatureKind === "signature") {
          const r = await orderRowForWrite(tx, input.targetId);
          // Throws COSIGN_PENDING / ILLEGAL_ORDER_TRANSITION. The §3.4 apply-trigger is SILENT on an
          // unmet cosign, so this pure guard is the real refusal — and it must run BEFORE the insert,
          // because the one-primary-signature unique index would otherwise be consumed by a signature
          // row that never applied (permanently blocking the real sign).
          transitionOrder(r.status as OrderStatus, {
            type: "sign",
            kind: r.kind as OrderKind,
            cosignAttached: r.cosignStatus !== "pending",
            onBehalf: false,
          });
        }
        const [row] = await tx
          .insert(OS)
          .values({
            organizationId,
            targetKind: input.targetKind,
            targetId: input.targetId,
            signatureKind: input.signatureKind,
            signerMembershipId: input.signerMembershipId,
            // The caller-attested discipline the leaf contract now REQUIRES (`SignOrderTargetInput.
            // signerDiscipline` — the TASK-002 contract change): the NOT NULL ledger column records the
            // real §2.1 signer-matrix value, exactly like the route path — the former
            // `unattested_via_seam` sentinel is gone.
            signerDiscipline: input.signerDiscipline,
            signedAt: new Date(input.signedAt),
          })
          .returning({ id: OS.id });
        if (!row) throw new NotFoundError("order_signature insert returned no row");
        return row.id as OrderSignatureId;
      });
    },

    async insertVerbalOrder(input) {
      const { organizationId } = requireRequestContext();
      return withOrgContextFromRequest(db, async (tx) => {
        if (input.targetKind === "order") {
          const r = await orderRowForWrite(tx, input.targetId);
          // Validates VERBAL_NOT_ALLOWED_FOR_KIND / VERBAL_ATTESTATION_REQUIRED /
          // ILLEGAL_ORDER_TRANSITION — the typed refusal ahead of the trigger's raw
          // TARGET_NOT_PENDING_SIGNATURE raise.
          transitionOrder(r.status as OrderStatus, {
            type: "recordVerbal",
            kind: r.kind as OrderKind,
            attestationRecorded: input.verbalAttestation.length >= 100,
            recorderEligible: true,
          });
        }
        // Inserting the verbal_order fires `verbal_order_set_target_pending_trg` for an order target
        // (pending_signature → verbal_pending; version bumped by the trigger).
        const [row] = await tx
          .insert(V)
          .values({
            organizationId,
            targetKind: input.targetKind,
            targetId: input.targetId,
            recordingMembershipId: input.recordingMembershipId,
            orderingPhysicianMdmId: input.orderingPhysicianMdmId,
            verbalAttestation: input.verbalAttestation,
            effectiveAt: new Date(input.effectiveAt),
            receivedAt: new Date(input.receivedAt),
            deadlineAt: new Date(input.deadlineAt),
            // The provider computed `deadlineAt` (and this version) from `verbalPolicyForOrg` — the org's
            // real `order_verbal_policy` row, defaulting to the platform floor when unseeded.
            deadlinePolicyVersion: input.deadlinePolicyVersion,
            status: "pending",
          })
          .returning({ id: V.id });
        if (!row) throw new NotFoundError("verbal_order insert returned no row");
        // Reflect the physician the recorder attributed the verbal order to (route-service parity).
        if (input.targetKind === "order") {
          await tx
            .update(OR)
            .set({ orderingPhysicianMdmId: input.orderingPhysicianMdmId, updatedAt: new Date() })
            .where(eq(OR.id, input.targetId));
        }
        return row.id as VerbalOrderId;
      });
    },

    async insertCosignature(input) {
      const { organizationId } = requireRequestContext();
      return withOrgContextFromRequest(db, async (tx) => {
        if (input.targetKind === "order") {
          const r = await orderRowForWrite(tx, input.targetId);
          // `order_record` carries no cosigner_role_needed column — RE-DERIVE the demanded axis from the
          // persisted drafter/kind/policy facts (route-service parity; the claimed role is validated
          // against it, never trusted): the LPN axis demands an RN, the escalation-jump / NP axes MD.
          const cosignerRoleNeeded = lpnCosignRequired(
            r.drafterDiscipline,
            r.kind as OrderKind,
            await cosignPolicyOf(tx),
          )
            ? "rn_case_manager"
            : "medical_director";
          // Validates COSIGN_NOT_REQUIRED / ALREADY_COSIGNED / COSIGNER_NOT_ELIGIBLE (incl. self-cosign).
          planCosignAttest({
            orderId: input.targetId,
            cosignRequired: r.cosignRequired,
            alreadyCosigned: r.cosignStatus === "attached",
            cosignerRole: input.cosignerRole,
            cosignerRoleNeeded,
            cosignerIsAuthor: r.drafterMembershipId === input.cosignerMembershipId,
          });
        }
        // A `medication_order` target records the primitive only — M12 owns that lifecycle and is the
        // eligibility enforcement point for its cosigns (no M11-side facts to re-derive from).
        const [row] = await tx
          .insert(OS)
          .values({
            organizationId,
            targetKind: input.targetKind,
            targetId: input.targetId,
            signatureKind: "cosignature",
            signerMembershipId: input.cosignerMembershipId,
            signerDiscipline: input.cosignerRole,
            cosignerRole: input.cosignerRole,
            signedAt: new Date(),
          })
          .returning({ id: OS.id });
        if (!row) throw new NotFoundError("order_signature (cosignature) insert returned no row");
        // Attach the cosign on the local row so the §3.4 apply-trigger's prerequisite is satisfied at
        // the eventual primary sign (route-service parity; no trigger does this).
        if (input.targetKind === "order") {
          await tx
            .update(OR)
            .set({ cosignStatus: "attached", updatedAt: new Date() })
            .where(eq(OR.id, input.targetId));
        }
        return row.id as OrderSignatureId;
      });
    },

    async insertDiscontinuation(input) {
      const { organizationId } = requireRequestContext();
      // The formerly refused `medication_order` arm is SOUND since mig 0156: `target_kind`
      // discriminates the ledger, so under 'medication_order' the `order_record_id` column holds the
      // M12 medication-order uuid without lying about what the id refers to. The guard SEMANTICS that
      // still apply follow the insertCosignature precedent: for an `order` target the pure
      // `transitionOrder` refusal runs against the local M11 row; a `medication_order` target has NO
      // local M11 row to guard against — M12 owns that lifecycle and is the eligibility/state
      // enforcement point for its discontinuations, so this store records the primitive only.
      return withOrgContextFromRequest(db, async (tx) => {
        if (input.targetKind === "order") {
          const r = await orderRowForWrite(tx, input.targetId);
          // Validates ILLEGAL_ORDER_TRANSITION for a terminal order (route-service parity).
          transitionOrder(r.status as OrderStatus, {
            type: "discontinue",
            kind: r.kind as OrderKind,
            reason: input.reason,
            fulfillmentInFlight: false,
          });
        }
        const [row] = await tx
          .insert(OD)
          .values({
            organizationId,
            orderRecordId: input.targetId,
            targetKind: input.targetKind,
            actorMembershipId: input.actorMembershipId,
            reason: input.reason,
            effectiveAt: new Date(input.effectiveAt),
          })
          .returning({ id: OD.id });
        if (!row) throw new NotFoundError("order_discontinuation insert returned no row");
        return row.id as OrderDiscontinuationId;
      });
    },

    async applyOrderStatus(orderId, status, signedAt) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [r] = await tx
          .select({ status: OR.status, version: OR.version })
          .from(OR)
          .where(eq(OR.id, orderId))
          .limit(1);
        if (!r) return null; // no local M11 row (a med-order target) — M12 owns that lifecycle
        if (status === "active") {
          // TRIGGER-OWNED: `order_signature_apply_to_target_trg` flipped the row when the primary
          // signature landed (or stayed silent on an unmet cosign). Never force it here — report the
          // actual post-transition status; resolve the open verbal receipt only when the sign applied.
          if (r.status === "active" && signedAt !== null) {
            const signed = new Date(signedAt);
            const [v] = await tx
              .select({ id: V.id, deadlineAt: V.deadlineAt })
              .from(V)
              .where(
                and(eq(V.targetKind, "order"), eq(V.targetId, orderId), eq(V.status, "pending")),
              )
              .limit(1);
            if (v) {
              await tx
                .update(V)
                .set({
                  signedAt: signed,
                  // On/before the deadline → signed_in_time; after → expired_unsigned (a late
                  // signature is not silently forgiven — the store contract, not the route's shape).
                  status: signed <= v.deadlineAt ? "signed_in_time" : "expired_unsigned",
                })
                .where(eq(V.id, v.id));
            }
          }
          return r.status as OrderStatus;
        }
        if (status === "verbal_pending") {
          // TRIGGER-OWNED: `verbal_order_set_target_pending_trg` flipped (or raised) at the receipt
          // insert — report the actual row status.
          return r.status as OrderStatus;
        }
        if (status === "discontinued") {
          // STORE-OWNED (no trigger drives this one): the same update the route service issues.
          if (r.status !== "discontinued") {
            await tx
              .update(OR)
              .set({
                status: "discontinued",
                discontinuedAt: new Date(),
                version: r.version + 1,
                updatedAt: new Date(),
              })
              .where(eq(OR.id, orderId));
          }
          return "discontinued";
        }
        // The seam providers drive exactly three transitions; anything else reaching here is a
        // contract error — refuse loudly rather than becoming an unguarded status mutator (the full
        // §2.2 lifecycle lives in orders-route-service-db.ts behind its guards).
        throw new NotFoundError(
          `OrderSeamStore.applyOrderStatus: unsupported seam-driven status '${status}' (only active / verbal_pending / discontinued are provider-driven)`,
        );
      });
    },
  };
}

/**
 * F-164 (#248) — the org-explicit `patientId`/`kind` lookup M14's "since last IDG" cache consumer needs
 * for `m11.order.discontinued` (whose payload carries neither): a relay tick is not a request, so the
 * published `OrderProvider` seam (which opens every read under `withOrgContextFromRequest`) cannot be
 * called from here — the `encounterIdsForVisitsForOrg` (M8) precedent applied to this module.
 */
export async function orderPatientAndKindForOrg(
  db: DbClient,
  organizationId: string,
  orderId: string,
): Promise<{ readonly patientId: string; readonly kind: string } | null> {
  return withOrgContext(db, { organizationId, userId: ORDER_READER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await tx
      .select({ patientId: OR.patientId, kind: OR.kind })
      .from(OR)
      .where(and(eq(OR.organizationId, organizationId), eq(OR.id, orderId)))
      .limit(1);
    return row ?? null;
  });
}
