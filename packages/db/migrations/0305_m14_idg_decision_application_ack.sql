-- M14 — `idg_decision_application_ack` (F-232, #248): the durable record that a downstream module APPLIED an
-- emitted IDG decision. First writer: M14's `m14.m15-idg-decision-applied` consumer, which consumes
-- `m15.idg_decision.applied` ({planId, versionId, idgDecisionId, mutationsApplied}). Until now M14's
-- `idg_decision.status` ran `open -> emitted -> superseded` only, so "emitted" was the last thing the IDG
-- coordinator could ever see; M7/M11/M12 each own an `*_idg_decision_applications` table but M14 consumed none
-- of their acknowledgements. This is the M14-side generalisation: one row per (decision, acknowledging module).
--
-- Metadata only — ids, a count, instants. No narrative text, so nothing is denylisted in the audit trigger.
-- Org-scoped canonical `app.org_id` RLS (ENABLED + FORCED); the three-column tenancy is nullable like the rest
-- of the M14 child tables (copied from the decision's meeting when present). The app role can INSERT/SELECT
-- and has NO UPDATE/DELETE: an acknowledgement is append-only and idempotent on (org, decision, module).
-- `plan_id` / `version_id` are the ACKNOWLEDGING module's ids (plain uuid; no cross-module FK).
-- Idempotent.

CREATE TABLE IF NOT EXISTS "idg_decision_application_ack" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid,
  "location_id" uuid,
  "idg_decision_id" uuid NOT NULL,
  "idg_meeting_id" uuid NOT NULL,
  "patient_id" uuid,
  "target_module" text NOT NULL,
  "plan_id" uuid,
  "version_id" uuid,
  "mutations_applied" integer DEFAULT 0 NOT NULL,
  "source_outbox_event_id" uuid NOT NULL,
  "acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idg_decision_application_ack_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "idg_decision_application_ack_provider_entity_id_provider_entity_id_fk"
    FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "idg_decision_application_ack_location_id_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action,
  CONSTRAINT "idg_decision_application_ack_idg_decision_id_idg_decision_id_fk"
    FOREIGN KEY ("idg_decision_id") REFERENCES "public"."idg_decision"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "idg_decision_application_ack_module_chk" CHECK ("target_module" IN ('m15')),
  CONSTRAINT "idg_decision_application_ack_count_chk" CHECK ("mutations_applied" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idg_decision_application_ack_decision_module_uq"
  ON "idg_decision_application_ack" ("organization_id", "idg_decision_id", "target_module");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idg_decision_application_ack_meeting_idx"
  ON "idg_decision_application_ack" ("organization_id", "idg_meeting_id");--> statement-breakpoint

ALTER TABLE "idg_decision_application_ack" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "idg_decision_application_ack" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "idg_decision_application_ack_org" ON "idg_decision_application_ack";--> statement-breakpoint
CREATE POLICY "idg_decision_application_ack_org" ON "idg_decision_application_ack"
  FOR ALL TO wardenx_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "idg_decision_application_ack" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "idg_decision_application_ack" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit trigger (the idg_discipline_note shape). Metadata only, so nothing is scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_idg_decision_application_ack() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'idg_decision_application_ack.' || lower(TG_OP),
    'idg_decision_application_ack',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_idg_decision_application_ack() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_idg_decision_application_ack" ON "idg_decision_application_ack";--> statement-breakpoint
CREATE TRIGGER "trg_audit_idg_decision_application_ack" AFTER INSERT OR UPDATE OR DELETE ON idg_decision_application_ack
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_idg_decision_application_ack();--> statement-breakpoint

-- Patient destruction (0157 / 0282 pattern; idg-eraser.ts deletes a patient's acks): SELECT + DELETE and an
-- org-pinned destruction policy.
GRANT SELECT, DELETE ON "idg_decision_application_ack" TO wardenx_destruction;--> statement-breakpoint
DROP POLICY IF EXISTS "idg_decision_application_ack_destruction" ON "idg_decision_application_ack";--> statement-breakpoint
CREATE POLICY "idg_decision_application_ack_destruction" ON "idg_decision_application_ack"
  FOR ALL TO wardenx_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
