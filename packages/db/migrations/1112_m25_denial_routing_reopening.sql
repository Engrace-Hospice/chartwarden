-- M25 non-response and medical-review denials (hospice ADR/TPE/QIC PRD, milestone 3): which path a denial takes
-- (appeal or a MAC reopening) and the reopening aggregate itself. A 56900 ADR non-response is not appealable; the
-- MAC reopens it. Org-scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text +
-- CHECK mirrored in domain/denial-route.ts and domain/reopening-machine.ts, so there is no new pgEnum.
--
-- denial_route_rule rows are tenant data (the agency verifies them against its MAC); the built-in default (56900 ->
-- reopening, unverified) lives in code, like the ADR window default, so a new tenant needs no seeding and the screen
-- says which rule decided. The route is computed on read from the rules, never stored, so a rule change cannot
-- leave a stale route on a denial.

-- The MAC's own reason code (FISS 56900 etc.): not a CARC, so it is its own column. Entered by the user until an
-- 835 mapping is confirmed.
ALTER TABLE "denial_case" ADD COLUMN "mac_reason_code" varchar(16);--> statement-breakpoint

CREATE TABLE "denial_route_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "mac_name" text,
  "code_kind" text NOT NULL CHECK ("code_kind" IN ('mac_reason','rarc','carc')),
  "code" varchar(16) NOT NULL CHECK (btrim("code") <> ''),
  "route" text NOT NULL CHECK ("route" IN ('appeal','reopening')),
  "source_note" text,
  "verified_on" date,
  "effective_from" date NOT NULL DEFAULT CURRENT_DATE,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
-- MAC names and codes match case-insensitively, so the rule key must too (a null MAC = every MAC).
CREATE UNIQUE INDEX "denial_route_rule_key" ON "denial_route_rule"
  ("organization_id", lower(btrim(coalesce("mac_name", ''))), "code_kind", upper(btrim("code")), "effective_from");--> statement-breakpoint
CREATE INDEX "denial_route_rule_org_ix" ON "denial_route_rule" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "reopening_case" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL,
  "denial_case_id" uuid NOT NULL REFERENCES "denial_case"("id") ON DELETE RESTRICT,
  "adr_case_id" uuid REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "mac_name" text NOT NULL,
  "state" text NOT NULL DEFAULT 'draft' CHECK ("state" IN ('draft','submitted','decided','withdrawn','closed')),
  -- The filing facts: what was used and what the MAC gave back. Recorded together, frozen once recorded.
  "form_name" text,
  "filing_channel" text CHECK ("filing_channel" IN ('mac_portal','fax','mail','other')),
  "filing_confirmation_ref" text,
  "filed_at" timestamptz,
  "proof_document_id" uuid,
  -- No deadline is known for a reopening (the MAC states none): the user may record one from the MAC's instruction.
  "due_at" timestamptz,
  "outcome" text CHECK ("outcome" IN ('granted','partial','denied')),
  "decided_at" timestamptz,
  "closed_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- A filed case always carries its proof; a decided one its outcome: no code path can record otherwise.
  CONSTRAINT "reopening_case_filed_has_proof" CHECK ("state" NOT IN ('submitted','decided','closed')
    OR ("form_name" IS NOT NULL AND "filing_channel" IS NOT NULL AND "filing_confirmation_ref" IS NOT NULL AND "filed_at" IS NOT NULL)),
  CONSTRAINT "reopening_case_decided_has_outcome" CHECK ("state" NOT IN ('decided','closed')
    OR ("outcome" IS NOT NULL AND "decided_at" IS NOT NULL))
);--> statement-breakpoint
-- One live reopening per denial: a second request would be a duplicate the MAC has to reconcile.
CREATE UNIQUE INDEX "reopening_case_live_per_denial" ON "reopening_case" ("denial_case_id")
  WHERE "state" IN ('draft','submitted','decided');--> statement-breakpoint
CREATE INDEX "ix_reopening_claim" ON "reopening_case" ("claim_id");--> statement-breakpoint
CREATE INDEX "ix_reopening_adr" ON "reopening_case" ("adr_case_id") WHERE "adr_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_reopening_due" ON "reopening_case" ("due_at") WHERE "due_at" IS NOT NULL AND "state" IN ('draft','submitted');--> statement-breakpoint
CREATE INDEX "reopening_case_org_ix" ON "reopening_case" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "reopening_case_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "reopening_case_id" uuid NOT NULL REFERENCES "reopening_case"("id") ON DELETE RESTRICT,
  "event_kind" text NOT NULL,
  "event_payload" jsonb,
  "actor_membership_id" uuid,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "ix_reopening_event_case" ON "reopening_case_event" ("reopening_case_id", "occurred_at");--> statement-breakpoint
CREATE INDEX "reopening_case_event_org_ix" ON "reopening_case_event" ("organization_id", "occurred_at");--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd, app role without DELETE.
ALTER TABLE "denial_route_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "denial_route_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "denial_route_rule_org" ON "denial_route_rule" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "denial_route_rule" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "denial_route_rule" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "reopening_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reopening_case" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "reopening_case_org" ON "reopening_case" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The anchor (claim, denial, ADR, MAC) never changes after logging: only the progress columns are updatable.
GRANT SELECT, INSERT ON "reopening_case" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("state", "version", "form_name", "filing_channel", "filing_confirmation_ref", "filed_at",
  "proof_document_id", "due_at", "outcome", "decided_at", "closed_at") ON "reopening_case" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "reopening_case" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "reopening_case_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reopening_case_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "reopening_case_event_org" ON "reopening_case_event" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The history is append-only for the app role: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON "reopening_case_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "reopening_case_event" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). The confirmation reference and the free-text notes are scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_denial_route_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'denial_route_rule.' || lower(TG_OP), 'denial_route_rule', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_denial_route_rule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_denial_route_rule" AFTER INSERT OR UPDATE OR DELETE ON denial_route_rule FOR EACH ROW EXECUTE FUNCTION audit_phi_write_denial_route_rule();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_reopening_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['filing_confirmation_ref'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'reopening_case.' || lower(TG_OP), 'reopening_case', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_reopening_case() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_reopening_case" AFTER INSERT OR UPDATE OR DELETE ON reopening_case FOR EACH ROW EXECUTE FUNCTION audit_phi_write_reopening_case();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_reopening_case_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['event_payload'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'reopening_case_event.' || lower(TG_OP), 'reopening_case_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_reopening_case_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_reopening_case_event" AFTER INSERT OR UPDATE OR DELETE ON reopening_case_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_reopening_case_event();--> statement-breakpoint

-- What was filed is frozen: once the filing facts are recorded, none of them may change (a correction is a new
-- request, not an edit of the proof). A terminal reopening is frozen entirely.
CREATE OR REPLACE FUNCTION m25_reopening_case_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('closed','withdrawn') THEN
    RAISE EXCEPTION 'M25_REOPENING_TERMINAL_IMMUTABLE: reopening_case % is % and cannot be modified', OLD.id, OLD.state;
  END IF;
  IF OLD.filed_at IS NOT NULL AND (
       NEW.form_name IS DISTINCT FROM OLD.form_name
    OR NEW.filing_channel IS DISTINCT FROM OLD.filing_channel
    OR NEW.filing_confirmation_ref IS DISTINCT FROM OLD.filing_confirmation_ref
    OR NEW.filed_at IS DISTINCT FROM OLD.filed_at
    OR NEW.proof_document_id IS DISTINCT FROM OLD.proof_document_id) THEN
    RAISE EXCEPTION 'M25_REOPENING_FILING_IMMUTABLE: reopening_case % has been filed; the filing record cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_reopening_case_guard" BEFORE UPDATE ON reopening_case FOR EACH ROW EXECUTE FUNCTION m25_reopening_case_guard();--> statement-breakpoint

-- reopening.read: see reopening cases. reopening.manage: open one from a denial and move it through drafting and
-- decision. reopening.submit: record the filing (step-up gated). denial.route_override: appeal a denial the rules
-- route to a reopening, with a recorded reason. denial_route.manage: edit the organization's routing rules (a
-- billing-lead decision, like mac_rule.manage). Full-catalog roles receive them from the template materializer;
-- existing tenants' roles get them from the next migration.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('reopening.read', 'reopening_case', 'read', 'billing', 'provider_entity_scope', ''),
  ('reopening.manage', 'reopening_case', 'manage', 'billing', 'provider_entity_scope', ''),
  ('reopening.submit', 'reopening_case', 'submit', 'billing', 'provider_entity_scope', ''),
  ('denial.route_override', 'denial_case', 'route_override', 'billing', 'provider_entity_scope', ''),
  ('denial_route.manage', 'denial_route_rule', 'manage', 'billing', 'none', '')
ON CONFLICT ("key") DO NOTHING;
