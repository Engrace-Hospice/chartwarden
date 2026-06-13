# WardenX — Fitness Enforcement Audit (manifest-derived)

Source of truth: `architecture/module-manifest.ts` (read by `.dependency-cruiser.cjs` + `check-table-ownership.ts`).
Modules: **40** · Owned tables: **451** (unique: **451**) · Import edges: **157**.
Cycles: **none ✓** · Consistency issues: **none ✓**.

## 1. Module Ownership Matrix

> Owned tables + import deps are manifest-authoritative. **Allowed seams, forbidden imports, events published/consumed are spec-prose** (ADR-0005: seam/outbox consumption needs no import edge) — see the separate Event/Seam catalog.

| Module | Name | #Tables | Inbound (imported by) | Outbound (dependsOn) |
|---|---|--:|---|---|
| M01 | Foundation | 16 | M02, M04, M22, M32, M36, M38, M39, M40 | — |
| M02 | Identity & Org | 4 | M03, M04, M05, M32, M34, M36, M38, M39, M40 | M01 |
| M03 | Authorization | 6 | M04, M05, M32, M34, M36, M38, M39, M40 | M02 |
| M04 | Audit & Compliance Log | 7 | M05, M32, M34, M36, M38, M39, M40 | M01, M02, M03 |
| M05 | Patient & Demographics | 16 | M06, M12, M16, M17, M19, M22, M28, M29, M31, M33, M39 | M02, M03, M04, M36, M38, M40 |
| M06 | Admission, Election & Certification | 12 | M07, M08, M11, M16, M23, M28, M33, M37 | M05, M38, M39, M40 |
| M07 | Care Plan (IPOC) | 6 | M08, M14, M15, M28, M31, M33 | M06, M38, M39 |
| M08 | Encounters & Visit Notes | 10 | M09, M10, M11, M14, M15, M17, M23, M28, M31, M33, M37 | M06, M07, M36, M38 |
| M09 | Clinical Assessments Suite | 5 | M10, M33 | M08, M38 |
| M10 | HOPE Engine | 6 | M30, M33 | M08, M09, M36, M38 |
| M11 | Orders | 7 | M12, M21, M28, M29, M33, M37 | M06, M08, M36, M38, M40 |
| M12 | DoseSpot Integration | 6 | M13, M28, M33 | M05, M11, M38, M40 |
| M13 | eMAR & Med Administration | 12 | M28, M33, M37 | M12, M36, M38 |
| M14 | IDG | 11 | M33 | M07, M08, M36 |
| M15 | Discipline Care Plans | 11 | M33 | M07, M08 |
| M16 | Bereavement | 9 | M33 | M05, M06, M36 |
| M17 | Scheduling & Route Optimization | 7 | M18, M19, M20, M33, M37 | M05, M08, M40 |
| M18 | EVV | 6 | M33 | M17 |
| M19 | On-Call Triage | 9 | M33 | M05, M17, M36 |
| M20 | Field Safety | 13 | M33 | M17, M36 |
| M21 | Supplies, DME & Comfort Kits | 11 | M33 | M11, M40 |
| M22 | Document Management | 17 | M23, M31, M33 | M01, M05, M39 |
| M23 | Billing — Medicare | 17 | M24, M25, M26, M27, M30, M33, M37 | M06, M08, M22, M38, M40 |
| M24 | Billing — Medicaid | 14 | M33 | M23, M40 |
| M25 | Remittance & Denials | 11 | M33 | M23, M36 |
| M26 | Cap Management | 12 | M27, M33 | M23, M36 |
| M27 | Cost Report | 14 | M30, M33 | M23, M26, M38 |
| M28 | FHIR Gateway | 8 | — | M05, M06, M07, M08, M11, M12, M13, M38, M40 |
| M29 | External Interfaces | 11 | — | M05, M11, M40 |
| M30 | HQRP & Quality | 19 | M33 | M10, M23, M27, M36, M38 |
| M31 | Patient/Family Portal & Telehealth | 3 | — | M05, M07, M08, M22, M36, M39 |
| M32 | AI Platform | 13 | — | M01, M02, M03, M04 |
| M33 | Reporting & Dashboards | 12 | — | M05, M06, M07, M08, M09, M10, M11, M12, M13, M14, M15, M16, M17, M18, M19, M20, M21, M22, M23, M24, M25, M26, M27, M30, M38, M40 |
| M34 | SaaS Tenant Platform | 17 | M35 | M02, M03, M04, M36 |
| M35 | Subscription Billing | 19 | — | M34 |
| M36 | Secure Messaging & Alerts | 13 | M05, M08, M10, M11, M13, M14, M16, M19, M20, M25, M26, M30, M31, M34 | M01, M02, M03, M04 |
| M37 | Inpatient Unit (IPU) Management | 26 | — | M06, M08, M11, M13, M17, M23 |
| M38 | Clinical Terminology Service | 13 | M05, M06, M07, M08, M09, M10, M11, M12, M13, M23, M27, M28, M30, M33 | M01, M02, M03, M04 |
| M39 | Consent & Authorization Management | 11 | M06, M07, M22, M31 | M01, M02, M03, M04, M05 |
| M40 | Master Data Management | 11 | M05, M06, M11, M12, M17, M21, M23, M24, M28, M29, M33 | M01, M02, M03, M04 |

## 2. Table Ownership Audit

`manifest_file` = `architecture/module-manifest.ts` for every row.

| # | table_name | owner_module | spec_file |
|--:|---|---|---|
| 1 | account | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 2 | audit_event | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 3 | feature_flag | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 4 | feature_flag_evaluation | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 5 | idempotency_key | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 6 | location | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 7 | membership | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 8 | organization | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 9 | organization_settings_registry | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 10 | outbox_event | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 11 | outbox_event_catalog | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 12 | provider_entity | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 13 | session | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 14 | system_status | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 15 | user | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 16 | verification | M01 Foundation | docs/modules/WARDENX_MODULE_01_FOUNDATION_SPEC_v0_4.md |
| 17 | organization_invitation | M02 Identity & Org | docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md |
| 18 | passkey | M02 Identity & Org | docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md |
| 19 | tenant_step_up_policy_override | M02 Identity & Org | docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md |
| 20 | two_factor | M02 Identity & Org | docs/modules/WARDENX_MODULE_02_IDENTITY_SPEC_v0_4.md |
| 21 | auditor_engagement | M03 Authorization | docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_2.md |
| 22 | break_glass_event | M03 Authorization | docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_2.md |
| 23 | membership_role | M03 Authorization | docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_2.md |
| 24 | permission | M03 Authorization | docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_2.md |
| 25 | role | M03 Authorization | docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_2.md |
| 26 | role_permission | M03 Authorization | docs/modules/WARDENX_MODULE_03_AUTHORIZATION_SPEC_v0_2.md |
| 27 | audit_action_catalog | M04 Audit & Compliance Log | docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md |
| 28 | audit_denylist_catalog | M04 Audit & Compliance Log | docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md |
| 29 | audit_export | M04 Audit & Compliance Log | docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md |
| 30 | audit_seal | M04 Audit & Compliance Log | docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md |
| 31 | destruction_certificate | M04 Audit & Compliance Log | docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md |
| 32 | legal_hold | M04 Audit & Compliance Log | docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md |
| 33 | state_retention_override | M04 Audit & Compliance Log | docs/modules/WARDENX_MODULE_04_AUDIT_SPEC_v0_4.md |
| 34 | caregiver | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 35 | emergency_contact | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 36 | patient | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 37 | patient_address | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 38 | patient_amendment_request | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 39 | patient_assignment | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 40 | patient_caregiver | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 41 | patient_communication_preference | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 42 | patient_email | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 43 | patient_identifier | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 44 | patient_match_review | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 45 | patient_merge | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 46 | patient_name_alias | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 47 | patient_payer | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 48 | patient_phone | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 49 | patient_privacy_flag_snapshot | M05 Patient & Demographics | docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md |
| 50 | admission | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 51 | certification_of_terminal_illness | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 52 | compliance_window | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 53 | discharge_event | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 54 | election_period | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 55 | election_statement | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 56 | face_to_face_encounter | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 57 | level_of_care_period | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 58 | notice_of_rights_acknowledgment | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 59 | referral | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 60 | revocation_event | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 61 | transfer_event | M06 Admission, Election & Certification | docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md |
| 62 | care_plan | M07 Care Plan (IPOC) | docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md |
| 63 | care_plan_signature | M07 Care Plan (IPOC) | docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md |
| 64 | care_plan_version | M07 Care Plan (IPOC) | docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md |
| 65 | goal | M07 Care Plan (IPOC) | docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md |
| 66 | intervention | M07 Care Plan (IPOC) | docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md |
| 67 | problem | M07 Care Plan (IPOC) | docs/modules/WARDENX_MODULE_07_CARE_PLAN_SPEC_v0_3.md |
| 68 | cosignature_request | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 69 | encounter | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 70 | encounter_addendum | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 71 | encounter_care_plan_link | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 72 | encounter_signature | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 73 | hearthnote_assembled_output | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 74 | hearthnote_llm_modification | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 75 | hearthnote_selection | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 76 | mileage | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 77 | vitals | M08 Encounters & Visit Notes | docs/modules/WARDENX_MODULE_08_ENCOUNTERS_SPEC_v0_2.md |
| 78 | assessment_cosignature | M09 Clinical Assessments Suite | docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_2.md |
| 79 | clinical_assessment | M09 Clinical Assessments Suite | docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_2.md |
| 80 | scale_license | M09 Clinical Assessments Suite | docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_2.md |
| 81 | scale_policy | M09 Clinical Assessments Suite | docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_2.md |
| 82 | significant_change_event | M09 Clinical Assessments Suite | docs/modules/WARDENX_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_2.md |
| 83 | hope_assessment | M10 HOPE Engine | docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md |
| 84 | hope_submission | M10 HOPE Engine | docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md |
| 85 | hope_submission_item | M10 HOPE Engine | docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md |
| 86 | hope_timepoint_schedule | M10 HOPE Engine | docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md |
| 87 | hope_validation_finding | M10 HOPE Engine | docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md |
| 88 | symptom_follow_up_visit | M10 HOPE Engine | docs/modules/WARDENX_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md |
| 89 | order_discontinuation | M11 Orders | docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md |
| 90 | order_record | M11 Orders | docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md |
| 91 | order_signature | M11 Orders | docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md |
| 92 | order_verbal_policy | M11 Orders | docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md |
| 93 | standing_order | M11 Orders | docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md |
| 94 | standing_order_instance | M11 Orders | docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md |
| 95 | verbal_order | M11 Orders | docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md |
| 96 | dosespot_prescriber | M12 DoseSpot Integration | docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md |
| 97 | dosespot_webhook_event | M12 DoseSpot Integration | docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md |
| 98 | epcs_signing_attempt | M12 DoseSpot Integration | docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md |
| 99 | medication_order | M12 DoseSpot Integration | docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md |
| 100 | medication_order_transmission | M12 DoseSpot Integration | docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md |
| 101 | refill_request | M12 DoseSpot Integration | docs/modules/WARDENX_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md |
| 102 | administration_offline_queue | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 103 | administration_policy | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 104 | administration_record | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 105 | administration_witness | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 106 | barcode_scan_event | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 107 | comfort_kit_deployment | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 108 | comfort_kit_drawdown | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 109 | medication_reconciliation_decision | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 110 | medication_reconciliation_worksheet | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 111 | missed_dose | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 112 | prn_administration | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 113 | scheduled_dose | M13 eMAR & Med Administration | docs/modules/WARDENX_MODULE_13_EMAR_SPEC_v0_2.md |
| 114 | idg_action_item | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 115 | idg_agenda_item | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 116 | idg_attendance | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 117 | idg_decision | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 118 | idg_meeting | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 119 | idg_minutes | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 120 | idg_minutes_amendment | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 121 | idg_patient_packet | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 122 | idg_recurring_policy | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 123 | notification_template | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 124 | tenant_notification_template_overlay | M14 IDG | docs/modules/WARDENX_MODULE_14_IDG_SPEC_v0_4.md |
| 125 | aide_supervisory_visit | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 126 | discipline_assessment | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 127 | discipline_care_plan | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 128 | discipline_care_plan_signature | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 129 | discipline_care_plan_version | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 130 | discipline_goal | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 131 | discipline_intervention | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 132 | volunteer_assignment | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 133 | volunteer_compliance_gate | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 134 | volunteer_hour_entry | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 135 | volunteer_hour_ledger | M15 Discipline Care Plans | docs/modules/WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md |
| 136 | bereaved_contact | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 137 | bereavement_anniversary_reminder | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 138 | bereavement_contact_log | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 139 | bereavement_opt_out | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 140 | bereavement_outreach | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 141 | bereavement_plan | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 142 | bereavement_plan_closure | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 143 | bereavement_risk_score | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 144 | tenant_bereavement_external_source_gate_override | M16 Bereavement | docs/modules/WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_4.md |
| 145 | clinician_availability | M17 Scheduling & Route Optimization | docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md |
| 146 | recurring_visit | M17 Scheduling & Route Optimization | docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md |
| 147 | route_segment | M17 Scheduling & Route Optimization | docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md |
| 148 | time_off | M17 Scheduling & Route Optimization | docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md |
| 149 | visit | M17 Scheduling & Route Optimization | docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md |
| 150 | visit_proposal | M17 Scheduling & Route Optimization | docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md |
| 151 | visit_state_history | M17 Scheduling & Route Optimization | docs/modules/WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md |
| 152 | evv_aggregator_submission | M18 EVV | docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md |
| 153 | evv_device | M18 EVV | docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md |
| 154 | evv_event | M18 EVV | docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md |
| 155 | evv_geofence_evaluation | M18 EVV | docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md |
| 156 | evv_geofence_policy | M18 EVV | docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md |
| 157 | evv_missing_resolution | M18 EVV | docs/modules/WARDENX_MODULE_18_EVV_SPEC_v0_2.md |
| 158 | external_triage_vendor | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 159 | on_call_shift | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 160 | tenant_oncall_policy | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 161 | triage_call | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 162 | triage_call_answer | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 163 | triage_call_state_history | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 164 | triage_escalation | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 165 | triage_protocol | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 166 | triage_protocol_question | M19 On-Call Triage | docs/modules/WARDENX_MODULE_19_ONCALL_TRIAGE_SPEC_v0_2.md |
| 167 | safety_acknowledgment | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 168 | safety_check_in | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 169 | safety_check_in_schedule | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 170 | safety_emergency_contact_consent | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 171 | safety_high_risk_area | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 172 | safety_incident | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 173 | safety_incident_state_history | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 174 | safety_policy | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 175 | safety_policy_version | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 176 | safety_sos_alert | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 177 | safety_sos_alert_state_history | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 178 | safety_sos_location_stream | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 179 | safety_supervisor_subscription | M20 Field Safety | docs/modules/WARDENX_MODULE_20_FIELD_SAFETY_SPEC_v0_2.md |
| 180 | comfort_kit_dispatch | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 181 | comfort_kit_dispatched_content | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 182 | comfort_kit_return | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 183 | comfort_kit_returned_content | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 184 | comfort_kit_template | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 185 | comfort_kit_template_medication | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 186 | par_stock | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 187 | supply_item | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 188 | supply_request | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 189 | tenant_supply_item_extension | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 190 | vendor_routing_rule | M21 Supplies, DME & Comfort Kits | docs/modules/WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md |
| 191 | classified_page | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 192 | document | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 193 | document_access_log | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 194 | document_legal_hold | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 195 | document_tag | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 196 | document_version | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 197 | extraction_candidate | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 198 | extraction_decision | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 199 | extraction_discrepancy | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 200 | extraction_job | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 201 | extraction_provenance | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 202 | extraction_review | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 203 | form_fill | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 204 | form_template | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 205 | form_template_version | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 206 | intake_upload_batch | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 207 | tenant_template_overlay | M22 Document Management | docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_4.md |
| 208 | claim | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 209 | claim_acknowledgment | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 210 | claim_line | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 211 | claim_state_history | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 212 | claim_submission | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 213 | eligibility_check | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 214 | hipps_calculation | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 215 | mac_submitter_credential | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 216 | noe_record | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 217 | notr_record | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 218 | sequestration_policy | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 219 | sia_calculation | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 220 | validation_override | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 221 | validation_result | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 222 | validation_rule_config | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 223 | validation_run | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 224 | wage_index_factor | M23 Billing — Medicare | docs/modules/WARDENX_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md |
| 225 | medicaid_acknowledgment | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 226 | medicaid_claim | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 227 | medicaid_claim_line | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 228 | medicaid_claim_line_encounter | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 229 | medicaid_claim_state_history | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 230 | medicaid_eligibility_check | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 231 | medicaid_submission | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 232 | medicaid_validation_override | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 233 | medicaid_validation_result | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 234 | medicaid_validation_rule_config | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 235 | medicaid_validation_run | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 236 | rb_arrangement | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 237 | rb_day | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 238 | state_medicaid_trading_partner_credential | M24 Billing — Medicaid | docs/modules/WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md |
| 239 | appeal_case | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 240 | appeal_case_event | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 241 | denial_case | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 242 | denial_case_assignment | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 243 | denial_taxonomy_overlay | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 244 | patient_responsibility_ledger | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 245 | remittance_adjustment | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 246 | remittance_advice | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 247 | remittance_line | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 248 | remittance_remark | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 249 | remittance_service_line | M25 Remittance & Denials | docs/modules/WARDENX_MODULE_25_REMITTANCE_SPEC_v0_2.md |
| 250 | cap_beneficiary_accrual | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 251 | cap_beneficiary_accrual_line | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 252 | cap_inpatient_accrual | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 253 | cap_inpatient_day_line | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 254 | cap_period | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 255 | cap_period_methodology_lock | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 256 | cap_period_platform_constant | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 257 | cap_projection_snapshot | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 258 | cap_psr_import | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 259 | cap_psr_reconciliation | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 260 | cap_settlement | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 261 | cap_threshold_event | M26 Cap Management | docs/modules/WARDENX_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md |
| 262 | bad_debt_record | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 263 | cost_center_mapping | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 264 | cost_report | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 265 | cost_report_compliance_window | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 266 | cost_report_snapshot | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 267 | cost_report_validation | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 268 | cost_report_validation_override | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 269 | cost_report_validation_result | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 270 | cost_report_validation_rule | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 271 | cost_report_worksheet | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 272 | ecr_submission | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 273 | statistic_data | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 274 | trial_balance_import | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 275 | wage_data_import | M27 Cost Report | docs/modules/WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md |
| 276 | fhir_bulk_export_artifact | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 277 | fhir_bulk_export_job | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 278 | fhir_capability_snapshot | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 279 | fhir_client | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 280 | fhir_client_credential | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 281 | fhir_client_session | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 282 | fhir_inbound_resource | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 283 | tenant_fhir_config | M28 FHIR Gateway | docs/modules/WARDENX_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md |
| 284 | external_feed | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 285 | external_feed_credential | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 286 | external_feed_health | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 287 | hl7_inbound_proposal | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 288 | hl7_message_inbound | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 289 | hl7_message_outbound | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 290 | lab_observation | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 291 | lab_observation_inbound_link | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 292 | lab_observation_value | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 293 | nppes_provider | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 294 | nppes_sync_run | M29 External Interfaces | docs/modules/WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md |
| 295 | cahps_decedent_sample | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 296 | cahps_result_summary | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 297 | cahps_sample | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 298 | cahps_vendor_binding | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 299 | cop_compliance_status | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 300 | incident_report | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 301 | infection_outbreak_case | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 302 | infection_surveillance_event | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 303 | measure_recompute_queue | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 304 | mortality_review | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 305 | qapi_governance_minutes | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 306 | qapi_indicator | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 307 | qapi_pip | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 308 | qapi_program | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 309 | qapi_project | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 310 | quality_measure_value | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 311 | sra_cycle | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 312 | sra_finding | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 313 | sra_remediation | M30 HQRP & Quality | docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_4.md |
| 314 | portal_access_grant | M31 Patient/Family Portal & Telehealth | docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md |
| 315 | portal_account | M31 Patient/Family Portal & Telehealth | docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md |
| 316 | telehealth_visit | M31 Patient/Family Portal & Telehealth | docs/modules/WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md |
| 317 | ai_capability | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 318 | ai_capability_calibration | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 319 | ai_capability_lifecycle_event | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 320 | ai_clinician_opt_out | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 321 | ai_evaluation_run | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 322 | ai_hallucination_report | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 323 | ai_invocation | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 324 | ai_kill_switch_state | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 325 | ai_model_backend | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 326 | ai_prompt_template | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 327 | ai_routing_override | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 328 | ai_tenant_opt_in_record | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 329 | ai_token_ledger | M32 AI Platform | docs/modules/WARDENX_MODULE_32_AI_PLATFORM_SPEC_v0_2.md |
| 330 | dashboard_tile_cache | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 331 | materialized_view_metadata | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 332 | report_base_catalog | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 333 | report_definition | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 334 | report_definition_version | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 335 | report_drilldown_audit | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 336 | report_metric_catalog | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 337 | report_run | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 338 | report_schedule | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 339 | report_schedule_run | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 340 | report_share | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 341 | report_view | M33 Reporting & Dashboards | docs/modules/WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md |
| 342 | dsar_export_job | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 343 | dsar_export_job_event | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 344 | onboarding_task | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 345 | onboarding_task_template | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 346 | platform_tenant_baa_record | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 347 | support_consent_grant | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 348 | support_session | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 349 | support_session_event | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 350 | tenant_account | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 351 | tenant_account_status_event | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 352 | tenant_export_job | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 353 | tenant_export_job_event | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 354 | tenant_invitation | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 355 | tenant_key_destruction_log | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 356 | tenant_key_ring | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 357 | tenant_signup_intent | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 358 | tenant_signup_token | M34 SaaS Tenant Platform | docs/modules/WARDENX_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_2.md |
| 359 | dunning_state | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 360 | invoice | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 361 | invoice_line | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 362 | patient_active_period | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 363 | patient_pseudonym_key | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 364 | payment_method | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 365 | plan | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 366 | plan_meter | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 367 | promo_code | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 368 | promo_code_application | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 369 | refund | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 370 | revenue_recognition_snapshot | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 371 | stripe_api_call_audit | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 372 | stripe_webhook_event | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 373 | subscription | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 374 | subscription_state_history | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 375 | usage_event | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 376 | usage_period_aggregate | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 377 | user_active_period | M35 Subscription Billing | docs/modules/WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_2.md |
| 378 | alert | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 379 | alert_payload_catalog | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 380 | alert_rule | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 381 | channel | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 382 | channel_member | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 383 | delivery_endpoint | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 384 | message | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 385 | message_attachment | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 386 | message_receipt | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 387 | notification_delivery | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 388 | presence | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 389 | tenant_alert_routing_override | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 390 | user_notification_preferences | M36 Secure Messaging & Alerts | docs/modules/WARDENX_MODULE_36_MESSAGING_SPEC_v0_4.md |
| 391 | gip_admission_criteria | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 392 | gip_criteria_reassessment | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 393 | inpatient_unit | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 394 | ipu_admission | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 395 | ipu_admission_state_history | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 396 | ipu_admission_transition | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 397 | ipu_bed | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 398 | ipu_bed_assignment | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 399 | ipu_bed_cleaning_event | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 400 | ipu_body_release | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 401 | ipu_census_snapshot | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 402 | ipu_equipment | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 403 | ipu_equipment_inspection | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 404 | ipu_equipment_maintenance | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 405 | ipu_iv_safety_overlay | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 406 | ipu_meal_service | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 407 | ipu_remote_inpatient_episode | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 408 | ipu_restraint_event | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 409 | ipu_restraint_reassessment | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 410 | ipu_rn_coverage_window | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 411 | ipu_room | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 412 | ipu_shift | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 413 | ipu_staff_assignment | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 414 | ipu_visitor | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 415 | ipu_visitor_restriction | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 416 | irc_episode | M37 Inpatient Unit (IPU) Management | docs/modules/WARDENX_MODULE_37_IPU_SPEC_v0_2.md |
| 417 | code_system | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 418 | code_system_version | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 419 | concept_embedding | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 420 | concept_icd10cm | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 421 | concept_loinc | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 422 | concept_rxnorm | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 423 | concept_snomed | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 424 | deprecation_mapping | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 425 | terminology_update_log | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 426 | value_set | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 427 | value_set_expansion | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 428 | value_set_member | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 429 | value_set_tenant_extension | M38 Clinical Terminology Service | docs/modules/WARDENX_MODULE_38_TERMINOLOGY_SPEC_v0_2.md |
| 430 | consent_document_link | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 431 | consent_eval_audit | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 432 | consent_expiration_reminder | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 433 | consent_record | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 434 | consent_record_dpoa_agent | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 435 | consent_record_recipient | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 436 | consent_renewal_cycle | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 437 | consent_revocation | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 438 | consent_type_catalog | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 439 | delegated_access | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 440 | tenant_consent_type_overlay | M39 Consent & Authorization Management | docs/modules/WARDENX_MODULE_39_CONSENT_SPEC_v0_2.md |
| 441 | entity_relationship | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 442 | external_physician | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 443 | external_physician_tenant_overlay | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 444 | facility | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 445 | mdm_baa_record | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 446 | mdm_baa_required | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 447 | mdm_provisional | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 448 | merge_request | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 449 | nppes_sync_coordination | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 450 | nppes_sync_log | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |
| 451 | payer | M40 Master Data Management | docs/modules/WARDENX_MODULE_40_MDM_SPEC_v0_4.md |

## 3. Dependency Graph Audit

Edges (compile-time import deps, `dependsOn`):

```
M02 -> M01
M03 -> M02
M04 -> M01
M04 -> M02
M04 -> M03
M05 -> M02
M05 -> M03
M05 -> M04
M05 -> M36
M05 -> M38
M05 -> M40
M06 -> M05
M06 -> M38
M06 -> M39
M06 -> M40
M07 -> M06
M07 -> M38
M07 -> M39
M08 -> M06
M08 -> M07
M08 -> M36
M08 -> M38
M09 -> M08
M09 -> M38
M10 -> M08
M10 -> M09
M10 -> M36
M10 -> M38
M11 -> M06
M11 -> M08
M11 -> M36
M11 -> M38
M11 -> M40
M12 -> M05
M12 -> M11
M12 -> M38
M12 -> M40
M13 -> M12
M13 -> M36
M13 -> M38
M14 -> M07
M14 -> M08
M14 -> M36
M15 -> M07
M15 -> M08
M16 -> M05
M16 -> M06
M16 -> M36
M17 -> M05
M17 -> M08
M17 -> M40
M18 -> M17
M19 -> M05
M19 -> M17
M19 -> M36
M20 -> M17
M20 -> M36
M21 -> M11
M21 -> M40
M22 -> M01
M22 -> M05
M22 -> M39
M23 -> M06
M23 -> M08
M23 -> M22
M23 -> M38
M23 -> M40
M24 -> M23
M24 -> M40
M25 -> M23
M25 -> M36
M26 -> M23
M26 -> M36
M27 -> M23
M27 -> M26
M27 -> M38
M28 -> M05
M28 -> M06
M28 -> M07
M28 -> M08
M28 -> M11
M28 -> M12
M28 -> M13
M28 -> M38
M28 -> M40
M29 -> M05
M29 -> M11
M29 -> M40
M30 -> M10
M30 -> M23
M30 -> M27
M30 -> M36
M30 -> M38
M31 -> M05
M31 -> M07
M31 -> M08
M31 -> M22
M31 -> M36
M31 -> M39
M32 -> M01
M32 -> M02
M32 -> M03
M32 -> M04
M33 -> M05
M33 -> M06
M33 -> M07
M33 -> M08
M33 -> M09
M33 -> M10
M33 -> M11
M33 -> M12
M33 -> M13
M33 -> M14
M33 -> M15
M33 -> M16
M33 -> M17
M33 -> M18
M33 -> M19
M33 -> M20
M33 -> M21
M33 -> M22
M33 -> M23
M33 -> M24
M33 -> M25
M33 -> M26
M33 -> M27
M33 -> M30
M33 -> M38
M33 -> M40
M34 -> M02
M34 -> M03
M34 -> M04
M34 -> M36
M35 -> M34
M36 -> M01
M36 -> M02
M36 -> M03
M36 -> M04
M37 -> M06
M37 -> M08
M37 -> M11
M37 -> M13
M37 -> M17
M37 -> M23
M38 -> M01
M38 -> M02
M38 -> M03
M38 -> M04
M39 -> M01
M39 -> M02
M39 -> M03
M39 -> M04
M39 -> M05
M40 -> M01
M40 -> M02
M40 -> M03
M40 -> M04
```

- **Cycles:** none ✓ (DAG)
- **Topological order:** M01 → M02 → M03 → M04 → M36 → M38 → M40 → M05 → M39 → M06 → M07 → M08 → M09 → M10 → M11 → M12 → M13 → M14 → M15 → M16 → M17 → M18 → M19 → M20 → M21 → M22 → M23 → M24 → M25 → M26 → M27 → M28 → M29 → M30 → M31 → M32 → M33 → M34 → M35 → M37
- **No outbound** deps (leaves of the graph): M01
- **No inbound** deps (nothing imports them): M28, M29, M31, M32, M33, M35, M37

## 4. Consistency Issues

None ✓ — every `dependsOn` resolves, every table has exactly one owner, every module has codePaths + a spec file.
