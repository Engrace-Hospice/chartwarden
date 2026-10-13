-- M36 WP 2.8 - message templates and saved replies.
--
-- Two tables:
--   * message_template: ONE table, three scopes. 'platform' rows (organization_id NULL) are seeded below, read-only to
--     every tenant, and carry `required_phrases` (the platform floor). 'org' rows are shared templates a tenant admin
--     authors. 'personal' rows are one user's own saved replies. The CHECK `message_template_scope_shape` pins which
--     columns each scope may set, so a personal row can never be org-less and a platform row can never carry an owner.
--   * tenant_message_template_overlay: a tenant's re-wording of (or opt-out from) a PLATFORM template. It holds a
--     nullable title/body and an enabled flag; it has no category and no required phrases, so it cannot change either.
--     The composite FK (target_scope, template_id) -> message_template(scope, id) with `target_scope = 'platform'` makes
--     it IMPOSSIBLE for an overlay to point at another tenant's (or a personal) template - the parent of an overlay has
--     no organization_id to share, so the scope column stands in as the second half of the composite key.
-- The "overlay never loosens the floor" rule (a body must keep every required phrase; text must pass the PHI lint) is
-- enforced by the service on write and again when a stored overlay is resolved (fail closed to the platform text). It is
-- NOT a database constraint: a phrase match over NFKC-normalised text is not expressible as a CHECK.
--
-- Not PHI: a template is plain text with no merge fields, vetted by a deterministic lint on save (packages/messaging
-- templates/phi-lint.ts, whose limits are documented). The tables carry no patient reference and, being org-level
-- configuration, only organization_id of the three-column rule (like notification_template). The audit trigger still
-- scrubs `body`, so a template that slipped past the lint is never copied into the immutable audit log.
--
-- RLS (FORCEd): message_template is the floor-plus-overlay shape of comfort_kit_template (0106): SELECT admits the
-- platform scope (a discriminator column, not `organization_id IS NULL`) and the caller's own org; INSERT/UPDATE/DELETE
-- admit only the caller's own org and only scopes 'org' and 'personal', so a tenant reads the floor and can never write
-- one. Per-owner privacy of 'personal' rows is enforced by the application (owner_user_id filter), not RLS: RLS here keys
-- only on app.org_id like every other M36 table. Grants are least privilege: no TRUNCATE, no platform write for the app role.
--
-- Index coverage (test:fk-indexes:live): organization, owner, created_by, configured_by and the overlay composite FK each
-- have a leading-column index below.

CREATE TABLE "message_template" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid REFERENCES "organization"("id") ON DELETE RESTRICT,
  "scope" text NOT NULL,
  "owner_user_id" uuid REFERENCES "user"("id"),
  "template_key" text,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "required_phrases" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_by_user_id" uuid REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "message_template_scope_id_unique" UNIQUE ("scope", "id"),
  CONSTRAINT "message_template_scope_valid" CHECK ("scope" IN ('platform', 'org', 'personal')),
  CONSTRAINT "message_template_scope_shape" CHECK (
    ("scope" = 'platform' AND "organization_id" IS NULL AND "owner_user_id" IS NULL AND "template_key" IS NOT NULL)
    OR ("scope" = 'org' AND "organization_id" IS NOT NULL AND "owner_user_id" IS NULL AND "template_key" IS NULL
        AND cardinality("required_phrases") = 0)
    OR ("scope" = 'personal' AND "organization_id" IS NOT NULL AND "owner_user_id" IS NOT NULL AND "template_key" IS NULL
        AND cardinality("required_phrases") = 0)
  ),
  CONSTRAINT "message_template_category_valid" CHECK (
    "category" IN ('scheduling', 'administrative', 'logistics', 'confirmation', 'general')
  ),
  CONSTRAINT "message_template_title_length" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
  CONSTRAINT "message_template_body_length" CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000)
);--> statement-breakpoint

CREATE UNIQUE INDEX "message_template_platform_key_uk" ON "message_template" ("template_key") WHERE "scope" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_org_title_uk" ON "message_template" ("organization_id", lower("title")) WHERE "scope" = 'org';--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_personal_title_uk"
  ON "message_template" ("organization_id", "owner_user_id", lower("title")) WHERE "scope" = 'personal';--> statement-breakpoint
CREATE INDEX "message_template_org_scope_idx" ON "message_template" ("organization_id", "scope");--> statement-breakpoint
CREATE INDEX "message_template_owner_idx" ON "message_template" ("owner_user_id") WHERE "owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_template_created_by_idx" ON "message_template" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "tenant_message_template_overlay" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "target_scope" text DEFAULT 'platform' NOT NULL,
  "template_id" uuid NOT NULL,
  "title" text,
  "body" text,
  "is_enabled" boolean DEFAULT true NOT NULL,
  "configured_by_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_message_template_overlay_target_platform" CHECK ("target_scope" = 'platform'),
  CONSTRAINT "tenant_message_template_overlay_template_fk"
    FOREIGN KEY ("target_scope", "template_id") REFERENCES "message_template"("scope", "id") ON DELETE CASCADE,
  CONSTRAINT "tenant_message_template_overlay_title_length"
    CHECK ("title" IS NULL OR char_length(btrim("title")) BETWEEN 1 AND 120),
  CONSTRAINT "tenant_message_template_overlay_body_length"
    CHECK ("body" IS NULL OR char_length(btrim("body")) BETWEEN 1 AND 2000),
  CONSTRAINT "tenant_message_template_overlay_org_template_unique" UNIQUE ("organization_id", "template_id")
);--> statement-breakpoint
CREATE INDEX "tenant_message_template_overlay_template_idx" ON "tenant_message_template_overlay" ("target_scope", "template_id");--> statement-breakpoint
CREATE INDEX "tenant_message_template_overlay_configured_by_idx" ON "tenant_message_template_overlay" ("configured_by_user_id");--> statement-breakpoint

-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "message_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_template" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_template_read" ON "message_template"
  FOR SELECT TO wardenx_app
  USING ("scope" = 'platform' OR "organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_template_insert" ON "message_template"
  FOR INSERT TO wardenx_app
  WITH CHECK ("scope" IN ('org', 'personal') AND "organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_template_update" ON "message_template"
  FOR UPDATE TO wardenx_app
  USING ("scope" IN ('org', 'personal') AND "organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("scope" IN ('org', 'personal') AND "organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_template_delete" ON "message_template"
  FOR DELETE TO wardenx_app
  USING ("scope" IN ('org', 'personal') AND "organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "message_template" TO wardenx_app;--> statement-breakpoint

ALTER TABLE "tenant_message_template_overlay" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_message_template_overlay" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_message_template_overlay_org_isolation" ON "tenant_message_template_overlay"
  FOR ALL TO wardenx_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_message_template_overlay" TO wardenx_app;--> statement-breakpoint

-- ── write audit (body scrubbed) ──────────────────────────────────────────────────────────────────────────────
-- A platform row has no organization_id and is changed only by a reviewed migration, never at runtime: it is not audited
-- (the audit row needs an org). Tenant rows are audited with `body` replaced by the change marker.
CREATE OR REPLACE FUNCTION audit_phi_write_message_template() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  IF COALESCE(NEW.organization_id, OLD.organization_id) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['body']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['body']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'message_template.' || lower(TG_OP), 'message_template',
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
ALTER FUNCTION audit_phi_write_message_template() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_template"
  AFTER INSERT OR UPDATE OR DELETE ON message_template
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_template();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_tenant_message_template_overlay() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['body']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['body']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'tenant_message_template_overlay.' || lower(TG_OP), 'tenant_message_template_overlay',
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
ALTER FUNCTION audit_phi_write_tenant_message_template_overlay() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_message_template_overlay"
  AFTER INSERT OR UPDATE OR DELETE ON tenant_message_template_overlay
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_message_template_overlay();--> statement-breakpoint

-- ── tenant erase (the destruction role deletes this tenant's rows only; platform rows have no org and never match) ──
GRANT SELECT, DELETE ON "message_template" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "message_template_destruction" ON "message_template"
  FOR ALL TO wardenx_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, DELETE ON "tenant_message_template_overlay" TO wardenx_destruction;--> statement-breakpoint
CREATE POLICY "tenant_message_template_overlay_destruction" ON "tenant_message_template_overlay"
  FOR ALL TO wardenx_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- ── permission: who may author shared templates and overlay platform ones (1060/1067's pattern) ──────────────────
-- Granted to the two full-catalog admin roles only. Personal saved replies need no new key: any sender (messaging.send).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.template.manage', 'template', 'manage', 'admin', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.template.manage'
  FROM "role" r
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

-- ── platform seed (mirrors packages/messaging/src/templates/template-seed.ts; a unit test compares them) ──────
INSERT INTO "message_template" ("id", "scope", "template_key", "category", "title", "body", "required_phrases") VALUES
  ('7d1c6e00-3600-4a00-8000-000000000001', 'platform', 'scheduling.running_late', 'scheduling', 'Running late', 'I am running a little behind and will arrive later than planned. I will update you as soon as I have a new arrival time.', ARRAY[]::text[]),
  ('7d1c6e00-3600-4a00-8000-000000000002', 'platform', 'scheduling.reschedule_request', 'scheduling', 'Request to reschedule', 'Can we move this visit to a different time? Please reply with a time that works for you.', ARRAY[]::text[]),
  ('7d1c6e00-3600-4a00-8000-000000000003', 'platform', 'administrative.documentation_reminder', 'administrative', 'Documentation reminder', 'Friendly reminder: please complete your outstanding documentation by the end of the day.', ARRAY[]::text[]),
  ('7d1c6e00-3600-4a00-8000-000000000004', 'platform', 'logistics.delivery_requested', 'logistics', 'Supply delivery requested', 'The supply delivery has been requested. I will confirm once it is on its way.', ARRAY[]::text[]),
  ('7d1c6e00-3600-4a00-8000-000000000005', 'platform', 'confirmation.received', 'confirmation', 'Message received', 'Thanks, message received. I will follow up shortly.', ARRAY[]::text[]),
  ('7d1c6e00-3600-4a00-8000-000000000006', 'platform', 'general.after_hours_emergency', 'general', 'After hours and emergencies', 'I am away from my messages right now. If this is an emergency, call 911. For urgent needs that are not an emergency, contact the on-call line.', ARRAY['call 911', 'on-call line']);
