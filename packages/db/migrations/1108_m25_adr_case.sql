-- M25 ADR intake (hospice ADR/TPE/QIC PRD, milestone 2a): an additional documentation request from a MAC, its
-- event history, and the per-MAC response-window rules the due date is derived from. Org-scoped on all three
-- (canonical app.org_id RLS, no DELETE for the app role). State and review type are text + CHECK rather than
-- new enums: the values are closed and mirrored in domain/types.ts. mac_rule rows are tenant data (the agency
-- owns and verifies its MAC rules); a missing rule falls back to the platform default in code and the case
-- records which one it used, so a due date never silently changes after the fact.

CREATE TABLE "mac_rule" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "mac_name" text NOT NULL,
  "review_type" text NOT NULL CHECK ("review_type" IN ('adr','re_adr')),
  "response_days" integer NOT NULL CHECK ("response_days" BETWEEN 1 AND 365),
  "source_note" text,
  "verified_on" date,
  "effective_from" date NOT NULL DEFAULT CURRENT_DATE,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mac_rule_unique" UNIQUE ("organization_id", "mac_name", "review_type", "effective_from")
);--> statement-breakpoint

CREATE TABLE "adr_case" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL,
  "denial_case_id" uuid REFERENCES "denial_case"("id") ON DELETE RESTRICT,
  "mac_name" text NOT NULL,
  "review_type" text NOT NULL CHECK ("review_type" IN ('adr','re_adr')),
  "state" text NOT NULL DEFAULT 'received'
    CHECK ("state" IN ('received','in_assembly','in_review','submitted','denied_no_response','withdrawn','closed')),
  "adr_reference" text,
  "requested_on" date NOT NULL,
  "window_days" integer NOT NULL CHECK ("window_days" BETWEEN 1 AND 365),
  "window_source" text NOT NULL CHECK ("window_source" IN ('org_rule','platform_default')),
  "window_verified" boolean NOT NULL DEFAULT false,
  "response_due_at" timestamptz NOT NULL,
  "submitted_at" timestamptz,
  "closed_at" timestamptz,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "ix_adr_claim" ON "adr_case" ("claim_id");--> statement-breakpoint
CREATE INDEX "ix_adr_denial" ON "adr_case" ("denial_case_id") WHERE "denial_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_adr_due" ON "adr_case" ("response_due_at") WHERE "state" IN ('received','in_assembly','in_review');--> statement-breakpoint
CREATE INDEX "adr_case_org_ix" ON "adr_case" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE "adr_case_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "adr_case_id" uuid NOT NULL REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "event_kind" text NOT NULL,
  "event_payload" jsonb,
  "actor_membership_id" uuid,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "ix_adr_event_case" ON "adr_case_event" ("adr_case_id", "occurred_at");--> statement-breakpoint
CREATE INDEX "adr_case_event_org_ix" ON "adr_case_event" ("organization_id", "occurred_at");--> statement-breakpoint
-- MAC names match case-insensitively, so the rule key must too.
CREATE UNIQUE INDEX "mac_rule_name_ci_unique" ON "mac_rule" ("organization_id", lower(btrim("mac_name")), "review_type", "effective_from");--> statement-breakpoint
CREATE INDEX "mac_rule_org_ix" ON "mac_rule" ("organization_id", "created_at");--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd, app role without DELETE.
ALTER TABLE "mac_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mac_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "mac_rule_org" ON "mac_rule" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "mac_rule" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "mac_rule" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "adr_case" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adr_case" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "adr_case_org" ON "adr_case" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- A case's anchor, window and due date never change after logging: only its progress columns are updatable.
GRANT SELECT, INSERT ON "adr_case" TO wardenx_app;--> statement-breakpoint
GRANT UPDATE ("state", "version", "submitted_at", "closed_at") ON "adr_case" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "adr_case" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "adr_case_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adr_case_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "adr_case_event_org" ON "adr_case_event" FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The history is append-only for the app role: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON "adr_case_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "adr_case_event" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). adr_case_event.event_payload is denylisted; no MBI is a column.
CREATE OR REPLACE FUNCTION audit_phi_write_adr_case() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['adr_reference'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'adr_case.' || lower(TG_OP), 'adr_case', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_adr_case() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_adr_case" AFTER INSERT OR UPDATE OR DELETE ON adr_case FOR EACH ROW EXECUTE FUNCTION audit_phi_write_adr_case();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_adr_case_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['event_payload'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'adr_case_event.' || lower(TG_OP), 'adr_case_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_adr_case_event() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_adr_case_event" AFTER INSERT OR UPDATE OR DELETE ON adr_case_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_adr_case_event();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_mac_rule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'mac_rule.' || lower(TG_OP), 'mac_rule', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_mac_rule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_mac_rule" AFTER INSERT OR UPDATE OR DELETE ON mac_rule FOR EACH ROW EXECUTE FUNCTION audit_phi_write_mac_rule();--> statement-breakpoint

-- A terminal ADR is frozen (mirrors the appeal closed-row immutability).
CREATE OR REPLACE FUNCTION m25_adr_case_terminal_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('closed','withdrawn','denied_no_response') THEN
    RAISE EXCEPTION 'M25_ADR_TERMINAL_IMMUTABLE: adr_case % is % and cannot be modified', OLD.id, OLD.state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_adr_case_terminal_immutable" BEFORE UPDATE ON adr_case FOR EACH ROW EXECUTE FUNCTION m25_adr_case_terminal_immutable();
--> statement-breakpoint

-- ── permissions (the 1105 shape): catalog rows + grants wherever a tenant has created the role ──────────────────────
-- adr.read: see ADR cases and MAC rules. adr.manage: log an ADR and move it through assembly / review / closure.
-- mac_rule.manage: edit the organization's MAC response-window rules (a billing-lead decision).
-- Full-catalog roles (administrator, org_admin) receive every non-platform key from the template materializer.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('adr.read', 'adr_case', 'read', 'billing', 'provider_entity_scope', ''),
  ('adr.manage', 'adr_case', 'manage', 'billing', 'provider_entity_scope', ''),
  ('mac_rule.manage', 'mac_rule', 'manage', 'billing', 'none', '')
ON CONFLICT ("key") DO NOTHING;
