-- compat: expand
-- M23: a tenant that "bills outside ChartWarden" files its NOE / NOTR itself (owner decision D4, ADR-0053 amendment 2026-11-06).
-- ChartWarden transmits nothing for it, but keeps counting the CMS 5-day window (the window-watch crons and the DDE watchdog
-- read `window_target_at`, which is untouched) until the tenant records the date it filed. No state / enum change: a parked
-- notice stays `draft` / `ready`; these columns say who files it and, once recorded, when.
--
--   external_filing_status          NULL      ChartWarden's own path (or nothing decided yet).
--                                   'pending' parked: the org bills outside, so the notice waits for the tenant to file it
--                                             with its biller ("file with your biller"). Still on the deadline tracker.
--                                   'filed'   the tenant recorded the date it filed (a notice with this status leaves the
--                                             window watch and the DDE watchdog: its deadline was met, or breached on record).
--   filed_externally_on             date the tenant filed it (the tenant's own statement; Medicare's answer is not recorded here).
--   filed_externally_recorded_at    when the tenant recorded it in ChartWarden.
--   filed_externally_by_membership_id  who recorded it (logical FK to M2, like every other membership column here).
--
--   external_filing_set_breach     true when the RECORD itself wrote the notice's breach stamp (`window_breached_at`): a late
--                                  record (filed after the due day) stamps its own filed date when the watchdog had stamped
--                                  nothing. false otherwise, always for a stamp the deadline watchdog wrote. The two writers can
--                                  stamp the SAME date (a tenant filing exactly one day late records the day the watchdog's first
--                                  tick stamps), so the dates cannot say whose stamp it is: a withdrawal of the record clears the
--                                  stamp only when this is true, and resets it. A true value needs status 'filed' (a CHECK; IS NOT DISTINCT FROM, since a NULL
--                                  status would otherwise satisfy it).
--
-- The three filed_* columns are set together with status 'filed' and are all NULL otherwise: the CHECK makes a half-recorded
-- notice impossible. The CHECKs are declared inline with their (new) columns, so they constrain nothing the previous release
-- writes: old code never touches these columns and leaves them NULL (the flag at its default, false), which satisfies all three. Each table's block is guarded by
-- the existence of its status column, which keeps the file idempotent (a column CHECK is not `IF NOT EXISTS`-able).
--
-- Existing org RLS (ENABLE + FORCE), the table-level app-role UPDATE grant and the write-audit triggers
-- (`trg_audit_noe_record` / `trg_audit_notr_record`, which snapshot the whole row, so who recorded what and when is in the
-- compliance-retained audit stream) cover the new columns; no new table, policy or grant. No free-text column: nothing here
-- can carry PHI.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'noe_record' AND column_name = 'external_filing_status'
  ) THEN
    ALTER TABLE "noe_record"
      ADD COLUMN "external_filing_status" text CONSTRAINT "noe_record_external_filing_status_ck" CHECK ("external_filing_status" IN ('pending', 'filed')),
      ADD COLUMN "filed_externally_on" date,
      ADD COLUMN "filed_externally_recorded_at" timestamp with time zone,
      ADD COLUMN "filed_externally_by_membership_id" uuid CONSTRAINT "noe_record_external_filing_filed_ck" CHECK (
        num_nonnulls("filed_externally_on", "filed_externally_recorded_at", "filed_externally_by_membership_id")
          = CASE WHEN "external_filing_status" = 'filed' THEN 3 ELSE 0 END),
      ADD COLUMN "external_filing_set_breach" boolean NOT NULL DEFAULT false CONSTRAINT "noe_record_external_filing_set_breach_ck" CHECK (
        NOT "external_filing_set_breach" OR "external_filing_status" IS NOT DISTINCT FROM 'filed');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'notr_record' AND column_name = 'external_filing_status'
  ) THEN
    ALTER TABLE "notr_record"
      ADD COLUMN "external_filing_status" text CONSTRAINT "notr_record_external_filing_status_ck" CHECK ("external_filing_status" IN ('pending', 'filed')),
      ADD COLUMN "filed_externally_on" date,
      ADD COLUMN "filed_externally_recorded_at" timestamp with time zone,
      ADD COLUMN "filed_externally_by_membership_id" uuid CONSTRAINT "notr_record_external_filing_filed_ck" CHECK (
        num_nonnulls("filed_externally_on", "filed_externally_recorded_at", "filed_externally_by_membership_id")
          = CASE WHEN "external_filing_status" = 'filed' THEN 3 ELSE 0 END),
      ADD COLUMN "external_filing_set_breach" boolean NOT NULL DEFAULT false CONSTRAINT "notr_record_external_filing_set_breach_ck" CHECK (
        NOT "external_filing_set_breach" OR "external_filing_status" IS NOT DISTINCT FROM 'filed');
  END IF;
END $$;
