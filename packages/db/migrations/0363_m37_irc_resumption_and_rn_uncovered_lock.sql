-- M37 §2.5 / §2.3 follow-ups (batch 11).
--
-- (1) IRC cap-window resumption. §2.5: "If an IRC episode is closed (discharge or transfer-out) and the same
-- patient is re-admitted to IRC within 30 days, the new episode's `consecutive_day_count` does NOT reset".
-- The `irc-cap-watchdog` derives each episode's day count from the calendar (day 1 = the start date), so a
-- resumed episode needs to remember how many days it inherited: `carried_over_days` is that base, and the
-- watchdog's target becomes `carried_over_days + elapsed local days + 1`. 0 = a fresh episode (every existing
-- row, so behaviour for episodes already open is unchanged). Additive; the table-level GRANT, FORCEd RLS
-- policy and audit trigger already cover the new column.
ALTER TABLE "irc_episode" ADD COLUMN IF NOT EXISTS "carried_over_days" smallint NOT NULL DEFAULT 0;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "irc_episode" ADD CONSTRAINT "irc_episode_carried_over_days_nonneg" CHECK ("carried_over_days" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- (2) Lock the `m37.shift.rn_uncovered` platform alert rule (spec M37 §2.3 / §4.9: the current hour has no RN
-- on shift — a block-severity alert, the CoP 418.100 24/7-RN survey invariant). Same shape as 0346 / 0352:
-- the tighten-only guard (0334) is DATA-driven (it protects the platform rows whose `system_locked = true`);
-- the code-side `SYSTEM_LOCKED_EVENT_TYPES` now names this event and the boot seed upserts the flag, this
-- closes the window between migrate and the next boot seed. A no-op when the row is not seeded yet.
UPDATE alert_rule
   SET system_locked = true, enabled = true, updated_at = now()
 WHERE organization_id IS NULL
   AND event_type = 'm37.shift.rn_uncovered';
