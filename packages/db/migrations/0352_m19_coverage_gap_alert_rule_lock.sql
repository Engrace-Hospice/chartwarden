-- M36/M19 — lock the `m19.oncall.coverage_gap_detected` platform alert rule (spec M19 §4.9: critical,
-- `role_set` org_admin + clinical_supervisor, system-locked; GAP-057 — the §4.8 coverage-gap watchdog is the
-- first thing that actually raises it).
--
-- Same shape as 0346 (M20): the tighten-only guard (0334 `enforce_alert_rule_locked_tighten_only`) is
-- DATA-driven — it protects exactly the platform rows (`organization_id IS NULL`) whose `system_locked = true`.
-- The code-side `SYSTEM_LOCKED_EVENT_TYPES` (packages/messaging/src/seed/alert-rules.ts) now names this event
-- type and the boot seed upserts `system_locked = true`; this migration closes the window between migrate and
-- the next boot seed by flipping an already-seeded platform row immediately. A no-op when the row has not been
-- seeded yet (idempotent). Existing tenant clones are not rewritten (the emitter ignores any weaker legacy row).
UPDATE alert_rule
   SET system_locked = true, enabled = true, updated_at = now()
 WHERE organization_id IS NULL
   AND event_type = 'm19.oncall.coverage_gap_detected';
