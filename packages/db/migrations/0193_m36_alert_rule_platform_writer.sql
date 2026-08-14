-- GAP-096 — a platform-scoped (organization_id IS NULL) write path for `alert_rule`, so the boot
-- population of PLATFORM_DEFAULT_ALERT_RULES (packages/messaging/src/seed/alert-rules.ts — its own doc
-- comment already calls this "the boot slice UPSERT", never wired) can actually succeed under real RLS
-- as `wardenx_app`, the role every request/worker connection runs as in production.
--
-- `alert_rule_write`'s own WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)
-- can never admit a NULL organization_id — by design, so no tenant session can write a platform-default
-- row (migration 0017). Mirrors 0187's `audit_writer_insert_platform_event` / 0189's
-- `cap_platform_loader_publish_constant` pattern exactly (ADR-0010 D2/D3: never a second RLS policy
-- branch on a role that is ALSO tenant-writable; instead a SECURITY DEFINER function owned by a
-- DIFFERENT role that legitimately may write null-org rows, EXECUTE granted to wardenx_app).
-- `organization_id` is hardcoded NULL inside the function body — never a caller-supplied parameter — so
-- there is no way to widen scope through an argument.

-- wardenx_admin already exists (migration 0001) and already holds this exact "_admin_all" shape on
-- other platform tables (migration 0159) — reused rather than inventing a new role. RLS policies alone
-- are not sufficient: SECURITY DEFINER changes which role's ROW-level policies apply, but the function
-- owner still needs the underlying table-level GRANT too (confirmed live: "permission denied for table
-- alert_rule" with the policy in place but no GRANT) — `GRANT ALL ON SCHEMA public TO wardenx_admin`
-- (migration 0001) is a schema-level USAGE/CREATE grant, it does not cascade to table privileges.
CREATE POLICY alert_rule_admin_all ON alert_rule FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON alert_rule TO wardenx_admin;--> statement-breakpoint

-- The platform-default seed's own §7.4/§3.10 invariant (packages/messaging/src/seed/alert-rules.ts
-- `validateAlertRuleSeed`) guarantees at most one row per event_type among organization_id IS NULL
-- rows — this partial unique index makes that guarantee real at the DB, and is the ON CONFLICT target
-- the upsert function below needs (the table's existing `alert_rule_unique` index on (organization_id,
-- event_type, severity_floor) does NOT dedupe multiple NULL-org rows — SQL treats each NULL as
-- distinct for uniqueness purposes).
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rule_platform_default_event_type_uq"
  ON "alert_rule" ("event_type") WHERE "organization_id" IS NULL;--> statement-breakpoint

-- p_channels_override is a JSON array of channel strings (or JSON null), not a native text[] param:
-- drizzle's `sql` template interpolates a bound JS array as a comma-joined placeholder LIST (the
-- `IN (...)`-clause shape), not a single array value, so a plain ARRAY/text[] bind from application
-- code silently mis-binds ("cannot cast type record to text[]", caught live). jsonb round-trips
-- correctly (proven elsewhere in this codebase, e.g. audit_writer_insert_platform_event's context
-- param), so every array-shaped parameter in this migration's functions uses it instead.
CREATE OR REPLACE FUNCTION alert_rule_platform_upsert(
  p_event_type text,
  p_category alert_category,
  p_severity_floor alert_severity,
  p_recipient_resolver alert_recipient_resolver,
  p_resolver_args jsonb,
  p_channels_override jsonb,
  p_system_locked boolean,
  p_enabled boolean
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO alert_rule
    (organization_id, event_type, category, severity_floor, recipient_resolver, resolver_args,
     channels_override, system_locked, enabled)
  VALUES
    (NULL, p_event_type, p_category, p_severity_floor, p_recipient_resolver, p_resolver_args,
     CASE WHEN p_channels_override IS NULL THEN NULL
          ELSE ARRAY(SELECT jsonb_array_elements_text(p_channels_override)) END,
     p_system_locked, p_enabled)
  ON CONFLICT (event_type) WHERE organization_id IS NULL
  DO UPDATE SET
    category = EXCLUDED.category,
    severity_floor = EXCLUDED.severity_floor,
    recipient_resolver = EXCLUDED.recipient_resolver,
    resolver_args = EXCLUDED.resolver_args,
    channels_override = EXCLUDED.channels_override,
    system_locked = EXCLUDED.system_locked,
    enabled = EXCLUDED.enabled,
    updated_at = now();
$$;--> statement-breakpoint
ALTER FUNCTION alert_rule_platform_upsert(text, alert_category, alert_severity, alert_recipient_resolver, jsonb, jsonb, boolean, boolean)
  OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION alert_rule_platform_upsert(text, alert_category, alert_severity, alert_recipient_resolver, jsonb, jsonb, boolean, boolean)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION alert_rule_platform_upsert(text, alert_category, alert_severity, alert_recipient_resolver, jsonb, jsonb, boolean, boolean)
  TO wardenx_app;
