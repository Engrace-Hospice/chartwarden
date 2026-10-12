-- M36 WP 2.2 - the database, not only the application, refuses a reply or quote that points at a message of
-- ANOTHER CHANNEL (audit F5 / decision D6). 1072 made the edge tenant-safe ((organization_id, parent_message_id) ->
-- message(organization_id, id)); it still accepted a same-org parent in a different channel, which the write
-- core's guard (messaging-write-core.ts, PARENT_MESSAGE_NOT_IN_CHANNEL / QUOTED_MESSAGE_NOT_IN_CHANNEL) was the only
-- thing stopping. The edges now carry the channel too: (organization_id, channel_id, parent_message_id) ->
-- message(organization_id, channel_id, id). A NULL parent/quote is skipped (MATCH SIMPLE), so top-level messages are
-- unaffected; moving a reply's channel_id, or re-pointing its parent, is refused by the same constraint. The 1072
-- (organization_id, id) edges are implied by the new ones and are replaced, not kept beside them.
--
-- Existing rows: the application guard has refused a cross-channel link since WP 1.7, so none is expected. The new
-- foreign keys are added NOT VALID (enforced for every write from this point on, no scan under the strong lock) and
-- then VALIDATEd (a scan under SHARE UPDATE EXCLUSIVE, which does not block reads or writes). A pre-existing
-- violating row would make VALIDATE, and so this migration, fail loudly with the offending constraint, leaving the
-- schema untouched (one transaction): the remedy is a reviewed data repair (re-point or null the link; the message
-- itself and its hash are never altered), never a silent NOT VALID left behind. Find them first with:
--   SELECT c.id FROM message c JOIN message p ON p.organization_id = c.organization_id AND p.id = c.parent_message_id
--    WHERE p.channel_id <> c.channel_id;      -- and the same for quoted_message_id
--
-- Locking: the UNIQUE constraint builds its index under a SHARE lock (writes to `message` wait while it builds);
-- same trade-off 1072 and 1080 accepted. Index coverage (test:fk-indexes:live): the referenced side is the new unique
-- constraint; the referencing side is a partial (organization_id, channel_id, parent|quoted) index, which also serves
-- the thread read (`WHERE organization_id = $1 AND channel_id = $2 AND parent_message_id = $3 ORDER BY created_at`
-- needs only the sort of one thread's replies) and the grouped reply-count lookup. It replaces the narrower
-- (organization_id, parent|quoted) index of 1072 (the leading-column prefix rule no longer needs it).

ALTER TABLE "message"
  ADD CONSTRAINT "message_org_channel_id_unique" UNIQUE ("organization_id", "channel_id", "id");--> statement-breakpoint

ALTER TABLE "message" DROP CONSTRAINT "message_parent_org_fk";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_quoted_org_fk";--> statement-breakpoint
ALTER TABLE "message"
  ADD CONSTRAINT "message_parent_channel_fk" FOREIGN KEY ("organization_id", "channel_id", "parent_message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") NOT VALID,
  ADD CONSTRAINT "message_quoted_channel_fk" FOREIGN KEY ("organization_id", "channel_id", "quoted_message_id")
    REFERENCES "message"("organization_id", "channel_id", "id") NOT VALID;--> statement-breakpoint
ALTER TABLE "message" VALIDATE CONSTRAINT "message_parent_channel_fk";--> statement-breakpoint
ALTER TABLE "message" VALIDATE CONSTRAINT "message_quoted_channel_fk";--> statement-breakpoint

DROP INDEX IF EXISTS "message_org_parent_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "message_org_quoted_idx";--> statement-breakpoint
CREATE INDEX "message_org_channel_parent_idx" ON "message" ("organization_id", "channel_id", "parent_message_id", "created_at", "id") WHERE "parent_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_org_channel_quoted_idx" ON "message" ("organization_id", "channel_id", "quoted_message_id") WHERE "quoted_message_id" IS NOT NULL;
