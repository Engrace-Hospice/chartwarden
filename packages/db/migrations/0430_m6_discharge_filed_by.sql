-- GAP-121 (M6 for-cause discharge governance) — record WHO filed a for-cause discharge.
--
-- W-DC-02 / D11 makes a for-cause discharge a two-step control: one person files it (`pending_cosign`), a
-- medical director cosigns it (route 40). `cosignDischarge` could not enforce "the cosigner is not the filer"
-- because the row carried no filer — only the cosigner facts. `filed_by_user_id` is that fact. The service
-- refuses a cosign by the same user (409 DISCHARGE_COSIGNER_IS_FILER) and the new decline route
-- (`POST /discharges/:id/decline-for-cause`) voids the filing instead.
--
-- NULLable: rows filed before this column existed, and every non-for-cause reason, have no recorded filer (the
-- check is skipped for them, never guessed). Not PHI; audited by the existing `discharge_event` write-audit
-- trigger. The table-level grants already cover a new column. Idempotent.

ALTER TABLE "discharge_event" ADD COLUMN IF NOT EXISTS "filed_by_user_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'discharge_event_filed_by_user_id_fk'
  ) THEN
    ALTER TABLE "discharge_event"
      ADD CONSTRAINT "discharge_event_filed_by_user_id_fk"
      FOREIGN KEY ("filed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;
  END IF;
END
$$;--> statement-breakpoint
COMMENT ON COLUMN "discharge_event"."filed_by_user_id" IS
  'GAP-121: the user who filed a for-cause discharge (the route-40 cosigner must differ). NULL = unrecorded (pre-0430 / not for-cause).';
