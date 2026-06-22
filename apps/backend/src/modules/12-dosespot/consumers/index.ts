// apps/backend/src/modules/12-dosespot/consumers/index.ts — the M12 outbox-subscription surface (M12-T08,
// spec §4.5). Each entry binds an event another module emits to the M12 consumer that handles it; the PURE
// decision core for each ships + is tested here, and the live boot wiring (when the M12 backend is mounted)
// binds the handler to the dispatcher and executes the returned action through M12's service path.
//
// Most producers (M5 demographics, M6 discharge/admission/CTI, M11 verbal timer) exist in Wave D/E — these
// bindings are LIVE-eligible. M22's document.rendered + M14's idg.decision_recorded are forward producers
// (Wave F / later Wave E). Every consumed event name is a STRING literal (no cross-module schema import):
// M12 reads other modules solely through the foundation outbox (M5/M11 already in dependsOn for the seam; no
// schema edge added by these consumers), so this task adds NO new edge to M12's manifest dependsOn.
export {
  type AdmissionDischargedPayload,
  type MedicationDischargeCascadeAction,
  type MedicationDischargeCascadeFacts,
  type MedicationDischargeDiscontinueAction,
  type MedicationOrderOnAdmission,
  decideMedicationDischargeCascade,
} from "./admission-discharged-cascade";
export {
  type VerbalExpiredAction,
  type VerbalExpiredFacts,
  type VerbalExpiredPayload,
  decideVerbalExpiry,
} from "./verbal-expired";
export {
  type AdmissionMedHxPayload,
  type MedHxFetchAction,
  type PatientChangedPayload,
  type PatientSyncTriggerAction,
  decideMedHxFetch,
  decidePatientSyncTrigger,
} from "./sync-triggers";

/** The §4.5 event → M12-consumer bindings. The live dispatcher wires each `eventName` to `consumerName`'s
 * handler at boot; the pure decider each handler runs ships above. Names mirror the §3.1 package layout. */
export const M12_OUTBOX_SUBSCRIPTIONS = [
  { eventName: "m5.patient.created", consumerName: "m12.patient-sync-created" },
  { eventName: "m5.patient.updated", consumerName: "m12.patient-sync-updated" },
  { eventName: "m5.patient.address_changed", consumerName: "m12.patient-sync-address-changed" },
  { eventName: "m5.patient.payer_changed", consumerName: "m12.patient-sync-payer-changed" },
  { eventName: "m6.admission.discharged", consumerName: "m12.admission-discharged-cascade" },
  { eventName: "m6.admission.activated", consumerName: "m12.admission-activated-medhx" },
  { eventName: "m6.cti.signed", consumerName: "m12.recertification-medhx" },
  { eventName: "m11.order.verbal_expired_unsigned", consumerName: "m12.verbal-expired" },
  { eventName: "m22.document.rendered", consumerName: "m12.document-backref" },
  { eventName: "idg.decision_recorded", consumerName: "m12.idg-decision-intake" },
] as const;
