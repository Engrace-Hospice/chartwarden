-- M23 (ADR-0052) -- the DDE work queue: human work tracking for Medicare Direct Data Entry (FISS) items.
--
-- DDE is the terminal each MAC gives hospice providers; WardenX never integrates with it (no credentials, no
-- automation). The queue tells a biller what must be keyed, by when, and records what came back. Recording that an
-- item was keyed is an operator attestation (ADR-0052 D2).
--
--   1. dde_work_item  -- one item of work (NOE, NOTR, claim entry, RTP correction, adjustment, cancel, ADR response).
--                        ORG-SCOPED (three tenancy columns), FORCEd RLS, M4 write-audit trigger (notes scrubbed),
--                        compliance retention. At most ONE open item per (subject, type) so the NOE/NOTR watchdog
--                        and a manual create can never duplicate work. No MBI column; `notes` is capped.
--   2. dde_work_event -- the APPEND-ONLY history of an item (UPDATE/DELETE refused; only the destruction role
--                        erases). `detail` holds codes, ids and dates only, never notes or names.
--   3. payer_status_date_source learns 'dde_manual': the MAC acceptance date an operator read off DDE and keyed
--      into the queue. NOE timeliness stays judged on `payer_status_date` (ADR-0052 D5).
--   4. Permission catalog rows + admin-role grants for billing.dde.{read,work,mark_submitted,admin}.
-- Idempotent.
--
-- NOTE (edited in place before merge): the CHECK constraints below (dcn 13-23 chars, closed outcome codes tied to
-- the state, the extra lookup index) were tightened after a first draft of this file. A dev / Docker database that
-- already applied the EARLIER 1060 keeps the old constraints (the guarded statements skip objects that already
-- exist): recreate that database (`bun run db:reset`) rather than re-running this file. Nothing was ever released with
-- the old version, so there is no production migration to write.

-- ── 1. dde_work_item ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "dde_work_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"assignee_membership_id" uuid,
	"priority" smallint DEFAULT 2 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"deadline_at" date,
	"submitted_at" timestamp with time zone,
	"mac_accepted_on" date,
	"dcn" text,
	"rtp_reason_code" text,
	"outcome_code" text,
	"notes" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dde_work_item_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "dde_work_item_type_chk" CHECK ("item_type" IN
		('noe', 'notr', 'claim_entry', 'rtp_correction', 'adjustment', 'cancel', 'adr_response')),
	CONSTRAINT "dde_work_item_subject_kind_chk" CHECK ("subject_kind" IN ('claim', 'noe_record', 'notr_record')),
	-- An NOE item acts on an NOE, an NOTR item on an NOTR, every other type on a claim.
	CONSTRAINT "dde_work_item_subject_matches_type_chk" CHECK (
		("item_type" = 'noe' AND "subject_kind" = 'noe_record')
		OR ("item_type" = 'notr' AND "subject_kind" = 'notr_record')
		OR ("item_type" NOT IN ('noe', 'notr') AND "subject_kind" = 'claim')
	),
	CONSTRAINT "dde_work_item_state_chk" CHECK ("state" IN
		('queued', 'assigned', 'in_progress', 'submitted', 'accepted', 'returned', 'closed', 'cancelled')),
	CONSTRAINT "dde_work_item_source_chk" CHECK ("source" IN ('manual', 'watchdog')),
	CONSTRAINT "dde_work_item_attempt_chk" CHECK ("attempt_number" >= 1),
	CONSTRAINT "dde_work_item_priority_chk" CHECK ("priority" BETWEEN 1 AND 3),
	-- DCN / ICN / receipt numbers and RTP reason codes are short codes, never free text.
	-- A DCN / ICN is 13 to 23 characters; an 11-character value (an MBI's length) can never be stored here.
	CONSTRAINT "dde_work_item_dcn_chk" CHECK ("dcn" IS NULL OR "dcn" ~ '^[A-Za-z0-9]{13,23}$'),
	CONSTRAINT "dde_work_item_rtp_code_chk" CHECK ("rtp_reason_code" IS NULL OR "rtp_reason_code" ~ '^[A-Z0-9]{1,8}$'),
	-- A closed set: a free-form code is a place to hide an identifier.
	CONSTRAINT "dde_work_item_outcome_code_chk" CHECK ("outcome_code" IS NULL OR "outcome_code" IN
		('accepted', 'accepted_with_edits', 'rtp', 'rejected', 'adr_requested', 'other')),
	-- The code must fit the state it describes: how it came back when returned, how it was accepted when accepted.
	CONSTRAINT "dde_work_item_outcome_state_chk" CHECK (
		"outcome_code" IS NULL
		OR ("state" = 'returned' AND "outcome_code" IN ('rtp', 'rejected', 'adr_requested', 'other'))
		OR ("state" = 'accepted' AND "outcome_code" IN ('accepted', 'accepted_with_edits', 'other'))
		OR "state" NOT IN ('returned', 'accepted')
	),
	-- ADR-0052 D7: free-text notes are capped (the service also refuses MBI-shaped text).
	CONSTRAINT "dde_work_item_notes_chk" CHECK ("notes" IS NULL OR length("notes") <= 500),
	-- An item that was keyed carries when; an accepted/closed-after-accept item may carry the MAC date.
	CONSTRAINT "dde_work_item_submitted_chk" CHECK (
		"state" NOT IN ('submitted', 'accepted', 'returned') OR "submitted_at" IS NOT NULL
	)
);--> statement-breakpoint
-- At most one OPEN item per (subject, type).
CREATE UNIQUE INDEX IF NOT EXISTS "dde_work_item_open_subject_uq" ON "dde_work_item" ("subject_kind", "subject_id", "item_type")
	WHERE "state" IN ('queued', 'assigned', 'in_progress', 'submitted', 'returned');--> statement-breakpoint
-- The watchdog's anti-join (`NOT EXISTS ... subject_kind, subject_id, item_type`) and any per-subject lookup: the
-- partial open-items index above cannot serve a finished item.
CREATE INDEX IF NOT EXISTS "dde_work_item_subject_idx" ON "dde_work_item" ("organization_id", "subject_kind", "subject_id", "item_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dde_work_item_worklist_idx" ON "dde_work_item" ("organization_id", "state", "deadline_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dde_work_item_assignee_idx" ON "dde_work_item" ("organization_id", "assignee_membership_id")
	WHERE "assignee_membership_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dde_work_item_patient_idx" ON "dde_work_item" ("organization_id", "patient_id");--> statement-breakpoint

ALTER TABLE "dde_work_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dde_work_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "dde_work_item_org" ON "dde_work_item"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE for the app role: a queue item is billing history (the eraser runs as wardenx_destruction).
GRANT SELECT, INSERT, UPDATE ON "dde_work_item" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "dde_work_item" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "dde_work_item" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "dde_work_item_destruction" ON "dde_work_item"
    FOR ALL TO wardenx_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_dde_work_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['notes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'dde_work_item.' || lower(TG_OP), 'dde_work_item', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_dde_work_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_dde_work_item" ON dde_work_item;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dde_work_item" AFTER INSERT OR UPDATE OR DELETE ON dde_work_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dde_work_item();--> statement-breakpoint

-- ── 2. dde_work_event (append-only) ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "dde_work_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"actor_membership_id" uuid,
	"actor_kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dde_work_event_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "dde_work_event_work_item_fk"
		FOREIGN KEY ("work_item_id") REFERENCES "dde_work_item"("id") ON DELETE restrict,
	CONSTRAINT "dde_work_event_event_chk" CHECK ("event" IN
		('create', 'assign', 'unassign', 'reassign', 'start', 'submit', 'accept', 'return', 'retry', 'close', 'cancel')),
	CONSTRAINT "dde_work_event_actor_kind_chk" CHECK ("actor_kind" IN ('user', 'system')),
	CONSTRAINT "dde_work_event_attempt_chk" CHECK ("attempt_number" >= 1),
	CONSTRAINT "dde_work_event_detail_chk" CHECK (jsonb_typeof("detail") = 'object')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dde_work_event_item_idx" ON "dde_work_event" ("work_item_id", "occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dde_work_event_org_idx" ON "dde_work_event" ("organization_id", "occurred_at");--> statement-breakpoint

ALTER TABLE "dde_work_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dde_work_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "dde_work_event_org" ON "dde_work_event"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
GRANT SELECT, INSERT ON "dde_work_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "dde_work_event" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "dde_work_event" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "dde_work_event_destruction" ON "dde_work_event"
    FOR ALL TO wardenx_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL; END $$;--> statement-breakpoint

-- Append-only guard: no UPDATE ever; DELETE only by the (non-superuser) destruction role.
CREATE OR REPLACE FUNCTION dde_work_event_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'dde_work_event is append-only (% refused)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_dde_work_event_append_only" ON dde_work_event;--> statement-breakpoint
CREATE TRIGGER "trg_dde_work_event_append_only" BEFORE UPDATE OR DELETE ON dde_work_event
  FOR EACH ROW EXECUTE FUNCTION dde_work_event_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_dde_work_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'dde_work_event.' || lower(TG_OP), 'dde_work_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_dde_work_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_dde_work_event" ON dde_work_event;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dde_work_event" AFTER INSERT OR UPDATE OR DELETE ON dde_work_event
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dde_work_event();--> statement-breakpoint

-- ── 3. payer_status_date_source learns 'dde_manual' ───────────────────────────────────────────────────────────
ALTER TABLE "noe_record" DROP CONSTRAINT IF EXISTS "noe_record_payer_status_date_chk";--> statement-breakpoint
ALTER TABLE "noe_record" ADD CONSTRAINT "noe_record_payer_status_date_chk"
  CHECK (("payer_status_date" IS NULL) = ("payer_status_date_source" IS NULL)
    AND ("payer_status_date_source" IS NULL
         OR "payer_status_date_source" IN ('277ca_stc02', '999_gs04', '999_isa09', 'receipt', 'dde_manual')));--> statement-breakpoint
ALTER TABLE "notr_record" DROP CONSTRAINT IF EXISTS "notr_record_payer_status_date_chk";--> statement-breakpoint
ALTER TABLE "notr_record" ADD CONSTRAINT "notr_record_payer_status_date_chk"
  CHECK (("payer_status_date" IS NULL) = ("payer_status_date_source" IS NULL)
    AND ("payer_status_date_source" IS NULL
         OR "payer_status_date_source" IN ('277ca_stc02', '999_gs04', '999_isa09', 'receipt', 'dde_manual')));--> statement-breakpoint

-- ── 4. Permission catalog mirror rows + admin-role grants (0280's pattern) ─────────────────────────────────────
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.dde.read',           'billing_dde', 'read',           'billing', 'provider_entity_billing_scope', ''),
  ('billing.dde.work',           'billing_dde', 'work',           'billing', 'provider_entity_billing_scope', ''),
  ('billing.dde.mark_submitted', 'billing_dde', 'mark_submitted', 'billing', 'provider_entity_billing_scope', ''),
  ('billing.dde.admin',          'billing_dde', 'admin',          'billing', 'provider_entity_billing_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES ('billing.dde.read'), ('billing.dde.work'), ('billing.dde.mark_submitted'), ('billing.dde.admin')) AS p("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
