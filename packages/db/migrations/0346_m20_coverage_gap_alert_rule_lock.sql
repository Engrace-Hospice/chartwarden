-- M36/M20 — lock the `m20.safety.coverage_gap_detected` platform alert rule (spec M20 §4.9: critical,
-- system-locked, to DON + org-admin; "nobody is subscribed to be paged for a field clinician's safety").
--
-- The tighten-only guard (0334 `enforce_alert_rule_locked_tighten_only`) is DATA-driven: it protects exactly the
-- platform rows (`organization_id IS NULL`) whose `system_locked = true`; there is no event-type list in SQL.
-- The code-side set `SYSTEM_LOCKED_EVENT_TYPES` (packages/messaging/src/seed/alert-rules.ts) now names this
-- event type and the boot seed upserts `system_locked = true` — this migration closes the window between
-- migrate and the next boot seed (and any environment whose seed runs late) by flipping an already-seeded
-- platform row immediately. A no-op when the row has not been seeded yet. Existing tenant clones are not
-- rewritten (the emitter ignores any weaker legacy row, as for 0334).
UPDATE alert_rule
   SET system_locked = true, enabled = true, updated_at = now()
 WHERE organization_id IS NULL
   AND event_type = 'm20.safety.coverage_gap_detected';
