-- Tenant-first indexes for the 151 org-scoped tables whose `organization_id` appeared in NO index
-- at all (GAP-089).
--
-- WHY THIS IS NOT A "PERFORMANCE NICE-TO-HAVE". Every org-scoped table in this schema carries an RLS
-- policy of the literal form
--     USING (organization_id = current_setting('app.org_id', true)::uuid)
-- so `organization_id = $tenant` is a predicate Postgres AND-s onto EVERY statement — every SELECT,
-- UPDATE and DELETE, on every one of these tables, forever. On a table where no index mentions
-- `organization_id`, the planner has no way to prune by tenant: it can only reach rows through an
-- index on some OTHER column (a parent FK, where one exists) or by scanning the whole table and
-- discarding other tenants' rows row-by-row. The second case is what an org-wide list, a reporting
-- rollup, or a cost/cap aggregate does today on all 151 of these tables — and it gets worse in
-- exact proportion to how many OTHER tenants share the deployment, which is the one number a
-- multi-tenant SaaS cannot control.
--
-- 13 of the 151 had no index whatsoever beyond the primary key on `id` (`qapi_pip`, `qapi_project`,
-- `report_share`, `sra_remediation`, `tenant_step_up_policy_override`, `idg_recurring_policy`,
-- `ipu_admission_transition`, …). On those, EVERY query of any shape is a sequential scan.
--
-- WHAT WAS CHOSEN, AND HOW.
--   • The table set is derived from the CATALOG, not from reading the migration corpus: this file's
--     list is every `relkind IN ('r','p') AND NOT relispartition` table in `public` that has an
--     `organization_id` column and for which no `pg_index` entry names that column in its key. A
--     partition is skipped because it inherits its parent's indexes.
--   • The second key column is the table's own event timestamp — `created_at` when present, else the
--     first NOT NULL timestamptz column in ordinal order (`occurred_at`, `posted_at`, `signed_at`,
--     `revoked_at`, `transitioned_at`, …). A bare `(organization_id)` index is close to useless on a
--     table where one tenant owns most of the rows: it prunes to that tenant and then has to read all
--     of it. `(organization_id, <time>)` is what actually serves the shape these tables are read in —
--     `WHERE org = $1 ORDER BY <time> DESC LIMIT n` — and it still prunes for the plain RLS recheck.
--     Three tables (`invoice_line`, `platform_tenant_baa_record`, `tenant_key_ring`) have no NOT NULL
--     time column at all and take `(organization_id)` alone.
--
-- WHY THESE ARE ADDED RATHER THAN FOLDING `organization_id` INTO THE EXISTING INDEXES. Rewriting, say,
-- `bereavement_plan_closure (plan_id)` into `(organization_id, plan_id)` would hold the index count
-- flat and be strictly better *under RLS*. But it is NOT strictly better: `withPlatformContext`
-- (M34/M40 platform workers) and the migration/ops paths run with RLS bypassed, and there the org
-- predicate is absent — those queries would lose their index entirely. Adding is a change no existing
-- plan can regress on; converting is not. The cost of that choice is one more index to maintain per
-- INSERT on these tables, which is the deliberate trade.
--
-- OPERATIONAL NOTE — `IF NOT EXISTS` IS LOAD-BEARING. `CREATE INDEX` (without CONCURRENTLY) takes a
-- SHARE lock: readers proceed, writers block for the build. On a fresh or small deployment that is
-- imperceptible. On a large populated one, an operator should pre-build these OUT OF BAND with
-- `CREATE INDEX CONCURRENTLY` (same names, same columns — CONCURRENTLY cannot run inside the
-- transaction this migration runner wraps each file in), after which this migration is a no-op.
--
-- Coverage is now gated: `bun run arch:org-indexes` (scripts/check-org-index-coverage.ts) fails when a
-- new org-scoped table ships without an index whose LEADING key column is `organization_id`.

-- M01 Foundation (1)
CREATE INDEX IF NOT EXISTS "feature_flag_evaluation_org_ix" ON "feature_flag_evaluation" ("organization_id", "evaluated_at");

-- M02 Identity & Org (1)
CREATE INDEX IF NOT EXISTS "tenant_step_up_policy_override_org_ix" ON "tenant_step_up_policy_override" ("organization_id", "configured_at");

-- M05 Patient & Demographics (10)
CREATE INDEX IF NOT EXISTS "emergency_contact_org_ix" ON "emergency_contact" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "patient_address_org_ix" ON "patient_address" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "patient_amendment_request_org_ix" ON "patient_amendment_request" ("organization_id", "received_at");
CREATE INDEX IF NOT EXISTS "patient_assignment_org_ix" ON "patient_assignment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "patient_caregiver_org_ix" ON "patient_caregiver" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "patient_communication_preference_org_ix" ON "patient_communication_preference" ("organization_id", "updated_at");
CREATE INDEX IF NOT EXISTS "patient_email_org_ix" ON "patient_email" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "patient_name_alias_org_ix" ON "patient_name_alias" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "patient_payer_org_ix" ON "patient_payer" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "patient_phone_org_ix" ON "patient_phone" ("organization_id", "created_at");

-- M06 Admission, Election & Certification (6)
CREATE INDEX IF NOT EXISTS "discharge_event_org_ix" ON "discharge_event" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "election_period_org_ix" ON "election_period" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "election_statement_org_ix" ON "election_statement" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "level_of_care_period_org_ix" ON "level_of_care_period" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "notice_of_rights_acknowledgment_org_ix" ON "notice_of_rights_acknowledgment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "revocation_event_org_ix" ON "revocation_event" ("organization_id", "created_at");

-- M07 Care Plan (IPOC) (5)
CREATE INDEX IF NOT EXISTS "care_plan_signature_org_ix" ON "care_plan_signature" ("organization_id", "signed_at");
CREATE INDEX IF NOT EXISTS "care_plan_version_org_ix" ON "care_plan_version" ("organization_id", "drafted_at");
CREATE INDEX IF NOT EXISTS "goal_org_ix" ON "goal" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "intervention_org_ix" ON "intervention" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "problem_org_ix" ON "problem" ("organization_id", "created_at");

-- M08 Encounters & Visit Notes (8)
CREATE INDEX IF NOT EXISTS "encounter_addendum_org_ix" ON "encounter_addendum" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "encounter_care_plan_link_org_ix" ON "encounter_care_plan_link" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "encounter_signature_org_ix" ON "encounter_signature" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "hearthnote_assembled_output_org_ix" ON "hearthnote_assembled_output" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "hearthnote_llm_modification_org_ix" ON "hearthnote_llm_modification" ("organization_id", "called_at");
CREATE INDEX IF NOT EXISTS "hearthnote_selection_org_ix" ON "hearthnote_selection" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "mileage_org_ix" ON "mileage" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "vitals_org_ix" ON "vitals" ("organization_id", "created_at");

-- M09 Clinical Assessments Suite (1)
CREATE INDEX IF NOT EXISTS "assessment_cosignature_org_ix" ON "assessment_cosignature" ("organization_id", "cosigned_at");

-- M10 HOPE Engine (1)
CREATE INDEX IF NOT EXISTS "hope_submission_item_org_ix" ON "hope_submission_item" ("organization_id", "created_at");

-- M12 DoseSpot Integration (1)
CREATE INDEX IF NOT EXISTS "epcs_signing_attempt_org_ix" ON "epcs_signing_attempt" ("organization_id", "created_at");

-- M14 IDG (2)
CREATE INDEX IF NOT EXISTS "idg_minutes_amendment_org_ix" ON "idg_minutes_amendment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "idg_recurring_policy_org_ix" ON "idg_recurring_policy" ("organization_id", "created_at");

-- M16 Bereavement (4)
CREATE INDEX IF NOT EXISTS "bereavement_contact_log_org_ix" ON "bereavement_contact_log" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "bereavement_opt_out_org_ix" ON "bereavement_opt_out" ("organization_id", "opted_out_at");
CREATE INDEX IF NOT EXISTS "bereavement_plan_closure_org_ix" ON "bereavement_plan_closure" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "bereavement_risk_score_org_ix" ON "bereavement_risk_score" ("organization_id", "created_at");

-- M17 Scheduling & Route Optimization (3)
CREATE INDEX IF NOT EXISTS "clinician_availability_org_ix" ON "clinician_availability" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "route_segment_org_ix" ON "route_segment" ("organization_id", "computed_at");
CREATE INDEX IF NOT EXISTS "visit_state_history_org_ix" ON "visit_state_history" ("organization_id", "transitioned_at");

-- M19 On-Call Triage (2)
CREATE INDEX IF NOT EXISTS "triage_call_answer_org_ix" ON "triage_call_answer" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "triage_protocol_question_org_ix" ON "triage_protocol_question" ("organization_id", "created_at");

-- M20 Field Safety (3)
CREATE INDEX IF NOT EXISTS "safety_acknowledgment_org_ix" ON "safety_acknowledgment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "safety_incident_state_history_org_ix" ON "safety_incident_state_history" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "safety_sos_alert_state_history_org_ix" ON "safety_sos_alert_state_history" ("organization_id", "created_at");

-- M21 Supplies, DME & Comfort Kits (2)
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatched_content_org_ix" ON "comfort_kit_dispatched_content" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "comfort_kit_template_medication_org_ix" ON "comfort_kit_template_medication" ("organization_id", "created_at");

-- M22 Document Management (8)
CREATE INDEX IF NOT EXISTS "classified_page_org_ix" ON "classified_page" ("organization_id", "classified_at");
CREATE INDEX IF NOT EXISTS "document_legal_hold_org_ix" ON "document_legal_hold" ("organization_id", "applied_at");
CREATE INDEX IF NOT EXISTS "extraction_candidate_org_ix" ON "extraction_candidate" ("organization_id", "extracted_at");
CREATE INDEX IF NOT EXISTS "extraction_decision_org_ix" ON "extraction_decision" ("organization_id", "decided_at");
CREATE INDEX IF NOT EXISTS "extraction_discrepancy_org_ix" ON "extraction_discrepancy" ("organization_id", "detected_at");
CREATE INDEX IF NOT EXISTS "extraction_job_org_ix" ON "extraction_job" ("organization_id", "queued_at");
CREATE INDEX IF NOT EXISTS "extraction_provenance_org_ix" ON "extraction_provenance" ("organization_id", "committed_at");
CREATE INDEX IF NOT EXISTS "extraction_review_org_ix" ON "extraction_review" ("organization_id", "opened_at");

-- M23 Billing — Medicare (7)
CREATE INDEX IF NOT EXISTS "claim_line_org_ix" ON "claim_line" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "claim_submission_org_ix" ON "claim_submission" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "hipps_calculation_org_ix" ON "hipps_calculation" ("organization_id", "calculated_at");
CREATE INDEX IF NOT EXISTS "mac_submitter_credential_org_ix" ON "mac_submitter_credential" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "sequestration_policy_org_ix" ON "sequestration_policy" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "sia_calculation_org_ix" ON "sia_calculation" ("organization_id", "calculated_at");
CREATE INDEX IF NOT EXISTS "validation_override_org_ix" ON "validation_override" ("organization_id", "applied_at");

-- M24 Billing — Medicaid (6)
CREATE INDEX IF NOT EXISTS "medicaid_acknowledgment_org_ix" ON "medicaid_acknowledgment" ("organization_id", "received_at");
CREATE INDEX IF NOT EXISTS "medicaid_eligibility_check_org_ix" ON "medicaid_eligibility_check" ("organization_id", "as_of_service_date");
CREATE INDEX IF NOT EXISTS "medicaid_submission_org_ix" ON "medicaid_submission" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "medicaid_validation_override_org_ix" ON "medicaid_validation_override" ("organization_id", "step_up_auth_token_at");
CREATE INDEX IF NOT EXISTS "rb_arrangement_org_ix" ON "rb_arrangement" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "state_medicaid_trading_partner_credential_org_ix" ON "state_medicaid_trading_partner_credential" ("organization_id", "created_at");

-- M25 Remittance & Denials (10)
CREATE INDEX IF NOT EXISTS "appeal_case_org_ix" ON "appeal_case" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "appeal_case_event_org_ix" ON "appeal_case_event" ("organization_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "denial_case_org_ix" ON "denial_case" ("organization_id", "opened_at");
CREATE INDEX IF NOT EXISTS "denial_case_assignment_org_ix" ON "denial_case_assignment" ("organization_id", "assigned_at");
CREATE INDEX IF NOT EXISTS "patient_responsibility_ledger_org_ix" ON "patient_responsibility_ledger" ("organization_id", "recorded_at");
CREATE INDEX IF NOT EXISTS "remittance_adjustment_org_ix" ON "remittance_adjustment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "remittance_advice_org_ix" ON "remittance_advice" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "remittance_line_org_ix" ON "remittance_line" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "remittance_remark_org_ix" ON "remittance_remark" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "remittance_service_line_org_ix" ON "remittance_service_line" ("organization_id", "created_at");

-- M26 Cap Management (4)
CREATE INDEX IF NOT EXISTS "cap_beneficiary_accrual_line_org_ix" ON "cap_beneficiary_accrual_line" ("organization_id", "posted_at");
CREATE INDEX IF NOT EXISTS "cap_inpatient_day_line_org_ix" ON "cap_inpatient_day_line" ("organization_id", "posted_at");
CREATE INDEX IF NOT EXISTS "cap_period_methodology_lock_org_ix" ON "cap_period_methodology_lock" ("organization_id", "locked_at");
CREATE INDEX IF NOT EXISTS "cap_settlement_org_ix" ON "cap_settlement" ("organization_id", "proposed_at");

-- M27 Cost Report (1)
CREATE INDEX IF NOT EXISTS "cost_report_validation_result_org_ix" ON "cost_report_validation_result" ("organization_id", "recorded_at");

-- M28 FHIR Gateway (3)
CREATE INDEX IF NOT EXISTS "fhir_bulk_export_artifact_org_ix" ON "fhir_bulk_export_artifact" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "fhir_client_credential_org_ix" ON "fhir_client_credential" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "fhir_client_session_org_ix" ON "fhir_client_session" ("organization_id", "issued_at");

-- M29 External Interfaces (2)
CREATE INDEX IF NOT EXISTS "external_feed_credential_org_ix" ON "external_feed_credential" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "lab_observation_value_org_ix" ON "lab_observation_value" ("organization_id", "received_at");

-- M30 HQRP & Quality (14)
CREATE INDEX IF NOT EXISTS "cahps_decedent_sample_org_ix" ON "cahps_decedent_sample" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "cahps_result_summary_org_ix" ON "cahps_result_summary" ("organization_id", "ingested_at");
CREATE INDEX IF NOT EXISTS "cop_compliance_status_org_ix" ON "cop_compliance_status" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "infection_outbreak_case_org_ix" ON "infection_outbreak_case" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "infection_surveillance_event_org_ix" ON "infection_surveillance_event" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "measure_recompute_queue_org_ix" ON "measure_recompute_queue" ("organization_id", "period_start");
CREATE INDEX IF NOT EXISTS "mortality_review_org_ix" ON "mortality_review" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "qapi_governance_minutes_org_ix" ON "qapi_governance_minutes" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "qapi_indicator_org_ix" ON "qapi_indicator" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "qapi_pip_org_ix" ON "qapi_pip" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "qapi_project_org_ix" ON "qapi_project" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "quality_measure_value_org_ix" ON "quality_measure_value" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "sra_finding_org_ix" ON "sra_finding" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "sra_remediation_org_ix" ON "sra_remediation" ("organization_id", "created_at");

-- M32 AI Platform (1)
CREATE INDEX IF NOT EXISTS "ai_clinician_opt_out_org_ix" ON "ai_clinician_opt_out" ("organization_id", "created_at");

-- M33 Reporting & Dashboards (2)
CREATE INDEX IF NOT EXISTS "report_run_org_ix" ON "report_run" ("organization_id", "started_at");
CREATE INDEX IF NOT EXISTS "report_share_org_ix" ON "report_share" ("organization_id", "created_at");

-- M34 SaaS Tenant Platform (6)
CREATE INDEX IF NOT EXISTS "onboarding_task_org_ix" ON "onboarding_task" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "platform_tenant_baa_record_org_ix" ON "platform_tenant_baa_record" ("organization_id");
CREATE INDEX IF NOT EXISTS "support_consent_grant_org_ix" ON "support_consent_grant" ("organization_id", "issued_at");
CREATE INDEX IF NOT EXISTS "support_session_org_ix" ON "support_session" ("organization_id", "started_at");
CREATE INDEX IF NOT EXISTS "tenant_key_destruction_log_org_ix" ON "tenant_key_destruction_log" ("organization_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "tenant_key_ring_org_ix" ON "tenant_key_ring" ("organization_id");

-- M35 Subscription Billing (6)
CREATE INDEX IF NOT EXISTS "dunning_state_org_ix" ON "dunning_state" ("organization_id", "entered_at");
CREATE INDEX IF NOT EXISTS "invoice_line_org_ix" ON "invoice_line" ("organization_id");
CREATE INDEX IF NOT EXISTS "promo_code_application_org_ix" ON "promo_code_application" ("organization_id", "applied_at");
CREATE INDEX IF NOT EXISTS "refund_org_ix" ON "refund" ("organization_id", "requested_at");
CREATE INDEX IF NOT EXISTS "subscription_state_history_org_ix" ON "subscription_state_history" ("organization_id", "transitioned_at");
CREATE INDEX IF NOT EXISTS "usage_period_aggregate_org_ix" ON "usage_period_aggregate" ("organization_id", "period_start");

-- M36 Secure Messaging & Alerts (3)
CREATE INDEX IF NOT EXISTS "channel_member_org_ix" ON "channel_member" ("organization_id", "joined_at");
CREATE INDEX IF NOT EXISTS "message_receipt_org_ix" ON "message_receipt" ("organization_id", "delivered_at");
CREATE INDEX IF NOT EXISTS "tenant_alert_routing_override_org_ix" ON "tenant_alert_routing_override" ("organization_id", "configured_at");

-- M37 Inpatient Unit (IPU) Management (23)
CREATE INDEX IF NOT EXISTS "gip_admission_criteria_org_ix" ON "gip_admission_criteria" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "gip_criteria_reassessment_org_ix" ON "gip_criteria_reassessment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_admission_org_ix" ON "ipu_admission" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_admission_state_history_org_ix" ON "ipu_admission_state_history" ("organization_id", "at");
CREATE INDEX IF NOT EXISTS "ipu_admission_transition_org_ix" ON "ipu_admission_transition" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_bed_org_ix" ON "ipu_bed" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_bed_assignment_org_ix" ON "ipu_bed_assignment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_bed_cleaning_event_org_ix" ON "ipu_bed_cleaning_event" ("organization_id", "at");
CREATE INDEX IF NOT EXISTS "ipu_body_release_org_ix" ON "ipu_body_release" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_equipment_inspection_org_ix" ON "ipu_equipment_inspection" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_equipment_maintenance_org_ix" ON "ipu_equipment_maintenance" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_iv_safety_overlay_org_ix" ON "ipu_iv_safety_overlay" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_meal_service_org_ix" ON "ipu_meal_service" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_remote_inpatient_episode_org_ix" ON "ipu_remote_inpatient_episode" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_restraint_event_org_ix" ON "ipu_restraint_event" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_restraint_reassessment_org_ix" ON "ipu_restraint_reassessment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_rn_coverage_window_org_ix" ON "ipu_rn_coverage_window" ("organization_id", "hour_start_at");
CREATE INDEX IF NOT EXISTS "ipu_room_org_ix" ON "ipu_room" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_shift_org_ix" ON "ipu_shift" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_staff_assignment_org_ix" ON "ipu_staff_assignment" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_visitor_org_ix" ON "ipu_visitor" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ipu_visitor_restriction_org_ix" ON "ipu_visitor_restriction" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "irc_episode_org_ix" ON "irc_episode" ("organization_id", "created_at");

-- M39 Consent & Authorization Management (5)
CREATE INDEX IF NOT EXISTS "consent_document_link_org_ix" ON "consent_document_link" ("organization_id", "rendered_at");
CREATE INDEX IF NOT EXISTS "consent_expiration_reminder_org_ix" ON "consent_expiration_reminder" ("organization_id", "scheduled_for");
CREATE INDEX IF NOT EXISTS "consent_record_dpoa_agent_org_ix" ON "consent_record_dpoa_agent" ("organization_id", "added_at");
CREATE INDEX IF NOT EXISTS "consent_record_recipient_org_ix" ON "consent_record_recipient" ("organization_id", "added_at");
CREATE INDEX IF NOT EXISTS "consent_revocation_org_ix" ON "consent_revocation" ("organization_id", "revoked_at");

-- ── One addition NOT from the derived set ───────────────────────────────────────────────────────
-- `membership` already indexes organization_id — as the SECOND key of `(user_id, organization_id)`,
-- which is right for the lookup that dominates auth ("this user's membership in this org") and is
-- why the coverage gate passes it. But the org ROSTER read is a different query with no user in it:
-- `GET /api/v1/orgs/{id}/members` (the staff facet of global search, the admin staff screens) filters
-- by org alone, and a btree cannot seek on a non-prefix key — so that list has been a sequential scan
-- of every membership row of every tenant on the deployment. `(organization_id, status)` serves it
-- and also serves the far more common "active members of this org" variant.
CREATE INDEX IF NOT EXISTS "membership_org_status_ix" ON "membership" ("organization_id", "status");
