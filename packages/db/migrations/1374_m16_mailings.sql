-- compat: expand
-- ADR-0109 D10 / blueprint section 1 - the M16 MAILING program: `bereavement_mailing_config` (one row per mailing key per tenant), `bereavement_mailing_run`
-- (one batch per occurrence) and `bereavement_mailing_item` (one row per contact of a run).
--   * CONFIG and RUN are ORG-LEVEL (ARCH-011's three-column rule applies to PHI-bearing rows; like `tenant_bereavement_external_source_gate_override`
--     they carry no patient, plan or contact id and no provider_entity_id / location_id, because one batch spans every provider entity of the tenant).
--     ITEM names a plan and a contact, so it carries organization_id + provider_entity_id NOT NULL + location_id (nullable), denormalized from the plan.
--   * `bereavement_mailing_config`: `enabled` defaults FALSE and NO default wording ships - `content_jsonb` starts empty and generation refuses empty content.
--     `decedent_birthday` is in the key CHECK so the deferred birthday mailing needs no later contracting migration; nothing builds it yet.
--     `schedule_jsonb` carries tenant overrides of the occurrence dates (the pure `nextOccurrences` applies the defaults); `audience_relationships` NULL = every
--     relationship. `version` is the If-Match token (0 = no row yet).
--   * `bereavement_mailing_run`: UNIQUE (organization_id, occurrence_key) is what lets the 5-minute sweep draft with ON CONFLICT DO NOTHING. Lifecycle
--     draft -> generating -> ready -> mailed (generating -> failed -> generating again; draft | ready | failed -> cancelled). `content_jsonb` is the wording
--     SNAPSHOT the batch is rendered from. `rendered_document_id` is a LOGICAL uuid to the M22 batch PDF, which holds EVERY recipient's name and address and
--     is therefore an INTERNAL-ONLY document (migration 1375). The run holds counts and ids, never an address.
--   * `bereavement_mailing_item`: UNIQUE (run_id, bereaved_contact_id), ids only (never an address). `ordinal` is the letter's position in the batch PDF;
--     `log_id` the activity row the sweep wrote (logical: the contact log is partitioned, so it cannot be a FK target). Statuses: included -> logged (postal,
--     after confirm-mailed), included -> excluded_after_render (the re-check at confirm-mailed dropped it), excluded (never selected). `email_sent` /
--     `email_failed` are reserved for the email channel, which is NOT built in this PR (the M36 transactional transport is a no-PHI, un-recorded link transport).
--   * Every table: ENABLE + FORCE RLS on app.org_id, SELECT/INSERT/UPDATE to the app role (nothing deletes; the destruction role is granted in 1376),
--     the 1200 PHI audit trigger (prose `content_jsonb` is scrubbed from the audit capture), and FK indexes.
CREATE TABLE "bereavement_mailing_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "mailing_key" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "lead_days" integer DEFAULT 10 NOT NULL,
  "schedule_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "audience_relationships" text[],
  "content_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "configured_by_membership_id" uuid NOT NULL,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_mailing_config_key_chk" CHECK ("mailing_key" IN ('newsletter_quarterly', 'holiday_december', 'mothers_day', 'fathers_day', 'decedent_birthday')),
  CONSTRAINT "berv_mailing_config_lead_chk" CHECK ("lead_days" BETWEEN 3 AND 60)
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_mailing_config_org_key_uniq" ON "bereavement_mailing_config" ("organization_id", "mailing_key");--> statement-breakpoint

CREATE TABLE "bereavement_mailing_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "run_kind" text NOT NULL,
  "mailing_key" text,
  "occurrence_key" text NOT NULL,
  "source_ref_id" uuid,
  "scheduled_for" date NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "content_jsonb" jsonb NOT NULL,
  "rendered_document_id" uuid,
  "recipient_count" integer DEFAULT 0 NOT NULL,
  "excluded_count" integer DEFAULT 0 NOT NULL,
  "failure_code" text,
  "generated_by_membership_id" uuid,
  "generated_at" timestamptz,
  "mailed_by_membership_id" uuid,
  "mailed_at" timestamptz,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_mailing_run_kind_chk" CHECK ("run_kind" IN ('newsletter', 'holiday', 'memorial_invitation')),
  CONSTRAINT "berv_mailing_run_key_chk" CHECK ("mailing_key" IS NULL OR "mailing_key" IN ('newsletter_quarterly', 'holiday_december', 'mothers_day', 'fathers_day', 'decedent_birthday')),
  CONSTRAINT "berv_mailing_run_status_chk" CHECK ("status" IN ('draft', 'generating', 'ready', 'mailed', 'cancelled', 'failed')),
  CONSTRAINT "berv_mailing_run_counts_chk" CHECK ("recipient_count" >= 0 AND "excluded_count" >= 0),
  -- A run that is ready or mailed has its batch PDF; a mailed run names who mailed it and when; a failed run names why.
  CONSTRAINT "berv_mailing_run_ready_chk" CHECK ("status" NOT IN ('ready', 'mailed') OR "rendered_document_id" IS NOT NULL),
  CONSTRAINT "berv_mailing_run_mailed_chk" CHECK (("status" = 'mailed') = ("mailed_at" IS NOT NULL AND "mailed_by_membership_id" IS NOT NULL)),
  CONSTRAINT "berv_mailing_run_failed_chk" CHECK ("status" <> 'failed' OR "failure_code" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_mailing_run_occurrence_uniq" ON "bereavement_mailing_run" ("organization_id", "occurrence_key");--> statement-breakpoint
-- The run list (newest scheduled first) and the sweep's "mailed runs still owing log rows" scan.
CREATE INDEX "berv_mailing_run_org_sched_idx" ON "bereavement_mailing_run" ("organization_id", "scheduled_for" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "berv_mailing_run_mailed_idx" ON "bereavement_mailing_run" ("organization_id", "mailed_at") WHERE "status" = 'mailed';--> statement-breakpoint

CREATE TABLE "bereavement_mailing_item" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "run_id" uuid NOT NULL REFERENCES "bereavement_mailing_run"("id") ON DELETE RESTRICT,
  "plan_id" uuid NOT NULL REFERENCES "bereavement_plan"("id") ON DELETE RESTRICT,
  "bereaved_contact_id" uuid NOT NULL REFERENCES "bereaved_contact"("id") ON DELETE RESTRICT,
  "channel" text NOT NULL,
  "status" text NOT NULL,
  "exclusion_reason" text,
  "ordinal" integer,
  "log_id" uuid,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "berv_mailing_item_channel_chk" CHECK ("channel" IN ('postal', 'email')),
  CONSTRAINT "berv_mailing_item_status_chk" CHECK ("status" IN ('included', 'excluded', 'logged', 'excluded_after_render', 'email_sent', 'email_failed')),
  CONSTRAINT "berv_mailing_item_reason_chk" CHECK ("exclusion_reason" IS NULL OR "exclusion_reason" IN ('plan_not_active', 'contact_not_engageable', 'opted_out', 'no_mailings', 'channel_opted_out', 'channel_not_allowed', 'no_mailing_address', 'no_email_address', 'email_channel_unavailable', 'not_in_audience')),
  -- An excluded item (never selected, or dropped after render) names why; no other item does.
  CONSTRAINT "berv_mailing_item_excluded_chk" CHECK (("status" IN ('excluded', 'excluded_after_render')) = ("exclusion_reason" IS NOT NULL)),
  CONSTRAINT "berv_mailing_item_attempts_chk" CHECK ("attempts" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "berv_mailing_item_run_contact_uniq" ON "bereavement_mailing_item" ("run_id", "bereaved_contact_id");--> statement-breakpoint
-- A letter has one position in the batch PDF.
CREATE UNIQUE INDEX "berv_mailing_item_run_ordinal_uniq" ON "bereavement_mailing_item" ("run_id", "ordinal") WHERE "ordinal" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "berv_mailing_item_run_status_idx" ON "bereavement_mailing_item" ("run_id", "status");--> statement-breakpoint
CREATE INDEX "berv_mailing_item_plan_idx" ON "bereavement_mailing_item" ("plan_id");--> statement-breakpoint
CREATE INDEX "berv_mailing_item_contact_idx" ON "bereavement_mailing_item" ("bereaved_contact_id");--> statement-breakpoint
CREATE INDEX "berv_mailing_item_org_ix" ON "bereavement_mailing_item" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX "berv_mailing_item_provider_entity_idx" ON "bereavement_mailing_item" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "berv_mailing_item_location_idx" ON "bereavement_mailing_item" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "bereavement_mailing_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_mailing_config" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_mailing_config_org_isolation" ON "bereavement_mailing_config"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_mailing_config" TO chartwarden_app;--> statement-breakpoint
ALTER TABLE "bereavement_mailing_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_mailing_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_mailing_run_org_isolation" ON "bereavement_mailing_run"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_mailing_run" TO chartwarden_app;--> statement-breakpoint
ALTER TABLE "bereavement_mailing_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_mailing_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bereavement_mailing_item_org_isolation" ON "bereavement_mailing_item"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bereavement_mailing_item" TO chartwarden_app;--> statement-breakpoint

-- The 1200 PHI audit pattern. The wording of a mailing is prose, so the audit row scrubs it (M16_AUDIT_DENYLIST).
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_mailing_config() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['content_jsonb']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
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
ALTER FUNCTION audit_phi_write_bereavement_mailing_config() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_mailing_config"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_mailing_config
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_mailing_config('bereavement_mailing_config');--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_mailing_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY['content_jsonb']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
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
ALTER FUNCTION audit_phi_write_bereavement_mailing_run() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_mailing_run"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_mailing_run
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_mailing_run('bereavement_mailing_run');--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_mailing_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_before jsonb; v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_ARGV[0] || '.' || lower(TG_OP), TG_ARGV[0],
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
ALTER FUNCTION audit_phi_write_bereavement_mailing_item() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_mailing_item"
  AFTER INSERT OR UPDATE OR DELETE ON bereavement_mailing_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_mailing_item('bereavement_mailing_item');
