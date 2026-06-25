-- M33 Reporting & Dashboards §3.2 (phase 2 seed) / §3.1 — platform-shipped catalog seed (M33-T06).
-- Idempotent (ON CONFLICT DO NOTHING). Registers ALL ~36 platform MV keys from §3.1 in
-- materialized_view_metadata: status='active' for the THREE physically-created MVs (0060), and
-- status='registered' for the rest (upstream module / MV SQL absent in Phase 1). Then seeds the metric
-- + base catalogs for the three active bases. The MV-metadata rows precede the base rows because
-- report_base_catalog.mv_key FK-references materialized_view_metadata.mv_key.

-- ============================================================================================
-- 1. materialized_view_metadata — the full ~36-key registry (3 active, 33 registered placeholders).
-- ============================================================================================
INSERT INTO "materialized_view_metadata"
  ("mv_key", "refresh_strategy", "expected_freshness_seconds", "status")
VALUES
  -- ACTIVE (physically created in 0060)
  ('mv_census_org_daily', 'nightly', 86400, 'active'),
  ('mv_encounter_productivity_membership_day', 'incremental', 300, 'active'),
  ('mv_evv_compliance_org_week', 'incremental', 300, 'active'),
  -- REGISTERED placeholders — census
  ('mv_admission_pipeline_org', 'nightly', 86400, 'registered'),
  ('mv_recert_calendar_org', 'nightly', 86400, 'registered'),
  ('mv_f2f_calendar_org', 'nightly', 86400, 'registered'),
  -- productivity
  ('mv_encounter_late_sign_rate_org_week', 'nightly', 86400, 'registered'),
  ('mv_cosignature_lag_org_month', 'nightly', 86400, 'registered'),
  ('mv_visit_completion_org_day', 'nightly', 86400, 'registered'),
  ('mv_route_efficiency_org_day', 'nightly', 86400, 'registered'),
  -- clinical
  ('mv_hope_window_compliance_org_period', 'nightly', 86400, 'registered'),
  ('mv_hope_sfv_compliance_org_period', 'nightly', 86400, 'registered'),
  ('mv_care_plan_review_overdue_org', 'nightly', 86400, 'registered'),
  ('mv_volunteer_ratio_org_fy', 'nightly', 86400, 'registered'),
  ('mv_supervisory_cadence_org_month', 'nightly', 86400, 'registered'),
  -- medication
  ('mv_orders_by_kind_org_week', 'nightly', 86400, 'registered'),
  ('mv_verbal_orders_expiring_org', 'nightly', 86400, 'registered'),
  ('mv_medication_administration_org_day', 'nightly', 86400, 'registered'),
  ('mv_missed_dose_rate_org_day', 'nightly', 86400, 'registered'),
  -- evv
  ('mv_evv_aggregator_acceptance_org_state_month', 'nightly', 86400, 'registered'),
  -- oncall
  ('mv_oncall_activity_org_day', 'nightly', 86400, 'registered'),
  ('mv_oncall_protocol_adherence_org_month', 'nightly', 86400, 'registered'),
  -- bereavement
  ('mv_bereavement_compliance_org_month', 'nightly', 86400, 'registered'),
  ('mv_bereavement_risk_distribution_org', 'nightly', 86400, 'registered'),
  -- field_safety
  ('mv_field_safety_incidents_org_month', 'nightly', 86400, 'registered'),
  -- billing
  ('mv_claims_ar_aging_org', 'nightly', 86400, 'registered'),
  ('mv_denial_worklist_org', 'nightly', 86400, 'registered'),
  ('mv_denial_rate_org_month', 'nightly', 86400, 'registered'),
  ('mv_noe_window_breach_org_month', 'nightly', 86400, 'registered'),
  ('mv_remittance_posted_org_day', 'nightly', 86400, 'registered'),
  ('mv_appeal_outcomes_org_month', 'nightly', 86400, 'registered'),
  -- cap
  ('mv_cap_watch_org_period', 'nightly', 86400, 'registered'),
  ('mv_cap_projection_patient_org', 'nightly', 86400, 'registered'),
  -- cost_report
  ('mv_cost_report_status_org_fy', 'nightly', 86400, 'registered'),
  ('mv_cost_report_validation_worklist_org', 'nightly', 86400, 'registered'),
  -- fhir
  ('mv_fhir_egress_org_day', 'nightly', 86400, 'registered'),
  ('mv_fhir_bulk_export_org_month', 'nightly', 86400, 'registered'),
  -- ipu
  ('mv_ipu_census_org_day', 'nightly', 86400, 'registered'),
  ('mv_ipu_los_org_loc_month', 'nightly', 86400, 'registered')
ON CONFLICT ("mv_key") DO NOTHING;--> statement-breakpoint

-- ============================================================================================
-- 2. report_metric_catalog — the metrics exposed by the three active bases (status='active').
-- ============================================================================================
INSERT INTO "report_metric_catalog"
  ("metric_key", "display_name", "unit", "aggregation", "source_seam", "sensitive_flag", "status")
VALUES
  ('active_patient_count', 'Active Patients', 'count', 'sum', 'AdmissionCensusProvider.aggregateForOrg', false, 'active'),
  ('encounter_count', 'Encounters', 'count', 'sum', 'EncounterStatisticsProvider.aggregateForOrg', false, 'active'),
  ('signed_encounter_count', 'Signed Encounters', 'count', 'sum', 'EncounterStatisticsProvider.aggregateForOrg', false, 'active'),
  ('evv_check_in_count', 'EVV Check-ins', 'count', 'sum', 'EvvMetricsProvider.aggregateForOrg', false, 'active'),
  ('evv_check_out_count', 'EVV Check-outs', 'count', 'sum', 'EvvMetricsProvider.aggregateForOrg', false, 'active'),
  ('evv_visit_count', 'EVV Visits', 'count', 'count_distinct', 'EvvMetricsProvider.aggregateForOrg', false, 'active')
ON CONFLICT ("metric_key") DO NOTHING;--> statement-breakpoint

-- ============================================================================================
-- 3. report_base_catalog — one base per active MV (status='active'). dimensions/measures are the
--    §3.3 DimensionCatalog[] / MeasureCatalog[] jsonb shapes.
-- ============================================================================================
INSERT INTO "report_base_catalog"
  ("base_key", "display_name", "domain", "description", "mv_key", "dimensions", "measures", "exposes_phi_via_drilldown", "status")
VALUES
  (
    'census_org_daily',
    'Daily Census',
    'census',
    'Newly-activated active-patient census per organization per day.',
    'mv_census_org_daily',
    '[{"dimensionKey":"census_day","displayName":"Census Day","dataType":"date"}]'::jsonb,
    '[{"measureKey":"active_patient_count","displayName":"Active Patients","metricKey":"active_patient_count","unit":"count","aggregation":"sum"}]'::jsonb,
    false,
    'active'
  ),
  (
    'encounter_productivity_membership_day',
    'Encounter Productivity by Clinician',
    'productivity',
    'Encounter counts (total and signed) per authoring membership per service day.',
    'mv_encounter_productivity_membership_day',
    '[{"dimensionKey":"authored_by_membership_id","displayName":"Clinician","dataType":"uuid"},{"dimensionKey":"productivity_day","displayName":"Service Day","dataType":"date"}]'::jsonb,
    '[{"measureKey":"encounter_count","displayName":"Encounters","metricKey":"encounter_count","unit":"count","aggregation":"sum"},{"measureKey":"signed_count","displayName":"Signed Encounters","metricKey":"signed_encounter_count","unit":"count","aggregation":"sum"}]'::jsonb,
    false,
    'active'
  ),
  (
    'evv_compliance_org_week',
    'EVV Compliance by Week',
    'evv',
    'EVV check-in/check-out pairing and visit counts per organization per ISO week.',
    'mv_evv_compliance_org_week',
    '[{"dimensionKey":"evv_week","displayName":"Week","dataType":"date"}]'::jsonb,
    '[{"measureKey":"check_in_count","displayName":"Check-ins","metricKey":"evv_check_in_count","unit":"count","aggregation":"sum"},{"measureKey":"check_out_count","displayName":"Check-outs","metricKey":"evv_check_out_count","unit":"count","aggregation":"sum"},{"measureKey":"visit_count","displayName":"Visits","metricKey":"evv_visit_count","unit":"count","aggregation":"count_distinct"}]'::jsonb,
    false,
    'active'
  )
ON CONFLICT ("base_key") DO NOTHING;
