// @wardenx/reporting · catalog — the §4.5 OUTBOX_SUBSCRIPTION_MAP (D15).
//
// The `report.mv_refresh` worker's incremental tier subscribes to ~60 upstream outbox topics across
// M5–M28; each topic projects to the `mv_keys_invalidated[]` it dirties. The §4.4 outbox-subscriber reads
// THIS map to expand a delivered upstream event into the set of MVs to debounce + enqueue (debounced per
// `(mv_key, organization_id)` over each MV's `materialized_view_metadata.debounce_window_seconds`, default
// 5s). The map is the SINGLE SOURCE OF TRUTH for the topic→MV fan-out — the boot dispatcher forward-declares
// one consumer binding per non-empty topic (see `refresh/outbox-subscriber.ts`).
//
// PURE DATA. No imports, no I/O — a frozen lookup table the subscriber + the §4.5 fan-out test read. Keys are
// upstream topic strings (`mN.<entity>.<event>`; M14 IDG keeps the bare `idg.decision_recorded` legacy
// convention). Values are arrays of `mv_key` strings. An EMPTY array `[]` means the topic carries NO
// incremental invalidation — the MV(s) it would feed are covered by the NIGHTLY tier instead (the
// `nightly-cron.ts` 02:00 orchestrator), so a high-velocity topic does not storm the refresh queue.
//
// Cross-module communication here is outbox-ONLY: M33 never imports M5–M28 internals (dependency-cruiser
// blocks it); the topic STRING is the entire contract. The transcribed map below is the §4.5 catalog
// verbatim; the trailing comment block enumerates the NIGHTLY-only MVs that intentionally carry no topic.

/**
 * The §4.5 catalog: upstream outbox topic → the `mv_key`s that event invalidates. An empty array means the
 * topic is aggregated by the nightly tier (no incremental refresh). Frozen so no consumer can mutate it.
 */
export const OUTBOX_SUBSCRIPTION_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // ── M5 patient lifecycle ────────────────────────────────────────────────────────────────────────
  "m5.patient.created": ["mv_census_org_daily"],
  "m6.discharge.created": ["mv_census_org_daily"], // discharge is M6-owned; M5 emits no patient.discharged

  // ── M6 admission lifecycle ──────────────────────────────────────────────────────────────────────
  "m6.admission.activated": [
    "mv_census_org_daily",
    "mv_admission_pipeline_org",
    "mv_recert_calendar_org",
    "mv_f2f_calendar_org",
  ],
  "m6.admission.discharged": ["mv_census_org_daily", "mv_admission_pipeline_org"],
  "m6.cti.signed": ["mv_recert_calendar_org"],
  "m6.f2f.attested": ["mv_f2f_calendar_org"],

  // ── M7 care plan ────────────────────────────────────────────────────────────────────────────────
  "m7.care_plan.review_overdue": ["mv_care_plan_review_overdue_org"],
  "m7.care_plan.version_signed": ["mv_care_plan_review_overdue_org"],

  // ── M8 encounters ───────────────────────────────────────────────────────────────────────────────
  "m8.encounter.signed": [
    "mv_encounter_productivity_membership_day",
    "mv_cosignature_lag_org_month",
  ],
  "m8.encounter.late_entry_override": ["mv_encounter_late_sign_rate_org_week"],
  "m8.encounter.cosigned": ["mv_cosignature_lag_org_month"],

  // ── M9 assessments ──────────────────────────────────────────────────────────────────────────────
  "m9.assessment.recorded": ["mv_supervisory_cadence_org_month"], // aggregate trend

  // ── M10 HOPE ────────────────────────────────────────────────────────────────────────────────────
  "m10.hope.timepoint_signed": ["mv_hope_window_compliance_org_period"],
  "m10.hope.j2051_trigger_fired": ["mv_hope_sfv_compliance_org_period"],
  "m10.hope.submission_accepted": ["mv_hope_window_compliance_org_period"],
  "m10.hope.submission_rejected": ["mv_hope_window_compliance_org_period"],

  // ── M11 orders ──────────────────────────────────────────────────────────────────────────────────
  "m11.order.signed": ["mv_orders_by_kind_org_week"],
  "m11.order.verbal_expired_unsigned": ["mv_verbal_orders_expiring_org"],

  // ── M12 medication orders ───────────────────────────────────────────────────────────────────────
  "m12.medication_order.signed": ["mv_orders_by_kind_org_week"],
  "m12.medication_order.transmitted": ["mv_orders_by_kind_org_week"],

  // ── M13 administration ──────────────────────────────────────────────────────────────────────────
  "m13.administration.recorded": ["mv_medication_administration_org_day"],
  "m13.scheduled_dose.missed": ["mv_missed_dose_rate_org_day"],

  // ── M14 IDG ─────────────────────────────────────────────────────────────────────────────────────
  "idg.decision_recorded": [], // aggregated; nightly refresh sufficient
  "m14.meeting.adjourned": [],

  // ── M15 discipline plans ────────────────────────────────────────────────────────────────────────
  "m15.aide_supervisory.completed": ["mv_supervisory_cadence_org_month"],
  "m15.volunteer.ratio_recomputed": ["mv_volunteer_ratio_org_fy"],

  // ── M16 bereavement ─────────────────────────────────────────────────────────────────────────────
  "m16.bereavement.outreach_completed": ["mv_bereavement_compliance_org_month"],
  "m16.bereavement.outreach_missed": ["mv_bereavement_compliance_org_month"],
  "m16.bereavement.risk_score_computed": ["mv_bereavement_risk_distribution_org"],

  // ── M17 scheduling ──────────────────────────────────────────────────────────────────────────────
  "m17.visit.completed": ["mv_visit_completion_org_day"],
  "m17.visit.no_show_detected": ["mv_visit_completion_org_day"],
  "m17.route_optimized": ["mv_route_efficiency_org_day"],

  // ── M18 EVV ─────────────────────────────────────────────────────────────────────────────────────
  "m18.evv.check_in_recorded": ["mv_evv_compliance_org_week"],
  "m18.evv.check_out_recorded": ["mv_evv_compliance_org_week"],
  "m18.evv.late_check_resolved": ["mv_evv_compliance_org_week"],
  "m18.evv.aggregator_accepted": ["mv_evv_aggregator_acceptance_org_state_month"],
  "m18.evv.aggregator_rejected": ["mv_evv_aggregator_acceptance_org_state_month"],

  // ── M19 on-call triage ──────────────────────────────────────────────────────────────────────────
  "m19.triage_call.opened": ["mv_oncall_activity_org_day"],
  "m19.triage_call.closed": [
    "mv_oncall_activity_org_day",
    "mv_oncall_protocol_adherence_org_month",
  ],

  // ── M20 field safety ────────────────────────────────────────────────────────────────────────────
  "m20.safety.incident_submitted": ["mv_field_safety_incidents_org_month"],

  // ── M21 supplies ────────────────────────────────────────────────────────────────────────────────
  "m21.supply_request.invoice_accrued": [], // nightly
  "m21.supply_request.delivered": [],

  // ── M22 documents ───────────────────────────────────────────────────────────────────────────────
  "m22.intake.uploaded": [],
  "m22.intake.page_classified": [],

  // ── M23 billing — Medicare ──────────────────────────────────────────────────────────────────────
  "m23.claim.submitted": ["mv_claims_ar_aging_org", "mv_noe_window_breach_org_month"],
  "m23.claim.acknowledged": ["mv_claims_ar_aging_org"],
  "m23.claim.paid": ["mv_claims_ar_aging_org", "mv_remittance_posted_org_day"],
  "m23.claim.denied": ["mv_denial_worklist_org", "mv_denial_rate_org_month"],
  "m23.noe.window_breached": ["mv_noe_window_breach_org_month"],

  // ── M24 billing — Medicaid ──────────────────────────────────────────────────────────────────────
  "m24.medicaid_claim.submitted": ["mv_claims_ar_aging_org"],
  "m24.medicaid_claim.denied": ["mv_denial_worklist_org", "mv_denial_rate_org_month"],

  // ── M25 remittance ──────────────────────────────────────────────────────────────────────────────
  "m25.remittance.claim_paid": ["mv_remittance_posted_org_day"],
  "m25.denial.opened": ["mv_denial_worklist_org"],
  "m25.appeal.submitted": ["mv_appeal_outcomes_org_month"],
  "m25.appeal.decided": ["mv_appeal_outcomes_org_month"],

  // ── M26 cap management ──────────────────────────────────────────────────────────────────────────
  "m26.cap.accrual_recorded": ["mv_cap_watch_org_period", "mv_cap_projection_patient_org"],
  "m26.cap.projection_updated": ["mv_cap_watch_org_period", "mv_cap_projection_patient_org"],
  "m26.cap.threshold_crossed": ["mv_cap_watch_org_period"],

  // ── M27 cost report ─────────────────────────────────────────────────────────────────────────────
  "m27.cost_report.created": ["mv_cost_report_status_org_fy"],
  "m27.cost_report.validation_completed": [
    "mv_cost_report_status_org_fy",
    "mv_cost_report_validation_worklist_org",
  ],
  "m27.cost_report.submitted": ["mv_cost_report_status_org_fy"],

  // ── M28 FHIR gateway ────────────────────────────────────────────────────────────────────────────
  "m28.fhir.bulk_export.completed": ["mv_fhir_bulk_export_org_month"],
  "m28.fhir.inbound.accepted": [], // nightly aggregate
});

// NIGHTLY-ONLY MVs (no incremental topic, by design — covered by the `nightly-cron.ts` 02:00 orchestrator):
//   - mv_fhir_egress_org_day             (FHIR egress is a low-velocity daily roll-up)
//   - mv_ipu_census_org_day              (inpatient-unit census — daily aggregate)
//   - mv_ipu_los_org_loc_month           (inpatient length-of-stay — monthly aggregate)
// These are intentionally absent from the map: an `[]` topic OR no topic at all routes the MV to the nightly
// tier (its `materialized_view_metadata.refresh_strategy='nightly'`), which the dispatcher enforces.

/** Every topic the incremental tier listens on (both the invalidating + the explicitly-nightly `[]` rows). */
export const OUTBOX_SUBSCRIPTION_TOPICS: readonly string[] = Object.freeze(
  Object.keys(OUTBOX_SUBSCRIPTION_MAP),
);

/** The topics that ACTUALLY trigger an incremental refresh (non-empty `mv_keys_invalidated`). The boot
 *  dispatcher forward-declares one consumer binding per topic in this set (the `[]` rows need none). */
export const OUTBOX_INVALIDATING_TOPICS: readonly string[] = Object.freeze(
  OUTBOX_SUBSCRIPTION_TOPICS.filter((topic) => (OUTBOX_SUBSCRIPTION_MAP[topic]?.length ?? 0) > 0),
);

/**
 * The `mv_key`s a delivered upstream topic invalidates (the §4.4 subscriber's fan-out lookup). Returns an
 * empty array for an unknown topic OR a nightly-covered `[]` topic — the caller enqueues nothing in both
 * cases (an unknown topic is a no-op, never an error: M33 tolerates upstream emitting events it does not map).
 */
export function mvKeysForTopic(topic: string): readonly string[] {
  return OUTBOX_SUBSCRIPTION_MAP[topic] ?? [];
}
