-- M21 Supplies §3.1.11 / §3.5 — RLS + grants on all 11 owned tables, the M4 write-audit trigger
-- (generateAuditTrigger shape) on each, the D8 return-discrepancy computation, and the controlled-substance
-- expiration floor. Tables/enums land in 0103 (unpartitioned + the platform-floor seed), 0104
-- (supply_request) and 0105 (comfort_kit_dispatch).
--
-- 1. RLS (§3.5 / ADR-0010 D2): row visibility keys ONLY on app.org_id, set by withOrgContext(). The
--    patient-bearing tables carry provider_entity_id + location_id for the §4.8 seam rollups, but the RLS
--    pivot stays organization_id ALONE — a second permissive policy would OR, not AND. The layered checks
--    §6 names (the courier's own-delivery scope, the billing clerk's invoice-only projection, the
--    `controlled_substance_dispatcher_eligible` / `comfort_kit_return_reconciler_eligible` predicates) are
--    M3 ABAC at the route, never RLS: RLS is the tenant moat, ABAC is the per-record filter.
--
--    THREE SHAPES, not one:
--      • Seven tables get the canonical org policy (`FOR ALL` on organization_id).
--      • Three tables are floor-plus-overlay — `comfort_kit_template`, `comfort_kit_template_medication`
--        and `vendor_routing_rule`. Their organization_id is NULLABLE on the platform row ONLY, paired with
--        a discriminator (`is_platform_floor` / `scope_kind = 'platform'`) and a CHECK pair in 0103. They get
--        THREE policies — SELECT that also admits the platform row, INSERT and UPDATE that admit only the
--        tenant's own non-locked rows — rather than one `FOR ALL`, so a tenant READS the floor and can never
--        write it. Split by command on purpose: two permissive `FOR ALL` policies on one table would OR
--        together, which is the exact shape ADR-0010 D3 forbids.
--      • `supply_item` is genuinely org-less (D11 platform catalog): dual-grant RLS — read-all TO
--        wardenx_app restricted to active rows, writes only via wardenx_admin (the M22 form_template / M38
--        code_system / M39 consent_type_catalog precedent).
--
--    For `supply_request` and `comfort_kit_dispatch` the policies + grants are declared on the PARTITIONED
--    PARENT only; they propagate to every partition (PG11+, the M25/M30 precedent).
--
--    Grants: wardenx_app gets SELECT/INSERT/UPDATE and DELETE on NOTHING — M21 rows are append plus
--    status-transition, and destruction goes through the admin-run eraseFn (§8.4, landing with the routes
--    task). `comfort_kit_dispatched_content` gets SELECT/INSERT only: it is the DEA 21 CFR §1304 outbound
--    log, and a dispatched line is a historical fact about what physically left the hub — a correction is a
--    new return-reconciliation row, never an edit to what was recorded as sent. Withholding UPDATE makes
--    that a permission error rather than a code-review convention. wardenx_admin keeps ALL everywhere.
--
-- 2. M4 write-audit triggers (§3.1.11). RETENTION CLASS NOTE: `audit_event.retention_class` is M1's
--    `audit_retention_class` enum (operational | compliance | legal_hold | compliance_42cfr_part2), which
--    has NO `clinical` value — so `supply_request`, which `M21_AUDIT_RETENTION_CLASS` in @wardenx/types
--    marks `clinical`, stamps 'compliance' here (the 7-year HIPAA floor). That is not in tension: the
--    @wardenx/types value is the M4 RETENTION/eraser DATA CLASS for the ROWS, registered through M4's
--    retention API at boot and carried by the eraser's `dataClass` (landing with the routes task). Two
--    different axes; both apply. Same resolution as M16-T02.
--
--    Denylists mirror `M21_AUDIT_DENYLIST` in @wardenx/types VERBATIM, so the code-side eraser/export view
--    and the DB-side scrub cannot drift:
--      supply_request                  delivery_instructions / cancellation_reason
--      comfort_kit_dispatch            special_handling_notes
--      comfort_kit_return              disposal_notes / discrepancy_notes / unreturnable_reason
--      par_stock                       reorder_notes
--      comfort_kit_template_medication notes
--      (everything else                structural only — empty denylist)
--
--    THE QUANTITY COLUMNS ARE DELIBERATELY NOT DENYLISTED. `dispatched_quantity`, `quantity_returned`,
--    `quantity_disposed_at_home` and `lot_number` ARE the DEA perpetual log — scrubbing them from the M4
--    snapshot would delete the only record of what changed in a controlled-substance count, which is exactly
--    what a diversion investigation reads. Only the clinician-authored prose is scrubbed (D13).
--
--    `supply_item` audits through M1's baseline `wardenx_audit_trigger()` instead of a generated function,
--    because the generator's body reads NEW.organization_id and this table has none (M22 form_template
--    precedent).
--
-- 3. D8 discrepancy computation — `m21_compute_return_discrepancy()`. The three computed columns on
--    `comfort_kit_returned_content` are not GENERATED columns because the formula reads
--    `dispatched_quantity` from ANOTHER row. It fails CLOSED: if the dispatched line is not visible to the
--    caller, the write RAISES rather than reconciling against a NULL and quietly reporting zero missing.
--
-- 4. The 14-day controlled-substance expiration floor — `m21_enforce_dispatch_expiration_floor()`. §3.1.9
--    writes this as a CHECK against CURRENT_DATE, which PostgreSQL cannot create (CURRENT_DATE is STABLE)
--    and which would in any case start failing on rows that were legal when written. A BEFORE trigger on
--    INSERT and on a real change to expiration_date is the same rule evaluated at the only moment it means
--    anything.
-- 1. RLS policies + grants (§3.5).--> statement-breakpoint
ALTER TABLE "supply_item" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supply_item_read" ON "supply_item";
CREATE POLICY "supply_item_read" ON "supply_item"
  FOR SELECT TO wardenx_app USING (is_active = true);
GRANT SELECT ON "supply_item" TO wardenx_app;
GRANT ALL ON "supply_item" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "tenant_supply_item_extension" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_supply_item_extension_org" ON "tenant_supply_item_extension";
CREATE POLICY "tenant_supply_item_extension_org" ON "tenant_supply_item_extension"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "tenant_supply_item_extension" TO wardenx_app;
GRANT ALL ON "tenant_supply_item_extension" TO wardenx_admin;--> statement-breakpoint
-- Floor-plus-overlay: read the platform floor, write only your own unlocked rows (D3).--> statement-breakpoint
ALTER TABLE "comfort_kit_template" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_template_read" ON "comfort_kit_template";
DROP POLICY IF EXISTS "comfort_kit_template_insert" ON "comfort_kit_template";
DROP POLICY IF EXISTS "comfort_kit_template_update" ON "comfort_kit_template";
CREATE POLICY "comfort_kit_template_read" ON "comfort_kit_template"
  FOR SELECT TO wardenx_app
  USING (is_platform_floor = true OR organization_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY "comfort_kit_template_insert" ON "comfort_kit_template"
  FOR INSERT TO wardenx_app
  WITH CHECK (
    is_platform_floor = false
    AND system_locked = false
    AND organization_id = current_setting('app.org_id', true)::uuid
  );
CREATE POLICY "comfort_kit_template_update" ON "comfort_kit_template"
  FOR UPDATE TO wardenx_app
  USING (
    organization_id = current_setting('app.org_id', true)::uuid
    AND system_locked = false
    AND is_platform_floor = false
  )
  WITH CHECK (
    organization_id = current_setting('app.org_id', true)::uuid
    AND system_locked = false
    AND is_platform_floor = false
  );
GRANT SELECT, INSERT, UPDATE ON "comfort_kit_template" TO wardenx_app;
GRANT ALL ON "comfort_kit_template" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "comfort_kit_template_medication" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_template_medication_read" ON "comfort_kit_template_medication";
DROP POLICY IF EXISTS "comfort_kit_template_medication_insert" ON "comfort_kit_template_medication";
DROP POLICY IF EXISTS "comfort_kit_template_medication_update" ON "comfort_kit_template_medication";
CREATE POLICY "comfort_kit_template_medication_read" ON "comfort_kit_template_medication"
  FOR SELECT TO wardenx_app
  USING (is_platform_floor = true OR organization_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY "comfort_kit_template_medication_insert" ON "comfort_kit_template_medication"
  FOR INSERT TO wardenx_app
  WITH CHECK (
    is_platform_floor = false
    AND system_locked = false
    AND organization_id = current_setting('app.org_id', true)::uuid
  );
CREATE POLICY "comfort_kit_template_medication_update" ON "comfort_kit_template_medication"
  FOR UPDATE TO wardenx_app
  USING (
    organization_id = current_setting('app.org_id', true)::uuid
    AND system_locked = false
    AND is_platform_floor = false
  )
  WITH CHECK (
    organization_id = current_setting('app.org_id', true)::uuid
    AND system_locked = false
    AND is_platform_floor = false
  );
GRANT SELECT, INSERT, UPDATE ON "comfort_kit_template_medication" TO wardenx_app;
GRANT ALL ON "comfort_kit_template_medication" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "vendor_routing_rule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vendor_routing_rule_read" ON "vendor_routing_rule";
DROP POLICY IF EXISTS "vendor_routing_rule_insert" ON "vendor_routing_rule";
DROP POLICY IF EXISTS "vendor_routing_rule_update" ON "vendor_routing_rule";
CREATE POLICY "vendor_routing_rule_read" ON "vendor_routing_rule"
  FOR SELECT TO wardenx_app
  USING (scope_kind = 'platform' OR organization_id = current_setting('app.org_id', true)::uuid);
CREATE POLICY "vendor_routing_rule_insert" ON "vendor_routing_rule"
  FOR INSERT TO wardenx_app
  WITH CHECK (
    scope_kind <> 'platform'
    AND organization_id = current_setting('app.org_id', true)::uuid
  );
CREATE POLICY "vendor_routing_rule_update" ON "vendor_routing_rule"
  FOR UPDATE TO wardenx_app
  USING (
    scope_kind <> 'platform'
    AND organization_id = current_setting('app.org_id', true)::uuid
  )
  WITH CHECK (
    scope_kind <> 'platform'
    AND organization_id = current_setting('app.org_id', true)::uuid
  );
GRANT SELECT, INSERT, UPDATE ON "vendor_routing_rule" TO wardenx_app;
GRANT ALL ON "vendor_routing_rule" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "par_stock" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "par_stock_org" ON "par_stock";
CREATE POLICY "par_stock_org" ON "par_stock"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "par_stock" TO wardenx_app;
GRANT ALL ON "par_stock" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "supply_request" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supply_request_org" ON "supply_request";
CREATE POLICY "supply_request_org" ON "supply_request"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "supply_request" TO wardenx_app;
GRANT ALL ON "supply_request" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "comfort_kit_dispatch" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_dispatch_org" ON "comfort_kit_dispatch";
CREATE POLICY "comfort_kit_dispatch_org" ON "comfort_kit_dispatch"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "comfort_kit_dispatch" TO wardenx_app;
GRANT ALL ON "comfort_kit_dispatch" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "comfort_kit_dispatched_content" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_dispatched_content_org" ON "comfort_kit_dispatched_content";
CREATE POLICY "comfort_kit_dispatched_content_org" ON "comfort_kit_dispatched_content"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT ON "comfort_kit_dispatched_content" TO wardenx_app;
GRANT ALL ON "comfort_kit_dispatched_content" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "comfort_kit_return" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_return_org" ON "comfort_kit_return";
CREATE POLICY "comfort_kit_return_org" ON "comfort_kit_return"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "comfort_kit_return" TO wardenx_app;
GRANT ALL ON "comfort_kit_return" TO wardenx_admin;--> statement-breakpoint
ALTER TABLE "comfort_kit_returned_content" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "comfort_kit_returned_content_org" ON "comfort_kit_returned_content";
CREATE POLICY "comfort_kit_returned_content_org" ON "comfort_kit_returned_content"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "comfort_kit_returned_content" TO wardenx_app;
GRANT ALL ON "comfort_kit_returned_content" TO wardenx_admin;--> statement-breakpoint
-- 2. M4 write-audit triggers (per-table D13 denylist, §3.1.11).--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_tenant_supply_item_ext() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'tenant_supply_item_extension.' || lower(TG_OP),
    'tenant_supply_item_extension',
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
ALTER FUNCTION audit_phi_write_tenant_supply_item_ext() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_tenant_supply_item_ext" AFTER INSERT OR UPDATE OR DELETE ON tenant_supply_item_extension
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_tenant_supply_item_ext();--> statement-breakpoint
-- The floor-plus-overlay tables COALESCE to app.org_id: the platform-floor row's organization_id is NULL by
-- design, and an audit row with no tenant attribution at all would be unattributable in the §164.528
-- accounting.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_comfort_kit_template() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id,
             NULLIF(current_setting('app.org_id', true), '')::uuid),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'comfort_kit_template.' || lower(TG_OP),
    'comfort_kit_template',
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
ALTER FUNCTION audit_phi_write_comfort_kit_template() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_comfort_kit_template" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_template
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_comfort_kit_template();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ckit_template_medication() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['notes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id,
             NULLIF(current_setting('app.org_id', true), '')::uuid),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'comfort_kit_template_medication.' || lower(TG_OP),
    'comfort_kit_template_medication',
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
ALTER FUNCTION audit_phi_write_ckit_template_medication() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ckit_template_medication" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_template_medication
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ckit_template_medication();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_vendor_routing_rule() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id,
             NULLIF(current_setting('app.org_id', true), '')::uuid),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'vendor_routing_rule.' || lower(TG_OP),
    'vendor_routing_rule',
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
ALTER FUNCTION audit_phi_write_vendor_routing_rule() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_vendor_routing_rule" AFTER INSERT OR UPDATE OR DELETE ON vendor_routing_rule
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_vendor_routing_rule();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_par_stock() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['reorder_notes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'par_stock.' || lower(TG_OP),
    'par_stock',
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
ALTER FUNCTION audit_phi_write_par_stock() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_par_stock" AFTER INSERT OR UPDATE OR DELETE ON par_stock
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_par_stock();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_supply_request() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['delivery_instructions','cancellation_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'supply_request.' || lower(TG_OP),
    'supply_request',
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
ALTER FUNCTION audit_phi_write_supply_request() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_supply_request" AFTER INSERT OR UPDATE OR DELETE ON supply_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_supply_request();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_comfort_kit_dispatch() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['special_handling_notes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'comfort_kit_dispatch.' || lower(TG_OP),
    'comfort_kit_dispatch',
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
ALTER FUNCTION audit_phi_write_comfort_kit_dispatch() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_comfort_kit_dispatch" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_dispatch
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_comfort_kit_dispatch();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ckit_dispatched_content() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'comfort_kit_dispatched_content.' || lower(TG_OP),
    'comfort_kit_dispatched_content',
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
ALTER FUNCTION audit_phi_write_ckit_dispatched_content() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ckit_dispatched_content" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_dispatched_content
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ckit_dispatched_content();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_comfort_kit_return() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['disposal_notes','discrepancy_notes','unreturnable_reason']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'comfort_kit_return.' || lower(TG_OP),
    'comfort_kit_return',
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
ALTER FUNCTION audit_phi_write_comfort_kit_return() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_comfort_kit_return" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_return
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_comfort_kit_return();--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_ckit_returned_content() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'comfort_kit_returned_content.' || lower(TG_OP),
    'comfort_kit_returned_content',
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
ALTER FUNCTION audit_phi_write_ckit_returned_content() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_ckit_returned_content" AFTER INSERT OR UPDATE OR DELETE ON comfort_kit_returned_content
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_ckit_returned_content();--> statement-breakpoint
-- supply_item has no organization_id, so its function reads app.org_id (NULL for a platform-loader write
-- outside any tenant context — audit_event.organization_id is nullable) instead of NEW.organization_id.
-- It is a DEDICATED function rather than M1's baseline `wardenx_audit_trigger()` (the M22 form_template
-- route) for one reason: the baseline hardcodes retention_class 'compliance', and this catalog is
-- 'operational' in `M21_AUDIT_RETENTION_CLASS`. A DB that stamps a different class than the published
-- constant is a drift the eraser would inherit, and 'operational' is a legal audit_retention_class value —
-- there is no reason to round it up to the 7-year floor for a HCPCS price list.--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_supply_item() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    NULLIF(current_setting('app.org_id', true), '')::uuid,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'supply_item.' || lower(TG_OP),
    'supply_item',
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
ALTER FUNCTION audit_phi_write_supply_item() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_supply_item" AFTER INSERT OR UPDATE OR DELETE ON supply_item
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_supply_item();--> statement-breakpoint
-- 3. D8 — the single discrepancy formula. Fails CLOSED when the dispatched line is not visible.--> statement-breakpoint
CREATE OR REPLACE FUNCTION m21_compute_return_discrepancy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_dispatched_quantity numeric;
BEGIN
  SELECT dispatched_quantity INTO v_dispatched_quantity
    FROM comfort_kit_dispatched_content
    WHERE id = NEW.dispatched_content_id;

  IF v_dispatched_quantity IS NULL THEN
    RAISE EXCEPTION 'M21_DISPATCHED_LINE_UNRESOLVED: comfort_kit_dispatched_content % is not visible; refusing to reconcile against an unknown dispatched quantity', NEW.dispatched_content_id;
  END IF;

  NEW.quantity_unaccounted := v_dispatched_quantity - NEW.quantity_returned - NEW.quantity_disposed_at_home;
  NEW.discrepancy_pct := CASE
    WHEN v_dispatched_quantity > 0 THEN abs(NEW.quantity_unaccounted) / v_dispatched_quantity
    ELSE 0
  END;
  NEW.discrepancy_flagged := NEW.is_controlled_substance AND NEW.discrepancy_pct >= 0.05;
  NEW.updated_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_m21_compute_return_discrepancy"
BEFORE INSERT OR UPDATE OF quantity_returned, quantity_disposed_at_home
ON comfort_kit_returned_content
FOR EACH ROW EXECUTE FUNCTION m21_compute_return_discrepancy();--> statement-breakpoint
-- 4. The 14-day expiration floor (§3.1.9, as a trigger — see the header).--> statement-breakpoint
CREATE OR REPLACE FUNCTION m21_enforce_dispatch_expiration_floor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.expiration_date IS NOT DISTINCT FROM OLD.expiration_date THEN
    RETURN NEW;
  END IF;
  IF NEW.expiration_date IS NOT NULL AND NEW.expiration_date < (CURRENT_DATE + INTERVAL '14 days') THEN
    RAISE EXCEPTION 'M21_EXPIRATION_FLOOR: dispatched line % expires % — the platform floor is 14 days from dispatch', NEW.id, NEW.expiration_date;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_m21_dispatch_expiration_floor"
BEFORE INSERT OR UPDATE OF expiration_date
ON comfort_kit_dispatched_content
FOR EACH ROW EXECUTE FUNCTION m21_enforce_dispatch_expiration_floor();
