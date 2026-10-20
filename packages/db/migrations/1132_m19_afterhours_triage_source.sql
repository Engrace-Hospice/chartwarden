-- M19 x M36 WP 4.13 slice S2 (ADR-0082, PROPOSED; flag-off) - the two enum values an after-hours triage request needs on `triage_call`.
--
-- Q3 (ADR-0082) resolved by reading the enums and the table's CHECKs:
--   * triage_call_source: ADD 'm36_afterhours_request'. `source` is the machine-opened marker (`caseOpenedSeverity` pages `warn` for the
--     machine sources, the coalesce grain keys on `source_outbox_event_id`, and the board filters on it). No existing value says "an urgent staff
--     message in M36 asked for this call"; `manual` would hide a machine-opened call from the machine rules, `m36_delivery_failure` would
--     misreport it as an alert failure.
--   * triage_call_inbound_channel: ADD 'inbound_afterhours_request'. `inbound_channel` is NOT NULL and every other machine source already has
--     its own `inbound_*` value (visit_failure, evv_anomaly, alert_failure); the human values (phone, sms, email, portal_message) are
--     what the intake form offers and what reports count as people ringing in, and `inbound_alert_failure` would fold after-hours requests
--     into the delivery-failure count. One value, same pattern.
--   * triage_call_caller_kind: NO change. `system_inbound` (the D10 machine-opened kind) already fits: nobody dialled in.
--   * CHECKs on triage_call: none reference source or channel except `m19_triage_call_paper_origin_pair` (source = 'paper_origin' <=> flag), which
--     a new value cannot touch. No CHECK change.
--
-- Additive only; no existing row is touched. Own migration and the values are NOT used here: PG forbids using an enum value added earlier in the
-- same transaction (the 0290 precedent), so nothing in this file, and nothing ordered before the next migration, may insert them.
ALTER TYPE "public"."triage_call_source" ADD VALUE IF NOT EXISTS 'm36_afterhours_request';--> statement-breakpoint
ALTER TYPE "public"."triage_call_inbound_channel" ADD VALUE IF NOT EXISTS 'inbound_afterhours_request';
