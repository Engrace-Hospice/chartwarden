// @wardenx/dosespot — the M5 → DoseSpot patient-sync domain (M12-T06, spec §2.6 D4). The PURE planner that
// builds the `DoseSpotClient.upsertPatient` payload + the coalescing `patient:${patientId}:${updatedAt}` job
// key, and folds an upsert outcome into the retry / M36-escalation decision. IO-free; the four `m5.patient.*`
// outbox subscribers + the `dosespot.patient_sync` worker bind it (M12-T08).
export {
  PATIENT_SYNC_MAX_RETRIES,
  buildPatientUpsertPayload,
  patientSyncIdempotencyKey,
  planPatientSync,
  planPatientSyncFailure,
  type PatientSyncFailedAlert,
  type PatientSyncFailureInput,
  type PatientSyncSnapshot,
  type PlannedPatientSync,
  type PlannedPatientSyncFailure,
} from "./plan";
