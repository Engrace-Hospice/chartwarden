// apps/backend/src/modules/05-patient/deceased-db.ts — GAP-004 the real Drizzle-backed
// {@link DeceasedCascadePorts} `recordDeath` (./deceased.ts) closes over (§7.8).
//
// `recordDeath` itself is a pure decision core — it was fully built (M5-T11) but had NO caller
// anywhere in the composition root, so `patient.status` never actually transitioned to `deceased`
// in the running app even though M6 (Admission) has recorded every hospice death via
// `discharge_event.dischargeType='death'` all along. `./outbox-consumers/m6-discharge-death.ts` is
// the caller this file backs: it resolves the death fact through M6's published `DeathDischargeReader`
// seam and invokes {@link recordDeathFromDischarge} below.
//
// ONE TRANSACTION, per the `deceased.ts` file header's own documented invariant ("flips status +
// emits the event in the SAME outbox-published transaction"): both ports close over the SAME
// `withOrgContext` tx, so a mid-cascade failure (e.g. a rejected outbox payload) rolls back the
// status flip too — a redelivery replays cleanly rather than leaving `patient.status='deceased'`
// with no cascade event ever published.
//
// IDEMPOTENCY. The outbox dispatcher's per-(event, consumer) receipt already de-dupes a delivery
// that fully SUCCEEDED, but a delivery that failed partway (e.g. a sibling consumer bound to the
// same event throws) is retried in full. `patient.status` itself is the durable idempotency signal
// here — no separate marker table is needed: a patient already `deceased` is a no-op success (the
// M6 `m6.applier.*` "refusals are success to the dispatcher" precedent). Which other statuses may flip
// is `deathTransitionFrom` (./patient-status-transitions.ts): `active`/`on_hold`, plus a `prospective`/
// `discharged` row that merely lagged M6's activation; a `merged` chart dead-letters for a human.
// Every flip also emits `m5.patient.status_changed` (§4.6) with the real `fromStatus`.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { eq } from "drizzle-orm";
import { type DeceasedCascadePorts, recordDeath } from "./deceased";
import { deathTransitionFrom } from "./patient-status-transitions";
import { voidPatientWristbandsInTx } from "./wristband-db";

const P = schema.patients;

/** The transactional-outbox emission shape `bindCallerModule`'s return value satisfies. */
export interface M5OutboxEmission {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
}

/** The composition root's transactional-outbox port, pinned to callerModule `m5`. */
export interface M5OutboxPort {
  publish(tx: DbClient, emission: M5OutboxEmission): Promise<void>;
}

/** Consumer-scope actor: no acting user (the M4 write-audit trigger maps `""` → NULL actor). */
const DEATH_CASCADE_SYSTEM_USER_ID = "";

/** What {@link recordDeathFromDischarge} reported. */
export type DeathCascadeOutcome =
  /** The cascade ran: status flipped, `deceased_date` set, `m5.patient.deceased` emitted. */
  | { readonly kind: "recorded"; readonly deceasedDate: string }
  /** The patient was already `deceased` — a redelivery or a race with another death intake. No-op. */
  | { readonly kind: "already_deceased" };

/** Thrown when a death is recorded against a patient whose status cannot take it (`deathTransitionFrom`
 *  → `reject`, i.e. a merged chart) — a genuine conflict that should dead-letter, not silently overwrite
 *  an unrelated transition. */
export class InvalidDeceasedTransitionError extends Error {
  constructor(
    readonly patientId: string,
    readonly fromStatus: string,
  ) {
    super(`patient '${patientId}': cannot record death from status '${fromStatus}'`);
    this.name = "InvalidDeceasedTransitionError";
  }
}

/**
 * Record a death for `patientId` (§7.8), backed by real `patient` writes + a real `m5.patient.deceased`
 * outbox emit, both in one `withOrgContext` tx. Idempotent on an already-deceased patient.
 */
export async function recordDeathFromDischarge(
  db: DbClient,
  outbox: M5OutboxPort,
  input: {
    organizationId: string;
    patientId: string;
    deceasedDate: string;
    today: string;
    actorUserId?: string;
  },
): Promise<DeathCascadeOutcome> {
  return withOrgContext<DbClient, DeathCascadeOutcome>(
    db,
    {
      organizationId: input.organizationId,
      userId: input.actorUserId ?? DEATH_CASCADE_SYSTEM_USER_ID,
    },
    async (tx) => {
      const [row] = await tx
        .select({ status: P.status })
        .from(P)
        .where(eq(P.id, input.patientId))
        .limit(1);
      if (!row) throw new Error(`patient '${input.patientId}' not found`);
      const transition = deathTransitionFrom(row.status);
      if (transition === "already_deceased") return { kind: "already_deceased" };
      if (transition === "reject") {
        throw new InvalidDeceasedTransitionError(input.patientId, row.status);
      }
      const fromStatus = row.status;

      const ports: DeceasedCascadePorts = {
        async markDeceased(organizationId, patientId, deceasedDate) {
          await tx
            .update(P)
            .set({ status: "deceased", deceasedDate, updatedAt: new Date() })
            .where(eq(P.id, patientId));
          // GAP-020 -- a deceased patient's band must stop verifying in the same commit.
          await voidPatientWristbandsInTx(tx, {
            organizationId,
            patientId,
            reason: "patient_deceased",
            actorUserId: input.actorUserId ?? null,
          });
        },
        async emitDeceased(organizationId, patientId, deceasedDate) {
          await outbox.publish(tx, {
            eventName: "m5.patient.status_changed",
            payload: { patientId, organizationId, fromStatus, toStatus: "deceased" },
            organizationId,
            aggregateKind: "patient",
            aggregateId: patientId,
          });
          await outbox.publish(tx, {
            eventName: "m5.patient.deceased",
            payload: { patientId, organizationId, deceasedDate },
            organizationId,
            aggregateKind: "patient",
            aggregateId: patientId,
          });
        },
      };

      const result = await recordDeath(input, ports);
      return { kind: "recorded", deceasedDate: result.deceasedDate };
    },
  );
}
