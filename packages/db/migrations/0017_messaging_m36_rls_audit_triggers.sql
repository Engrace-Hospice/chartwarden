-- M36 Secure Messaging & Alerts §3.7 (RLS & grants) + §3.8 (channel-visibility ABAC, documented)
-- + §3.9 (write-audit triggers via the M4 generator) — M36-T03.
--
-- Tables, enums, indexes, FKs and CHECKs land in 0016 (drizzle-generated). This migration locks
-- the per-table RLS, the supporting grants, and the per-table write-audit triggers. M36 owns 15
-- tables (manifest-authoritative). Ten carry organization_id and take the canonical M4
-- generateAuditTrigger() output; the five that carry NONE by design — presence, delivery_endpoint
-- (user-owned, cross-tenant; the human not the tenant), message_attachment + notification_delivery
-- (pure children of message/alert; org-isolated through the parent join), alert_payload_catalog
-- (platform-floor §3.12) — take M1's null-safe baseline wardenx_audit_trigger() (0004), the same
-- treatment platform reference tables already receive (`permission`, 0009; the M38 platform tables,
-- 0015). Every M36 table therefore declares BOTH an RLS policy and an audit trigger (the arch:gaps
-- phi-guards floor; the bleed-tolerant org-scope regex flags the children too, and they are covered).
--
-- §3.8 CHANNEL VISIBILITY (ABAC, not just RLS). RLS keeps Org A out of Org B (the org_id floor
-- below). It does NOT decide which channels a user inside Org A may read — a clinical_rn sees only
-- the care-team channels they are on. That intra-org read guard is `assertChannelVisible(ctx,
-- channelId)` enforced at the read API / Socket.IO connect (M36-T07 routes; the bereavement_membership
-- predicate is M3's §4 catalog extension shipped with M36). It is APP-LAYER, not SQL — there is no
-- DDL for it here; this comment records the contract the routes must honor (D5: clients only join
-- rooms they are allowed in). The channel_member row IS the authorization for on_call/discipline/
-- location/dm channels; the RLS below makes that row org-visible, the ABAC guard reads it.

-- 1. M4 write-audit append path (M04-F06 #2) — idempotent re-assertion (already from 0012/0013/0015).
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);--> statement-breakpoint

-- 2. Org-scoped tenant tables — standard app.org_id RLS (§3.7) ---------------------------------
-- channel_member + message_receipt carry organization_id DIRECTLY (M36-F04 / ADR-0010), so they
-- take the same org_id policy as channel/message/alert rather than the spec's pre-ADR-0010 parent
-- subquery — simpler and equally isolating. tenant_alert_routing_override +
-- tenant_notification_template_overlay are tenant config (§3.11/§3.13), org_id NOT NULL.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channel','channel_member','message','message_receipt','alert',
    'tenant_alert_routing_override','tenant_notification_template_overlay'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I_org_isolation ON %I
                     FOR ALL TO wardenx_app
                     USING (organization_id = current_setting('app.org_id', true)::uuid)
                     WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)$p$, t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO wardenx_app', t);
  END LOOP;
END $$;--> statement-breakpoint

-- 3. alert_rule — platform-default rows (organization_id IS NULL) are read-only to every tenant;
-- tenant rows are own-org read/write; system_locked rows cannot be updated or deleted by a tenant
-- (§3.7, §7.4 system_locked). organization_id is NULLABLE here by design (the platform-default seed).
ALTER TABLE "alert_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY alert_rule_read ON alert_rule
  FOR SELECT TO wardenx_app
  USING (organization_id IS NULL OR organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY alert_rule_write ON alert_rule
  FOR INSERT TO wardenx_app
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY alert_rule_update ON alert_rule
  FOR UPDATE TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid AND system_locked = false);--> statement-breakpoint
CREATE POLICY alert_rule_delete ON alert_rule
  FOR DELETE TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid AND system_locked = false);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON alert_rule TO wardenx_app;--> statement-breakpoint

-- 4. notification_template — platform-floor rows (organization_id IS NULL) are read-only to every
-- tenant (the ADR-0024 floor template); tenant overrides are own-org read/write. organization_id
-- is NULLABLE by design.
ALTER TABLE "notification_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY notification_template_read ON notification_template
  FOR SELECT TO wardenx_app
  USING (organization_id IS NULL OR organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY notification_template_write ON notification_template
  FOR INSERT TO wardenx_app
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY notification_template_update ON notification_template
  FOR UPDATE TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY notification_template_delete ON notification_template
  FOR DELETE TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_template TO wardenx_app;--> statement-breakpoint

-- 5. user_notification_preferences — the user's own rows only (a NULL organization_id row is the
-- user's cross-tenant default). Keyed on app.user_id, not app.org_id (§3.7, user-scoped).
ALTER TABLE "user_notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY user_notif_pref_self ON user_notification_preferences
  FOR ALL TO wardenx_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON user_notification_preferences TO wardenx_app;--> statement-breakpoint

-- 6. presence — a user's presence, visible to themself or to a co-worker in the current tenant
-- context (§3.7). User-owned and cross-org; DELETE is an admin/ops path only.
ALTER TABLE "presence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY presence_self_or_coworker ON presence
  FOR SELECT TO wardenx_app
  USING (
    user_id = current_setting('app.user_id', true)::uuid
    OR user_id IN (
      SELECT user_id FROM membership
      WHERE organization_id = current_setting('app.org_id', true)::uuid
        AND status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY presence_self_write ON presence
  FOR INSERT TO wardenx_app
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);--> statement-breakpoint
CREATE POLICY presence_self_update ON presence
  FOR UPDATE TO wardenx_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON presence TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON presence TO wardenx_admin;--> statement-breakpoint

-- 7. delivery_endpoint — only the user themself (§3.7). User-owned, cross-org.
ALTER TABLE "delivery_endpoint" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY delivery_endpoint_self ON delivery_endpoint
  FOR ALL TO wardenx_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_endpoint TO wardenx_app;--> statement-breakpoint

-- 8. message_attachment — pure child of message; org isolation through the parent join (§3.7
-- "RLS applied through the parent-join"). No WITH CHECK clause: PostgreSQL applies the USING
-- expression as the INSERT/UPDATE WITH CHECK automatically (and a literal subquery WITH CHECK
-- would also trip the DDL-legality CHECK-subquery heuristic — USING-only sidesteps both).
ALTER TABLE "message_attachment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY message_attachment_via_message ON message_attachment
  FOR ALL TO wardenx_app
  USING (message_id IN (
    SELECT id FROM message
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON message_attachment TO wardenx_app;--> statement-breakpoint

-- 9. notification_delivery — pure child of alert; org isolation through the parent join.
ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY notification_delivery_via_alert ON notification_delivery
  FOR ALL TO wardenx_app
  USING (alert_id IN (
    SELECT id FROM alert
    WHERE organization_id = current_setting('app.org_id', true)::uuid
  ));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_delivery TO wardenx_app;--> statement-breakpoint

-- 10. alert_payload_catalog — platform-floor registry (§3.12 Foundation Registry): readable by
-- every tenant, written only by the boot/migration admin path. No tenant write.
ALTER TABLE "alert_payload_catalog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY alert_payload_catalog_read ON alert_payload_catalog
  FOR SELECT TO wardenx_app USING (true);--> statement-breakpoint
GRANT SELECT ON alert_payload_catalog TO wardenx_app;--> statement-breakpoint
GRANT ALL ON alert_payload_catalog TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- §3.9 WRITE-AUDIT TRIGGERS
-- (a) The ten organization_id-bearing tables — canonical M4 generateAuditTrigger() output below.
-- ============================================================================================
CREATE OR REPLACE FUNCTION audit_phi_write_channel() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'channel.' || lower(TG_OP),
    'channel',
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
ALTER FUNCTION audit_phi_write_channel() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_channel" AFTER INSERT OR UPDATE OR DELETE ON channel
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_channel();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_channel_member() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'channel_member.' || lower(TG_OP),
    'channel_member',
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
ALTER FUNCTION audit_phi_write_channel_member() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_channel_member" AFTER INSERT OR UPDATE OR DELETE ON channel_member
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_channel_member();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_message() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['body_cipher']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['body_cipher']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'message.' || lower(TG_OP),
    'message',
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
ALTER FUNCTION audit_phi_write_message() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message" AFTER INSERT OR UPDATE OR DELETE ON message
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_message_receipt() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'message_receipt.' || lower(TG_OP),
    'message_receipt',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_receipt() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_receipt" AFTER INSERT OR UPDATE OR DELETE ON message_receipt
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_receipt();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_alert_rule() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'alert_rule.' || lower(TG_OP),
    'alert_rule',
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
ALTER FUNCTION audit_phi_write_alert_rule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_alert_rule" AFTER INSERT OR UPDATE OR DELETE ON alert_rule
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_alert_rule();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_alert() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['payload']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['payload']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'alert.' || lower(TG_OP),
    'alert',
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
ALTER FUNCTION audit_phi_write_alert() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_alert" AFTER INSERT OR UPDATE OR DELETE ON alert
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_alert();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_alert_routing_override() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'tenant_alert_routing_override.' || lower(TG_OP),
    'tenant_alert_routing_override',
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
ALTER FUNCTION audit_phi_write_tenant_alert_routing_override() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_alert_routing_override" AFTER INSERT OR UPDATE OR DELETE ON tenant_alert_routing_override
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_alert_routing_override();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_notification_template() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'notification_template.' || lower(TG_OP),
    'notification_template',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_notification_template() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_notification_template" AFTER INSERT OR UPDATE OR DELETE ON notification_template
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_notification_template();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_notification_template_overlay() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'tenant_notification_template_overlay.' || lower(TG_OP),
    'tenant_notification_template_overlay',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_tenant_notification_template_overlay() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_notification_template_overlay" AFTER INSERT OR UPDATE OR DELETE ON tenant_notification_template_overlay
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_notification_template_overlay();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_user_notification_preferences() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'user_notif_pref.' || lower(TG_OP),
    'user_notif_pref',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_user_notification_preferences() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_user_notification_preferences" AFTER INSERT OR UPDATE OR DELETE ON user_notification_preferences
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_user_notification_preferences();
--> statement-breakpoint
-- ============================================================================================
-- §3.9 WRITE-AUDIT TRIGGERS
-- (b) The five tables that carry NO organization_id — M1 null-safe baseline wardenx_audit_trigger()
--     (0004, hardened in 0015 for non-UUID PKs). Same posture as the M38 platform tables and the
--     `permission` table (0009): a full before/after diff attributed via app.org_id of the writing
--     session. presence + alert_payload_catalog have no `id` column, so resource_id audits as NULL
--     (the 0015 UUID-shape guard). The M4 generator cannot run on these — it keys
--     COALESCE(NEW.organization_id, OLD.organization_id), a column they do not have.
-- ============================================================================================
CREATE TRIGGER "message_attachment_audit" AFTER INSERT OR UPDATE OR DELETE ON message_attachment
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "notification_delivery_audit" AFTER INSERT OR UPDATE OR DELETE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "delivery_endpoint_audit" AFTER INSERT OR UPDATE OR DELETE ON delivery_endpoint
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "presence_audit" AFTER INSERT OR UPDATE OR DELETE ON presence
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "alert_payload_catalog_audit" AFTER INSERT OR UPDATE OR DELETE ON alert_payload_catalog
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
