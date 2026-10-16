-- M25 electronic submission, milestone 6a (hospice ADR/TPE/QIC PRD): the SUBMISSION ATTEMPT aggregate. Until now every
-- "submit" in M25 recorded a filing made outside WardenX, and an appeal submit recorded no channel, confirmation or
-- receipt at all. One attempt row now exists per filing, behind a channel-adapter port. In 6a the only live adapter is
-- the guided MANUAL one (checklist + the receipt the user enters); the esMD and fax adapters are UNBOUND shells that
-- fall back to `needs_manual`, so nothing is transmitted anywhere. A `sending` / `sent` attempt cannot exist without a
-- non-manual adapter AND a recorded human approval, so no transmission can start without both.
--
-- The case tables keep their own filing columns (and their CHECKs) as the authority; the attempt mirrors them. Org
-- scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK mirrored in
-- domain/submission.ts, so there is no new pgEnum. There are no history tables: the write-audit trigger is the trail.
-- Idempotent on purpose (the 1116/1117 renumber lesson: a migration can be re-applied after a branch renumber).

CREATE TABLE IF NOT EXISTS "submission_attempt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  -- Exactly one subject; the purpose says which kind (an escalation request is an appeal_case too).
  "adr_case_id" uuid REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "appeal_case_id" uuid REFERENCES "appeal_case"("id") ON DELETE RESTRICT,
  "reopening_case_id" uuid REFERENCES "reopening_case"("id") ON DELETE RESTRICT,
  "purpose" text NOT NULL CHECK ("purpose" IN ('adr_response','appeal_request','reopening_request','qic_escalation_request')),
  "attempt_no" integer NOT NULL CHECK ("attempt_no" >= 1),
  "idempotency_key" text NOT NULL CHECK (btrim("idempotency_key") <> ''),
  "channel" text CHECK ("channel" IN ('esmd','mac_portal','qic_portal','fax','mail','other')),
  "adapter" text NOT NULL DEFAULT 'manual' CHECK ("adapter" IN ('manual','esmd','fax')),
  "status" text NOT NULL CHECK ("status" IN ('prepared','queued','sending','sent','acknowledged','needs_manual','failed','cancelled')),
  "needs_manual_reason" text,
  "failure_reason" text,
  "destination" text,
  "prepared_by_membership_id" uuid,
  "approved_by_membership_id" uuid,
  "approved_at" timestamptz,
  -- The retained proof: what the channel gave back, entered by the user (or, in 6b, acknowledged by the adapter).
  "confirmation_ref" text,
  "receipt_at" timestamptz,
  "receipt_document_id" uuid,
  "receipt_source" text CHECK ("receipt_source" IN ('entered','adapter_ack')),
  "receipt_amendments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "packet_sha256" text,
  "packet_manifest" jsonb,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "submission_attempt_one_subject" CHECK (num_nonnulls("adr_case_id","appeal_case_id","reopening_case_id") = 1),
  CONSTRAINT "submission_attempt_purpose_subject" CHECK (
    ("purpose" = 'adr_response' AND "adr_case_id" IS NOT NULL)
    OR ("purpose" IN ('appeal_request','qic_escalation_request') AND "appeal_case_id" IS NOT NULL)
    OR ("purpose" = 'reopening_request' AND "reopening_case_id" IS NOT NULL)),
  -- Nothing becomes acknowledged without proof: a reference and a time, from a named source.
  CONSTRAINT "submission_attempt_ack_has_proof" CHECK ("status" <> 'acknowledged'
    OR ("confirmation_ref" IS NOT NULL AND btrim("confirmation_ref") <> '' AND "receipt_at" IS NOT NULL AND "receipt_source" IS NOT NULL)),
  CONSTRAINT "submission_attempt_no_proof_before_ack" CHECK ("status" = 'acknowledged'
    OR ("confirmation_ref" IS NULL AND "receipt_at" IS NULL AND "receipt_source" IS NULL AND "receipt_document_id" IS NULL)),
  -- Only an electronic adapter ever sends, and only after a human approved it.
  CONSTRAINT "submission_attempt_send_is_electronic" CHECK ("status" NOT IN ('sending','sent') OR "adapter" <> 'manual'),
  CONSTRAINT "submission_attempt_send_is_approved" CHECK ("status" NOT IN ('queued','sending','sent')
    OR ("approved_by_membership_id" IS NOT NULL AND "approved_at" IS NOT NULL)),
  CONSTRAINT "submission_attempt_needs_manual_reason" CHECK ("status" <> 'needs_manual'
    OR ("needs_manual_reason" IS NOT NULL AND btrim("needs_manual_reason") <> '')),
  CONSTRAINT "submission_attempt_failed_reason" CHECK ("status" <> 'failed'
    OR ("failure_reason" IS NOT NULL AND btrim("failure_reason") <> ''))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "submission_attempt_idempotency_key" ON "submission_attempt" ("organization_id", "idempotency_key");--> statement-breakpoint
-- One live attempt per (subject, purpose): a second would be a duplicate filing the MAC has to reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS "submission_attempt_one_live" ON "submission_attempt"
  ("organization_id", "purpose", (coalesce("adr_case_id", "appeal_case_id", "reopening_case_id")))
  WHERE "status" IN ('prepared','queued','sending','sent','needs_manual');--> statement-breakpoint
-- FK-covering indexes (the partial unique index above cannot serve an unqualified FK lookup).
CREATE INDEX IF NOT EXISTS "ix_submission_attempt_adr" ON "submission_attempt" ("adr_case_id") WHERE "adr_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_submission_attempt_appeal" ON "submission_attempt" ("appeal_case_id") WHERE "appeal_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_submission_attempt_reopening" ON "submission_attempt" ("reopening_case_id") WHERE "reopening_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "submission_attempt_org_ix" ON "submission_attempt" ("organization_id", "created_at");--> statement-breakpoint
-- The proof-missing watch reads needs_manual attempts oldest-first.
CREATE INDEX IF NOT EXISTS "ix_submission_attempt_needs_manual" ON "submission_attempt" ("organization_id", "created_at") WHERE "status" = 'needs_manual';--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd, app role without DELETE.
ALTER TABLE "submission_attempt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "submission_attempt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "submission_attempt_org" ON "submission_attempt";--> statement-breakpoint
CREATE POLICY "submission_attempt_org" ON "submission_attempt" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The subject, purpose, attempt number and idempotency key never change after insert.
GRANT SELECT, INSERT ON "submission_attempt" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("status", "needs_manual_reason", "failure_reason", "approved_by_membership_id", "approved_at",
  "confirmation_ref", "receipt_at", "receipt_document_id", "receipt_source", "receipt_amendments",
  "version", "updated_at") ON "submission_attempt" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "submission_attempt" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit trigger (the 0084 shape). The channel's own reference and free text are scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_submission_attempt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['confirmation_ref','failure_reason','needs_manual_reason','destination','receipt_amendments'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'submission_attempt.' || lower(TG_OP), 'submission_attempt', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_submission_attempt() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_submission_attempt" ON submission_attempt;--> statement-breakpoint
CREATE TRIGGER "trg_audit_submission_attempt" AFTER INSERT OR UPDATE OR DELETE ON submission_attempt FOR EACH ROW EXECUTE FUNCTION audit_phi_write_submission_attempt();--> statement-breakpoint

-- The legal edges (the same table as domain/submission.ts) and the frozen proof:
--   - a failed or cancelled attempt never changes again; a retry is a NEW row (attempt_no + 1);
--   - once acknowledged, the receipt (reference, time, document, source), channel, adapter, approval and packet facts
--     are frozen; corrections append to receipt_amendments, which only ever grows (every entry keeps its position).
CREATE OR REPLACE FUNCTION m25_submission_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('failed','cancelled') THEN
    RAISE EXCEPTION 'M25_SUBMISSION_FROZEN: submission_attempt % is % and cannot change; start a new attempt', OLD.id, OLD.status;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'prepared' AND NEW.status IN ('queued','needs_manual','cancelled'))
    OR (OLD.status = 'queued' AND NEW.status IN ('sending','needs_manual','cancelled'))
    OR (OLD.status = 'sending' AND NEW.status IN ('sent','needs_manual','failed'))
    OR (OLD.status = 'sent' AND NEW.status = 'acknowledged')
    OR (OLD.status = 'needs_manual' AND NEW.status IN ('acknowledged','cancelled'))) THEN
    RAISE EXCEPTION 'M25_SUBMISSION_ILLEGAL_TRANSITION: submission_attempt % cannot move from % to %', OLD.id, OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'acknowledged' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.confirmation_ref IS DISTINCT FROM OLD.confirmation_ref
    OR NEW.receipt_at IS DISTINCT FROM OLD.receipt_at
    OR NEW.receipt_document_id IS DISTINCT FROM OLD.receipt_document_id
    OR NEW.receipt_source IS DISTINCT FROM OLD.receipt_source
    OR NEW.approved_by_membership_id IS DISTINCT FROM OLD.approved_by_membership_id
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'M25_SUBMISSION_RECEIPT_FROZEN: submission_attempt % is acknowledged; its receipt cannot change (append an amendment)', OLD.id;
  END IF;
  IF NEW.receipt_amendments IS DISTINCT FROM OLD.receipt_amendments THEN
    IF OLD.status <> 'acknowledged' THEN
      RAISE EXCEPTION 'M25_SUBMISSION_AMENDMENT_STATE: submission_attempt % can be amended only once acknowledged', OLD.id;
    END IF;
    IF jsonb_array_length(NEW.receipt_amendments) < jsonb_array_length(OLD.receipt_amendments)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(OLD.receipt_amendments) WITH ORDINALITY AS o(e, n)
          WHERE NEW.receipt_amendments -> ((o.n - 1)::int) IS DISTINCT FROM o.e) THEN
      RAISE EXCEPTION 'M25_SUBMISSION_AMENDMENTS_APPEND_ONLY: submission_attempt % amendments can only be appended to', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_submission_attempt_guard" ON submission_attempt;--> statement-breakpoint
CREATE TRIGGER "trg_submission_attempt_guard" BEFORE UPDATE ON submission_attempt FOR EACH ROW EXECUTE FUNCTION m25_submission_attempt_guard();
