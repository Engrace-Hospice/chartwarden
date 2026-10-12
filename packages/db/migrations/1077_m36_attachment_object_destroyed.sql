-- M36 WP 1.5 hardening — a way to say "this row's bytes are gone" without deleting the row (the row stays for audit).
--
-- A quarantined file (or a file on a deleted message) keeps a row that is the only pointer to PHI-adjacent evidence. The
-- reaper destroys the OBJECT after a retention window (default 7 days, MESSAGING_ATTACHMENT_RETENTION_DAYS) and stamps this
-- column; the quota sum stops counting a row whose object is destroyed, and `access` refuses it. Only the destruction
-- credential (the one that already deletes rows and holds the destroy rights) may write the column: the app role's UPDATE
-- column list (1075) is unchanged, so an app session can never mark a live object destroyed (or un-mark one).

ALTER TABLE "message_attachment" ADD COLUMN "object_destroyed_at" timestamptz;--> statement-breakpoint

GRANT UPDATE ("object_destroyed_at") ON "message_attachment" TO wardenx_destruction;
