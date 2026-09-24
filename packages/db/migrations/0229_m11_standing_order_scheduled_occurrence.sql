-- D5 recurrence identity is the template's existing next_spawn_at cursor, not a newly invented token.
-- A scheduled retry may observe the same cursor, but may never mint a second instance for it.
ALTER TABLE "standing_order_instance"
  ADD COLUMN IF NOT EXISTS "scheduled_for" timestamptz;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "standing_order_instance_scheduled_occurrence_uq"
  ON "standing_order_instance" ("standing_order_id", "scheduled_for")
  WHERE "scheduled_for" IS NOT NULL;
