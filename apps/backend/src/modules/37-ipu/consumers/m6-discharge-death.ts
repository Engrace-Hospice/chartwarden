// apps/backend/src/modules/37-ipu/consumers/m6-discharge-death.ts — the SEPARATE, previously
// catalog-unbindable `m6.discharge.death` consumer `m6-admission-discharged.ts`'s own header names
// (F-172, #248). `transitionAdmission`'s `recordDeath` case (`@wardenx/inpatient`,
// `machines/ipu-admission.ts`) has been a complete, pure, unit-tested transition since M37-T04 — its own
// `isSystemActor` guard's message says outright "recordDeath is driven by the M6 death consumer (system
// actor), never a human route" — and had NO CALLER anywhere outside its own unit test until this file.
// `m6.discharge.death`'s own catalog entry (`06-admission/events-by-m6.ts`) declared only `["m5"]`; `m37`
// is added there in the same change.
//
// WHY THIS EVENT AND NOT `m6.admission.discharged`: `m37.ipu_admission.death_recorded`'s own §2.2 row
// requires the M6 death fact ("the death_event in M6 references this admission"), and `m6.discharge.death`
// carries the real `discharge_event.id` (`dischargeEventId`) that IS that fact — `m6.admission.discharged`
// (M37's already-bound sibling consumer, `m6-admission-discharged.ts`) carries no death-event id at all
// and is a deliberate no-op on `reason === "death"` for exactly this reason (see that file's own header).
//
// NO NEW SEAM: `pronouncingPhysicianId` (`ipu_body_release`, NOT NULL) is M6's `death_certifier_id` —
// enforced present for `dischargeType === "death"` by `checkDischargeNarrative` well before
// `dischargeAdmissionTx` ever runs, so it is a real, already-verified fact at the ONE emit site that can
// ever fire this event, not a guess. Rather than a new M6 seam read (the `admissionSchedulingContextForOrg`
// shape this arc uses elsewhere), the fact is carried on the widened `m6.discharge.death` payload itself
// (`deathCertifierId`) — the F-099/F-100 "the artifact is already in hand at the emit site" precedent.
// `pronouncedAt` (NOT NULL) is reconstructed from `dischargeDate` the identical way M16's own
// `m6-admission-discharged-death.ts` already does for the same underlying fact (F-105's
// `deathCalendarDate` convention: M6 models no time of death, so every value is midnight UTC of the
// entered date) — not a new convention, the existing one applied a third time.
//
// EVERY OTHER FACT `ipu_body_release` NEEDS (`providerEntityId`/`locationId`/`patientId`) is already ON
// `ipu_admission` itself (ARCH-011) — no cross-module read at all, the identical "no seam needed" shape
// `m6-admission-discharged.ts`'s own header documents for `admissionId`.
//
// UNSUPPORTED-STATE CASCADES ARE NOT GUESSED AT, the `m6-admission-discharged.ts` precedent verbatim:
// the §2.2 `ADMISSION_GRAPH` accepts `recordDeath` only from `active` — this consumer calls the SAME
// `transitionAdmission` the (still-unbuilt) route layer would with no pre-check on state, so a death
// recorded against an IPU stay that is still `pending`/`bed_pending`/`bed_assigned`/`transferring` throws
// the machine's own typed `IpuStateError` (`ILLEGAL_ADMISSION_TRANSITION`) and dead-letters for a human
// rather than being silently accepted or skipped.
//
// IDEMPOTENCY VIA THE REAL VERSION COLUMN, the `m6-admission-discharged.ts` precedent again: the guarded
// `ipu_admission` UPDATE conditions its WHERE on `version = <the version just read>`, CAS-style, and only
// a winning UPDATE proceeds to the rest of the effect list. A genuine redelivery after the first delivery
// already committed never re-matches the initial SELECT at all — `deceased` is not in
// `OPEN_ADMISSION_STATES`, so a fully-applied death is skipped outright, and `ipu_body_release`'s own
// `body_release_one_per_admission` unique index is never at risk of a double insert because the whole
// admission-plus-body-release write happens in ONE transaction per admission (all-or-nothing).
//
// SYSTEM ACTOR: reuses the same fixed M37 sentinel `m6-admission-discharged.ts` established
// (`M37_WORKER_SYSTEM_USER_ID` in `jobs/cron-workers.ts`, restated here for the same reason that file
// restates it rather than importing across an unrelated module) — `ipu_admission_state_history
// .by_membership_id` is `uuid NOT NULL` with no FK (D17), so the F-102 empty-string `CONSUMER_USER_ID`
// convention (valid for the `withOrgContext` text GUC, not this column) does not apply to it.
//
// M16 DELIBERATELY DOES NOT CONSUME THE DOWNSTREAM `m37.ipu_admission.death_recorded` EVENT THIS
// CONSUMER NOW PUBLISHES: checked directly against both of M16's real M6-sourced death consumers
// (`16-bereavement/outbox-consumers/m6-bereavement-eligible.ts`, `m6-admission-discharged-death.ts`) —
// both are keyed off the SAME `m6.discharge.death`/`m6.admission.discharged` transaction this consumer
// itself reacts to, so M16's bereavement intake already has every fact (patientId, admissionId) it needs
// no later than this consumer's own delivery, regardless of whether an IPU stay was ever involved. A
// third M16 path off `death_recorded` would be strictly redundant — see that event's own catalog entry
// (`events-by-m37.ts`) for the drop.
import { type DbClient, schema } from "@wardenx/db";
import { planOpenBodyRelease, transitionAdmission } from "@wardenx/inpatient";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { WriteOutboxPort } from "../routes/service-drizzle";

const A = schema.ipuAdmission;
const H = schema.ipuAdmissionStateHistory;
const BR = schema.ipuBodyRelease;

/** Mirrors `M37_WORKER_SYSTEM_USER_ID` (`../jobs/cron-workers.ts`) and
 *  `m6-admission-discharged.ts`'s own identical constant — see file header. */
const M37_SYSTEM_MEMBERSHIP_ID = "00000000-0000-0000-0000-000000000037";
/** The `withOrgContext` session-GUC actor for a consumer-driven write (F-102's `CONSUMER_USER_ID`
 *  convention — a plain text session variable, distinct from the `uuid NOT NULL` column above). */
const CONSUMER_USER_ID = "";

/** The non-terminal `ipu_admission_state` values a death recording may still find (§2.2 `ADMISSION_GRAPH`
 *  keys minus `discharged`/`transferred`/`deceased`/`closed`, which are already exited/terminal) —
 *  mirrors `m6-admission-discharged.ts`'s own `OPEN_ADMISSION_STATES`. */
const OPEN_ADMISSION_STATES = [
  "pending",
  "bed_pending",
  "bed_assigned",
  "active",
  "transferring",
] as const;

export const M37_DEATH_RECORDED_CONSUMER = {
  eventName: "m6.discharge.death",
  consumerName: "m37.death-recorded",
} as const;

export interface DeathRecordedConsumerDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${M37_DEATH_RECORDED_CONSUMER.consumerName}: '${key}' must be a non-empty string`,
    );
  }
  return value;
}

function factsOf(payload: unknown): {
  dischargeEventId: string;
  admissionId: string;
  dischargeDate: string;
  /** F-227 — null for an external (M29) death: the sending facility pronounced it, M6 names no physician. */
  deathCertifierId: string | null;
} {
  const record = (payload ?? {}) as Record<string, unknown>;
  return {
    dischargeEventId: stringOf(record, "dischargeEventId"),
    admissionId: stringOf(record, "admissionId"),
    dischargeDate: stringOf(record, "dischargeDate"),
    deathCertifierId:
      typeof record.deathCertifierId === "string" && record.deathCertifierId.length > 0
        ? record.deathCertifierId
        : null,
  };
}

/**
 * M37's live `m6.discharge.death` binding (§2.2 row 178). Drives `recordDeath` on every still-open
 * `ipu_admission` hanging off the M6 admission that just died, auto-opening its `ipu_body_release` row.
 */
export function buildM37DeathRecordedConsumer(deps: DeathRecordedConsumerDeps) {
  return {
    consumerName: M37_DEATH_RECORDED_CONSUMER.consumerName,
    consumerModule: "m37" as const,
    eventTypes: [M37_DEATH_RECORDED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      // F-105's `deathCalendarDate` convention: M6 models no time of death — `discharge_event.death_at`
      // is itself written as `new Date(dischargeDate)` (midnight UTC of the entered date) at the one
      // real emit site, so reconstructing it here from the identical field reproduces that exact instant
      // rather than approximating a different one.
      const pronouncedAt = new Date(facts.dischargeDate);
      if (Number.isNaN(pronouncedAt.getTime())) {
        throw new Error(
          `${M37_DEATH_RECORDED_CONSUMER.consumerName}: malformed dischargeDate '${facts.dischargeDate}'`,
        );
      }

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const candidateAdmissions = await tx
            .select()
            .from(A)
            .where(and(eq(A.organizationId, organizationId), eq(A.admissionId, facts.admissionId)));

          for (const admission of candidateAdmissions) {
            if (!(OPEN_ADMISSION_STATES as readonly string[]).includes(admission.state)) continue; // already terminal (or already deceased)

            // Pure, IO-free: throws IpuStateError ILLEGAL_ADMISSION_TRANSITION for any state other than
            // `active` (pending/bed_pending/bed_assigned/transferring have no `recordDeath` edge — file
            // header). Left to propagate and dead-letter rather than guessed at.
            const transition = transitionAdmission(admission.state, admission.kind, {
              type: "recordDeath",
              // The event ITSELF is the proof, the `m6-admission-discharged.ts` precedent: this consumer
              // IS the M6 death-event subscriber, and `admission.admissionId === facts.admissionId` was
              // already the SELECT's own filter.
              deathEventReferencesAdmission: true,
              isSystemActor: true,
            });

            // CAS on the version this read saw. A lost race (concurrent delivery) or a genuine redelivery
            // that arrives after an earlier delivery already committed both resolve to zero rows updated.
            const [updated] = await tx
              .update(A)
              .set({
                state: transition.to as never,
                deathEventId: facts.dischargeEventId,
                updatedAt: new Date(),
                version: admission.version + 1,
              })
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
                  reason: "death",
                });
              } else if (eff.kind === "open_body_release" && facts.deathCertifierId !== null) {
                // F-227 — with no pronouncing physician (external death) the NOT NULL
                // `pronouncing_physician_id` cannot be filled honestly: the admission still moves to
                // `deceased` above, but no body-release row is auto-opened (the fabricated alternative is worse).
                // Every fact `ipu_body_release` needs beyond the death itself is already ON `ipu_admission`
                // (ARCH-011) — no cross-module read (see file header).
                const [br] = await tx
                  .insert(BR)
                  .values({
                    organizationId,
                    ipuAdmissionId: admission.id,
                    providerEntityId: admission.providerEntityId,
                    locationId: admission.locationId,
                    patientId: admission.patientId,
                    deathEventId: facts.dischargeEventId,
                    pronouncingPhysicianId: facts.deathCertifierId,
                    pronouncedAt,
                  })
                  .returning({ id: BR.id });
                if (!br) {
                  throw new Error(
                    `${M37_DEATH_RECORDED_CONSUMER.consumerName}: ipu_body_release insert returned no row`,
                  );
                }
                // `planOpenBodyRelease()` is pure and IO-free (no facts to inject) — the `[*] → pending`
                // edge, emitting `m37.body_release.pending`.
                const bodyReleaseTransition = planOpenBodyRelease();
                for (const brEff of bodyReleaseTransition.effects) {
                  if (brEff.kind === "outbox") {
                    await deps.outbox.publish(tx, {
                      eventName: brEff.event,
                      organizationId,
                      aggregateKind: "ipu_body_release",
                      aggregateId: br.id,
                      payload: {
                        ipuAdmissionId: admission.id,
                        organizationId,
                        bodyReleaseId: br.id,
                      },
                    });
                  }
                  // `state` needs no interpreter here — the row above was already INSERTed with the
                  // machine's own `to` value (`pending`, the schema column's own default and the only
                  // value this transition ever produces).
                }
              } else if (eff.kind === "outbox") {
                await deps.outbox.publish(tx, {
                  eventName: eff.event,
                  organizationId,
                  aggregateKind: "ipu_admission",
                  aggregateId: admission.id,
                  payload: {
                    ipuAdmissionId: admission.id,
                    organizationId,
                    deathEventId: facts.dischargeEventId,
                  },
                });
              }
              // `defer_bed_dirty_until_body_release` needs no interpreter: its entire job is that no
              // `source_bed_cleaning` effect fires on THIS transition (the machine's own effect list for
              // `recordDeath` never includes one — §2.11: the bed stays occupied until release completes).
            }
          }
        },
      );
    },
  };
}
