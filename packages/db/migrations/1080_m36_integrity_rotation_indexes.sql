-- M36 WP 1.9 — indexes for the nightly `messaging.hash_verify` rotation. The job pages each tenant's message heads and
-- revisions in (created_at, id) order (keyset: `WHERE (created_at, id) > cursor ORDER BY created_at, id LIMIT n`), reads
-- the rows created since the previous run, and draws a small random page by primary key within the tenant. Without
-- (organization_id, created_at, id) the planner sorts the whole tenant every night; for `message` the random page uses the existing
-- unique (organization_id, id); `message_revision` has no such index, so it gets one.
--
-- Lock behaviour: plain CREATE INDEX takes a SHARE lock, blocking writes to `message` / `message_revision` for the build.
-- Both tables are small at this stage (M36 is pre-launch; prod is demo data). The migration runner applies each file in a
-- transaction, which rules out CREATE INDEX CONCURRENTLY; revisit with a separate non-transactional step if these tables
-- ever hold enough rows for the build to matter.

CREATE INDEX IF NOT EXISTS "message_org_created_id_idx"
  ON "message" ("organization_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_revision_org_created_id_idx"
  ON "message_revision" ("organization_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_revision_org_id_idx"
  ON "message_revision" ("organization_id", "id");
