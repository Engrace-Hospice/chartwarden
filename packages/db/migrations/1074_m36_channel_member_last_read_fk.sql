-- M36 WP 1.7 follow-up — channel_member.last_read_message_id was a "soft FK" (no constraint, to avoid a
-- channel_member <-> message cycle), so nothing below the application stopped it from holding another
-- tenant's message id. A composite FK (organization_id, last_read_message_id) closes that without a cycle:
-- ON DELETE SET NULL (last_read_message_id) nulls only the pointer (never organization_id), so the eraser
-- and retention deletes of `message` keep working. PG15+ column-list SET NULL; the repo runs pg18.
-- Pointers that were already dangling (message erased/never existed in this org) are cleared first so the
-- constraint can validate; they carried no information (the receipt rows hold read state).

UPDATE "channel_member" cm
   SET "last_read_message_id" = NULL
 WHERE cm."last_read_message_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "message" m
      WHERE m."organization_id" = cm."organization_id" AND m."id" = cm."last_read_message_id"
   );--> statement-breakpoint

ALTER TABLE "channel_member"
  ADD CONSTRAINT "channel_member_last_read_org_fk"
  FOREIGN KEY ("organization_id", "last_read_message_id")
  REFERENCES "message"("organization_id", "id") ON DELETE SET NULL ("last_read_message_id");--> statement-breakpoint

-- SET NULL is an active edge: a message delete must not scan channel_member (fk-index-coverage).
CREATE INDEX "channel_member_org_last_read_idx" ON "channel_member" ("organization_id", "last_read_message_id")
  WHERE "last_read_message_id" IS NOT NULL;
