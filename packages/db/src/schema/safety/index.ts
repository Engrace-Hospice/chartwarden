// @chartwarden/db — M20 Field Safety schema barrel (§3.3, 13 owned tables, manifest-exact). The central
// ../index.ts re-exports this barrel; the 12 M20 pgEnums live in ../../enums.ts (M20-T01, unprefixed SQL
// names — M20's §3.2 spells them without an `m20_` prefix, as M19's does).
//
// SHAPE. Four layers:
//   • POLICY — `safety_policy` + `safety_policy_version` (§2.2.4 / D4). Org-level configuration; every
//     other row PINS the version it was written under, so a 2027 policy edit cannot rewrite what cadence
//     was in force during a 2025 incident. The platform FLOOR is a code constant (M20-F03), not a row.
//   • OBLIGATION + ATTESTATION — `safety_check_in_schedule` (what the overdue detector scans) and
//     `safety_check_in` (what the clinician posted). Two tables on purpose: one is a timer the system
//     owns, the other is a statement a person made.
//   • SOS — `safety_sos_alert` and its `safety_sos_location_stream` / `safety_sos_alert_state_history`
//     children. The press is never deduplicated (§2.6); the FAN-OUT is what is idempotent.
//   • INCIDENT + ACT — `safety_incident` + `safety_incident_state_history`, and `safety_acknowledgment`,
//     the row that proves a human answered.
//   • CONFIG — `safety_supervisor_subscription` (who gets woken up), `safety_high_risk_area` (advisory
//     polygons, jsonb rings and no PostGIS per M20-F07) and `safety_emergency_contact_consent` (the
//     clinician's own consent, three separately-revocable purposes).
//
// TENANCY (ARCH-011 / ADR-0010 D2): every table's RLS keys on app.org_id ALONE, all thirteen carry
// organization_id NOT NULL, and there is NO org-NULL row anywhere in this module — M20-F03 struck the
// platform policy row and §3.2 Phase E routes platform polygons to a separate pattern-2 table that the
// manifest does not (yet) own. Eight tables additionally carry provider_entity_id NOT NULL + location_id
// NULLABLE (the three-column rule architecture supplies and the §3.3 block omits): the two check-in
// tables, the three SOS tables, the two incident tables and the acknowledgment. The three CONFIG tables
// and the two POLICY tables are org-level and carry neither — `safety_supervisor_subscription`'s
// `location_id` / `provider_entity_id` look like tenancy columns and are not: they are SCOPE SELECTORS
// saying what a subscription covers, which is why they are nullable.
//
// NOT PARTITIONED. `safety_sos_location_stream` is the only table with a plausible volume argument (one
// row every 30 seconds during an active SOS, capped at 4 hours by the D6/§8.7 forced sunset — so ~480
// rows per alert, and an agency has single-digit SOS alerts per year). §3.7 additionally deletes the
// stream physically at SOS-resolve + 90 days, so the table is self-limiting by design. Partitioning it
// would forbid the real FK to `safety_sos_alert` that makes the crypto-erase sweep a single statement.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
// core) and the intra-M20 parents get real FK constraints. visit_id (M17), patient_id + last_known_patient_id
// (M5), posted_via_device_id (M2) and every `*_membership_id` (M2) are LOGICAL uuid, validated at the write
// boundary through the owning module's seam — the M17 `visit.assigned_membership_id` precedent. The Drizzle
// `.references()` on those columns is the ORM's view of the relationship; the SQL in migration 0110 is
// normative and emits a plain uuid.
//
// IDENTIFIER LENGTH: every CHECK is explicitly named with an `m20_` prefix and a short table abbreviation
// (sp / spv / scis / sci / ssa / ssls / ssash / si / sish / sack / sss / shra / secc). PostgreSQL truncates
// at 63 characters and Drizzle's default naming on a column like
// `osha_reportable_signed_off_by_membership_id` truncates two different constraints to the same string
// (the M16-T02 finding).
//
// Enums + the thirteen tables land in migration 0110; RLS/grants, the thirteen M4 write-audit triggers
// (with the §3.6 denylists mirrored from `M20_AUDIT_DENYLIST` in @chartwarden/types) and the §2.3
// active-SOS guard on the location stream in 0111. The §7.x lifecycle services, the overdue/SLA workers
// and the polygon evaluator land in M20-T03.

export * from "./safety-policy"; // safety_policy, safety_policy_version
export * from "./safety-check-ins"; // safety_check_in_schedule, safety_check_in
export * from "./safety-sos-alerts"; // safety_sos_alert (+ location_stream, alert_state_history)
export * from "./safety-sos-terminus-actions"; // safety_sos_terminus_action (GAP-032)
export * from "./safety-incidents"; // safety_incident, safety_incident_state_history
export * from "./safety-acknowledgments"; // safety_acknowledgment
export * from "./safety-supervisor-subscriptions"; // safety_supervisor_subscription
export * from "./safety-high-risk-areas"; // safety_high_risk_area
export * from "./safety-emergency-contact-consents"; // safety_emergency_contact_consent
