-- M41 Billing - Commercial: the submission slice (ADR-0053 D10, ADR-0100 D4/D5/D9). One table, wider claim states.
--
--   commercial_submission   one logical send of a claim through the platform ClearinghouseTransport: our idempotency key, the control
--                           number and interchange number the payload carries, the clearinghouse and the payer id it routes on, the
--                           status (queued / sent / failed / in_doubt), the attempt count and the transport's receipt id. No PHI:
--                           ids, codes and times only (the 837I itself is rendered at send time and never stored).
--   commercial_claim        state widens from draft / ready / void to the submission lifecycle (submitted, ack_pending, accepted,
--                           rejected). `submitted` is written only when the transport ACCEPTED the file. ready_at stays stamped
--                           from ready on. The state guard stops a claim that has left `ready` going back (a sent claim cannot be
--                           re-readied or voided locally; a payer-side void is a separate, later transaction).
--   commercial_claim_state_history  same widened sets.
--
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role), three-column rule, write-audit trigger. A claim has at
-- most ONE live submission (queued / sent / in_doubt): a partial unique index. The interchange control number comes from a cycling
-- 9-digit sequence (X12 ISA13), assigned once at insert so a retry of the same submission renders the same payload.
-- Also: the role grant for commercial_billing.submit (1265 created the key and granted it to compliance_officer, administrator,
-- org_admin; every role holding the Medicare analogue billing.claim.submit gets it too, as 1266 did for read / write / override).

-- 1. wider claim states --------------------------------------------------------------------------------------------------------
ALTER TABLE "commercial_claim" DROP CONSTRAINT IF EXISTS "commercial_claim_state_check";--> statement-breakpoint
ALTER TABLE "commercial_claim" ADD CONSTRAINT "commercial_claim_state_check" CHECK ("state" IN ('draft','ready','submitted','ack_pending','accepted','rejected','void'));--> statement-breakpoint
ALTER TABLE "commercial_claim" DROP CONSTRAINT IF EXISTS "commercial_claim_ready_stamp";--> statement-breakpoint
ALTER TABLE "commercial_claim" ADD CONSTRAINT "commercial_claim_ready_stamp" CHECK (("state" <> 'draft' AND "state" <> 'void') = ("ready_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" DROP CONSTRAINT IF EXISTS "commercial_claim_state_history_from_state_check";--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" ADD CONSTRAINT "commercial_claim_state_history_from_state_check" CHECK ("from_state" IS NULL OR "from_state" IN ('draft','ready','submitted','ack_pending','accepted','rejected','void'));--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" DROP CONSTRAINT IF EXISTS "commercial_claim_state_history_to_state_check";--> statement-breakpoint
ALTER TABLE "commercial_claim_state_history" ADD CONSTRAINT "commercial_claim_state_history_to_state_check" CHECK ("to_state" IN ('draft','ready','submitted','ack_pending','accepted','rejected','void'));--> statement-breakpoint

-- Lifecycle backstop (the service's row lock is the first line). void is final; a claim that left draft/ready for the payer side
-- never returns to draft or ready, and only a rejected claim may be voided locally (so a corrected claim can be assembled).
CREATE OR REPLACE FUNCTION m41_commercial_claim_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state <> OLD.state AND OLD.state = 'void' THEN
    RAISE EXCEPTION 'M41_CLAIM_VOID_IS_FINAL: claim % is void and cannot change state', OLD.id;
  END IF;
  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;
  -- the ONLY legal moves; everything else (draft -> submitted, ready -> accepted, accepted -> submitted, rejected -> accepted ...) is refused
  IF NOT (
       (OLD.state = 'draft' AND NEW.state IN ('ready', 'void'))
    OR (OLD.state = 'ready' AND NEW.state IN ('draft', 'submitted', 'void'))
    OR (OLD.state = 'submitted' AND NEW.state IN ('ack_pending', 'accepted', 'rejected'))
    OR (OLD.state = 'ack_pending' AND NEW.state IN ('accepted', 'rejected'))
    OR (OLD.state = 'rejected' AND NEW.state = 'void')
  ) THEN
    RAISE EXCEPTION 'M41_CLAIM_ILLEGAL_TRANSITION: claim % cannot move from % to %', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $fn$;--> statement-breakpoint

-- 2. the submission ------------------------------------------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS "commercial_submission_icn_seq" AS bigint MINVALUE 1 MAXVALUE 999999999 CYCLE;--> statement-breakpoint
GRANT USAGE ON SEQUENCE "commercial_submission_icn_seq" TO chartwarden_app;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "commercial_submission" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  "control_number" text NOT NULL CHECK ("control_number" ~ '^[A-Za-z0-9-]{1,38}$'),
  "interchange_control_number" bigint NOT NULL DEFAULT nextval('commercial_submission_icn_seq') CHECK ("interchange_control_number" BETWEEN 1 AND 999999999),
  "clearinghouse_key" text NOT NULL CHECK ("clearinghouse_key" ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  "clearinghouse_payer_id" text NOT NULL CHECK ("clearinghouse_payer_id" ~ '^[A-Za-z0-9._-]{1,40}$'),
  "status" text NOT NULL DEFAULT 'queued' CHECK ("status" IN ('queued','sent','failed','in_doubt')),
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_failure_code" text CHECK ("last_failure_code" IS NULL OR "last_failure_code" ~ '^[A-Z0-9_]{1,64}$'),
  "clearinghouse_submission_id" text CHECK ("clearinghouse_submission_id" IS NULL OR char_length("clearinghouse_submission_id") BETWEEN 1 AND 256),
  "requested_by_membership_id" uuid NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "sent_at" timestamptz,
  -- the stamp the 837I carries (ISA09/ISA10 date and time). A re-submission of the same claim copies it, and the interchange number,
  -- from the claim's FIRST submission, so every attempt in the lineage renders the SAME payload and the transport's idempotency
  -- key (one per claim) replays instead of double-sending.
  "payload_stamp" timestamptz NOT NULL DEFAULT now(),
  -- set just before the transport call, cleared when the transport gave a DEFINITE answer. Still set when a lease expires = that
  -- attempt was interrupted after it may have reached the transport (the send is ambiguous).
  "transport_call_started_at" timestamptz,
  -- sticky: some attempt of this submission may have reached the transport without a definite answer. Exhaustion then ends in_doubt.
  "ambiguous" boolean NOT NULL DEFAULT false,
  -- how an in-doubt or queued submission was settled: the transport's receipt, a later acknowledgment, or a person's decision.
  "resolution" text CHECK ("resolution" IS NULL OR "resolution" IN ('receipt','acknowledgment','operator_confirmed','operator_not_received')),
  -- SHA-256 of the exact 837I handed to the transport (set just before the call; the file itself is never stored). A later
  -- submission of the same claim must render the SAME hash; if the facts changed it is refused with COMMERCIAL_PAYLOAD_CHANGED
  -- before anything is sent, because the transport's single key per claim would answer an opaque idempotency conflict.
  "payload_hash" text CHECK ("payload_hash" IS NULL OR "payload_hash" ~ '^[0-9a-f]{64}$'),
  -- what a person relied on when they settled an in-doubt submission as received (a closed set; no free text)
  "reconcile_evidence" text CHECK ("reconcile_evidence" IS NULL OR "reconcile_evidence" IN ('clearinghouse_portal','payer_portal','vendor_support')),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "commercial_submission_claim_fk" FOREIGN KEY ("claim_id", "organization_id") REFERENCES "commercial_claim"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "commercial_submission_sent_stamp" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL)),
  -- a receipt id exists only on sent or in-doubt rows (an acknowledgment or a person may settle a row that has none)
  CONSTRAINT "commercial_submission_receipt" CHECK ("clearinghouse_submission_id" IS NULL OR "status" IN ('sent','in_doubt'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_submission_id_org_uq" ON "commercial_submission" ("id", "organization_id");--> statement-breakpoint
-- the route's Idempotency-Key: one submission per (claim, key), so a retried POST finds the row it wrote
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_submission_key_uq" ON "commercial_submission" ("organization_id", "claim_id", "idempotency_key");--> statement-breakpoint
-- at most one live submission per claim: a second click while one is queued, sent or in doubt cannot create another
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_submission_live_uq" ON "commercial_submission" ("claim_id") WHERE "status" IN ('queued','sent','in_doubt');--> statement-breakpoint
-- the transport matches acknowledgments on the control number
CREATE INDEX IF NOT EXISTS "commercial_submission_control_ix" ON "commercial_submission" ("organization_id", "control_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_submission_due_ix" ON "commercial_submission" ("next_attempt_at") WHERE "status" = 'queued';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_submission_claim_ix" ON "commercial_submission" ("claim_id", "requested_at");--> statement-breakpoint
-- the composite foreign key (claim_id, organization_id) needs an index that LEADS with exactly those columns (the fk-index-coverage suite)
CREATE INDEX IF NOT EXISTS "commercial_submission_claim_fk_ix" ON "commercial_submission" ("claim_id", "organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_submission_org_ix" ON "commercial_submission" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_submission_pe_ix" ON "commercial_submission" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commercial_submission_location_ix" ON "commercial_submission" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "commercial_submission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commercial_submission" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "commercial_submission_org" ON "commercial_submission";--> statement-breakpoint
CREATE POLICY "commercial_submission_org" ON "commercial_submission" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "commercial_submission" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "attempt_count", "next_attempt_at", "last_failure_code", "clearinghouse_submission_id", "sent_at", "transport_call_started_at", "ambiguous", "resolution", "payload_hash", "reconcile_evidence", "updated_at") ON "commercial_submission" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "commercial_submission" TO chartwarden_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_commercial_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'commercial_submission.' || lower(TG_OP), 'commercial_submission', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_commercial_submission() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_commercial_submission" ON commercial_submission;--> statement-breakpoint
CREATE TRIGGER "trg_audit_commercial_submission" AFTER INSERT OR UPDATE OR DELETE ON commercial_submission FOR EACH ROW EXECUTE FUNCTION audit_phi_write_commercial_submission();--> statement-breakpoint

-- 3. role grant: whoever files a Medicare claim may send a commercial one (the key itself was created in 1265). Idempotent.
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT rp."organization_id", rp."role_id", 'commercial_billing.submit'
  FROM "role_permission" rp
 WHERE rp."permission_key" = 'billing.claim.submit'
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
