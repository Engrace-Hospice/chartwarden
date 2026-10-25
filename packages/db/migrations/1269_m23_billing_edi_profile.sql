-- M23: the per-(provider entity, route) EDI profile the 837I loader reads for the interchange parties the chart cannot supply:
-- who submits (name, id, contact), and who receives (name, id, GS03 application code). These are VENDOR / TRADING-PARTNER
-- facts that differ per route (a clearinghouse, a direct MAC link), so they are entered by the tenant and are NEVER seeded or
-- defaulted here; a missing row is a typed gap in the loader, not a guess. `route_key` is the CLEARINGHOUSE_VENDOR value the
-- profile applies to (free text, so adding a vendor adds no migration). Billing provider and payer data come from
-- provider_entity and M40, not from here. Business contact details only: no beneficiary data, no secret.
--
-- `version` makes an edit a compare-and-set (If-Match). The app role reads, inserts and edits the profile; it never deletes one.
CREATE TABLE IF NOT EXISTS "billing_edi_profile" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "route_key" text NOT NULL CHECK ("route_key" ~ '^[a-z][a-z0-9_]{1,31}$'),
  "submitter_name" text NOT NULL CHECK (btrim("submitter_name") <> '' AND char_length("submitter_name") <= 60),
  "submitter_id" text NOT NULL CHECK (btrim("submitter_id") <> '' AND char_length("submitter_id") <= 80),
  "submitter_contact_name" text NOT NULL CHECK (btrim("submitter_contact_name") <> '' AND char_length("submitter_contact_name") <= 60),
  "submitter_contact_phone" text NOT NULL CHECK ("submitter_contact_phone" ~ '^[0-9]{10}$'),
  "receiver_name" text NOT NULL CHECK (btrim("receiver_name") <> '' AND char_length("receiver_name") <= 60),
  "receiver_id" text NOT NULL CHECK (btrim("receiver_id") <> '' AND char_length("receiver_id") <= 80),
  "receiver_application_code" text NOT NULL CHECK ("receiver_application_code" ~ '^[A-Za-z0-9]{2,15}$'),
  "set_by_membership_id" uuid NOT NULL,
  "version" integer NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_edi_profile_key" UNIQUE ("organization_id", "provider_entity_id", "route_key")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_edi_profile_org_ix" ON "billing_edi_profile" ("organization_id", "created_at");--> statement-breakpoint
ALTER TABLE "billing_edi_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_edi_profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "billing_edi_profile_org" ON "billing_edi_profile";--> statement-breakpoint
CREATE POLICY "billing_edi_profile_org" ON "billing_edi_profile" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "billing_edi_profile" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("submitter_name", "submitter_id", "submitter_contact_name", "submitter_contact_phone", "receiver_name",
  "receiver_id", "receiver_application_code", "set_by_membership_id", "version", "updated_at") ON "billing_edi_profile" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "billing_edi_profile" TO chartwarden_admin;--> statement-breakpoint
-- M04 write-audit (compliance retention: the profile decides who an interchange is addressed to).
CREATE OR REPLACE FUNCTION audit_phi_write_billing_edi_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'billing_edi_profile.' || lower(TG_OP), 'billing_edi_profile', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'warn', v_before, v_after, jsonb_build_object('provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_billing_edi_profile() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_billing_edi_profile" ON billing_edi_profile;--> statement-breakpoint
CREATE TRIGGER "trg_audit_billing_edi_profile" AFTER INSERT OR UPDATE OR DELETE ON billing_edi_profile FOR EACH ROW EXECUTE FUNCTION audit_phi_write_billing_edi_profile();
