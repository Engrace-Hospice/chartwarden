// apps/backend/src/bootstrap/erasers/registry.ts — the M4 destruction-cert eraser
// registry. Every PHI data class must register a DataEraser or boot fails
// (validateErasers()), mirroring validateSeams(). This is decision D4 from the promoted
// boot.ts example: a missing eraser means a right-to-erasure request would silently
// no-op a data class, so we fail closed at startup instead.

import type { DataClass, DataEraser } from "../interfaces";

export class EraserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EraserError";
  }
}

const erasers = new Map<DataClass, DataEraser>();

/** Every PHI data class that must have a registered eraser before serving traffic. */
export const REQUIRED_ERASERS: readonly DataClass[] = [
  "audit_event",
  "clinical_record",
  // M22-T10: a patient's document record (document/document_version + tags + the intake_artifact subtree:
  // intake_upload_batch/classified_page/extraction_job/extraction_candidate/extraction_review/extraction_decision
  // + the MinIO objects). M22 registers the REAL eraser via the composition-root hook over this deny-stub —
  // under an M4 destruction certificate (§8.6 / W14, D12) it crypto-erases the document/extraction ciphertext
  // (tenant DEK) FIRST, SKIPS documents under an active legal hold + passes compliance_42cfr_part2-class rows
  // through to M4's eraseAuditRows Part 2 refusal, then version-aware deletes the remaining MinIO objects + rows;
  // document_access_log rows inside the §164.528 retention floor survive (ADR-0013). The `subjectId` is the patient.
  "documents",
  // M36-T10: message bodies (D9 tenant offboarding). M36 registers the REAL eraser via the
  // composition-root hook over this deny-stub — tenant-offboarding cryptographically erases every
  // `message.body_cipher` by destroying the tenant DEK (§7.8), then deletes structural +
  // sole-tenant cross-tenant rows. Bodies are unreadable the instant the DEK is gone.
  "messages",
  "consent",
  "telehealth_recording",
  // M2-T10: identity credentials (two_factor/passkey + pending invitations). M2 registers
  // the REAL eraser via the composition root's registerModuleErasers hook (it runs AFTER
  // wireErasers(), standing over the Phase-0 deny-stub); see apps/backend/src/index.ts.
  "identity",
  // M38-T10: a tenant's `value_set_tenant_extension` rows (D8 offboarding). M38 registers the
  // REAL eraser via the same composition-root hook over this deny-stub; platform terminology
  // tables are reference data and stay untouched.
  "terminology_tenant_extensions",
  // M40-T10: a tenant's MDM overlay/provisional/baa rows (D7 offboarding). M40 registers the REAL
  // eraser via the composition-root hook over this deny-stub; the org-less CANONICAL entities
  // (physician/facility/payer) are shared reference data and stay untouched (§7.8).
  "mdm_tenant_overlays",
  // M6-T12: a patient's admission record (election/CTI/F2F/LOC/revocation/discharge/transfer/NOR/
  // compliance windows + referrals). M6 registers the REAL eraser via the composition-root hook over
  // this deny-stub — under an M4 destruction certificate it deletes the admission satellites and
  // tombstones the `admission` row for FK integrity (D8); the `subjectId` is the patient.
  "admission_record",
  // M7-T09: a patient's care-plan record (care_plan_version/signature/problem/goal/intervention).
  // M7 registers the REAL eraser via the composition-root hook over this deny-stub — under an M4
  // destruction certificate it deletes the care-plan satellites and tombstones the `care_plan` root
  // for FK integrity (D8); the `subjectId` is the patient.
  "care_plan_record",
  // M8-T12: a patient's encounter record (encounter_signature/addendum/care_plan_link/cosignature_request/
  // vitals/mileage/hearthnote_selection/assembled_output/llm_modification). M8 registers the REAL eraser
  // via the composition-root hook over this deny-stub — under an M4 destruction certificate it crypto-erases
  // the HearthNote ciphertext (tenant DEK, §3.6), deletes the encounter satellites, and tombstones the
  // `encounter` root for FK integrity (D8); the `subjectId` is the patient.
  "encounter_record",
  // M9-T07: a patient's assessment record (assessment_cosignature/significant_change_event + the
  // clinical_assessment rows, both active and superseded). M9 registers the REAL eraser via the
  // composition-root hook over this deny-stub — under an M4 destruction certificate (§8.4) it deletes the
  // child rows then the assessment rows outright (no root tombstone); the org-level scale_license/scale_policy
  // tables are tenant config, not patient data, and stay untouched. The `subjectId` is the patient.
  "clinical_assessment",
  // M10-T08: a patient's HOPE record (hope_timepoint_schedule/symptom_follow_up_visit/hope_validation_finding
  // + the partitioned hope_assessment rows, both signed and superseded). M10 registers the REAL eraser via the
  // composition-root hook over this deny-stub — under an M4 destruction certificate (§8.4) it refuses when
  // submitted assessments are still inside the CMS 10-year retention horizon (unless a legal-hold override is
  // supplied), then drops/row-deletes the assessment rows and deletes the child rows; hope_submission rows
  // survive as compliance evidence (envelope content purged by M4's MinIO worker). The `subjectId` is the patient.
  "hope_record",
  // M11-T08: a patient's orders record (order_signature/verbal_order/standing_order_instance/
  // order_discontinuation child rows + the partitioned order_record rows + the patient's standing_order
  // templates). M11 registers the REAL eraser via the composition-root hook over this deny-stub — under an M4
  // destruction certificate (§7.7 / D12) it drops/row-deletes the order_record rows and cascade-deletes the
  // child rows; the cert's retentionAsOf enforces M4's standard `compliance` 7-year floor. The org-scoped
  // order_verbal_policy is tenant config, not patient data, and stays untouched. The `subjectId` is the patient.
  "order_record",
  // M12-T09: a patient's medication-order record (medication_order_transmission/refill_request/
  // epcs_signing_attempt child rows + the partitioned medication_order rows). M12 registers the REAL eraser via
  // the composition-root hook over this deny-stub — under an M4 destruction certificate (§7.7 / D15) it
  // drops/row-deletes the medication_order rows and cascade-deletes the child rows; the cert's retentionAsOf
  // enforces M4's standard `compliance` retention floor. The org-scoped dosespot_prescriber/
  // dosespot_webhook_event/refill_inbox_policy/controlled_substance_policy are tenant config / encrypted
  // webhook receipts, not patient data, and stay untouched. The `subjectId` is the patient.
  "medication_order_record",
  // M13-T10: a patient's eMAR record (prn_administration/administration_witness/barcode_scan_event child rows +
  // the partitioned administration_record rows + scheduled_dose/missed_dose + comfort_kit_deployment/drawdown +
  // medication_reconciliation_worksheet/decision + administration_offline_queue). M13 registers the REAL eraser
  // via the composition-root hook over this deny-stub — under an M4 destruction certificate (§7.7) it
  // drops/row-deletes the administration_record rows and cascade-deletes the child + satellite rows; the cert's
  // retentionAsOf enforces M4's standard `compliance` retention floor. The org-scoped administration_policy is
  // tenant config, not patient data, and stays untouched. The `subjectId` is the patient.
  "emar_record",
  // M14-T07: a patient's IDG record (the patient-scoped idg_agenda_item/idg_decision/idg_action_item/
  // idg_patient_packet rows). M14 registers the REAL eraser via the composition-root hook over this deny-stub —
  // under an M4 destruction certificate (§8.4) it deletes the patient's packets / decisions / action-items /
  // agenda items; the caseload-wide idg_meeting / idg_recurring_policy / idg_attendance / idg_minutes /
  // idg_minutes_amendment rows SURVIVE (a meeting is not a single patient's record; minutes are hash-redacted by
  // the M4 trigger, not deleted here). The `subjectId` is the patient.
  "idg_record",
  // M15-T06: a patient's discipline record (discipline_goal / discipline_intervention /
  // discipline_assessment / discipline_care_plan_signature / discipline_care_plan_version /
  // aide_supervisory_visit / volunteer_assignment). M15 registers the REAL eraser via the composition-root
  // hook over this deny-stub — under an M4 destruction certificate (§8.5) it scrubs the two PHI-bearing
  // jsonb payloads (`state_snapshot`, assessment `data`) first, deletes the subtree, and tombstones the
  // `discipline_care_plan` roots for FK integrity. The WORKFORCE-scoped volunteer_compliance_gate /
  // volunteer_hour_ledger / volunteer_hour_entry rows are a volunteer's own record, not the patient's, and
  // stay untouched. The `subjectId` is the patient.
  "discipline_plan_record",
  // M16-T06: a DECEDENT's bereavement record (bereaved_contact / bereavement_outreach /
  // bereavement_contact_log / bereavement_risk_score / bereavement_opt_out /
  // bereavement_anniversary_reminder). M16 registers the REAL eraser via the composition-root hook over
  // this deny-stub — under an M4 destruction certificate (§8.5) it SHREDS the PHI-bearing columns first
  // (the three `bereaved_contact` channel ciphers, `contact_notes_cipher`, the risk `risk_factors_jsonb` +
  // `augmented_narrative_redacted`, and the four redacted narrative columns), then deletes the subtree and
  // tombstones the `bereavement_plan` root for FK integrity. The `bereavement_plan_closure` row SURVIVES
  // with its narrative shredded (§7.15 survey reconstruction), and the ORG-scoped
  // `tenant_bereavement_external_source_gate_override` is tenant config that stays untouched. The
  // `subjectId` is the decedent whose death opened the program.
  "bereavement_record",
  // M17-T02 (this task) registers the data-class contract; the Phase-0 deny-stub (wireErasers) stands until
  // M17-T08 registers the REAL eraser via the composition-root hook. Under an M4 destruction certificate the
  // real eraser row-deletes the patient's partitioned `visit` rows (+ cascaded `visit_state_history`),
  // `recurring_visit`, `visit_proposal`, and the `route_segment` legs joinable via a visit being erased
  // (§3.7); retention class `operational` (3 years post-discharge). The clinician-scoped
  // `clinician_availability` / `time_off` rows are workforce data, not patient data, and stay untouched. The
  // `subjectId` is the patient.
  "operational_schedule",
  // M18-T02 (this task) registers the data-class contract; the Phase-0 deny-stub (wireErasers) stands until
  // M18-T07 registers the REAL eraser via the composition-root hook. Under an M4 destruction certificate the
  // real eraser cryptographic-shreds the per-tenant DEK (rendering the `evv_event.coords_cipher` GPS
  // ciphertext unrecoverable) and drops the patient's partitioned `evv_event` rows, their
  // `evv_geofence_evaluation` children (by evv_event_id), and the `evv_missing_resolution` /
  // `evv_aggregator_submission` rows joinable via a visit being erased (§3.7 / D12); retention class
  // `compliance` (`evv_record`, 7 years). The tenant-config `evv_geofence_policy` and the membership-scoped
  // `evv_device` rows are not patient data and stay untouched (device erases on workforce departure per M2 D8).
  // The `subjectId` is the patient.
  "evv_record",
  // M34: a TENANT's control-plane footprint (NOT patient data) on offboarding (D6, §3.5/§8.4). M34 registers
  // the REAL eraser via the composition-root hook over this deny-stub — it deletes the org's operational
  // working rows (onboarding_task / support_consent_grant / support_session headers / platform_tenant_baa_record
  // / tenant_invitation / tenant_signup_intent+token / tenant_export_job+event ledger) and NOTHING ELSE; the
  // lifecycle/key-ring destruction ledger + the §164.528 disclosure-accounting tables (dsar_export_job,
  // support_session_event) SURVIVE (§8.4). Unlike every class above, `subjectId` is the ORG being offboarded.
  "saas_tenant_platform_class",
];

export function registerEraser(dataClass: DataClass, eraser: DataEraser): void {
  erasers.set(dataClass, eraser);
}

export function getEraser(dataClass: DataClass): DataEraser {
  const e = erasers.get(dataClass);
  if (e === undefined) throw new EraserError(`no eraser registered for data class '${dataClass}'`);
  return e;
}

/** Boot gate: throw listing every PHI data class with no registered eraser. */
export function validateErasers(): void {
  const missing = REQUIRED_ERASERS.filter((c) => !erasers.has(c));
  if (missing.length > 0) {
    throw new EraserError(
      `validateErasers: ${missing.length} data class(es) without an eraser — refusing to start: ${missing.join(", ")}`,
    );
  }
}

/** Test-only: clear the registry between cases. */
export function __resetErasersForTest(): void {
  erasers.clear();
}
