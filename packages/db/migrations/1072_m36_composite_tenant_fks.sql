-- M36 WP 1.7 follow-up — make the database refuse a cross-tenant link, not just the application.
-- A foreign key check bypasses RLS, so `message.channel_id -> channel(id)` accepted a row whose
-- organization_id was org B but whose channel belonged to org A (the app layer always filters by org,
-- but nothing below it enforced that). Each child -> parent edge now references (organization_id, id),
-- the pattern 1065 (message_entity_reference) and 1070 (message_revision) already use. Delete rules are
-- unchanged; the nullable parent/quote columns are skipped under MATCH SIMPLE when NULL. Existing rows
-- are validated by ADD CONSTRAINT, so a pre-existing cross-tenant link would fail this migration loudly.

ALTER TABLE "channel"
  ADD CONSTRAINT "channel_org_id_id_unique" UNIQUE ("organization_id", "id");--> statement-breakpoint

ALTER TABLE "message" DROP CONSTRAINT "message_channel_id_channel_id_fk";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_parent_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_quoted_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "message"
  ADD CONSTRAINT "message_channel_org_fk" FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "message_parent_org_fk" FOREIGN KEY ("organization_id", "parent_message_id")
    REFERENCES "message"("organization_id", "id"),
  ADD CONSTRAINT "message_quoted_org_fk" FOREIGN KEY ("organization_id", "quoted_message_id")
    REFERENCES "message"("organization_id", "id");--> statement-breakpoint

ALTER TABLE "channel_member" DROP CONSTRAINT "channel_member_channel_id_channel_id_fk";--> statement-breakpoint
ALTER TABLE "channel_member"
  ADD CONSTRAINT "channel_member_channel_org_fk" FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "message_receipt" DROP CONSTRAINT "message_receipt_message_id_message_id_fk";--> statement-breakpoint
ALTER TABLE "message_receipt"
  ADD CONSTRAINT "message_receipt_message_org_fk" FOREIGN KEY ("organization_id", "message_id")
    REFERENCES "message"("organization_id", "id") ON DELETE CASCADE;--> statement-breakpoint

-- Index coverage for the new composite edges (test:fk-indexes:live): a cascade/restrict parent delete
-- must not scan the child table.
CREATE INDEX "message_org_channel_idx" ON "message" ("organization_id", "channel_id");--> statement-breakpoint
CREATE INDEX "message_org_parent_idx" ON "message" ("organization_id", "parent_message_id") WHERE "parent_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_org_quoted_idx" ON "message" ("organization_id", "quoted_message_id") WHERE "quoted_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "channel_member_org_channel_idx" ON "channel_member" ("organization_id", "channel_id");--> statement-breakpoint
CREATE INDEX "message_receipt_org_message_idx" ON "message_receipt" ("organization_id", "message_id");
