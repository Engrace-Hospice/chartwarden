-- compat: contract
-- ADR-0109 D10 / blueprint section 3 - the contact log stops being welded to a scheduled outreach. A PROGRAM ACTIVITY row (a newsletter or holiday
-- mailing, a memorial invitation mailing, a support-group session, a memorial attendance) logs that a contact was reached WITHOUT an outreach row,
-- so it never inflates the M30 CoP numerator and satisfies no cadence item.
--   * `outreach_id` and `kind` drop NOT NULL; `activity_kind` (what the activity was) and `activity_ref_id` (the run / session / service it belongs
--     to, a LOGICAL uuid) are added. The shape CHECK makes the two row families exclusive: an outreach row carries outreach_id + kind and no
--     activity columns; an activity row carries both activity columns and neither outreach column.
--   * The activity kinds are a closed list (all five now, so the groups / memorials PR widens nothing). The outcome CHECK pins the three new
--     outcome values (1370-1372) to activity rows and keeps every activity row on one of them, so an activity row can never read as a
--     `no_response` strike (the unreachable detector also filters on `activity_kind IS NULL`).
--   * A partial UNIQUE index makes the log write idempotent: one row per (activity ref, contact, activity kind, contact_at). The partition key
--     (`contact_at`) must be in a unique index on a partitioned table, and the sweep stamps every row of a run with the run's `mailed_at`, so a
--     retried sweep chunk conflicts instead of double-logging.
-- CONTRACT (it adds CHECKs and a unique index over a populated, partitioned table, and the previous release inserts outreach-only rows that still
-- satisfy them, but a rollback past this file would meet NULL outreach ids): the previous release is not auto-restored over it.
ALTER TABLE "bereavement_contact_log" ALTER COLUMN "outreach_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bereavement_contact_log" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bereavement_contact_log" ADD COLUMN "activity_kind" text;--> statement-breakpoint
ALTER TABLE "bereavement_contact_log" ADD COLUMN "activity_ref_id" uuid;--> statement-breakpoint
ALTER TABLE "bereavement_contact_log" ADD CONSTRAINT "berv_log_activity_shape_chk" CHECK (
  ("outreach_id" IS NOT NULL AND "kind" IS NOT NULL AND "activity_kind" IS NULL AND "activity_ref_id" IS NULL)
  OR ("outreach_id" IS NULL AND "kind" IS NULL AND "activity_kind" IS NOT NULL AND "activity_ref_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "bereavement_contact_log" ADD CONSTRAINT "berv_log_activity_kind_chk" CHECK (
  "activity_kind" IS NULL OR "activity_kind" IN (
    'newsletter_mailing', 'holiday_mailing', 'memorial_invitation_mailing', 'support_group_session', 'memorial_service_attendance'
  )
);--> statement-breakpoint
ALTER TABLE "bereavement_contact_log" ADD CONSTRAINT "berv_log_activity_outcome_chk" CHECK (
  ("activity_kind" IS NULL) = ("outcome" NOT IN ('mailed', 'emailed', 'attended'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_log_activity_uniq" ON "bereavement_contact_log" ("activity_ref_id", "bereaved_contact_id", "activity_kind", "contact_at")
  WHERE "activity_ref_id" IS NOT NULL;
