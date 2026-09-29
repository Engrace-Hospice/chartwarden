// apps/backend/src/modules/06-admission/outbox-consumers/m11-level-of-care-change-signed.ts — the live
// `m11.order.level_of_care_change_signed` → §2.3.5 LCP transition binding (F-155/F-159, #248).
//
// M11 D9 (WARDENX_MODULE_11_ORDERS_SPEC §11): "Level-of-care-change orders are advisory; M6 owns the
// `level_of_care_period` state machine. M11 emits `m11.order.level_of_care_change_signed`; M6 subscribes
// and runs its LCP transition. M11 never writes `level_of_care_period`." Nothing ever bound it —
// `changeLoc` (admission-route-service-db.ts) is the only write path and has always been an HTTP-route
// call, never an outbox consumer.
//
// F-143/F-155 (#248) recorded the reason this stayed unbound for two prior passes: `changeLoc` "closes
// the prior open LOC (§2.3.5 side effect) BEFORE inserting the new one" with NO idempotency key — a
// genuine redelivery of the same catalogued event (the dispatcher retries a thrown handler up to
// maxAttempts=8) would silently open a second/third LOC period for the same signed order. Migration 0250
// adds `level_of_care_period.source_order_id` (a LOGICAL uuid — M6's `dependsOn` excludes 11, so no SQL
// FK crosses the boundary) + a plain `UNIQUE(organization_id, source_order_id)` constraint, the M25
// `denial_case.source_idempotency_key` / migration 0249 precedent (NULLS DISTINCT by default, so every
// clinician-initiated LOC change — which never sets this column — coexists freely; only order-triggered
// rows are ever constrained against each other).
//
// This consumer does NOT call `changeLoc` — that route-shaped function has no parameter for the new
// idempotency column, and widening its signature is shared-file work (`admission-route-service-db.ts`,
// `routes/service.ts`) outside this isolated-file build's scope (per this pass's instructions). Instead
// it calls the SAME pure `transitionLevelOfCare` machine `changeLoc` calls, and performs the identical
// close-then-insert sequence directly via Drizzle — the F-158 M37 "call the pure machine directly rather
// than the HTTP-route-shaped path" precedent.
//
// **A REAL, SEPARATE GAP THIS CONSUMER REFUSES RATHER THAN GUESSES AT**: the catalogued
// `m11.order.level_of_care_change_signed` payload (events-by-m11.ts) is `{orderId, fromLevel, toLevel,
// effectiveAt, admissionId}` — no `facilityId` and no `clinicalJustification`. `transitionLevelOfCare`'s
// `requestAssign` guard REQUIRES a non-null `facilityId` for `inpatient_respite_care`/
// `general_inpatient_care` (`needsIpuBed`) and, for `general_inpatient_care` specifically, a
// `reason` of ≥30 chars (`TEXT_MINIMUMS.gipDocumentation`, state-machines/validation.ts). Neither fact is
// available here: M11's own `level_of_care_change` order-kind schema (packages/orders/src/kinds.ts) has
// no facility field AT ALL (so M11 cannot even collect it at order-authoring time — a genuine missing
// M11-side capability, not a payload-widening fix), and `clinicalJustification` (which the order kind
// DOES capture, ≥20 chars) is captured by M11 but dropped from the catalogued signed-event payload. This
// consumer therefore calls the machine with `facilityId: null, reason: ""` for every level, honestly —
// `routine_home_care`/`continuous_home_care` transitions (which need neither fact) succeed; `irc`/`gip`
// transitions deterministically throw the machine's own typed `IPU_FACILITY_REQUIRED` guard and
// dead-letter after retries, a correct, non-destructive refusal rather than a fabricated facility or
// padded-out "clinical justification" string. Reported, not fixed: an IRC/GIP-directed signed order can
// never satisfy §2.3.5's guards via this consumer until M11 gains a facility field on the order kind AND
// widens the catalogued payload to carry `clinicalJustification` — both real, scoped, future M11-side
// changes.
//
// `fromLevel`/`toLevel` on the wire are M11's short codes (`rhc`/`chc`/`irc`/`gip`, packages/orders/src/
// kinds.ts's `level` union); M6's `LevelOfCare` enum is long-form (`routine_home_care`/
// `continuous_home_care`/`inpatient_respite_care`/`general_inpatient_care`, packages/db/src/enums.ts).
// `M11_TO_M6_LEVEL` is the one-line translation table F-155 named as "fixable in an isolated file."
//
// The event name is a STRING literal and no M11 schema is imported — M6 reads M11 solely through the
// foundation outbox (the `m22-document-rendered.ts` / `m29-proposal-accepted.ts` precedent one file
// over), so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import type { LevelOfCare } from "@wardenx/types";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AdmissionWriteOutboxPort } from "../admission-route-service-db";
import { transitionLevelOfCare } from "../state-machines/level-of-care";

export const M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER = {
  eventName: "m11.order.level_of_care_change_signed",
  consumerName: "m6.level-of-care-change-signed",
} as const;

/** Structural binding (matches the dispatcher's `OutboxConsumerBinding` without importing bootstrap). */
export interface M6LevelOfCareChangeSignedConsumerBinding {
  readonly consumerName: typeof M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName;
  readonly consumerModule: "m6";
  readonly eventTypes: readonly [typeof M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.eventName];
  handle(event: { readonly organizationId: string; readonly payload: unknown }): Promise<void>;
}

export interface M6LevelOfCareChangeSignedConsumerDeps {
  readonly db: DbClient;
  readonly outbox: AdmissionWriteOutboxPort;
}

/** M11's short LOC codes (packages/orders/src/kinds.ts's `level` union) → M6's long-form `LevelOfCare`
 *  enum (packages/db/src/enums.ts). */
const M11_TO_M6_LEVEL: Readonly<Record<string, LevelOfCare>> = {
  rhc: "routine_home_care",
  chc: "continuous_home_care",
  irc: "inpatient_respite_care",
  gip: "general_inpatient_care",
};

interface Payload {
  readonly orderId: string;
  readonly toLevel: string;
  readonly effectiveAt: string;
  readonly admissionId: string;
}

function payloadOf(payload: unknown): Payload {
  const p = (payload ?? {}) as Record<string, unknown>;
  const orderId = p.orderId;
  const toLevel = p.toLevel;
  const effectiveAt = p.effectiveAt;
  const admissionId = p.admissionId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error(`${M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName}: payload has no orderId`);
  }
  if (typeof toLevel !== "string" || toLevel.length === 0) {
    throw new Error(`${M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName}: payload has no toLevel`);
  }
  if (typeof effectiveAt !== "string" || effectiveAt.length === 0) {
    throw new Error(
      `${M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName}: payload has no effectiveAt`,
    );
  }
  if (typeof admissionId !== "string" || admissionId.length === 0) {
    throw new Error(
      `${M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName}: payload has no admissionId`,
    );
  }
  return { orderId, toLevel, effectiveAt, admissionId };
}

/** The dispatcher's own system-attribution convention (F-102) for a consumer-driven write with no human
 *  actor. */
const CONSUMER_USER_ID = "";

/** Build the live `m11.order.level_of_care_change_signed` consumer the composition root registers with
 *  the outbox dispatcher. */
export function buildM6LevelOfCareChangeSignedConsumer(
  deps: M6LevelOfCareChangeSignedConsumerDeps,
): M6LevelOfCareChangeSignedConsumerBinding {
  const LOC = schema.levelOfCarePeriods;
  const ADM = schema.admissions;

  return {
    consumerName: M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName,
    consumerModule: "m6" as const,
    eventTypes: [M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.eventName] as const,
    async handle(event) {
      const { orderId, toLevel, effectiveAt, admissionId } = payloadOf(event.payload);
      const organizationId = event.organizationId;
      const level = M11_TO_M6_LEVEL[toLevel];
      if (!level) {
        // Refuse rather than guess — an unrecognized code is an M11/M6 vocabulary drift, not a business
        // outcome. Dead-letters after retries for a human to investigate.
        throw new Error(
          `${M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName}: unrecognized M11 level code '${toLevel}'`,
        );
      }

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
        // Idempotency pre-check — see file header. Must run BEFORE the close-update below: if this
        // event was already fully applied (an ordinary at-least-once redelivery, not a true concurrent
        // race), the admission's currently-open period IS the one this order already created, and
        // touching it again would wrongly re-close it with nothing to reopen it.
        const [already] = await tx
          .select({ id: LOC.id })
          .from(LOC)
          .where(and(eq(LOC.organizationId, organizationId), eq(LOC.sourceOrderId, orderId)))
          .limit(1);
        if (already) return; // idempotent skip — already applied

        const [adm] = await tx
          .select({ status: ADM.status })
          .from(ADM)
          .where(eq(ADM.id, admissionId))
          .limit(1);
        if (!adm) {
          // Refuse rather than guess — an order-signed event for an admission M6 cannot resolve is a
          // genuine integration defect or a cross-tenant mismatch, not a business outcome.
          throw new Error(
            `${M6_LEVEL_OF_CARE_CHANGE_SIGNED_CONSUMER.consumerName}: no admission ${admissionId} in org ${organizationId}`,
          );
        }

        // The same pure §2.3.5 guard `changeLoc` runs — may throw ILLEGAL_TRANSITION /
        // IPU_FACILITY_REQUIRED / GIP_DOCUMENTATION_INSUFFICIENT / LEVEL_OF_CARE_OVERLAP (see file
        // header for the honest irc/gip refusal). `wouldOverlap: false` mirrors `changeLoc`'s own
        // hardcoded value — no overlap-detection input exists on either path today.
        const t = transitionLevelOfCare("pending", {
          type: "requestAssign",
          level,
          admissionActiveOrOnHold: adm.status === "active" || adm.status === "on_hold",
          facilityId: null,
          wouldOverlap: false,
          reason: "",
        });
        const to = t.to;

        const now = new Date();
        // Close the prior open LOC (§2.3.5 side effect) — a no-op if nothing is open, or if a
        // concurrent delivery already closed it (see below).
        await tx
          .update(LOC)
          .set({ endedAt: now, status: "ended", version: sql`${LOC.version} + 1`, updatedAt: now })
          .where(and(eq(LOC.admissionId, admissionId), isNull(LOC.endedAt)));

        const [inserted] = await tx
          .insert(LOC)
          .values({
            organizationId,
            admissionId,
            levelOfCare: level,
            status: to === "assigning" ? "assigning" : "active",
            facilityId: null,
            reason: "",
            effectiveAt: new Date(effectiveAt),
            sourceOrderId: orderId,
          })
          .onConflictDoNothing({ target: [LOC.organizationId, LOC.sourceOrderId] })
          .returning({ id: LOC.id });

        if (!inserted) {
          // Lost a true concurrent race against another delivery of this same event — the winner
          // already inserted (and will publish) under this orderId; the close above was a safe no-op
          // against its own already-closed prior period. Nothing further to do.
          return;
        }

        // No outbox event while `assigning` — mirrors `changeLoc`: nothing downstream should treat an
        // unconfirmed IPU request as a real period of care yet (`confirmLocBedAssignment` publishes
        // `m6.loc.changed` once real — out of scope here since irc/gip never reach `assigning` via this
        // consumer today, see file header, but the guard is kept for when the facility gap is fixed).
        if (to !== "assigning") {
          await deps.outbox.publish(tx, {
            eventName: "m6.loc.changed",
            payload: {
              levelOfCarePeriodId: inserted.id,
              newLevel: level,
              effectiveStart: new Date(effectiveAt).toISOString(),
              admissionId,
            },
            organizationId,
            aggregateKind: "level_of_care_period",
            aggregateId: inserted.id,
          });
        }
      });
    },
  };
}
