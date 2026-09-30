-- M14 §2.7 / D8 / §7.6 — `compute-carry-forward` idempotency key.
--
-- The carry-forward cron adds ONE `idg_agenda_item` (kind='carry_forward', carried_from_action_item_id = the
-- overdue action item) to the next meeting and increments `idg_action_item.meeting_carry_forward_count` ONCE
-- per (action item, target meeting). The agenda row IS the "carried into this meeting" marker: the cron
-- INSERTs it with ON CONFLICT DO NOTHING against this partial unique index and increments the count only
-- when a row was actually inserted (same tx), so re-runs, concurrent ticks and on-demand packet rebuilds can
-- never double-increment. No new table (agenda rows are append-only: wardenx_app has no DELETE grant, so the
-- marker cannot vanish and re-arm the increment).
--
-- Tenancy/RLS/grants/audit triggers are UNCHANGED (same table; 0043). Idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS "idg_agenda_item_carry_forward_uq"
  ON "idg_agenda_item" ("organization_id", "idg_meeting_id", "carried_from_action_item_id")
  WHERE "kind" = 'carry_forward' AND "carried_from_action_item_id" IS NOT NULL;
