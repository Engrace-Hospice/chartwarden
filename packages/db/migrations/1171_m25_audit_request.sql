-- M25 milestone 7a-1 (hospice ADR/TPE/QIC PRD, milestone 7): the AUDIT REQUEST aggregate. A RAC / UPIC / SMRC (or other)
-- request for records is its own aggregate, NOT an adr_case: an ADR is a claim-level MAC request with a MAC-rule window
-- and a denial/reopening route, whereas an audit request has a different issuer, is often multi-claim or patient-level,
-- and its follow-ons (findings, overpayment demand, rebuttal) are unverified SME items. It links to claims
-- (audit_request_claim) and optionally to an ADR / denial; nothing opens an appeal automatically.
--
-- NO CLOCK IS ENCODED. authority_kind is a LABEL (it names a contractor type, it implies no window, channel or
-- procedure). The due date is not a column here: it is a recorded_deadline (1172) typed from the request letter. A request
-- with no recorded deadline reads "no deadline recorded" (derived on read) and raises one alert (no_deadline_alerted_at).
--
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK mirrored in
-- domain/audit-request.ts, so there is no new pgEnum. Idempotent on purpose (the 1116/1117 renumber lesson).

CREATE TABLE IF NOT EXISTS "audit_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "authority_kind" text NOT NULL CHECK ("authority_kind" IN ('rac','upic','smrc','other')),
  "authority_name" text,
  "request_reference" text,
  "request_dated_on" date,
  "received_on" date NOT NULL,
  "state" text NOT NULL DEFAULT 'received' CHECK ("state" IN ('received','in_assembly','in_review','responded','withdrawn','closed')),
  "scope_note" text,
  "adr_case_id" uuid REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "denial_case_id" uuid REFERENCES "denial_case"("id") ON DELETE RESTRICT,
  "responded_at" timestamptz,
  "closed_at" timestamptz,
  "no_deadline_alerted_at" timestamptz,
  "created_by_membership_id" uuid,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "audit_request_other_needs_name" CHECK ("authority_kind" <> 'other' OR ("authority_name" IS NOT NULL AND btrim("authority_name") <> '')),
  CONSTRAINT "audit_request_dated_before_received" CHECK ("request_dated_on" IS NULL OR "request_dated_on" <= "received_on"),
  CONSTRAINT "audit_request_responded_has_time" CHECK ("state" NOT IN ('responded','closed') OR "responded_at" IS NOT NULL),
  CONSTRAINT "audit_request_terminal_has_closed_at" CHECK ("state" NOT IN ('closed','withdrawn') OR "closed_at" IS NOT NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_request_org_ix" ON "audit_request" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_request_state" ON "audit_request" ("organization_id", "state");--> statement-breakpoint
-- FK-covering indexes for the optional links.
CREATE INDEX IF NOT EXISTS "ix_audit_request_adr" ON "audit_request" ("adr_case_id") WHERE "adr_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_request_denial" ON "audit_request" ("denial_case_id") WHERE "denial_case_id" IS NOT NULL;--> statement-breakpoint

-- The claims a request covers (many). A claim is removed by stamping removed_at (history is the audit trail), never
-- deleted. claim_id is the M23 logical FK; the service checks it is visible under RLS inside the actor's provider scope.
CREATE TABLE IF NOT EXISTS "audit_request_claim" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "audit_request_id" uuid NOT NULL REFERENCES "audit_request"("id") ON DELETE RESTRICT,
  "claim_id" uuid NOT NULL,
  "date_of_service_note" text,
  "added_by_membership_id" uuid,
  "removed_at" timestamptz,
  "removed_by_membership_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_request_claim_live_unique" ON "audit_request_claim" ("audit_request_id", "claim_id") WHERE "removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_request_claim_claim" ON "audit_request_claim" ("claim_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_request_claim_org_ix" ON "audit_request_claim" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "audit_request_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "audit_request_id" uuid NOT NULL REFERENCES "audit_request"("id") ON DELETE RESTRICT,
  "event_kind" text NOT NULL,
  "event_payload" jsonb,
  "actor_membership_id" uuid,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_request_event_case" ON "audit_request_event" ("audit_request_id", "occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_request_event_org_ix" ON "audit_request_event" ("organization_id", "occurred_at");--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd; the app role has no DELETE on any of the three.
ALTER TABLE "audit_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "audit_request_org" ON "audit_request";--> statement-breakpoint
CREATE POLICY "audit_request_org" ON "audit_request" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "audit_request_claim" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_request_claim" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "audit_request_claim_org" ON "audit_request_claim";--> statement-breakpoint
CREATE POLICY "audit_request_claim_org" ON "audit_request_claim" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "audit_request_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_request_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "audit_request_event_org" ON "audit_request_event";--> statement-breakpoint
CREATE POLICY "audit_request_event_org" ON "audit_request_event" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- The anchor (authority kind, received date, provider entity) never changes after logging: only progress and the
-- user-editable intake facts are updatable. The history is append-only.
GRANT SELECT, INSERT ON "audit_request" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("authority_name", "request_reference", "request_dated_on", "scope_note", "adr_case_id", "denial_case_id",
  "state", "responded_at", "closed_at", "no_deadline_alerted_at", "version", "updated_at") ON "audit_request" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "audit_request" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_request_claim" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("date_of_service_note", "removed_at", "removed_by_membership_id") ON "audit_request_claim" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "audit_request_claim" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_request_event" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "audit_request_event" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). Free text (the issuer's reference and name, the scope note, the
-- per-claim note, the event payload) is scrubbed from the audit trail.
CREATE OR REPLACE FUNCTION audit_phi_write_audit_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['authority_name','request_reference','scope_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'audit_request.' || lower(TG_OP), 'audit_request', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_audit_request() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_audit_request" ON audit_request;--> statement-breakpoint
CREATE TRIGGER "trg_audit_audit_request" AFTER INSERT OR UPDATE OR DELETE ON audit_request FOR EACH ROW EXECUTE FUNCTION audit_phi_write_audit_request();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_audit_request_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['date_of_service_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'audit_request_claim.' || lower(TG_OP), 'audit_request_claim', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_audit_request_claim() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_audit_request_claim" ON audit_request_claim;--> statement-breakpoint
CREATE TRIGGER "trg_audit_audit_request_claim" AFTER INSERT OR UPDATE OR DELETE ON audit_request_claim FOR EACH ROW EXECUTE FUNCTION audit_phi_write_audit_request_claim();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_audit_request_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['event_payload'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'audit_request_event.' || lower(TG_OP), 'audit_request_event', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_audit_request_event() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_audit_request_event" ON audit_request_event;--> statement-breakpoint
CREATE TRIGGER "trg_audit_audit_request_event" AFTER INSERT OR UPDATE OR DELETE ON audit_request_event FOR EACH ROW EXECUTE FUNCTION audit_phi_write_audit_request_event();--> statement-breakpoint

-- The legal edges (the same table as domain/audit-request.ts) and the freeze:
--   - withdrawn and closed never change again; the state only moves forward (or to withdrawn);
--   - the anchor columns are not in the app role's UPDATE grants at all.
CREATE OR REPLACE FUNCTION m25_audit_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('withdrawn','closed') THEN
    RAISE EXCEPTION 'M25_AUDIT_FROZEN: audit_request % is % and cannot change', OLD.id, OLD.state;
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'received' AND NEW.state IN ('in_assembly','withdrawn'))
    OR (OLD.state = 'in_assembly' AND NEW.state IN ('in_review','withdrawn'))
    OR (OLD.state = 'in_review' AND NEW.state IN ('responded','withdrawn'))
    OR (OLD.state = 'responded' AND NEW.state IN ('closed','withdrawn'))) THEN
    RAISE EXCEPTION 'M25_AUDIT_ILLEGAL_TRANSITION: audit_request % cannot move from % to %', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_request_guard" ON audit_request;--> statement-breakpoint
CREATE TRIGGER "trg_audit_request_guard" BEFORE UPDATE ON audit_request FOR EACH ROW EXECUTE FUNCTION m25_audit_request_guard();--> statement-breakpoint

-- Org-consistency + freeze for the claim links: a FK does not prove the parent belongs to organization_id, and RLS hides
-- another tenant's parent from this SELECT, so a cross-tenant audit_request_id fails closed. A finished request takes
-- no new claim and loses none.
CREATE OR REPLACE FUNCTION m25_audit_request_claim_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  SELECT state INTO v_state FROM audit_request WHERE id = NEW.audit_request_id AND organization_id = NEW.organization_id;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'M25_AUDIT_CLAIM_PARENT: audit_request % is not visible to this organization', NEW.audit_request_id;
  END IF;
  IF v_state IN ('withdrawn','closed') THEN
    RAISE EXCEPTION 'M25_AUDIT_FROZEN: audit_request % is % and its claims cannot change', NEW.audit_request_id, v_state;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_request_claim_guard" ON audit_request_claim;--> statement-breakpoint
CREATE TRIGGER "trg_audit_request_claim_guard" BEFORE INSERT OR UPDATE ON audit_request_claim FOR EACH ROW EXECUTE FUNCTION m25_audit_request_claim_guard();--> statement-breakpoint

-- audit_request.read: see audit requests. audit_request.manage: log one, edit it, link claims, move it through its
-- states. (The plain `audit.*` keys are the platform compliance audit trail, a different thing.) Full-catalog roles
-- receive them from the template materializer; existing tenants' roles get them from 1173.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('audit_request.read', 'audit_request', 'read', 'billing', 'provider_entity_scope', ''),
  ('audit_request.manage', 'audit_request', 'manage', 'billing', 'provider_entity_scope', '')
ON CONFLICT ("key") DO NOTHING;
