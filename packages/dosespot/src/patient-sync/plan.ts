// @chartwarden/dosespot — the M5 → DoseSpot patient-sync planner (M12-T06, spec §2.6 D4). WardenX is the system
// of record for demographics; DoseSpot needs a synchronized copy for the prescribing workflow. M12 subscribes
// to the four `m5.patient.*` outbox events (created / updated / address_changed / payer_changed — wired in
// M12-T08) and runs the `dosespot.patient_sync` worker; THIS module is the PURE core: it builds the
// `DoseSpotClient.upsertPatient` payload + the job idempotency key `patient:${patientId}:${updatedAt}` (which
// coalesces same-state re-syncs, §2.6), and folds an upsert outcome into the retry/escalation decision. No
// reverse sync: a demographic mismatch raises an M36 alert, never a silent overwrite (§2.6). IO-free; the
// upstream upsert is keyed on `wardenxPatientId` so repeated calls are no-ops at DoseSpot's side.
import type { M12AlertPayload, M12EventName } from "@chartwarden/types";
import type { DoseSpotPatientPayload } from "../client/contract";

/** §2.6 — the retry budget for a patient upsert before M12 escalates a sync failure to M36 / the org admin. */
export const PATIENT_SYNC_MAX_RETRIES = 5;

/** §4.9 — the `patient_sync.failed` alert eventType (the discriminant of {@link M12AlertPayload}). */
export type PatientSyncFailedAlert = Extract<M12AlertPayload, { eventType: "patient_sync.failed" }>;

/** §2.6 — the demographic snapshot M5 hands the sync (a projection of the M5 patient aggregate; the upstream
 * upsert is keyed on `patientId`, so this carries no DoseSpot-side identity). */
export interface PatientSyncSnapshot {
  readonly patientId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly gender: string;
  readonly addressLine1: string;
  readonly addressLine2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly phone?: string;
  /** `false` once the patient is deceased/discharged — the upstream copy is deactivated, not deleted. */
  readonly active: boolean;
  /** The M5 aggregate's `updated_at` — the second half of the job idempotency key (coalesces re-syncs). */
  readonly updatedAt: string;
}

/**
 * `patientSyncIdempotencyKey` — the `dosespot.patient_sync` job key `patient:${patientId}:${updatedAt}` (§2.6).
 * Two events carrying the same patient at the same `updated_at` collapse to one job — same-state re-syncs are
 * no-ops without hitting the adapter.
 */
export function patientSyncIdempotencyKey(patientId: string, updatedAt: string): string {
  return `patient:${patientId}:${updatedAt}`;
}

/**
 * `buildPatientUpsertPayload` — project the M5 snapshot into the {@link DoseSpotPatientPayload} the adapter's
 * `upsertPatient(orgId, payload, idempotencyKey)` consumes. `wardenxPatientId` is the upstream upsert key
 * (§2.6 — repeated calls are no-ops at DoseSpot). Pure structural map; no IO, no clock.
 */
export function buildPatientUpsertPayload(snapshot: PatientSyncSnapshot): DoseSpotPatientPayload {
  return {
    wardenxPatientId: snapshot.patientId,
    firstName: snapshot.firstName,
    lastName: snapshot.lastName,
    dateOfBirth: snapshot.dateOfBirth,
    gender: snapshot.gender,
    address: {
      line1: snapshot.addressLine1,
      ...(snapshot.addressLine2 !== undefined ? { line2: snapshot.addressLine2 } : {}),
      city: snapshot.city,
      state: snapshot.state,
      postalCode: snapshot.postalCode,
    },
    ...(snapshot.phone !== undefined ? { phone: snapshot.phone } : {}),
    active: snapshot.active,
  };
}

/** The full plan for one patient-sync job dispatch (the idempotency key + the upsert payload). */
export interface PlannedPatientSync {
  readonly idempotencyKey: string;
  readonly payload: DoseSpotPatientPayload;
  readonly event: Extract<M12EventName, "m12.dosespot_patient_synced">;
}

/**
 * `planPatientSync` — build the dispatch plan from an M5 snapshot: the coalescing idempotency key, the upsert
 * payload, and the `m12.dosespot_patient_synced` success event the worker emits on a clean upsert.
 */
export function planPatientSync(snapshot: PatientSyncSnapshot): PlannedPatientSync {
  return {
    idempotencyKey: patientSyncIdempotencyKey(snapshot.patientId, snapshot.updatedAt),
    payload: buildPatientUpsertPayload(snapshot),
    event: "m12.dosespot_patient_synced",
  };
}

/** The §2.6 failure verdict — either a re-queue (budget remains) or the terminal escalation to M36. */
export type PlannedPatientSyncFailure =
  | { readonly escalate: false; readonly retryCount: number; readonly requeue: true }
  | {
      readonly escalate: true;
      readonly retryCount: number;
      readonly event: Extract<M12EventName, "m12.dosespot_patient_sync_failed">;
      readonly alert: PatientSyncFailedAlert;
    };

/** Inputs to {@link planPatientSyncFailure} (the patient + the retry count BEFORE this attempt). */
export interface PatientSyncFailureInput {
  readonly patientId: string;
  readonly currentRetryCount: number;
}

/**
 * `planPatientSyncFailure` — fold one failed upsert into the retry decision: increment the count, re-queue
 * while below {@link PATIENT_SYNC_MAX_RETRIES}; on the 5th failure emit `m12.dosespot_patient_sync_failed` and
 * dispatch the §4.9 `patient_sync.failed` M36 alert (warn) to the org admin (§2.6). Deterministic.
 */
export function planPatientSyncFailure(input: PatientSyncFailureInput): PlannedPatientSyncFailure {
  const retryCount = input.currentRetryCount + 1;
  if (retryCount < PATIENT_SYNC_MAX_RETRIES) {
    return { escalate: false, retryCount, requeue: true };
  }
  return {
    escalate: true,
    retryCount,
    event: "m12.dosespot_patient_sync_failed",
    alert: {
      eventType: "patient_sync.failed",
      patientId: input.patientId,
      retryCount,
      severity: "warn",
    },
  };
}
