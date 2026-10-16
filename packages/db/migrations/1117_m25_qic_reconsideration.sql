-- M25 QIC reconsideration and escalation (hospice ADR/TPE/QIC PRD, milestone 4). The reconsideration tier already
-- exists as an appeal_case; this adds what only that tier needs, as nullable columns tier-guarded by CHECK (no new
-- table, so no new RLS or ownership): the evidence the redetermination notice named, the QIC's own decision clock,
-- and the OMHA escalation. Table-level grants (0083) already cover the new columns.
--
--   cited_evidence / cited_evidence_none  the documentation the redetermination notice named as missing, or the
--                                         attestation that it named none. Editable while the case is a draft, frozen
--                                         once it is filed (what was cited at filing is the record).
--   qic_received_on                       the date the QIC received the request, from its acknowledgement. The 60-day
--                                         clock is derived from it on read; there is no stored due date to go stale.
--   qic_clock_extensions                  append-only list of {days, recordedAt}: each late-evidence extension.
--   filed_by_escalation                   true on the ALJ case an escalation opens: it was filed by the QIC's forwarding,
--                                         so it has no filing deadline of its own (its NOT NULL tier_deadline_at is the
--                                         escalation request instant, already past). Set at insert, never changed.
--   escalation_*                          the OMHA escalation REQUEST (channel, confirmation reference, time), made
--                                         outside WardenX, frozen once recorded; and the date the QIC forwarded the
--                                         case, which moves the case to `escalated`.
-- Nothing here is sent electronically (milestone 6).

ALTER TABLE "appeal_case"
  ADD COLUMN IF NOT EXISTS "cited_evidence" jsonb,
  ADD COLUMN IF NOT EXISTS "cited_evidence_none" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "qic_received_on" date,
  ADD COLUMN IF NOT EXISTS "qic_clock_extensions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "escalation_requested_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "escalation_channel" text,
  ADD COLUMN IF NOT EXISTS "escalation_confirmation_ref" text,
  ADD COLUMN IF NOT EXISTS "escalation_confirmed_on" date,
  ADD COLUMN IF NOT EXISTS "filed_by_escalation" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Re-runnable: this file was renumbered from 1114/1115 (a duplicate ordinal), so a database that already ran the
-- old names runs it again. Every statement is a no-op or an in-place replacement of an identical definition.
ALTER TABLE "appeal_case" DROP CONSTRAINT IF EXISTS "appeal_case_qic_columns_shape";--> statement-breakpoint
ALTER TABLE "appeal_case" DROP CONSTRAINT IF EXISTS "appeal_case_qic_reconsideration_only";--> statement-breakpoint
ALTER TABLE "appeal_case" DROP CONSTRAINT IF EXISTS "appeal_case_filed_by_escalation_alj_only";--> statement-breakpoint
ALTER TABLE "appeal_case" DROP CONSTRAINT IF EXISTS "appeal_case_escalation_channel_known";--> statement-breakpoint
ALTER TABLE "appeal_case" DROP CONSTRAINT IF EXISTS "appeal_case_escalation_requested_has_proof";--> statement-breakpoint
ALTER TABLE "appeal_case" DROP CONSTRAINT IF EXISTS "appeal_case_escalated_has_facts";--> statement-breakpoint
-- Only a reconsideration carries QIC data: any other tier (including the ALJ case an escalation opens) has none.
ALTER TABLE "appeal_case"
  ADD CONSTRAINT "appeal_case_qic_columns_shape" CHECK (
    ("cited_evidence" IS NULL OR jsonb_typeof("cited_evidence") = 'array')
    AND jsonb_typeof("qic_clock_extensions") = 'array'
    AND (NOT "cited_evidence_none" OR "cited_evidence" IS NULL OR jsonb_array_length("cited_evidence") = 0)
  ),
  ADD CONSTRAINT "appeal_case_qic_reconsideration_only" CHECK (
    "tier" = 'reconsideration' OR (
      "cited_evidence" IS NULL AND NOT "cited_evidence_none" AND "qic_received_on" IS NULL
      AND "qic_clock_extensions" = '[]'::jsonb AND "escalation_requested_at" IS NULL
      AND "escalation_channel" IS NULL AND "escalation_confirmation_ref" IS NULL
      AND "escalation_confirmed_on" IS NULL)
  ),
  ADD CONSTRAINT "appeal_case_filed_by_escalation_alj_only" CHECK (
    NOT "filed_by_escalation" OR ("tier" = 'alj' AND "prior_tier_appeal_case_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "appeal_case_escalation_channel_known" CHECK (
    "escalation_channel" IS NULL OR "escalation_channel" IN ('qic_portal','fax','mail','other')
  ),
  -- A recorded escalation request always carries its proof, and needs the QIC clock it is measured against.
  ADD CONSTRAINT "appeal_case_escalation_requested_has_proof" CHECK (
    ("escalation_requested_at" IS NULL
      AND "escalation_channel" IS NULL AND "escalation_confirmation_ref" IS NULL AND "escalation_confirmed_on" IS NULL)
    OR ("escalation_requested_at" IS NOT NULL AND "escalation_channel" IS NOT NULL
      AND "escalation_confirmation_ref" IS NOT NULL AND btrim("escalation_confirmation_ref") <> ''
      AND "qic_received_on" IS NOT NULL)
  ),
  -- An escalated case was requested and confirmed: no code path can record `escalated` without both.
  ADD CONSTRAINT "appeal_case_escalated_has_facts" CHECK (
    "state" <> 'escalated' OR ("escalation_requested_at" IS NOT NULL AND "escalation_confirmed_on" IS NOT NULL)
  );--> statement-breakpoint

-- audit_phi_write_appeal_case: scrub the free-text and PHI-adjacent columns the new fields add.
CREATE OR REPLACE FUNCTION audit_phi_write_appeal_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['appeal_narrative','cited_evidence','escalation_confirmation_ref'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'appeal_case.' || lower(TG_OP), 'appeal_case', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_appeal_case() OWNER TO wardenx_audit_writer;--> statement-breakpoint

-- What was cited at filing and what was recorded to the QIC is frozen, so SQL that bypasses the service cannot
-- rewrite the record:
--   - the cited-evidence list is editable only while the case is a draft;
--   - the extension list is append-only (every existing entry keeps its position and value) and, with the receipt
--     date, is frozen once an escalation request is recorded (the request was measured against that clock);
--   - the escalation request (time, channel, confirmation) and the forwarded date never change once set;
--   - `escalated` is reachable only from `under_review` (the same edge as domain/appeal-machine.ts).
CREATE OR REPLACE FUNCTION m25_appeal_case_qic_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' AND (
       NEW.cited_evidence IS DISTINCT FROM OLD.cited_evidence
    OR NEW.cited_evidence_none IS DISTINCT FROM OLD.cited_evidence_none) THEN
    RAISE EXCEPTION 'M25_QIC_EVIDENCE_FROZEN: appeal_case % is no longer a draft; its cited evidence cannot change', OLD.id;
  END IF;
  IF NEW.qic_clock_extensions IS DISTINCT FROM OLD.qic_clock_extensions THEN
    IF OLD.state <> 'under_review' THEN
      RAISE EXCEPTION 'M25_QIC_EXTENSIONS_STATE: appeal_case % extensions can only be appended while the QIC is reviewing (under_review)', OLD.id;
    END IF;
    IF jsonb_array_length(NEW.qic_clock_extensions) < jsonb_array_length(OLD.qic_clock_extensions)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(OLD.qic_clock_extensions) WITH ORDINALITY AS o(e, n)
          WHERE NEW.qic_clock_extensions -> ((o.n - 1)::int) IS DISTINCT FROM o.e) THEN
      RAISE EXCEPTION 'M25_QIC_EXTENSIONS_APPEND_ONLY: appeal_case % extensions can only be appended to', OLD.id;
    END IF;
  END IF;
  IF OLD.escalation_requested_at IS NOT NULL AND (
       NEW.qic_received_on IS DISTINCT FROM OLD.qic_received_on
    OR NEW.qic_clock_extensions IS DISTINCT FROM OLD.qic_clock_extensions) THEN
    RAISE EXCEPTION 'M25_QIC_CLOCK_FROZEN: appeal_case % has an escalation request recorded; its QIC clock cannot change', OLD.id;
  END IF;
  IF OLD.escalation_requested_at IS NOT NULL AND (
       NEW.escalation_requested_at IS DISTINCT FROM OLD.escalation_requested_at
    OR NEW.escalation_channel IS DISTINCT FROM OLD.escalation_channel
    OR NEW.escalation_confirmation_ref IS DISTINCT FROM OLD.escalation_confirmation_ref) THEN
    RAISE EXCEPTION 'M25_QIC_ESCALATION_FROZEN: appeal_case % has an escalation request recorded; it cannot change', OLD.id;
  END IF;
  IF OLD.escalation_confirmed_on IS NOT NULL AND NEW.escalation_confirmed_on IS DISTINCT FROM OLD.escalation_confirmed_on THEN
    RAISE EXCEPTION 'M25_QIC_ESCALATION_FROZEN: appeal_case % has a recorded forwarding date that cannot change', OLD.id;
  END IF;
  IF NEW.escalation_confirmed_on IS NOT NULL AND NEW.state NOT IN ('escalated','closed') THEN
    RAISE EXCEPTION 'M25_QIC_CONFIRM_STATE: appeal_case % forwarding date can only be set by moving the case to escalated', OLD.id;
  END IF;
  IF NEW.filed_by_escalation IS DISTINCT FROM OLD.filed_by_escalation THEN
    RAISE EXCEPTION 'M25_QIC_ESCALATION_FROZEN: appeal_case % filed_by_escalation is set at insert and never changes', OLD.id;
  END IF;
  IF NEW.state = 'escalated' AND OLD.state <> 'escalated' AND OLD.state <> 'under_review' THEN
    RAISE EXCEPTION 'M25_QIC_ILLEGAL_ESCALATION: appeal_case % cannot move from % to escalated', OLD.id, OLD.state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_appeal_case_qic_guard" ON appeal_case;--> statement-breakpoint
CREATE TRIGGER "trg_appeal_case_qic_guard" BEFORE UPDATE ON appeal_case FOR EACH ROW EXECUTE FUNCTION m25_appeal_case_qic_guard();
