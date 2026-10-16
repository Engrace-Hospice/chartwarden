-- M25 QIC reconsideration and escalation (hospice ADR/TPE/QIC PRD, milestone 4): the enum values the next migration
-- (1115) and the service read and write. Additive only. Own migration: PG forbids using a value added earlier in the
-- same transaction, so this stands alone ahead of the file that uses it (the 1109 / 0239 precedent).
--
--   m25_appeal_state       + escalated            a late QIC reconsideration the provider moved to OMHA
--   m25_appeal_event_kind  + evidence_updated     the cited-evidence list of a reconsideration changed
--                          + qic_clock_recorded   the QIC receipt date, or a late-evidence extension, was recorded
--                          + escalation_requested the OMHA escalation request was recorded (state stays under_review)
ALTER TYPE "public"."m25_appeal_state" ADD VALUE IF NOT EXISTS 'escalated';--> statement-breakpoint
ALTER TYPE "public"."m25_appeal_event_kind" ADD VALUE IF NOT EXISTS 'evidence_updated';--> statement-breakpoint
ALTER TYPE "public"."m25_appeal_event_kind" ADD VALUE IF NOT EXISTS 'qic_clock_recorded';--> statement-breakpoint
ALTER TYPE "public"."m25_appeal_event_kind" ADD VALUE IF NOT EXISTS 'escalation_requested';
