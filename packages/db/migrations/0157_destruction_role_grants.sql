-- 0157 — the DESTRUCTION ROLE (right-to-erasure deployment; TASK-003 follow-up).
--
-- TASK-003 bound Drizzle erase stores for every data class, but many of the tables those stores
-- DELETE (and tombstone-UPDATE) are append-only for `wardenx_app` — the deliberate 0001 posture
-- (SELECT/INSERT/UPDATE, no DELETE) — so the erase paths fail with `permission denied` on the app
-- connection. This migration creates the NOLOGIN role `wardenx_destruction` carrying EXACTLY the
-- grants the erase stores need. Deployment later creates a login role `IN ROLE wardenx_destruction`
-- and points DATABASE_DESTRUCTION_URL at it; the composition root binds the erase stores to that
-- connection.
--
-- POSTURE (uniform): every table an erase store touches is granted here, INCLUDING tables whose
-- erase leg already works under `wardenx_app` (e.g. `two_factor`/`passkey`/`delegated_access`
-- carry DELETE for the app role). One connection role serves the whole erase path — no split-brain
-- over which store runs on which URL, and revoking a grant from `wardenx_app` later cannot silently
-- break destruction. SELECT is granted alongside every DELETE/UPDATE (the stores `.returning()`
-- and pre-read), and SELECT-ONLY grants cover the stores' guard reads (legal-hold checks,
-- transmitted-submission guards, destruction-blocked evidence COUNTs) — a guard read that
-- default-denies to zero rows would FAIL OPEN (a hold not seen is a hold not honored), so those
-- reads must be real.
--
-- RLS: destruction is ORG-SCOPED, not RLS-bypassed. Every RLS'd org-scoped table granted here gets
-- a `<table>_destruction` policy pinned to the canonical `app.org_id` (same predicate as the
-- wardenx_app policies), so the erase stores' `withOrgContext` scoping still applies and a
-- destruction certificate can never reach across tenants. Org-NULLABLE tables (audit_event,
-- notification_template) keep their platform rows unreachable — `organization_id = app.org_id`
-- never matches NULL. Tables WITHOUT organization_id split three ways:
--   • two_factor / passkey / "user" — user-owned, NO RLS (0006 posture): plain grants, no policy.
--   • presence / delivery_endpoint / user_notification_preferences — RLS'd, user-keyed (0017):
--     policy admits rows of users holding a membership in the context org (app.org_id only — the
--     tenancy gate reserves app.user_id for audit capture). The store's `WHERE user_id = $1`
--     targets the row; the D9 sole-tenant carve-out stays enforced at the code layer
--     (deleteSoleTenantUserRows / soleTenantUserIds).
--   • message_attachment / notification_delivery — pure children: parent-join policy (0017 shape;
--     USING-only, the USING doubles as the implicit WITH CHECK).
--
-- PARTITIONED PARENTS (audit_event, clinical_assessment, hope_assessment, order_record,
-- medication_order, administration_record, idg_patient_packet, extraction_job,
-- extraction_candidate, the report_* family, the 0062–0068 quality partitions): grants and
-- policies attach to the PARENT — parent-routed DML checks privileges and RLS on the parent only,
-- and 0118 keeps every leaf ENABLE+FORCE with no policies of its own, so direct-leaf access
-- default-denies for this role exactly as it does for wardenx_app.
--
-- DELIBERATELY NOT GRANTED (the erase paths are gated, and the gate must hold at the DB layer):
--   • M27 cost-report COMPLIANCE EVIDENCE (cost_report, worksheets, snapshots, validations,
--     imports, bad_debt, statistics, ecr, compliance windows) — SELECT (count) ONLY; deletion is
--     the elevated-cert path, not this role.
--   • M30 quality COMPLIANCE EVIDENCE (incident/mortality/infection/QAPI/SRA/CAHPS-summary/CoP)
--     — SELECT (count) ONLY, same posture.
--   • M26 tenant-offboarding deletes (createDrizzleCapTenantStore: cap_period, cap_settlement,
--     cap_psr_import, …) — that store is documented to run under wardenx_admin; only the
--     per-patient REDACTION (UPDATE) path is granted here (the M24 sibling posture).
--   • M34 platform tables — the platform credential path, out of scope for the tenant-scoped
--     destruction role.
--   • audit_event IS granted (SELECT, DELETE): the partitioned crypto-erase adapter lands in
--     packages/audit under exactly this role (the M4 eraser's performErasure note). The
--     HELPER_ONLY rule (packages/audit is the only sanctioned reader) stays enforced at the code
--     layer; wardenx_app keeps INSERT/SELECT only — the append-only guarantee is unchanged.
--
-- Forward-only (never edit an applied migration). Idempotent guards throughout (role-existence
-- check; GRANTs re-apply cleanly; DROP POLICY IF EXISTS before each CREATE POLICY).

-- ── 1. The role ─────────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_destruction') THEN
    CREATE ROLE wardenx_destruction NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO wardenx_destruction;

-- ── 2. Grants, by module (one statement per table; the comment names the store method) ──────────

-- M1 foundation spine (guard reads used by the user-keyed policies in §3b)
GRANT SELECT ON "membership" TO wardenx_destruction;             -- presence/delivery_endpoint/user_notification_preferences destruction-policy membership join

-- M2 Identity — createDrizzleIdentityEraserStore (identity-eraser.ts)
GRANT SELECT, DELETE ON "two_factor" TO wardenx_destruction;     -- eraseTwoFactor()
GRANT SELECT, DELETE ON "passkey" TO wardenx_destruction;        -- erasePasskeys()
GRANT SELECT ON "user" TO wardenx_destruction;                   -- rescindInvitationsFor() email lookup
GRANT SELECT, DELETE ON "organization_invitation" TO wardenx_destruction;  -- rescindInvitationsFor()

-- M4 Audit — createDrizzleAuditEraserStore/Ports (audit-eraser.ts) + the packages/audit
-- crypto-erase adapter this role exists for (performErasure, landing in a sibling task)
GRANT SELECT, DELETE ON "audit_event" TO wardenx_destruction;    -- performErasure() partitioned crypto-erase (HELPER_ONLY stays code-enforced)
GRANT SELECT ON "legal_hold" TO wardenx_destruction;             -- legalHoldFor() §10.6 supremacy guard (also M39 consentSummary hold read)

-- M5 Patient — createDrizzlePatientEraseStore (patient-eraser.ts)
GRANT SELECT, UPDATE ON "patient" TO wardenx_destruction;        -- tombstonePatient() (also M4 loadPatient / M39 deceased-proof reads)
GRANT SELECT, DELETE ON "patient_address" TO wardenx_destruction;               -- erasePatientSubtree()
GRANT SELECT, UPDATE, DELETE ON "patient_identifier" TO wardenx_destruction;    -- erasePatientSubtree() cipher scrub + delete
GRANT SELECT, DELETE ON "patient_payer" TO wardenx_destruction;                 -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_caregiver" TO wardenx_destruction;             -- erasePatientSubtree()
GRANT SELECT, DELETE ON "emergency_contact" TO wardenx_destruction;             -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_assignment" TO wardenx_destruction;            -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_communication_preference" TO wardenx_destruction;  -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_privacy_flag_snapshot" TO wardenx_destruction; -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_amendment_request" TO wardenx_destruction;     -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_name_alias" TO wardenx_destruction;            -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_phone" TO wardenx_destruction;                 -- erasePatientSubtree()
GRANT SELECT, DELETE ON "patient_email" TO wardenx_destruction;                 -- erasePatientSubtree()

-- M6 Admission — createDrizzleAdmissionEraseStore (admission-eraser.ts)
GRANT SELECT, UPDATE ON "admission" TO wardenx_destruction;      -- tombstoneAdmissions()
GRANT SELECT, DELETE ON "referral" TO wardenx_destruction;                      -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "election_period" TO wardenx_destruction;               -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "election_statement" TO wardenx_destruction;            -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "certification_of_terminal_illness" TO wardenx_destruction;  -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "face_to_face_encounter" TO wardenx_destruction;        -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "level_of_care_period" TO wardenx_destruction;          -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "revocation_event" TO wardenx_destruction;              -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "discharge_event" TO wardenx_destruction;               -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "transfer_event" TO wardenx_destruction;                -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "notice_of_rights_acknowledgment" TO wardenx_destruction;  -- eraseAdmissionSubtree()
GRANT SELECT, DELETE ON "compliance_window" TO wardenx_destruction;             -- eraseAdmissionSubtree()

-- M7 Care Plan — createDrizzleCarePlanEraseStore (care-plan-eraser.ts)
GRANT SELECT, UPDATE ON "care_plan" TO wardenx_destruction;      -- tombstoneCarePlans()
GRANT SELECT, DELETE ON "care_plan_version" TO wardenx_destruction;             -- eraseCarePlanSubtree()
GRANT SELECT, DELETE ON "care_plan_signature" TO wardenx_destruction;           -- eraseCarePlanSubtree()
GRANT SELECT, DELETE ON "problem" TO wardenx_destruction;                       -- eraseCarePlanSubtree()
GRANT SELECT, DELETE ON "goal" TO wardenx_destruction;                          -- eraseCarePlanSubtree()
GRANT SELECT, DELETE ON "intervention" TO wardenx_destruction;                  -- eraseCarePlanSubtree()

-- M8 Encounters — createDrizzleEncounterEraseStore (encounter-eraser.ts)
GRANT SELECT, UPDATE ON "encounter" TO wardenx_destruction;      -- tombstoneEncounters()
GRANT SELECT, UPDATE, DELETE ON "hearthnote_selection" TO wardenx_destruction;         -- cryptoEraseHearthnote() + eraseEncounterSubtree()
GRANT SELECT, UPDATE, DELETE ON "hearthnote_assembled_output" TO wardenx_destruction;  -- cryptoEraseHearthnote() + eraseEncounterSubtree()
GRANT SELECT, DELETE ON "hearthnote_llm_modification" TO wardenx_destruction;   -- eraseEncounterSubtree()
GRANT SELECT, DELETE ON "encounter_signature" TO wardenx_destruction;           -- eraseEncounterSubtree()
GRANT SELECT, DELETE ON "encounter_addendum" TO wardenx_destruction;            -- eraseEncounterSubtree()
GRANT SELECT, DELETE ON "encounter_care_plan_link" TO wardenx_destruction;      -- eraseEncounterSubtree()
GRANT SELECT, DELETE ON "cosignature_request" TO wardenx_destruction;           -- eraseEncounterSubtree()
GRANT SELECT, DELETE ON "vitals" TO wardenx_destruction;                        -- eraseEncounterSubtree()
GRANT SELECT, DELETE ON "mileage" TO wardenx_destruction;                       -- eraseEncounterSubtree()

-- M9 Assessments — createDrizzleAssessmentEraseStore (assessment-eraser.ts)
GRANT SELECT, DELETE ON "clinical_assessment" TO wardenx_destruction;           -- eraseAssessmentSubtree() (partitioned parent)
GRANT SELECT, DELETE ON "assessment_cosignature" TO wardenx_destruction;        -- eraseAssessmentSubtree()
GRANT SELECT, DELETE ON "significant_change_event" TO wardenx_destruction;      -- eraseAssessmentSubtree()

-- M10 HOPE — createDrizzleHopeEraseStore (hope-eraser.ts)
GRANT SELECT, DELETE ON "hope_assessment" TO wardenx_destruction;               -- eraseHopeSubtree() (partitioned parent)
GRANT SELECT, DELETE ON "hope_timepoint_schedule" TO wardenx_destruction;       -- eraseHopeSubtree()
GRANT SELECT, DELETE ON "symptom_follow_up_visit" TO wardenx_destruction;       -- eraseHopeSubtree()
GRANT SELECT, DELETE ON "hope_validation_finding" TO wardenx_destruction;       -- eraseHopeSubtree()
GRANT SELECT ON "hope_submission" TO wardenx_destruction;        -- getSubmittedAssessments() transmitted-retention guard (fail-open if unreadable)
GRANT SELECT ON "hope_submission_item" TO wardenx_destruction;   -- getSubmittedAssessments() transmitted-retention guard

-- M11 Orders — createDrizzleOrderEraseStore (orders-eraser.ts)
GRANT SELECT, DELETE ON "order_record" TO wardenx_destruction;                  -- eraseOrdersSubtree() (partitioned parent)
GRANT SELECT, DELETE ON "order_signature" TO wardenx_destruction;               -- eraseOrdersSubtree()
GRANT SELECT, DELETE ON "verbal_order" TO wardenx_destruction;                  -- eraseOrdersSubtree()
GRANT SELECT, DELETE ON "standing_order_instance" TO wardenx_destruction;       -- eraseOrdersSubtree()
GRANT SELECT, DELETE ON "order_discontinuation" TO wardenx_destruction;         -- eraseOrdersSubtree()
GRANT SELECT, DELETE ON "standing_order" TO wardenx_destruction;                -- eraseOrdersSubtree()

-- M12 DoseSpot — createDrizzleMedicationOrderEraseStore (dosespot-eraser.ts)
GRANT SELECT, DELETE ON "medication_order" TO wardenx_destruction;              -- eraseMedicationOrdersSubtree() (partitioned parent)
GRANT SELECT, DELETE ON "medication_order_transmission" TO wardenx_destruction; -- eraseMedicationOrdersSubtree()
GRANT SELECT, DELETE ON "refill_request" TO wardenx_destruction;                -- eraseMedicationOrdersSubtree()
GRANT SELECT, DELETE ON "epcs_signing_attempt" TO wardenx_destruction;          -- eraseMedicationOrdersSubtree()

-- M13 eMAR — createDrizzleEmarEraseStore (emar-eraser.ts)
GRANT SELECT, DELETE ON "administration_record" TO wardenx_destruction;         -- eraseEmarSubtree() (partitioned parent)
GRANT SELECT, DELETE ON "prn_administration" TO wardenx_destruction;            -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "administration_witness" TO wardenx_destruction;        -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "barcode_scan_event" TO wardenx_destruction;            -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "administration_offline_queue" TO wardenx_destruction;  -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "missed_dose" TO wardenx_destruction;                   -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "scheduled_dose" TO wardenx_destruction;                -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "comfort_kit_deployment" TO wardenx_destruction;        -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "comfort_kit_drawdown" TO wardenx_destruction;          -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "medication_reconciliation_worksheet" TO wardenx_destruction;  -- eraseEmarSubtree()
GRANT SELECT, DELETE ON "medication_reconciliation_decision" TO wardenx_destruction;   -- eraseEmarSubtree()

-- M14 IDG — createDrizzleIdgEraseStore (idg-eraser.ts)
GRANT SELECT, DELETE ON "idg_agenda_item" TO wardenx_destruction;               -- erasePatientRecords()
GRANT SELECT, UPDATE, DELETE ON "idg_decision" TO wardenx_destruction;          -- erasePatientRecords() delete + retention redact
GRANT SELECT, UPDATE, DELETE ON "idg_action_item" TO wardenx_destruction;       -- erasePatientRecords() delete + retention redact
GRANT SELECT, DELETE ON "idg_patient_packet" TO wardenx_destruction;            -- erasePatientRecords() (partitioned parent)
GRANT SELECT, UPDATE ON "idg_minutes" TO wardenx_destruction;    -- erasePatientRecords() minutes digest redact

-- M22 Documents — createDrizzleDocumentEraseStore (document-eraser.ts)
GRANT SELECT, DELETE ON "document" TO wardenx_destruction;                      -- eraseDocumentSubtree()
GRANT SELECT, UPDATE, DELETE ON "document_version" TO wardenx_destruction;      -- cryptoEraseDocumentPayloads() + eraseDocumentSubtree()
GRANT SELECT, DELETE ON "document_tag" TO wardenx_destruction;                  -- eraseDocumentSubtree()
GRANT SELECT, DELETE ON "document_legal_hold" TO wardenx_destruction;           -- resolveSkips() + eraseDocumentSubtree()
GRANT SELECT, DELETE ON "intake_upload_batch" TO wardenx_destruction;           -- eraseDocumentSubtree()
GRANT SELECT, DELETE ON "classified_page" TO wardenx_destruction;               -- eraseDocumentSubtree()
GRANT SELECT, DELETE ON "extraction_job" TO wardenx_destruction;                -- eraseDocumentSubtree() (partitioned parent)
GRANT SELECT, UPDATE, DELETE ON "extraction_candidate" TO wardenx_destruction;  -- cryptoEraseDocumentPayloads() + eraseDocumentSubtree() (partitioned parent)
GRANT SELECT, DELETE ON "extraction_review" TO wardenx_destruction;             -- eraseDocumentSubtree()
GRANT SELECT, DELETE ON "extraction_decision" TO wardenx_destruction;           -- eraseDocumentSubtree()
GRANT SELECT, DELETE ON "extraction_discrepancy" TO wardenx_destruction;        -- eraseDocumentSubtree()
GRANT SELECT, DELETE ON "extraction_provenance" TO wardenx_destruction;         -- eraseDocumentSubtree()

-- M23 Billing-Medicare — createDrizzleBillingEraseStore (billing-eraser.ts)
GRANT SELECT, UPDATE, DELETE ON "claim" TO wardenx_destruction;                 -- erasePatientBillingRecord() redact + delete
GRANT SELECT, DELETE ON "claim_line" TO wardenx_destruction;                    -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "claim_state_history" TO wardenx_destruction;           -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "claim_submission" TO wardenx_destruction;              -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "claim_acknowledgment" TO wardenx_destruction;          -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "validation_run" TO wardenx_destruction;                -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "validation_result" TO wardenx_destruction;             -- erasePatientBillingRecord()
GRANT SELECT, UPDATE, DELETE ON "validation_override" TO wardenx_destruction;   -- erasePatientBillingRecord() redact + delete
GRANT SELECT, DELETE ON "hipps_calculation" TO wardenx_destruction;             -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "sia_calculation" TO wardenx_destruction;               -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "eligibility_check" TO wardenx_destruction;             -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "noe_record" TO wardenx_destruction;                    -- erasePatientBillingRecord()
GRANT SELECT, DELETE ON "notr_record" TO wardenx_destruction;                   -- erasePatientBillingRecord()
GRANT SELECT, UPDATE, DELETE ON "mac_submitter_credential" TO wardenx_destruction;  -- eraseOrgBillingConfig() cipher scrub + delete
GRANT SELECT, DELETE ON "sequestration_policy" TO wardenx_destruction;          -- eraseOrgBillingConfig()
GRANT SELECT, DELETE ON "validation_rule_config" TO wardenx_destruction;        -- eraseOrgBillingConfig()

-- M24 Billing-Medicaid — createDrizzleMedicaidRedactStore (medicaid-eraser.ts; UPDATE-only redaction)
GRANT SELECT, UPDATE ON "rb_arrangement" TO wardenx_destruction;                -- redactRbArrangements()
GRANT SELECT, UPDATE ON "rb_day" TO wardenx_destruction;                        -- redactRbDays()
GRANT SELECT, UPDATE ON "medicaid_eligibility_check" TO wardenx_destruction;    -- redactEligibilityChecks()

-- M25 Remittance — createDrizzleRemittanceEraseStore (remittance-eraser.ts)
GRANT SELECT, DELETE ON "patient_responsibility_ledger" TO wardenx_destruction; -- erasePrLedgerForPatient()

-- M26 Cap — createDrizzleCapRedactStore (cap-eraser.ts; UPDATE-only D14 redaction — the tenant
-- delete store stays on the wardenx_admin offboarding path)
GRANT SELECT, UPDATE ON "cap_beneficiary_accrual" TO wardenx_destruction;       -- redactBeneficiaryAccrual()
GRANT SELECT, UPDATE ON "cap_beneficiary_accrual_line" TO wardenx_destruction;  -- redactAccrualLines()
GRANT SELECT, UPDATE ON "cap_inpatient_day_line" TO wardenx_destruction;        -- redactInpatientDayLines()
GRANT SELECT, UPDATE ON "cap_projection_snapshot" TO wardenx_destruction;       -- redactProjectionSnapshots()
GRANT SELECT, UPDATE ON "cap_threshold_event" TO wardenx_destruction;           -- redactThresholdEvents()
GRANT SELECT, UPDATE ON "cap_psr_reconciliation" TO wardenx_destruction;        -- redactPsrReconciliation()

-- M27 Cost Report — createDrizzleCostReportEraseStore (cost-report-eraser.ts). Operational config
-- deletes only; the 12 compliance-evidence tables are COUNT-ONLY (elevated-cert gate — no DELETE).
GRANT SELECT, DELETE ON "cost_center_mapping" TO wardenx_destruction;           -- deleteOperationalConfig()
GRANT SELECT, DELETE ON "cost_report_validation_rule" TO wardenx_destruction;   -- deleteOperationalConfig() (evidence-referenced rules survive via notExists guard)
GRANT SELECT ON "cost_report" TO wardenx_destruction;                           -- countComplianceEvidence()
GRANT SELECT ON "cost_report_worksheet" TO wardenx_destruction;                 -- countComplianceEvidence()
GRANT SELECT ON "cost_report_snapshot" TO wardenx_destruction;                  -- countComplianceEvidence()
GRANT SELECT ON "cost_report_validation" TO wardenx_destruction;                -- countComplianceEvidence()
GRANT SELECT ON "cost_report_validation_result" TO wardenx_destruction;         -- countComplianceEvidence() + the rule-survival guard join
GRANT SELECT ON "cost_report_validation_override" TO wardenx_destruction;       -- countComplianceEvidence()
GRANT SELECT ON "trial_balance_import" TO wardenx_destruction;                  -- countComplianceEvidence()
GRANT SELECT ON "wage_data_import" TO wardenx_destruction;                      -- countComplianceEvidence()
GRANT SELECT ON "bad_debt_record" TO wardenx_destruction;                       -- countComplianceEvidence()
GRANT SELECT ON "statistic_data" TO wardenx_destruction;                        -- countComplianceEvidence()
GRANT SELECT ON "ecr_submission" TO wardenx_destruction;                        -- countComplianceEvidence()
GRANT SELECT ON "cost_report_compliance_window" TO wardenx_destruction;         -- countComplianceEvidence()

-- M30 Quality — createDrizzleQualityEraseStore (quality-eraser.ts). Operational deletes only; the
-- compliance-evidence families are COUNT-ONLY (destruction-blocked §3.7 — no DELETE).
GRANT SELECT, DELETE ON "measure_recompute_queue" TO wardenx_destruction;       -- deleteRecomputeQueue()
GRANT SELECT, DELETE ON "quality_measure_value" TO wardenx_destruction;         -- deleteMeasureValues()
GRANT SELECT, DELETE ON "cahps_decedent_sample" TO wardenx_destruction;         -- deleteCahpsDecedentSamples() (partitioned parent)
GRANT SELECT, DELETE ON "cahps_vendor_binding" TO wardenx_destruction;          -- deleteCahpsVendorBindings()
GRANT SELECT ON "incident_report" TO wardenx_destruction;                       -- countIncidents()
GRANT SELECT ON "mortality_review" TO wardenx_destruction;                      -- countMortalityReviews()
GRANT SELECT ON "infection_surveillance_event" TO wardenx_destruction;          -- infection-evidence count
GRANT SELECT ON "infection_outbreak_case" TO wardenx_destruction;               -- infection-evidence count
GRANT SELECT ON "cahps_result_summary" TO wardenx_destruction;                  -- CAHPS-evidence count
GRANT SELECT ON "cop_compliance_status" TO wardenx_destruction;                 -- CoP-evidence count
GRANT SELECT ON "qapi_program" TO wardenx_destruction;                          -- QAPI-evidence count
GRANT SELECT ON "qapi_indicator" TO wardenx_destruction;                        -- QAPI-evidence count
GRANT SELECT ON "qapi_pip" TO wardenx_destruction;                              -- QAPI-evidence count
GRANT SELECT ON "qapi_project" TO wardenx_destruction;                          -- QAPI-evidence count
GRANT SELECT ON "qapi_governance_minutes" TO wardenx_destruction;               -- QAPI-evidence count
GRANT SELECT ON "sra_cycle" TO wardenx_destruction;                             -- countSraEvidence()
GRANT SELECT ON "sra_finding" TO wardenx_destruction;                           -- countSraEvidence()
GRANT SELECT ON "sra_remediation" TO wardenx_destruction;                       -- countSraEvidence()

-- M33 Reporting — createDrizzleReportingEraseStore (reporting-eraser.ts). All partitioned parents.
GRANT SELECT, DELETE ON "report_schedule" TO wardenx_destruction;               -- deleteSchedules()
GRANT SELECT, DELETE ON "report_schedule_run" TO wardenx_destruction;           -- deleteScheduleRuns()
GRANT SELECT, DELETE ON "report_run" TO wardenx_destruction;                    -- deleteRuns() (org-NULL platform refresh rows unreachable via the org policy)
GRANT SELECT, DELETE ON "dashboard_tile_cache" TO wardenx_destruction;          -- deleteTileCache()
GRANT SELECT, DELETE ON "report_view" TO wardenx_destruction;                   -- deleteViews()
GRANT SELECT, DELETE ON "report_share" TO wardenx_destruction;                  -- deleteShares()
GRANT SELECT, DELETE ON "report_definition" TO wardenx_destruction;             -- deleteDefinitions()
GRANT SELECT, DELETE ON "report_definition_version" TO wardenx_destruction;     -- deleteDefinitionVersions()
GRANT SELECT ON "report_drilldown_audit" TO wardenx_destruction;                -- countDrilldownAudit() (retention-audit evidence, never deleted here)

-- M36 Messaging — createDrizzleMessagingEraseStore (messaging-eraser.ts)
GRANT SELECT, UPDATE, DELETE ON "message" TO wardenx_destruction;               -- destroyTenantDek() cipher scrub + deleteStructuralRows()
GRANT SELECT, DELETE ON "channel" TO wardenx_destruction;                       -- deleteStructuralRows()
GRANT SELECT, DELETE ON "channel_member" TO wardenx_destruction;                -- deleteStructuralRows()
GRANT SELECT, DELETE ON "message_receipt" TO wardenx_destruction;               -- deleteStructuralRows()
GRANT SELECT, DELETE ON "message_attachment" TO wardenx_destruction;            -- deleteStructuralRows()
GRANT SELECT, DELETE ON "alert" TO wardenx_destruction;                         -- deleteStructuralRows()
GRANT SELECT, DELETE ON "notification_delivery" TO wardenx_destruction;         -- deleteStructuralRows()
GRANT SELECT, DELETE ON "tenant_alert_routing_override" TO wardenx_destruction; -- deleteStructuralRows()
GRANT SELECT, DELETE ON "notification_template" TO wardenx_destruction;         -- deleteStructuralRows() (org rows only; platform-floor NULL rows unreachable)
GRANT SELECT, DELETE ON "tenant_notification_template_overlay" TO wardenx_destruction;  -- deleteStructuralRows()
GRANT SELECT, DELETE ON "presence" TO wardenx_destruction;                      -- deleteSoleTenantUserRows() (wardenx_app holds NO DELETE here — 0017 admin-only)
GRANT SELECT, DELETE ON "delivery_endpoint" TO wardenx_destruction;             -- deleteSoleTenantUserRows()
GRANT SELECT, DELETE ON "user_notification_preferences" TO wardenx_destruction; -- deleteSoleTenantUserRows()

-- M38 Terminology — createDrizzleTerminologyEraseStore (terminology-eraser.ts)
GRANT SELECT, DELETE ON "value_set_tenant_extension" TO wardenx_destruction;    -- eraseTenantExtensions()

-- M39 Consent — createDrizzleConsentEraseStore (consent-eraser.ts; legal_hold + patient guard
-- reads are covered under M4/M5 above)
GRANT SELECT, DELETE ON "consent_record" TO wardenx_destruction;                -- deleteConsents()
GRANT SELECT, DELETE ON "consent_record_recipient" TO wardenx_destruction;      -- deleteConsents()
GRANT SELECT, DELETE ON "consent_record_dpoa_agent" TO wardenx_destruction;     -- deleteConsents()
GRANT SELECT, DELETE ON "consent_revocation" TO wardenx_destruction;            -- deleteConsents()
GRANT SELECT, DELETE ON "consent_expiration_reminder" TO wardenx_destruction;   -- deleteConsents()
GRANT SELECT, DELETE ON "consent_renewal_cycle" TO wardenx_destruction;         -- deleteConsents()
GRANT SELECT, DELETE ON "delegated_access" TO wardenx_destruction;              -- deleteConsents()
GRANT SELECT, DELETE ON "consent_document_link" TO wardenx_destruction;         -- deleteConsents()

-- M40 MDM — createDrizzleMdmEraseStore (mdm-eraser.ts)
GRANT SELECT, DELETE ON "external_physician_tenant_overlay" TO wardenx_destruction;  -- eraseTenantOverlays()
GRANT SELECT, DELETE ON "mdm_provisional" TO wardenx_destruction;               -- eraseTenantProvisionals()
GRANT SELECT, DELETE ON "mdm_baa_record" TO wardenx_destruction;                -- eraseTenantBaaRecords()

-- ── 3a. RLS policies — org-scoped tables (canonical app.org_id pin, the wardenx_app shape) ──────
-- One `<table>_destruction` FOR ALL policy per RLS'd org-scoped table granted above. The GRANTs in
-- §2 stay the privilege ceiling — a FOR ALL policy on a SELECT-only table admits rows, not writes.
-- Idempotent: DROP POLICY IF EXISTS before CREATE (Postgres has no CREATE POLICY IF NOT EXISTS).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- M1 spine + M2 + M4
    'membership','organization_invitation','audit_event','legal_hold',
    -- M5
    'patient','patient_address','patient_identifier','patient_payer','patient_caregiver',
    'emergency_contact','patient_assignment','patient_communication_preference',
    'patient_privacy_flag_snapshot','patient_amendment_request','patient_name_alias',
    'patient_phone','patient_email',
    -- M6
    'admission','referral','election_period','election_statement',
    'certification_of_terminal_illness','face_to_face_encounter','level_of_care_period',
    'revocation_event','discharge_event','transfer_event','notice_of_rights_acknowledgment',
    'compliance_window',
    -- M7
    'care_plan','care_plan_version','care_plan_signature','problem','goal','intervention',
    -- M8
    'encounter','encounter_signature','encounter_addendum','encounter_care_plan_link',
    'cosignature_request','vitals','mileage','hearthnote_selection',
    'hearthnote_assembled_output','hearthnote_llm_modification',
    -- M9
    'clinical_assessment','assessment_cosignature','significant_change_event',
    -- M10
    'hope_assessment','hope_timepoint_schedule','symptom_follow_up_visit',
    'hope_validation_finding','hope_submission','hope_submission_item',
    -- M11
    'order_record','order_signature','verbal_order','standing_order_instance',
    'order_discontinuation','standing_order',
    -- M12
    'medication_order','medication_order_transmission','refill_request','epcs_signing_attempt',
    -- M13
    'administration_record','prn_administration','administration_witness','barcode_scan_event',
    'administration_offline_queue','missed_dose','scheduled_dose','comfort_kit_deployment',
    'comfort_kit_drawdown','medication_reconciliation_worksheet',
    'medication_reconciliation_decision',
    -- M14
    'idg_agenda_item','idg_decision','idg_action_item','idg_patient_packet','idg_minutes',
    -- M22
    'document','document_version','document_tag','document_legal_hold','intake_upload_batch',
    'classified_page','extraction_job','extraction_candidate','extraction_review',
    'extraction_decision','extraction_discrepancy','extraction_provenance',
    -- M23
    'claim','claim_line','claim_state_history','claim_submission','claim_acknowledgment',
    'validation_run','validation_result','validation_override','hipps_calculation',
    'sia_calculation','eligibility_check','noe_record','notr_record','mac_submitter_credential',
    'sequestration_policy','validation_rule_config',
    -- M24 + M25
    'rb_arrangement','rb_day','medicaid_eligibility_check','patient_responsibility_ledger',
    -- M26
    'cap_beneficiary_accrual','cap_beneficiary_accrual_line','cap_inpatient_day_line',
    'cap_projection_snapshot','cap_threshold_event','cap_psr_reconciliation',
    -- M27
    'cost_center_mapping','cost_report_validation_rule','cost_report','cost_report_worksheet',
    'cost_report_snapshot','cost_report_validation','cost_report_validation_result',
    'cost_report_validation_override','trial_balance_import','wage_data_import',
    'bad_debt_record','statistic_data','ecr_submission','cost_report_compliance_window',
    -- M30
    'measure_recompute_queue','quality_measure_value','cahps_decedent_sample',
    'cahps_vendor_binding','incident_report','mortality_review','infection_surveillance_event',
    'infection_outbreak_case','cahps_result_summary','cop_compliance_status','qapi_program',
    'qapi_indicator','qapi_pip','qapi_project','qapi_governance_minutes','sra_cycle',
    'sra_finding','sra_remediation',
    -- M33
    'report_schedule','report_schedule_run','report_run','dashboard_tile_cache','report_view',
    'report_share','report_definition','report_definition_version','report_drilldown_audit',
    -- M36 (org-scoped; the user-keyed and parent-join tables are bespoke in §3b)
    'channel','channel_member','message','message_receipt','alert',
    'tenant_alert_routing_override','notification_template',
    'tenant_notification_template_overlay',
    -- M38 + M39 + M40
    'value_set_tenant_extension','consent_record','consent_record_recipient',
    'consent_record_dpoa_agent','consent_revocation','consent_expiration_reminder',
    'consent_renewal_cycle','delegated_access','consent_document_link',
    'external_physician_tenant_overlay','mdm_provisional','mdm_baa_record'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_destruction', t);
    EXECUTE format($p$CREATE POLICY %I ON %I
                     FOR ALL TO wardenx_destruction
                     USING (organization_id = current_setting('app.org_id', true)::uuid)
                     WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)$p$,
                   t || '_destruction', t);
  END LOOP;
END $$;

-- ── 3b. RLS policies — tables without organization_id ───────────────────────────────────────────
-- two_factor / passkey / "user" carry NO RLS (0001/0006 user-owned posture): the plain grants in
-- §2 suffice, and there is no policy to mirror.
--
-- message_attachment / notification_delivery: pure children — same parent-join shape as their
-- 0017 wardenx_app policies. USING-only: the USING doubles as the implicit WITH CHECK (and a
-- subquery inside a literal WITH CHECK would trip the DDL-legality CHECK heuristic).
DROP POLICY IF EXISTS "message_attachment_destruction" ON "message_attachment";
CREATE POLICY "message_attachment_destruction" ON "message_attachment"
  FOR ALL TO wardenx_destruction
  USING (message_id IN (
    SELECT id FROM message
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));

DROP POLICY IF EXISTS "notification_delivery_destruction" ON "notification_delivery";
CREATE POLICY "notification_delivery_destruction" ON "notification_delivery"
  FOR ALL TO wardenx_destruction
  USING (alert_id IN (
    SELECT id FROM alert
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));

-- presence / delivery_endpoint / user_notification_preferences: user-keyed in 0017 (app.user_id),
-- but ADR-0010 D2 reserves visibility predicates for the canonical app.org_id — so the destruction
-- policy pins to the org through membership: only rows of users holding a membership in the
-- context org are reachable. The store still targets ONE user (`WHERE user_id = $1`), and the D9
-- sole-tenant carve-out (never delete rows of a user who belongs to another tenant) stays enforced
-- at the code layer (deleteSoleTenantUserRows / soleTenantUserIds). The membership SELECT grant +
-- org policy above make this subquery real for the role.
DROP POLICY IF EXISTS "presence_destruction" ON "presence";
CREATE POLICY "presence_destruction" ON "presence"
  FOR ALL TO wardenx_destruction
  USING (user_id IN (
    SELECT user_id FROM membership
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));

DROP POLICY IF EXISTS "delivery_endpoint_destruction" ON "delivery_endpoint";
CREATE POLICY "delivery_endpoint_destruction" ON "delivery_endpoint"
  FOR ALL TO wardenx_destruction
  USING (user_id IN (
    SELECT user_id FROM membership
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));

DROP POLICY IF EXISTS "user_notification_preferences_destruction" ON "user_notification_preferences";
CREATE POLICY "user_notification_preferences_destruction" ON "user_notification_preferences"
  FOR ALL TO wardenx_destruction
  USING (user_id IN (
    SELECT user_id FROM membership
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));
