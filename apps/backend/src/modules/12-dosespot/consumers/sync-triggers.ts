// apps/backend/src/modules/12-dosespot/consumers/sync-triggers.ts — the M5 patient-sync + M6 MedHx-fetch
// trigger consumers (M12-T08, spec §4.5 / §2.6 D4). PHASE-1 PURE DECISION CORES.
//
// M5 demographic events drive a DoseSpot patient upsert (`dosespot.patient_sync`); a payer change ALSO
// invalidates the RxBenefit cache. M6 admission-activated + CTI-signed events drive a MedicationHistory pull
// (`dosespot.fetch_medhx`). All consumed event names are STRING literals (no M5/M6 schema import). The live
// consumers enqueue the named BullMQ jobs; these pure deciders return the job descriptor (or a skip).
//
// The §2.6 D4 DoseSpot-relevant demographic fields: a patient update only enqueues a sync when it touches a
// field DoseSpot ships (name / DOB / sex / address / phone). The decider takes the changed-field set as data.

/** The `m5.patient.*` payload subset M12 reads (M5 owns the canonical wire shape). */
export interface PatientChangedPayload {
  readonly organizationId: string;
  readonly patientId: string;
  /** For `m5.patient.updated` — the changed demographic field keys (empty for created / address / payer). */
  readonly changedFields?: readonly string[];
}

/** The job (and optional cache invalidation) the worker enqueues from an M5 demographic event. */
export interface PatientSyncTriggerAction {
  readonly enqueueSync: boolean;
  readonly invalidateRxBenefitCache: boolean;
  readonly patientId: string;
}

/** The §2.6 D4 demographic fields a change must touch to warrant a DoseSpot re-sync. */
const DOSESPOT_RELEVANT_FIELDS: ReadonlySet<string> = new Set([
  "firstName",
  "lastName",
  "dateOfBirth",
  "sex",
  "address",
  "addressLine1",
  "city",
  "state",
  "postalCode",
  "phone",
]);

/**
 * Decide the DoseSpot reaction to an M5 demographic event (pure). `created` / `address_changed` always sync;
 * `payer_changed` syncs AND invalidates the RxBenefit cache; `updated` syncs only when a DoseSpot-relevant
 * field changed (§2.6 D4). `reason` selects the branch.
 */
export function decidePatientSyncTrigger(
  reason: "created" | "updated" | "address_changed" | "payer_changed",
  payload: PatientChangedPayload,
): PatientSyncTriggerAction {
  if (reason === "payer_changed")
    return { enqueueSync: true, invalidateRxBenefitCache: true, patientId: payload.patientId };
  if (reason === "created" || reason === "address_changed")
    return { enqueueSync: true, invalidateRxBenefitCache: false, patientId: payload.patientId };
  // updated — only DoseSpot-relevant fields warrant a re-sync.
  const relevant = (payload.changedFields ?? []).some((f) => DOSESPOT_RELEVANT_FIELDS.has(f));
  return { enqueueSync: relevant, invalidateRxBenefitCache: false, patientId: payload.patientId };
}

/** The `m6.admission.activated` / `m6.cti.signed` payload subset M12 reads (M6 owns the wire shape). */
export interface AdmissionMedHxPayload {
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
}

/** The MedHx-fetch job the worker enqueues from an M6 admission/CTI event. */
export interface MedHxFetchAction {
  readonly enqueueFetch: true;
  readonly patientId: string;
  readonly admissionId: string;
  readonly reason: "admission_activated" | "recertification";
}

/** Decide the DoseSpot MedHx pull for an M6 admission-activated / CTI-signed delivery (pure; always fetches). */
export function decideMedHxFetch(
  reason: "admission_activated" | "recertification",
  payload: AdmissionMedHxPayload,
): MedHxFetchAction {
  return { enqueueFetch: true, patientId: payload.patientId, admissionId: payload.admissionId, reason };
}
