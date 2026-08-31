// apps/backend/src/modules/17-scheduling/consumers/index.ts — the M17 outbox-subscription surface (M17-T06,
// spec §4.4). M17's read side of the M8 BIDIRECTIONAL handshake: M17 emits `m17.visit.published` (M8 consumes
// it when an encounter is created against the `visit_id`), and HERE M17 consumes M8's `m8.encounter.signed`
// outbox to drive the visit's terminal `in_visit → completed` transition (§2.2.1 — a visit completes ONLY on
// the encounter-signed consumer, system actor). The pure mapping (`planVisitCompletionFromEncounter`) ships +
// is testable here; the live handler resolves the visit row under RLS, runs the planned `transitionVisit`, and
// runs the §2.4 effect list (history append + `m17.visit.completed` outbox) in the visit's optimistic-locked tx
// when the M17 backend is mounted (routes/services land in M17-T07/T08).
//
// Every consumed event name is a STRING literal (no cross-module schema import): M17 reads M8 solely through the
// foundation outbox, so this task adds NO new edge to M17's manifest `dependsOn` (M8 is already a dependsOn). The
// `m8.encounter.signed` producer exists (Wave E) — this binding is LIVE-eligible. M11's `m11.order_requires_visit`
// and M14's `idg.decision_recorded` (kind `change_visit_frequency`) flow into the proposal queue and are wired by
// the proposal task (M17-T04); the EVV `m18.evv.check_in/out_recorded` advance bindings land with M18 (Wave F).
import { type DbClient, schema } from "@wardenx/db";
import { transitionVisit, VISIT_GRAPH, type VisitEvent, type VisitState } from "@wardenx/scheduling";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { DispatchableOutboxEvent } from "../../../bootstrap/outbox-dispatcher";

const V = schema.visit;
const VSH = schema.visitStateHistory;

/** The fields M17 reads off `m8.encounter.signed` (a subset of M8's LOCKED payload §2.4). `visitId` is OPTIONAL:
 *  an ad-hoc / retroactive encounter signs with NULL `visit_id` and never completes a visit (M17 reconciliation,
 *  M8 D2) — it is not a transition. */
export interface EncounterSignedConsumed {
  readonly encounterId: string;
  readonly patientId: string;
  readonly admissionId?: string;
  /** The visit this encounter was authored against; absent for ad-hoc/retroactive encounters. */
  readonly visitId?: string;
  readonly signedAt: string;
}

/** The pure plan for one consumed `m8.encounter.signed`: complete the linked visit, or a skip reason. */
export type VisitCompletionPlan =
  | {
      readonly kind: "complete";
      readonly visitId: string;
      /** The §2.2.1 system-actor `complete` event the live handler feeds to `transitionVisit(state, event)`. */
      readonly event: Extract<VisitEvent, { type: "complete" }>;
    }
  | {
      readonly kind: "skip";
      readonly reason: "no_visit_link" | "visit_not_found" | "not_completable";
    };

/**
 * §4.4 — map a consumed `m8.encounter.signed` event + the current state of its linked visit to the visit's
 * terminal completion plan (M17-T06). Returns:
 *  - `no_visit_link`   — the encounter had no `visit_id` (ad-hoc/retroactive; M17 reconciliation, never a transition);
 *  - `visit_not_found` — the linked visit row is absent under the consumer's RLS (already erased / cross-tenant);
 *  - `not_completable` — the visit is not in a state that accepts `complete` (only `in_visit` does, per `VISIT_GRAPH`);
 *    the live handler logs this for the EVV/late-checkout reconciliation sweep (D2) rather than forcing a transition;
 *  - `complete`        — the system-actor `complete` event to run through `transitionVisit`.
 * Pure + idempotent: the live handler dedups on `(eventId, consumerName)` per the M1 outbox-consumer pattern, so a
 * re-delivered encounter-signed is a no-op (the visit is already `completed`, which `not_completable` covers).
 */
export function planVisitCompletionFromEncounter(
  event: EncounterSignedConsumed,
  visit: { readonly state: VisitState } | null,
): VisitCompletionPlan {
  if (!event.visitId) return { kind: "skip", reason: "no_visit_link" };
  if (visit === null) return { kind: "skip", reason: "visit_not_found" };
  if (!VISIT_GRAPH[visit.state].includes("complete")) {
    return { kind: "skip", reason: "not_completable" };
  }
  return {
    kind: "complete",
    visitId: event.visitId,
    event: { type: "complete", isSystemActor: true },
  };
}

/** The §4.4 event → M17-consumer bindings. The live dispatcher wires each `eventName` to `consumerName`'s handler
 * at boot; the `m8.encounter.signed` path runs `planVisitCompletionFromEncounter` + `transitionVisit`. Consumer
 * dedup is keyed on `(eventId, consumerName)` per the M1 outbox-consumer pattern; re-delivery is safe. */
export const M17_OUTBOX_SUBSCRIPTIONS = [
  // M8 bidirectional — encounter sign completes the bracketed visit (§2.2.1, system actor).
  { eventName: "m8.encounter.signed", consumerName: "m17.m8-encounter-signed" },
] as const;

export interface M17EncounterSignedOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("m17.m8-encounter-signed: payload must be an object");
  }
  return value as Record<string, unknown>;
}

function stringOf(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m17.m8-encounter-signed: '${key}' must be a non-empty string`);
  }
  return value;
}

function optionalStringOf(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m17.m8-encounter-signed: '${key}' must be a non-empty string when present`);
  }
  return value;
}

function signedPayload(payload: unknown): EncounterSignedConsumed {
  const p = recordOf(payload);
  return {
    encounterId: stringOf(p, "encounterId"),
    patientId: stringOf(p, "patientId"),
    admissionId: optionalStringOf(p, "admissionId"),
    visitId: optionalStringOf(p, "visitId"),
    signedAt: stringOf(p, "signedAt"),
  };
}

export function buildM17EncounterSignedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M17EncounterSignedOutboxPort;
}): {
  readonly consumerName: "m17.m8-encounter-signed";
  readonly consumerModule: "m17";
  readonly eventTypes: readonly ["m8.encounter.signed"];
  handle(event: DispatchableOutboxEvent): Promise<void>;
} {
  return {
    consumerName: "m17.m8-encounter-signed",
    consumerModule: "m17",
    eventTypes: ["m8.encounter.signed"],
    async handle(event) {
      const payload = signedPayload(event.payload);
      if (!payload.visitId) return;
      const visitId = payload.visitId;
      const signedAt = new Date(payload.signedAt);
      if (Number.isNaN(signedAt.getTime())) {
        throw new Error("m17.m8-encounter-signed: signedAt must be a valid ISO instant");
      }

      await withOrgContext(
        deps.db,
        { organizationId: event.organizationId, userId: "" },
        async (txRaw) => {
          const tx = txRaw as DbClient;
          const [visit] = await tx
            .select({
              id: V.id,
              patientId: V.patientId,
              admissionId: V.admissionId,
              status: V.status,
              encounterId: V.encounterId,
              evvBracketState: V.evvBracketState,
              providerEntityId: V.providerEntityId,
              locationId: V.locationId,
              version: V.version,
            })
            .from(V)
            .where(eq(V.id, visitId))
            .limit(1);
          if (!visit) return;
          if (visit.patientId !== payload.patientId) {
            throw new Error("m17.m8-encounter-signed: encounter patient does not match visit");
          }
          if (payload.admissionId && visit.admissionId !== payload.admissionId) {
            throw new Error("m17.m8-encounter-signed: encounter admission does not match visit");
          }
          if (visit.encounterId !== null && visit.encounterId !== payload.encounterId) {
            throw new Error("m17.m8-encounter-signed: visit is already linked to a different encounter");
          }
          if (visit.status === "completed" && visit.encounterId === payload.encounterId) return;

          const plan = planVisitCompletionFromEncounter(payload, {
            state: visit.status as VisitState,
          });
          if (plan.kind !== "complete") return;

          const transition = transitionVisit(visit.status as VisitState, plan.event);
          const [updated] = await tx
            .update(V)
            .set({
              status: transition.to,
              actualEndedAt: signedAt,
              encounterId: payload.encounterId,
              version: sql`${V.version} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(V.id, visitId),
                eq(V.status, "in_visit"),
                sql`${V.encounterId} IS NULL OR ${V.encounterId} = ${payload.encounterId}`,
              ),
            )
            .returning({ id: V.id });
          if (!updated) return;

          await tx.insert(VSH).values({
            organizationId: event.organizationId,
            providerEntityId: visit.providerEntityId,
            locationId: visit.locationId,
            visitId,
            fromState: "in_visit",
            toState: "completed",
            actorMembershipId: null,
            systemSource: "encounter_signed",
            reason: null,
            outboxEventId: event.id,
          });

          await deps.outbox.publish(tx, {
            eventName: "m17.visit.completed",
            organizationId: event.organizationId,
            aggregateKind: "visit",
            aggregateId: visitId,
            payload: {
              visitId,
              completedAt: signedAt.toISOString(),
              encounterId: payload.encounterId,
              evvBracketState: visit.evvBracketState ?? "evv_present",
            },
          });
        },
      );
    },
  };
}
