-- M36 ADR-0058 design review condition 12 (F5) - the tenant's acknowledgement of the whole-history-discoverability notice.
--
-- Turning global search ON makes every message a reader can reach discoverable by content, past and future, not only new
-- ones. The enable PUT now carries the notice version the admin saw; these columns record who accepted which version and
-- when. All three are NULL until a tenant is first switched ON (and stay on their last values across OFF/ON cycles until
-- the next ON overwrites them). The existing write-audit trigger (1091) records the row image, so each acknowledgement is
-- audited with the actor. No new table, no grant change: the table-level SELECT/INSERT/UPDATE grants and the RLS policies
-- already cover the new columns. changed-by style FK to the soft-deleted `user` parent: exempt from the FK-index rule.
ALTER TABLE "tenant_messaging_search_setting"
  ADD COLUMN "notice_ack_version" text,
  ADD COLUMN "notice_ack_by_user_id" uuid REFERENCES "user"("id"),
  ADD COLUMN "notice_ack_at" timestamptz,
  ADD CONSTRAINT "tenant_messaging_search_setting_notice_ack_all_or_none"
    CHECK (("notice_ack_version" IS NULL) = ("notice_ack_by_user_id" IS NULL)
       AND ("notice_ack_version" IS NULL) = ("notice_ack_at" IS NULL));
