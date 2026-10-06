-- M23 — the Medicare hospice Change of Provider / Transfer Notice (TOB 81C/82C, "8xC"), its void (8xD) and its
-- date correction (8xC + occurrence code 56 + condition code D0). CMS Pub. 100-04 (Medicare Claims Processing
-- Manual) ch. 11 §20.1.3 and §20.1.4, Rev. 12847 (issued 2024-09-13, effective 2024-06-03).
--
-- WHY A TABLE OF ITS OWN. A transfer notice is filed by the RECEIVING hospice "after the transfer has occurred",
-- and "does not get submitted until after the other provider has finalized their billing" (§20.1.3). It creates no
-- election period (§20.1.6 summary chart: 8xC — "Creates Election Period: Never"), so it is not an NOE (8xA) and it
-- does not share the NOE's one-per-admission index or its 5-day watchdog: CGS's CR 8877 FAQ states that "hospice
-- transfers and the submission of 8XC transactions are not subject to the 5-day timely filing requirement". It does
-- share the NOE/NOTR lifecycle alphabet (`noe_state`), the submission/acknowledgment rows and the control-number
-- scheme, which this migration reuses rather than forks.
--
--   1. transfer_event.receiving_or_sending_npi — the counterparty hospice's NPI, captured on a transfer-in with its
--      CCN (the CCN drives the §20.1.3 "must not submit an 8XC if the CCN is the same" block).
--   2. transfer_notice_record — one row per 8xC / corrected 8xC / 8xD, ORG-SCOPED (three tenancy columns), FORCEd
--      RLS, M4 write-audit trigger, compliance retention (part of the billing record, like noe_record).
--   3. claim_submission learns a fourth subject: kind 'transfer_notice' + transfer_notice_id. The CHECKs compare
--      `kind::text` so the new enum label is not USED in the transaction that adds it.
-- Idempotent.

-- ── 1. transfer_event.receiving_or_sending_npi ─────────────────────────────────────────────────────────────────
ALTER TABLE "transfer_event" ADD COLUMN IF NOT EXISTS "receiving_or_sending_npi" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "transfer_event" ADD CONSTRAINT "transfer_event_counterparty_npi_chk"
    CHECK ("receiving_or_sending_npi" IS NULL OR "receiving_or_sending_npi" ~ '^[0-9]{10}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- ── 2. transfer_notice_record ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "transfer_notice_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"transfer_event_id" uuid NOT NULL,
	"election_period_id" uuid,
	"action" text NOT NULL,
	"supersedes_notice_id" uuid,
	"state" "noe_state" DEFAULT 'DRAFT' NOT NULL,
	"tob" text NOT NULL,
	"statement_from_date" date NOT NULL,
	"original_transfer_date" date,
	"admission_date" date,
	"benefit_period_sequence" smallint NOT NULL,
	"benefit_period_start_date" date,
	"prior_hospice_name" text NOT NULL,
	"prior_hospice_ccn" text,
	"prior_hospice_npi" text,
	"provider_ccn" text NOT NULL,
	"attending_physician_id" uuid,
	"certifying_physician_id" uuid,
	"prior_billing_confirmed_at" timestamp with time zone,
	"prior_billing_confirmed_by_membership_id" uuid,
	"prior_hospice_through_date" date,
	"prior_hospice_patient_status" text,
	"control_number" text NOT NULL,
	"payer_control_number" text,
	"latest_submission_id" uuid,
	"latest_acknowledgment_id" uuid,
	"cancel_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_notice_record_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "transfer_notice_record_supersedes_fk"
		FOREIGN KEY ("supersedes_notice_id") REFERENCES "transfer_notice_record"("id") ON DELETE restrict,
	CONSTRAINT "transfer_notice_control_number_uq" UNIQUE ("provider_entity_id", "control_number"),
	CONSTRAINT "transfer_notice_action_chk" CHECK ("action" IN ('original', 'correction', 'void')),
	-- An original stands alone; a correction or a void always names the accepted notice it acts on.
	CONSTRAINT "transfer_notice_supersedes_chk" CHECK (("action" = 'original') = ("supersedes_notice_id" IS NULL)),
	-- 81C/82C for an original or a correction, 81D/82D for a void (§20.1.3 / §20.1.4).
	CONSTRAINT "transfer_notice_tob_chk" CHECK (
		("action" IN ('original', 'correction') AND "tob" IN ('81C', '82C'))
		OR ("action" = 'void' AND "tob" IN ('81D', '82D'))
	),
	-- §20.1.3: a correction reports the corrected date as From and the original incorrect date with OC 56.
	CONSTRAINT "transfer_notice_correction_chk" CHECK (
		("action" = 'correction') = ("original_transfer_date" IS NOT NULL)
		AND ("original_transfer_date" IS NULL OR "original_transfer_date" <> "statement_from_date")
	),
	CONSTRAINT "transfer_notice_sequence_chk" CHECK ("benefit_period_sequence" >= 1),
	CONSTRAINT "transfer_notice_prior_ccn_chk" CHECK ("prior_hospice_ccn" IS NULL OR "prior_hospice_ccn" ~ '^[0-9A-Z]{6}$'),
	CONSTRAINT "transfer_notice_prior_npi_chk" CHECK ("prior_hospice_npi" IS NULL OR "prior_hospice_npi" ~ '^[0-9]{10}$'),
	CONSTRAINT "transfer_notice_prior_status_chk" CHECK ("prior_hospice_patient_status" IS NULL OR "prior_hospice_patient_status" IN ('50', '51')),
	-- The "prior hospice finalized its billing" confirmation is one fact: all four columns or none.
	CONSTRAINT "transfer_notice_prior_billing_chk" CHECK (
		("prior_billing_confirmed_at" IS NULL AND "prior_billing_confirmed_by_membership_id" IS NULL
			AND "prior_hospice_through_date" IS NULL AND "prior_hospice_patient_status" IS NULL)
		OR ("prior_billing_confirmed_at" IS NOT NULL AND "prior_billing_confirmed_by_membership_id" IS NOT NULL
			AND "prior_hospice_through_date" IS NOT NULL AND "prior_hospice_patient_status" IS NOT NULL)
	)
);--> statement-breakpoint
-- One live original per transfer (a cancelled or rejected one may be redrafted).
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_notice_original_uq" ON "transfer_notice_record" ("transfer_event_id")
	WHERE "action" = 'original' AND "state" NOT IN ('CANCELLED', 'ACK_REJECTED');--> statement-breakpoint
-- At most one live correction/void acting on the same accepted notice.
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_notice_follow_up_uq" ON "transfer_notice_record" ("supersedes_notice_id")
	WHERE "supersedes_notice_id" IS NOT NULL AND "state" NOT IN ('CANCELLED', 'ACK_REJECTED');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_notice_worklist_idx" ON "transfer_notice_record" ("organization_id", "state", "created_at");--> statement-breakpoint
-- "A beneficiary can change hospices only once per benefit period" (§20.1.3) — the per-period lookup.
CREATE INDEX IF NOT EXISTS "transfer_notice_patient_period_idx" ON "transfer_notice_record" ("organization_id", "patient_id", "benefit_period_sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transfer_notice_admission_idx" ON "transfer_notice_record" ("admission_id");--> statement-breakpoint

ALTER TABLE "transfer_notice_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transfer_notice_record" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "transfer_notice_record_org" ON "transfer_notice_record"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE for the app role: a filed notice is billing history (the eraser runs as wardenx_destruction).
GRANT SELECT, INSERT, UPDATE ON "transfer_notice_record" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "transfer_notice_record" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "transfer_notice_record" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_transfer_notice_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'transfer_notice_record.' || lower(TG_OP), 'transfer_notice_record', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_transfer_notice_record() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_transfer_notice_record" ON transfer_notice_record;--> statement-breakpoint
CREATE TRIGGER "trg_audit_transfer_notice_record" AFTER INSERT OR UPDATE OR DELETE ON transfer_notice_record
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_transfer_notice_record();--> statement-breakpoint

-- ── 3. claim_submission: the transfer-notice subject ──────────────────────────────────────────────────────────
ALTER TYPE "claim_submission_kind" ADD VALUE IF NOT EXISTS 'transfer_notice';--> statement-breakpoint
ALTER TABLE "claim_submission" ADD COLUMN IF NOT EXISTS "transfer_notice_id" uuid;--> statement-breakpoint
ALTER TABLE "claim_submission" DROP CONSTRAINT IF EXISTS "claim_submission_exactly_one_subject";--> statement-breakpoint
ALTER TABLE "claim_submission" ADD CONSTRAINT "claim_submission_exactly_one_subject" CHECK (
	("claim_id" IS NOT NULL)::int + ("noe_id" IS NOT NULL)::int + ("notr_id" IS NOT NULL)::int
	+ ("transfer_notice_id" IS NOT NULL)::int = 1
);--> statement-breakpoint
ALTER TABLE "claim_submission" DROP CONSTRAINT IF EXISTS "claim_submission_kind_matches_subject";--> statement-breakpoint
ALTER TABLE "claim_submission" ADD CONSTRAINT "claim_submission_kind_matches_subject" CHECK (
	("kind"::text = 'claim_837i' AND "claim_id" IS NOT NULL) OR
	("kind"::text = 'noe' AND "noe_id" IS NOT NULL) OR
	("kind"::text = 'notr' AND "notr_id" IS NOT NULL) OR
	("kind"::text = 'transfer_notice' AND "transfer_notice_id" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_submission_transfer_notice_idx" ON "claim_submission" ("transfer_notice_id")
	WHERE "transfer_notice_id" IS NOT NULL;--> statement-breakpoint

-- The 0171 queued -> terminal guard, now also pinning the new subject column.
CREATE OR REPLACE FUNCTION m23_terminalize_claim_submission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim_submission rows cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.outcome <> 'queued'
     OR NEW.outcome NOT IN ('submitted', 'failed_worker', 'failed_portal')
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.noe_id IS DISTINCT FROM OLD.noe_id
     OR NEW.notr_id IS DISTINCT FROM OLD.notr_id
     OR NEW.transfer_notice_id IS DISTINCT FROM OLD.transfer_notice_id
     OR NEW.claim_control_number IS DISTINCT FROM OLD.claim_control_number
     OR NEW.attempt_index IS DISTINCT FROM OLD.attempt_index
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.outcome = 'submitted' AND (
       NEW.generated_file_uri IS NULL
       OR NEW.submitted_at IS NULL
       OR NEW.worker_correlation_id IS NULL
       OR NEW.outcome_reason IS NOT NULL
     ))
     OR (NEW.outcome IN ('failed_worker', 'failed_portal') AND NEW.outcome_reason IS NULL)
  THEN
    RAISE EXCEPTION 'claim_submission is immutable except for one queued-to-terminal transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
