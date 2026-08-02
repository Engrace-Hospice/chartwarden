-- M6L-T04 — the F2F / LOC / discharge / transfer / revocation write lifecycle. Three tables were shaped
-- for a COMPLETED record and could not persist the intent the §4.1 routes actually carry:
--
--   * discharge_event had no status, so the D11 two-step for-cause cascade (file → medical-director
--     cosign) had nowhere to hold the `pending_cosign` state while the admission stays active. Add a
--     `status` (pending_cosign → completed / voided); the immediate reasons insert straight at `completed`.
--   * transfer_event required the counterparty CCN + name, but transferOut/transferIn (routes 37/38) do
--     not capture the sending/receiving agency yet — relax both to nullable (filled when known).
--   * level_of_care_period required assigned_by (a user FK) + reason + q_code, but changeLoc (route 33)
--     carries only the new level — relax the three to nullable (assigned_by/reason filled on patchLoc;
--     q_code derived from M38 once wired).
CREATE TYPE "public"."discharge_event_status" AS ENUM('pending_cosign', 'completed', 'voided');--> statement-breakpoint
ALTER TABLE "discharge_event" ADD COLUMN "status" "discharge_event_status" DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_event" ALTER COLUMN "receiving_or_sending_ccn" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_event" ALTER COLUMN "receiving_or_sending_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "level_of_care_period" ALTER COLUMN "assigned_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "level_of_care_period" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "level_of_care_period" ALTER COLUMN "q_code" DROP NOT NULL;
