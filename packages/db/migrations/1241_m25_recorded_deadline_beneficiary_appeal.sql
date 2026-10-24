-- M25 milestone 13a: recorded_deadline learns its FOURTH subject, a beneficiary_appeal (1240). This EXTENDS 1208 (it does not
-- rewrite it): the same drop-and-recreate of `recorded_deadline_one_subject`, now over all four subject columns, and the same
-- guard function with the beneficiary branch added. Additive and idempotent; every existing appeal_case / audit_request /
-- payer_appeal_case row still satisfies the constraint (exactly one subject of the four).
--
-- A beneficiary appeal carries NO computed deadline. A deadline on it is a due date a person typed from a notice, with a
-- mandatory source note (the 7a-1 primitive), and it alerts at the existing recorded-deadline boundaries.

ALTER TABLE "recorded_deadline" ADD COLUMN IF NOT EXISTS "beneficiary_appeal_id" uuid REFERENCES "beneficiary_appeal"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "recorded_deadline" DROP CONSTRAINT IF EXISTS "recorded_deadline_one_subject";--> statement-breakpoint
ALTER TABLE "recorded_deadline" ADD CONSTRAINT "recorded_deadline_one_subject"
  CHECK (num_nonnulls("appeal_case_id","audit_request_id","payer_appeal_case_id","beneficiary_appeal_id") = 1);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_recorded_deadline_beneficiary_appeal" ON "recorded_deadline" ("beneficiary_appeal_id") WHERE "beneficiary_appeal_id" IS NOT NULL;--> statement-breakpoint

-- The subject must be visible to this organization (cross-tenant ids fail closed); once satisfied the deadline is frozen
-- except for the alert bookkeeping. Same body as 1208 with the beneficiary-appeal branch added.
CREATE OR REPLACE FUNCTION m25_recorded_deadline_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.appeal_case_id IS NOT NULL THEN
      SELECT true INTO v_ok FROM appeal_case WHERE id = NEW.appeal_case_id AND organization_id = NEW.organization_id;
    ELSIF NEW.payer_appeal_case_id IS NOT NULL THEN
      SELECT true INTO v_ok FROM payer_appeal_case WHERE id = NEW.payer_appeal_case_id AND organization_id = NEW.organization_id;
    ELSIF NEW.beneficiary_appeal_id IS NOT NULL THEN
      SELECT true INTO v_ok FROM beneficiary_appeal WHERE id = NEW.beneficiary_appeal_id AND organization_id = NEW.organization_id;
    ELSE
      SELECT true INTO v_ok FROM audit_request WHERE id = NEW.audit_request_id AND organization_id = NEW.organization_id;
    END IF;
    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'M25_RECORDED_DEADLINE_PARENT: the subject is not visible to this organization';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.satisfied_on IS NOT NULL AND (
       NEW.label IS DISTINCT FROM OLD.label
    OR NEW.due_on IS DISTINCT FROM OLD.due_on
    OR NEW.zone IS DISTINCT FROM OLD.zone
    OR NEW.source_note IS DISTINCT FROM OLD.source_note
    OR NEW.notice_document_id IS DISTINCT FROM OLD.notice_document_id
    OR NEW.satisfied_on IS DISTINCT FROM OLD.satisfied_on) THEN
    RAISE EXCEPTION 'M25_RECORDED_DEADLINE_FROZEN: recorded_deadline % is satisfied and cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;
