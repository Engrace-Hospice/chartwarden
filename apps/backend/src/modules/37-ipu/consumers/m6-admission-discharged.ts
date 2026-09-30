// apps/backend/src/modules/37-ipu/consumers/m6-admission-discharged.ts — M37's §4.5 "If patient has open
// `ipu_admission` → cascade-discharge" subscription, live for the first time (F-156-followup, #248).
//
// `transitionAdmission`'s `discharge` case (`@wardenx/inpatient`, `machines/ipu-admission.ts`) has been a
// complete, pure, unit-tested transition since M37-T04 — the SAME machine the route-driven `discharge()`
// op in `../routes/service-drizzle.ts` already calls. M37's own §4.5 table names this event with a
// designated (but never built) consumer file, `m6-admission-discharged.ts`, and no `consumers/` directory
// existed anywhere under `37-ipu/` until this file — the FIRST outbox consumer this module has ever had.
//
// NO SEAM READ NEEDED, unlike the M13/M16 precedents this arc built for the SAME `m6.admission.discharged`
// event (F-155/F-151): `ipu_admission.admission_id` is already a real (if logical, D17) column on M37's
// own row — the M6 admission id the catalogued `{admissionId, reason, dischargeDate}` payload carries IS
// the FK M37 already stores, so the target row (and its `patient_id`) is resolved with a plain query
// against M37's own table under the caller's `withOrgContext`, never a cross-module read.
//
// REASON FILTER, the opposite of M13's F-155 sibling: `dischargeAdmissionTx` (M6) fires
// `m6.admission.discharged` for EVERY discharge reason, including `death`, and co-emits `m6.discharge.death`
// in the SAME transaction whenever it does. M37's own catalog entry for `m37.ipu_admission.discharged`
// (`events-by-m37.ts`) already documents why this consumer must not treat a death discharge as an ordinary
// one: "M37's own outbox table conditions M30's inclusion on 'mortality if death is the discharge reason —
// but use `death_recorded` for death'" (F-149) — `.discharged` is reserved for every OTHER reason, and the
// death path is `recordDeath` → `m37.ipu_admission.death_recorded`, driven by the SEPARATE (still
// catalog-unbindable: `m37` is not yet a declared consumer of `m6.discharge.death`, reported below, not
// fixed here) `m6-discharge-death.ts` consumer M37's own §4.5 table also names. Running `discharge()` on a
// death would emit the WRONG outbox event (`.discharged` instead of `.death_recorded`) and would race the
// (currently unbuildable) death consumer for the same row — so `reason === "death"` is a deliberate,
// documented no-op here, not an oversight.
//
// UNSUPPORTED-STATE CASCADES ARE NOT GUESSED AT: the §2.2 `ADMISSION_GRAPH` accepts `discharge` only from
// `active` (bed_assigned/pending/bed_pending/transferring have no `discharge` edge — inventing one, or a
// silent no-op, is exactly the "guess at business logic" this arc's discipline refuses). This consumer
// calls the SAME `transitionAdmission` the route layer calls with no pre-check on state, so a discharged M6
// admission whose IPU stay is still `pending`/`bed_pending`/`bed_assigned`/`transferring` throws the
// machine's own typed `IpuStateError` (`ILLEGAL_ADMISSION_TRANSITION`) and dead-letters for a human, the
// F-151 precedent (M16's `proposed`-contact case) applied to this module.
//
// IDEMPOTENCY VIA A REAL VERSION COLUMN (unlike M13's F-155 sibling, which has none on its target tables):
// the guarded `ipu_admission` UPDATE conditions its WHERE on `version = <the version just read>`, CAS-style,
// and only a winning UPDATE proceeds to apply the transition's other effects (state-history row, source-bed
// cleaning transition, IRC-episode close, the outbox emit) — a lost race or a genuine redelivery after the
// first delivery already committed both resolve to zero rows updated and a silent skip. A redelivery after
// a full commit additionally never re-matches the SELECT below at all, because it filters out every
// terminal/closed state.
//
// SYSTEM ACTOR: `by_membership_id` on `ipu_admission_state_history` is `uuid NOT NULL` with NO FK
// constraint (`packages/db/src/schema/ipu/admission.ts`'s own header: "Cross-module ids … are logical
// uuids — M37 never FKs into other modules' schema (D17)"), so the F-102 empty-string `CONSUMER_USER_ID`
// convention (valid for a text GUC, not a `uuid NOT NULL` column) does not apply here. Reuses the literal
// M37 already established for exactly this purpose in `jobs/cron-workers.ts`'s
// `M37_WORKER_SYSTEM_USER_ID` (not exported there, so restated here rather than importing across an
// unrelated file) — a fixed, module-scoped sentinel rather than a fresh one, so every system-attributed
// M37 write shares one identifiable non-human actor.
import { type DbClient, schema } from "@wardenx/db";
import { transitionAdmission, transitionBedCleaning } from "@wardenx/inpatient";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import type { WriteOutboxPort } from "../routes/service-drizzle";

const A = schema.ipuAdmission;
const H = schema.ipuAdmissionStateHistory;
const BA = schema.ipuBedAssignment;
const B = schema.ipuBed;
const BCE = schema.ipuBedCleaningEvent;
const IE = schema.ircEpisode;

/** Mirrors `M37_WORKER_SYSTEM_USER_ID` (`../jobs/cron-workers.ts`) — see file header. */
const M37_SYSTEM_MEMBERSHIP_ID = "00000000-0000-0000-0000-000000000037";
/** The `withOrgContext` session-GUC actor for a consumer-driven write (F-102's `CONSUMER_USER_ID`
 *  convention — a plain text session variable, distinct from the `uuid NOT NULL` column above). */
const CONSUMER_USER_ID = "";

/** The non-terminal `ipu_admission_state` values a cascade-discharge may still find (§2.2 `ADMISSION_GRAPH`
 *  keys minus `discharged`/`transferred`/`deceased`/`closed`, which are already exited/terminal). */
const OPEN_ADMISSION_STATES = [
  "pending",
  "bed_pending",
  "bed_assigned",
  "active",
  "transferring",
] as const;

export const M37_ADMISSION_DISCHARGED_CONSUMER = {
  eventName: "m6.admission.discharged",
  consumerName: "m37.admission-discharged-cascade",
} as const;

export interface AdmissionDischargedConsumerDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
}

function factsOf(payload: unknown): { admissionId: string; reason: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const admissionId = p.admissionId;
  const reason = p.reason;
  if (typeof admissionId !== "string" || admissionId.length === 0) {
    throw new Error(`${M37_ADMISSION_DISCHARGED_CONSUMER.consumerName}: payload has no admissionId`);
  }
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error(`${M37_ADMISSION_DISCHARGED_CONSUMER.consumerName}: payload has no reason`);
  }
  return { admissionId, reason };
}

/**
 * M37's live `m6.admission.discharged` binding (§4.5). Cascade-discharges every still-open `ipu_admission`
 * hanging off the M6 admission that just discharged, EXCEPT a death (see file header) — which the separate,
 * currently catalog-unbindable `m6-discharge-death.ts` consumer owns.
 */
export function buildM37AdmissionDischargedConsumer(deps: AdmissionDischargedConsumerDeps) {
  return {
    consumerName: M37_ADMISSION_DISCHARGED_CONSUMER.consumerName,
    consumerModule: "m37" as const,
    eventTypes: [M37_ADMISSION_DISCHARGED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      // Death discharges are NOT this consumer's job — see file header.
      if (facts.reason === "death") return;

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const openAdmissions = await tx
          .select()
          .from(A)
          .where(
            and(
              eq(A.organizationId, organizationId),
              eq(A.admissionId, facts.admissionId),
              // Drizzle has no `notInArray` shorthand imported here on purpose — an explicit OR-of-`eq`
              // list keeps the "which states are open" fact in ONE place (the const above) rather than
              // spread across an inArray-vs-notInArray inversion.
            ),
          );

        for (const admission of openAdmissions) {
          if (!(OPEN_ADMISSION_STATES as readonly string[]).includes(admission.state)) continue; // already terminal

          // Pure, IO-free: throws IpuStateError ILLEGAL_ADMISSION_TRANSITION for a non-`active` open state
          // (pending/bed_pending/bed_assigned/transferring have no `discharge` edge — file header). Left
          // to propagate and dead-letter rather than guessed at.
          const transition = transitionAdmission(admission.state, admission.kind, {
            type: "discharge",
            // The event ITSELF is the proof — `dischargeAdmissionTx` only ever fires
            // `m6.admission.discharged` after the M6 admission row has already been updated to a
            // discharged state in the SAME transaction.
            m6AdmissionDischarged: true,
          });

          // CAS on the version this read saw. A lost race (concurrent delivery) or a genuine redelivery
          // that arrives after an earlier delivery already committed both resolve to zero rows updated.
          const [updated] = await tx
            .update(A)
            .set({ state: transition.to as never, updatedAt: new Date(), version: admission.version + 1 })
            .where(and(eq(A.id, admission.id), eq(A.version, admission.version)))
            .returning({ id: A.id });
          if (!updated) continue;

          for (const eff of transition.effects) {
            if (eff.kind === "state_history") {
              await tx.insert(H).values({
                organizationId,
                ipuAdmissionId: admission.id,
                fromState: transition.from,
                toState: eff.to,
                byMembershipId: M37_SYSTEM_MEMBERSHIP_ID,
                reason: facts.reason,
              });
            } else if (eff.kind === "source_bed_cleaning") {
              // The active (unended) bed assignment for this admission, if any — an `arranged` (remote)
              // admission has none (`ipu_admission_unit_xor_remote`), and the discharge effect list for
              // one carries no `source_bed_cleaning` entry to begin with, so this loop body simply never
              // runs for that kind.
              const [ba] = await tx
                .select({ bedId: BA.bedId })
                .from(BA)
                .where(and(eq(BA.ipuAdmissionId, admission.id), isNull(BA.endedAt)))
                .limit(1);
              if (!ba) continue;
              const [bed] = await tx.select().from(B).where(eq(B.id, ba.bedId)).limit(1);
              if (!bed) continue;
              const bedResult = transitionBedCleaning(bed.cleaningStatus as never, eff.event);
              await tx
                .update(B)
                .set({ cleaningStatus: bedResult.to, cleaningStatusChangedAt: new Date() })
                .where(eq(B.id, bed.id));
              await tx.insert(BCE).values({
                organizationId,
                bedId: bed.id,
                fromStatus: bedResult.from,
                toStatus: bedResult.to,
                byMembershipId: M37_SYSTEM_MEMBERSHIP_ID,
              });
            } else if (eff.kind === "close_irc_episode") {
              await tx
                .update(IE)
                .set({ state: "closed", closedAt: new Date(), closureReason: facts.reason })
                .where(and(eq(IE.organizationId, organizationId), eq(IE.ipuAdmissionId, admission.id)));
            } else if (eff.kind === "outbox") {
              await deps.outbox.publish(tx, {
                eventName: eff.event,
                organizationId,
                aggregateKind: "ipu_admission",
                aggregateId: admission.id,
                payload: {
                  ipuAdmissionId: admission.id,
                  organizationId,
                  reason: facts.reason,
                },
              });
            }
            // `persist_bed_assignment` / `defer_bed_dirty_until_body_release` / `open_body_release` /
            // `open_irc_episode` never appear in `discharge`'s effect list — no branch needed for them.
          }
        }
      });
    },
  };
}
