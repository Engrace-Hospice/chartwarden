// apps/backend/src/modules/39-consent/m5-patient-deceased-consumer.ts — M39 §7.7 / D13 (GAP-110).
//
// `m5.patient.deceased` → every ACTIVE consent of the decedent that does not survive death transitions to
// `expired`, one `m39.consent.expired` per row, in ONE transaction.
//
// SEAM PULL OR OUTBOX PUSH? M39's own spec decides: §4.6 and the §7.7 W-CON-07 walkthrough name an OUTBOX
// consumer (`m5-patient-deceased.ts`, job `m39-m5-patient-deceased`, "Transition active non-survives-death
// consents to `expired` per D13"), and `consumed-seams.ts` records that `PatientReader` has no deceased
// signal. Until this consumer was bound, `createDbConsentStore.isPatientDeceased` answered `false`
// unconditionally and nothing flipped the rows, so a consent that should have ended at death kept
// authorizing PHI egress to its recipients (M22 disclosure subsetter, M28 egress). The status flip is the
// durable fact the evaluator reads (`pickGoverning` only lets an `active` row govern), so the evaluator
// needs no second, per-call death probe: the `expired` status IS the D13 termination.
//
// THE PAYLOAD IS A TRIGGER, NOT A DATA FEED. The org id comes from the M1 outbox envelope the dispatcher
// runs under; the payload's own org id (when present) must agree with it or the delivery dead-letters. The
// consent rows are read back under RLS, never trusted from the event.
//
// IDEMPOTENT. Candidates are `status = 'active'` only and the UPDATE repeats the guard, so a redelivery
// finds nothing to flip and emits nothing. Rows are locked `FOR UPDATE` so a concurrent revoke/supersede
// either wins (the row is no longer active and is skipped) or waits.
//
// RENEWAL SAFETY. When another consent of the same type that SURVIVES death stays active,
// `remainingActiveConsentRecordId` rides the event so M5's privacy-snapshot consumer keeps the flag lifted
// instead of re-restricting SUD (the same contract as the expiration cron).
import {
  type ConsentTypeKey,
  consentTerminatesOnDeath,
  decideDeceasedConsentExpiry,
} from "@wardenx/consent";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../bootstrap/outbox-dispatcher";
import type { ConsentWriteOutboxPort } from "./consent-store-db";

const CR = schema.consentRecord;

export const M39_PATIENT_DECEASED_CONSUMER_NAME = "m39-m5-patient-deceased";

/** One active consent as the D13 decision reads it. */
export interface DeceasedConsentRow {
  readonly id: string;
  readonly typeKey: ConsentTypeKey;
  readonly status: string;
  readonly survivesDeath: boolean;
}

/** The consent writes the consumer needs, scoped to ONE org transaction. */
export interface DeceasedConsentTx {
  /** The patient's `active` consents, locked for update. */
  lockActiveConsents(patientId: string): Promise<readonly DeceasedConsentRow[]>;
  /** `active → expired`; false when the row lost a race (no longer active). */
  expire(consentRecordId: string, at: Date): Promise<boolean>;
  publishExpired(payload: Record<string, unknown>, consentRecordId: string): Promise<void>;
}

export interface DeceasedConsentUnitOfWork {
  run<T>(organizationId: string, fn: (tx: DeceasedConsentTx) => Promise<T>): Promise<T>;
}

/** The row ids to expire and, per row, the same-type survivor that keeps the privacy flag lifted. */
export function planDeceasedExpiry(rows: readonly DeceasedConsentRow[]): readonly {
  readonly id: string;
  readonly typeKey: ConsentTypeKey;
  readonly remainingActiveConsentRecordId: string | null;
}[] {
  const expiring = new Set(decideDeceasedConsentExpiry(rows));
  return rows
    .filter((r) => expiring.has(r.id))
    .map((r) => ({
      id: r.id,
      typeKey: r.typeKey,
      remainingActiveConsentRecordId:
        rows.find(
          (o) =>
            o.id !== r.id &&
            o.typeKey === r.typeKey &&
            o.status === "active" &&
            !consentTerminatesOnDeath(o.typeKey, o.survivesDeath),
        )?.id ?? null,
    }));
}

/** Validate the delivery and return the decedent. Throws (dead-letters) on a malformed or cross-org event. */
export function parseDeceasedEvent(event: {
  readonly organizationId: string;
  readonly payload: unknown;
}): { readonly organizationId: string; readonly patientId: string } {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : null;
  if (payload === null) throw new Error(`${M39_PATIENT_DECEASED_CONSUMER_NAME}: payload missing`);
  const patientId = payload.patientId;
  if (typeof patientId !== "string" || patientId.length === 0) {
    throw new Error(
      `${M39_PATIENT_DECEASED_CONSUMER_NAME}: 'patientId' must be a non-empty string`,
    );
  }
  if (payload.organizationId !== undefined && payload.organizationId !== event.organizationId) {
    throw new Error(
      `${M39_PATIENT_DECEASED_CONSUMER_NAME}: payload organization does not match the outbox envelope`,
    );
  }
  return { organizationId: event.organizationId, patientId };
}

/** Execute the D13 cascade for one delivery. Returns the consent ids it expired. */
export async function applyPatientDeceased(
  uow: DeceasedConsentUnitOfWork,
  event: { readonly organizationId: string; readonly payload: unknown },
  now: Date,
): Promise<readonly string[]> {
  const { organizationId, patientId } = parseDeceasedEvent(event);
  return uow.run(organizationId, async (tx) => {
    const rows = await tx.lockActiveConsents(patientId);
    const expired: string[] = [];
    for (const plan of planDeceasedExpiry(rows)) {
      if (!(await tx.expire(plan.id, now))) continue; // lost a race to a revoke/supersede
      await tx.publishExpired(
        {
          organizationId,
          patientId,
          consentRecordId: plan.id,
          typeKey: plan.typeKey,
          expiredAt: now.toISOString(),
          expiredReason: "patient_deceased_consent_terminated",
          ...(plan.remainingActiveConsentRecordId
            ? { remainingActiveConsentRecordId: plan.remainingActiveConsentRecordId }
            : {}),
        },
        plan.id,
      );
      expired.push(plan.id);
    }
    return expired;
  });
}

/** The Drizzle unit of work: an explicit-org, system-actor transaction (a relay delivery is not a request). */
export function createDrizzleDeceasedConsentUow(
  db: DbClient,
  outbox: ConsentWriteOutboxPort,
): DeceasedConsentUnitOfWork {
  return {
    run: (organizationId, fn) =>
      withOrgContext(db, { organizationId, userId: "", systemActor: true }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        return fn({
          async lockActiveConsents(patientId) {
            const rows = await tx
              .select({
                id: CR.id,
                typeKey: CR.typeKey,
                status: CR.status,
                survivesDeath: CR.survivesDeath,
              })
              .from(CR)
              .where(
                and(
                  eq(CR.organizationId, organizationId),
                  eq(CR.patientId, patientId),
                  eq(CR.status, "active"),
                ),
              )
              .for("update");
            return rows.map((r) => ({ ...r, typeKey: r.typeKey as ConsentTypeKey }));
          },
          async expire(consentRecordId, at) {
            const updated = await tx
              .update(CR)
              .set({ status: "expired", updatedAt: at })
              .where(
                and(
                  eq(CR.organizationId, organizationId),
                  eq(CR.id, consentRecordId),
                  eq(CR.status, "active"),
                ),
              )
              .returning({ id: CR.id });
            return updated.length === 1;
          },
          async publishExpired(payload, consentRecordId) {
            await outbox.publish(tx, {
              eventName: "m39.consent.expired",
              payload,
              organizationId,
              aggregateKind: "consent_record",
              aggregateId: consentRecordId,
            });
          },
        });
      }),
  };
}

/** The live `m5.patient.deceased` → D13 expiry binding. */
export function buildM39PatientDeceasedConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: ConsentWriteOutboxPort;
  readonly now?: () => Date;
}): OutboxConsumerBinding {
  const uow = createDrizzleDeceasedConsentUow(deps.db, deps.outbox);
  const clock = deps.now ?? (() => new Date());
  return {
    consumerName: M39_PATIENT_DECEASED_CONSUMER_NAME,
    consumerModule: "m39",
    eventTypes: ["m5.patient.deceased"],
    async handle(event) {
      await applyPatientDeceased(uow, event, clock());
    },
  };
}
