-- Supporting indexes for foreign keys that had none (GAP-178).
--
-- WHY. A foreign key without an index on its referencing column makes every DELETE/UPDATE of the
-- PARENT row scan the whole child table to check or cascade (`ON DELETE CASCADE` / `SET NULL` run the
-- same scan per parent row), and gives joins from the parent no way to seek. On the cascade and
-- set-null edges of clinical tables (`idg_action_item.idg_meeting_id`, ...) that is a sequential scan
-- of a PHI table inside a clinical write path; on the tenant-shred (M34) it is quadratic.
--
-- HOW THE SET WAS CHOSEN. Derived from the CATALOG (`pg_constraint` x `pg_index`) of a freshly migrated
-- database, never from reading the corpus: every FK on a non-partition `public` table whose column list
-- is not a LEADING prefix of some valid index key (a PRIMARY KEY / UNIQUE constraint counts as the
-- index it creates). 186 of 526 such FKs are indexed here.
--
-- DELIBERATELY NOT INDEXED (340). FKs with a NO ACTION / RESTRICT delete rule whose parent is
-- `location`, `provider_entity`, `"user"` or `membership` -- the siting and actor stamps carried by
-- nearly every clinical row. Those parents are soft-deleted (never hard-deleted) and an index on each
-- stamp column would add a write to every INSERT on the highest-volume tables for a parent-delete scan
-- that does not happen. They are recorded in `audit/fk-index/baseline.json` and the `arch:fk-indexes`
-- gate (ratchet) lets that list only shrink: a NEW unindexed FK fails the gate.
--
-- Plain (non-CONCURRENT) builds, like 0207: the migration runner is the deploy-time path and holds a
-- transaction per file. `IF NOT EXISTS` makes a re-run safe.

CREATE INDEX IF NOT EXISTS "admission_referral_id_fk_idx" ON admission ("referral_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admission_evidence_admission_id_fk_idx" ON admission_evidence ("admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admission_evidence_election_period_id_fk_idx" ON admission_evidence ("election_period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_clinician_opt_out_capability_id_fk_idx" ON ai_clinician_opt_out ("capability_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aide_supervisory_visit_plan_id_fk_idx" ON aide_supervisory_visit ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_evaluation_run_backend_id_fk_idx" ON ai_evaluation_run ("backend_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_invocation_backend_id_fk_idx" ON ai_invocation ("backend_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_invocation_capability_id_fk_idx" ON ai_invocation ("capability_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_routing_override_capability_id_fk_idx" ON ai_routing_override ("capability_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_tenant_opt_in_record_capability_id_fk_idx" ON ai_tenant_opt_in_record ("capability_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_token_ledger_backend_id_fk_idx" ON ai_token_ledger ("backend_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_token_ledger_capability_id_fk_idx" ON ai_token_ledger ("capability_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_export_requested_by_fk_idx" ON audit_export ("requested_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auditor_engagement_created_by_fk_idx" ON auditor_engagement ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bereavement_contact_log_bereaved_contact_id_fk_idx" ON bereavement_contact_log ("bereaved_contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_beneficiary_accrual_cap_period_id_fk_idx" ON cap_beneficiary_accrual ("cap_period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_inpatient_accrual_cap_period_id_fk_idx" ON cap_inpatient_accrual ("cap_period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_psr_import_cap_period_id_fk_idx" ON cap_psr_import ("cap_period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_psr_reconciliation_psr_import_id_fk_idx" ON cap_psr_reconciliation ("psr_import_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cap_psr_reconciliation_cap_period_id_fk_idx" ON cap_psr_reconciliation ("cap_period_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_plan_idg_proposed_change_care_plan_id_fk_idx" ON care_plan_idg_proposed_change ("care_plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clinical_assessment_corrects_assessment_id_captured_at_fk_idx" ON clinical_assessment ("corrects_assessment_id", "captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatch_comfort_kit_template_id_fk_idx" ON comfort_kit_dispatch ("comfort_kit_template_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatched_content_comfort_kit_template_me_9746a941" ON comfort_kit_dispatched_content ("comfort_kit_template_medication_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_template_replaces_template_id_fk_idx" ON comfort_kit_template ("replaces_template_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compliance_window_closed_by_fk_idx" ON compliance_window ("closed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_carc_version_id_fk_idx" ON concept_carc ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_cvx_version_id_fk_idx" ON concept_cvx ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_embedding_asof_version_fk_idx" ON concept_embedding ("asof_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_hcpcs_version_id_fk_idx" ON concept_hcpcs ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_icd10cm_version_id_fk_idx" ON concept_icd10cm ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_icd10pcs_version_id_fk_idx" ON concept_icd10pcs ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_loinc_version_id_fk_idx" ON concept_loinc ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_ndc_version_id_fk_idx" ON concept_ndc ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_rarc_version_id_fk_idx" ON concept_rarc ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_revenue_version_id_fk_idx" ON concept_revenue ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_rxnorm_version_id_fk_idx" ON concept_rxnorm ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concept_snomed_version_id_fk_idx" ON concept_snomed ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_record_acting_consent_id_fk_idx" ON consent_record ("acting_consent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_record_renewed_from_consent_record_id_fk_idx" ON consent_record ("renewed_from_consent_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_record_superseded_by_consent_record_id_fk_idx" ON consent_record ("superseded_by_consent_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_record_supersedes_consent_record_id_fk_idx" ON consent_record ("supersedes_consent_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_record_type_key_fk_idx" ON consent_record ("type_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consent_renewal_cycle_resolved_consent_record_id_fk_idx" ON consent_renewal_cycle ("resolved_consent_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cosignature_request_supervisor_released_by_fk_idx" ON cosignature_request ("supervisor_released_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_report_snapshot_prior_snapshot_id_fk_idx" ON cost_report_snapshot ("prior_snapshot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_report_validation_cost_report_id_fk_idx" ON cost_report_validation ("cost_report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_report_validation_result_rule_id_fk_idx" ON cost_report_validation_result ("rule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_access_consent_record_id_fk_idx" ON delegated_access ("consent_record_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegated_access_consent_record_recipient_id_fk_idx" ON delegated_access ("consent_record_recipient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deprecation_mapping_created_in_version_id_fk_idx" ON deprecation_mapping ("created_in_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_attestation_membership_id_fk_idx" ON device_attestation ("membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_assessment_plan_id_fk_idx" ON discipline_assessment ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_care_plan_signature_version_id_fk_idx" ON discipline_care_plan_signature ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_care_plan_version_plan_id_fk_idx" ON discipline_care_plan_version ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_goal_plan_id_fk_idx" ON discipline_goal ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_intervention_plan_id_fk_idx" ON discipline_intervention ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_plan_idg_decision_application_plan_id_fk_idx" ON discipline_plan_idg_decision_application ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discipline_plan_idg_decision_application_version_id_fk_idx" ON discipline_plan_idg_decision_application ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ecr_submission_cost_report_id_fk_idx" ON ecr_submission ("cost_report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ecr_submission_snapshot_id_fk_idx" ON ecr_submission ("snapshot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "election_addendum_acknowledgement_recorded_by_user_id_fk_idx" ON election_addendum ("acknowledgement_recorded_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "election_addendum_created_by_user_id_fk_idx" ON election_addendum ("created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "election_addendum_election_statement_id_fk_idx" ON election_addendum ("election_statement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "election_addendum_furnished_by_user_id_fk_idx" ON election_addendum ("furnished_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "election_addendum_superseded_by_id_fk_idx" ON election_addendum ("superseded_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounter_administrative_override_by_fk_idx" ON encounter ("administrative_override_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounter_significant_late_override_by_fk_idx" ON encounter ("significant_late_override_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounter_voided_by_fk_idx" ON encounter ("voided_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "encounter_signature_addendum_id_fk_idx" ON encounter_signature ("addendum_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evv_event_evv_device_id_fk_idx" ON evv_event ("evv_device_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extraction_decision_extraction_review_id_fk_idx" ON extraction_decision ("extraction_review_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_to_face_encounter_window_override_by_fk_idx" ON face_to_face_encounter ("window_override_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "facility_merged_into_id_fk_idx" ON facility ("merged_into_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flag_created_by_fk_idx" ON feature_flag ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flag_organization_id_fk_idx" ON feature_flag ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flag_updated_by_fk_idx" ON feature_flag ("updated_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_fill_template_version_id_fk_idx" ON form_fill ("template_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gip_criteria_reassessment_gip_admission_criteria_id_fk_idx" ON gip_criteria_reassessment ("gip_admission_criteria_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_problem_id_fk_idx" ON goal ("problem_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hearthnote_assembled_output_addendum_id_fk_idx" ON hearthnote_assembled_output ("addendum_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hope_assessment_corrects_assessment_id_target_date_fk_idx" ON hope_assessment ("corrects_assessment_id", "target_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hope_assessment_schedule_id_fk_idx" ON hope_assessment ("schedule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hope_assessment_answer_spec_version_id_fk_idx" ON hope_assessment_answer ("spec_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hope_validation_finding_spec_version_id_fk_idx" ON hope_validation_finding ("spec_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_action_item_idg_decision_id_fk_idx" ON idg_action_item ("idg_decision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_action_item_idg_meeting_id_fk_idx" ON idg_action_item ("idg_meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_agenda_item_idg_meeting_id_fk_idx" ON idg_agenda_item ("idg_meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_attendance_idg_meeting_id_fk_idx" ON idg_attendance ("idg_meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_decision_agenda_item_id_fk_idx" ON idg_decision ("agenda_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_decision_idg_meeting_id_fk_idx" ON idg_decision ("idg_meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_decision_application_ack_idg_decision_id_fk_idx" ON idg_decision_application_ack ("idg_decision_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_discipline_note_idg_meeting_id_fk_idx" ON idg_discipline_note ("idg_meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_meeting_recurring_policy_id_fk_idx" ON idg_meeting ("recurring_policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_minutes_idg_meeting_id_fk_idx" ON idg_minutes ("idg_meeting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_minutes_amendment_idg_minutes_id_fk_idx" ON idg_minutes_amendment ("idg_minutes_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_batch_relink_intake_upload_batch_id_fk_idx" ON intake_batch_relink ("intake_upload_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_upload_batch_records_request_conflict_id_fk_idx" ON intake_upload_batch ("records_request_conflict_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intake_upload_batch_records_request_id_fk_idx" ON intake_upload_batch ("records_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intervention_problem_id_fk_idx" ON intervention ("problem_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_subscription_id_fk_idx" ON invoice ("subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_line_plan_meter_id_fk_idx" ON invoice_line ("plan_meter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_admission_transition_ipu_admission_id_fk_idx" ON ipu_admission_transition ("ipu_admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_admission_transition_destination_unit_id_fk_idx" ON ipu_admission_transition ("destination_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_census_snapshot_unit_id_fk_idx" ON ipu_census_snapshot ("unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_equipment_current_room_id_fk_idx" ON ipu_equipment ("current_room_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_equipment_current_unit_id_fk_idx" ON ipu_equipment ("current_unit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicaid_claim_state_history_organization_id_fk_idx" ON medicaid_claim_state_history ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medication_history_record_pull_id_fk_idx" ON medication_history_record ("pull_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medication_order_dispense_webhook_event_id_fk_idx" ON medication_order_dispense ("webhook_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_invited_by_fk_idx" ON membership ("invited_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_credential_membership_id_fk_idx" ON membership_credential ("membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_elevated_approval_membership_id_fk_idx" ON membership_elevated_approval ("membership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_role_granted_by_fk_idx" ON membership_role ("granted_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_role_role_id_fk_idx" ON membership_role ("role_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_quoted_message_id_fk_idx" ON message ("quoted_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notice_of_rights_acknowledgment_witness_user_id_fk_idx" ON notice_of_rights_acknowledgment ("witness_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_delivery_endpoint_id_fk_idx" ON notification_delivery ("endpoint_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_template_default_payload_type_fk_idx" ON notification_template ("default_payload_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_task_template_key_fk_idx" ON onboarding_task ("template_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "on_call_shift_external_actor_id_fk_idx" ON on_call_shift ("external_actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_created_by_fk_idx" ON organization ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_invitation_inviter_id_fk_idx" ON organization_invitation ("inviter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "par_stock_sku_id_fk_idx" ON par_stock ("sku_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "par_stock_tenant_sku_extension_id_fk_idx" ON par_stock ("tenant_sku_extension_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_merged_into_id_fk_idx" ON patient ("merged_into_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_allergy_patient_id_fk_idx" ON patient_allergy ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_amendment_request_reviewer_user_id_fk_idx" ON patient_amendment_request ("reviewer_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_caregiver_caregiver_id_fk_idx" ON patient_caregiver ("caregiver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_match_review_candidate_existing_patient_id_fk_idx" ON patient_match_review ("candidate_existing_patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_match_review_new_patient_id_fk_idx" ON patient_match_review ("new_patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_match_review_reviewed_by_fk_idx" ON patient_match_review ("reviewed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_merge_performed_by_fk_idx" ON patient_merge ("performed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_merge_unmerged_by_fk_idx" ON patient_merge ("unmerged_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_merged_into_id_fk_idx" ON payer ("merged_into_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "problem_proposal_accepted_problem_id_fk_idx" ON problem_proposal ("accepted_problem_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "problem_proposal_care_plan_id_fk_idx" ON problem_proposal ("care_plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "problem_proposal_duplicate_of_problem_id_fk_idx" ON problem_proposal ("duplicate_of_problem_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_code_application_promo_code_id_fk_idx" ON promo_code_application ("promo_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qapi_governance_minutes_qapi_program_id_fk_idx" ON qapi_governance_minutes ("qapi_program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qapi_indicator_qapi_program_id_fk_idx" ON qapi_indicator ("qapi_program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qapi_pip_linked_project_id_fk_idx" ON qapi_pip ("linked_project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qapi_pip_qapi_program_id_fk_idx" ON qapi_pip ("qapi_program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qapi_project_linked_indicator_id_fk_idx" ON qapi_project ("linked_indicator_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qapi_project_qapi_program_id_fk_idx" ON qapi_project ("qapi_program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_assigned_to_user_id_fk_idx" ON referral ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_evaluated_by_fk_idx" ON referral ("evaluated_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_qualified_by_fk_idx" ON referral ("qualified_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_reviewed_by_fk_idx" ON referral ("reviewed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_activity_actor_id_fk_idx" ON referral_activity ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_note_author_id_fk_idx" ON referral_note ("author_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_base_catalog_mv_key_fk_idx" ON report_base_catalog ("mv_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_schedule_report_view_id_fk_idx" ON report_schedule ("report_view_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_schedule_run_organization_id_fk_idx" ON report_schedule_run ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_share_report_view_id_fk_idx" ON report_share ("report_view_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_view_definition_version_id_fk_idx" ON report_view ("definition_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revocation_event_admission_id_fk_idx" ON revocation_event ("admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_permission_permission_key_fk_idx" ON role_permission ("permission_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_check_in_safety_policy_version_id_fk_idx" ON safety_check_in ("safety_policy_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_check_in_schedule_fulfilled_by_check_in_id_fk_idx" ON safety_check_in_schedule ("fulfilled_by_check_in_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_check_in_schedule_safety_policy_version_id_fk_idx" ON safety_check_in_schedule ("safety_policy_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_incident_safety_policy_version_id_fk_idx" ON safety_incident ("safety_policy_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_incident_linked_sos_alert_id_fk_idx" ON safety_incident ("linked_sos_alert_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_policy_current_version_id_fk_idx" ON safety_policy ("current_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_policy_version_safety_policy_id_fk_idx" ON safety_policy_version ("safety_policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_sos_alert_linked_incident_id_fk_idx" ON safety_sos_alert ("linked_incident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "safety_sos_alert_safety_policy_version_id_fk_idx" ON safety_sos_alert ("safety_policy_version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sra_remediation_sra_finding_id_fk_idx" ON sra_remediation ("sra_finding_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plan_id_fk_idx" ON subscription ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_session_event_organization_id_fk_idx" ON support_session_event ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_alert_routing_override_payload_type_fk_idx" ON tenant_alert_routing_override ("payload_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_consent_type_overlay_type_key_fk_idx" ON tenant_consent_type_overlay ("type_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_oncall_policy_external_triage_vendor_id_fk_idx" ON tenant_oncall_policy ("external_triage_vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_template_overlay_template_id_fk_idx" ON tenant_template_overlay ("template_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "terminology_update_log_version_id_fk_idx" ON terminology_update_log ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_event_admission_id_fk_idx" ON transfer_event ("admission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_selected_protocol_id_fk_idx" ON triage_call ("selected_protocol_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_suggested_protocol_id_fk_idx" ON triage_call ("suggested_protocol_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_call_answer_triage_protocol_question_id_fk_idx" ON triage_call_answer ("triage_protocol_question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_escalation_escalated_to_external_actor_id_fk_idx" ON triage_escalation ("escalated_to_external_actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_paper_reentry_worklist_linked_triage_call_id_fk_idx" ON triage_paper_reentry_worklist ("linked_triage_call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_paper_reentry_worklist_shift_id_fk_idx" ON triage_paper_reentry_worklist ("shift_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_notification_preferences_organization_id_fk_idx" ON user_notification_preferences ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_invoice_line_cost_report_id_fk_idx" ON vendor_invoice_line ("cost_report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_assignment_plan_id_fk_idx" ON volunteer_assignment ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volunteer_hour_entry_ledger_id_fk_idx" ON volunteer_hour_entry ("ledger_id");--> statement-breakpoint
