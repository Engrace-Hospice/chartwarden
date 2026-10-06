// apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m24-rb-day-consumers.ts — GAP-071 follow-up:
// the three outbox-PUSH consumers behind the rb_day lifecycle (M24 §4.4 consumers/ tree:
// `m6-loc-changed.consumer.ts` "triggers rb_day re-evaluation", `m5-patient-deceased.consumer.ts` "triggers
// final R&B day finalization"; §2.2 voids on "M5 deceased / discharge correction"). The producing events are
// outbox-only/catalogued (`m6.loc.changed`, `m6.admission.discharged`, `m5.patient.deceased`) and M24's own
// spec names them as inbound, so this is push, not a seam pull. The tenant is ALWAYS `event.organizationId`
// (the dispatcher envelope), never the payload. `m6.*` payloads carry an admissionId, not a patientId, so the
// patient is resolved through an injected org-explicit port (M24 does not depend on M6).
//   - m6.loc.changed       -> re-evaluate not-yet-billed days from `effectiveStart` forward
//   - m6.admission.discharged -> void not-yet-billed days from `dischargeDate` (discharge day not billed)
//   - m5.patient.deceased  -> void not-yet-billed days AFTER `deceasedDate` (day of death is billable)
// Idempotent: re-evaluation converges and voiding an already-voided/billed day is a no-op, so a redelivery
// is harmless.
import type { DbClient } from "@wardenx/db";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { reevaluateRbDaysFrom, voidRbDaysFrom } from "../jobs/rb-day-lifecycle";
import { MS_PER_DAY, type RbLocPeriodsPort } from "../jobs/rb-day-sweep";

export interface RbAdmissionPatientPort {
  /** The admission's patient, org-explicit; null when unknown in the org. */
  patientIdForAdmission(organizationId: string, admissionId: string): Promise<string | null>;
}

export interface M24RbDayConsumerDeps {
  readonly db: DbClient;
  readonly locPeriods: RbLocPeriodsPort;
  readonly admissions: RbAdmissionPatientPort;
}

function str(payload: unknown, key: string, consumer: string): string {
  const v = ((payload ?? {}) as Record<string, unknown>)[key];
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`${consumer}: payload has no ${key}`);
  return v;
}

async function patientOfAdmission(
  deps: M24RbDayConsumerDeps,
  event: DispatchableOutboxEvent,
  consumer: string,
): Promise<string | null> {
  return deps.admissions.patientIdForAdmission(
    event.organizationId,
    str(event.payload, "admissionId", consumer),
  );
}

const nextDay = (isoDate: string): string => {
  const ms = Date.parse(`${isoDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`rb_day: invalid date "${isoDate}"`);
  return new Date(ms + MS_PER_DAY).toISOString().slice(0, 10);
};

export function buildM24RbDayConsumers(deps: M24RbDayConsumerDeps): OutboxConsumerBinding[] {
  const locName = "m24.rb-day-loc-changed";
  const dischargeName = "m24.rb-day-admission-discharged";
  const deceasedName = "m24.rb-day-patient-deceased";
  return [
    {
      consumerName: locName,
      consumerModule: "m24",
      eventTypes: ["m6.loc.changed"],
      async handle(event) {
        const patientId = await patientOfAdmission(deps, event, locName);
        if (!patientId) return; // unknown admission in this org — nothing to re-evaluate
        await reevaluateRbDaysFrom(
          deps,
          event.organizationId,
          patientId,
          str(event.payload, "effectiveStart", locName),
        );
      },
    },
    {
      consumerName: dischargeName,
      consumerModule: "m24",
      eventTypes: ["m6.admission.discharged"],
      async handle(event) {
        // A death discharge is owned by the m5.patient.deceased consumer: the day of death stays billable, and
        // voiding from the discharge date (= date of death) would drop it.
        if (((event.payload ?? {}) as Record<string, unknown>).reason === "death") return;
        const patientId = await patientOfAdmission(deps, event, dischargeName);
        if (!patientId) return;
        await voidRbDaysFrom(
          deps.db,
          event.organizationId,
          patientId,
          str(event.payload, "dischargeDate", dischargeName),
        );
      },
    },
    {
      consumerName: deceasedName,
      consumerModule: "m24",
      eventTypes: ["m5.patient.deceased"],
      async handle(event) {
        await voidRbDaysFrom(
          deps.db,
          event.organizationId,
          str(event.payload, "patientId", deceasedName),
          nextDay(str(event.payload, "deceasedDate", deceasedName)),
        );
      },
    },
  ];
}
