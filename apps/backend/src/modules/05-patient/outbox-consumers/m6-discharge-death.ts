// apps/backend/src/modules/05-patient/outbox-consumers/m6-discharge-death.ts — GAP-004 the LIVE
// `m6.discharge.death` consumer that closes the §7.8 record-death cascade M5-T11 built but never
// wired: M6 (Admission) is the module that actually records a hospice death
// (`discharge_event.dischargeType='death'`, fired unconditionally — unlike `m6.bereavement.eligible`,
// which M6's own opt-out rule can suppress); this consumer is the M5-owned handshake that turns that
// fact into `patient.status='deceased'` + `deceased_date` + the `m5.patient.deceased` cascade emit
// (seeding M16 bereavement, M23's final-claim eligibility, M28's FHIR sync, M36's IDG alert).
//
// SPEC-vs-CODE DEVIATION, deliberate (the M16 `consumers/death-discharge.ts` precedent, verbatim
// reasoning). §7.8 describes the death fact arriving as `patientId`/`deceasedDate` fields on an M8
// event; the actual system records death through M6's discharge flow, whose `m6.discharge.death`
// payload (events-by-m6.ts) carries `dischargeEventId`/`admissionId`/`dischargeDate` — no
// `patientId`. So the death fact is READ, not received: M6's §4.11 `DeathDischargeReader` is the
// only published surface carrying the patient id + the exact death instant, resolved via
// `getSeam("DeathDischargeReader")` (no `dependsOn` edge required — seam/outbox consumption is
// runtime-resolved, ADR-0005 D1) rather than importing M6's schema.
//
// FAIL-CLOSED: an unresolvable death fact throws (dead-letters for a human) rather than guessing a
// patient id. `recordDeathFromDischarge` is itself idempotent on an already-deceased patient, so a
// redelivery after a partial failure converges safely.
import type { DbClient } from "@chartwarden/db";
import { getSeam } from "../../../bootstrap/index";
import { type M5OutboxPort, recordDeathFromDischarge } from "../deceased-db";

/** How far back the death-discharge scan windows from the discharge's own date, mirroring M16's
 *  `DEATH_DISCHARGE_LOOKBACK_DAYS` (consumers/death-discharge.ts) — generous enough to cover a
 *  backdated correction without pulling an org's whole decedent census. */
const LOOKBACK_DAYS = 180;
const MS_PER_DAY = 86_400_000;

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m5.death-cascade: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m5.death-cascade: '${key}' must be a non-empty string`);
  }
  return value;
}

export interface M6DischargeDeathPayload {
  readonly dischargeEventId: string;
  readonly admissionId: string;
  readonly dischargeDate: string;
}

function parsePayload(payload: unknown): M6DischargeDeathPayload {
  const record = recordOf(payload, "payload");
  return {
    dischargeEventId: stringOf(record, "dischargeEventId"),
    admissionId: stringOf(record, "admissionId"),
    dischargeDate: stringOf(record, "dischargeDate"),
  };
}

/** Resolve the decedent's patient id + exact death instant through M6's §4.11 seam, matching on
 *  `admissionId` within a window around the discharge date. Returns `null` when no matching census
 *  row is found (the caller dead-letters — see file header). */
async function resolvePatientId(
  organizationId: string,
  admissionId: string,
  dischargeDate: string,
): Promise<{ patientId: string; deathDate: string } | null> {
  const centerMs = Date.parse(dischargeDate);
  if (Number.isNaN(centerMs)) {
    throw new Error(`m5.death-cascade: malformed dischargeDate '${dischargeDate}'`);
  }
  const from = new Date(centerMs - LOOKBACK_DAYS * MS_PER_DAY).toISOString();
  const to = new Date(centerMs + MS_PER_DAY).toISOString();

  const reader = getSeam("DeathDischargeReader");
  const decedents = await reader.listDeathDischargesInPeriod(organizationId, { from, to });
  const match = decedents.find((d) => d.admissionId === admissionId);
  if (match === undefined) return null;
  return { patientId: match.patientId, deathDate: match.deathAt.slice(0, 10) };
}

export const M5_DEATH_CASCADE_CONSUMER = {
  eventName: "m6.discharge.death",
  consumerName: "m5.death-cascade",
} as const;

/** Build the LIVE `m6.discharge.death` → M5 `recordDeath` consumer binding (registered in the boot
 *  dispatcher's `consumers` array, apps/backend/src/index.ts). */
export function buildM5DeathCascadeConsumer(deps: {
  readonly db: DbClient;
  readonly outbox: M5OutboxPort;
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M5_DEATH_CASCADE_CONSUMER.consumerName,
    consumerModule: "m5" as const,
    eventTypes: [M5_DEATH_CASCADE_CONSUMER.eventName] as const,
    async handle(event: { readonly organizationId: string; readonly payload: unknown }) {
      const payload = parsePayload(event.payload);
      const resolved = await resolvePatientId(
        event.organizationId,
        payload.admissionId,
        payload.dischargeDate,
      );
      if (resolved === null) {
        throw new Error(
          `m5.death-cascade: no DeathDischargeReader row for admission '${payload.admissionId}' ` +
            `(discharge '${payload.dischargeEventId}') — cannot resolve the decedent's patient id`,
        );
      }
      await recordDeathFromDischarge(deps.db, deps.outbox, {
        organizationId: event.organizationId,
        patientId: resolved.patientId,
        deceasedDate: resolved.deathDate,
        today: now().toISOString().slice(0, 10),
      });
    },
  };
}
