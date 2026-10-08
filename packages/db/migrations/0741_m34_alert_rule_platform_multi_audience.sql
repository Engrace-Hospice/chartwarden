-- 0741 — M34 GAP-057: a platform-default `alert_rule` may hold SEVERAL M34 audience rows for one event.
--
-- 0193 made platform-default rules unique per `event_type` alone (the M36 seed's own invariant: one row per
-- event). M34's §4.8 table is multi-audience by design: an event like `m34.dsar_export.requested` carries up to
-- five rows (compliance officer / platform security owner, per SLA tier), and `m34.tenant.suspension_initiated`
-- carries one per audience. Under the old index the second UPSERT of an event OVERWROTE the first, so only the
-- last-seeded audience ever heard about it (seen live: 21 declared M34 rules, 18 surviving rows, the tenant
-- compliance officer dropped from onboarding_step_blocked). The "distinct severity floor" workaround M34 used
-- cannot work either: there are only three floors and one event has five rows.
--
-- The fix is scoped to the two M34 resolvers and leaves M36's built-in rules exactly as they were:
--   A  one row per event_type for every NON-M34 resolver (the old invariant, unchanged);
--   B  one row per (event_type, resolver, resolver_args) for the two M34 resolvers - the rule's logical identity.
-- `severity_floor` stays a mutable attribute of the rule, so editing a floor updates it in place.
-- The predicates use the enum values 0740 appended, so this is its own migration (a new enum value is not usable
-- until the migration that adds it has committed).
DROP INDEX IF EXISTS "alert_rule_platform_default_event_type_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rule_platform_default_event_type_uq"
  ON "alert_rule" ("event_type")
  WHERE "organization_id" IS NULL
    AND "recipient_resolver" NOT IN ('compliance_officer_for_tenant', 'platform_security_owner');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rule_platform_default_m34_audience_uq"
  ON "alert_rule" ("event_type", "recipient_resolver", "resolver_args")
  WHERE "organization_id" IS NULL
    AND "recipient_resolver" IN ('compliance_officer_for_tenant', 'platform_security_owner');--> statement-breakpoint

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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_channels text[] := CASE WHEN p_channels_override IS NULL THEN NULL
                            ELSE ARRAY(SELECT jsonb_array_elements_text(p_channels_override)) END;
BEGIN
  IF p_recipient_resolver IN ('compliance_officer_for_tenant', 'platform_security_owner') THEN
    INSERT INTO alert_rule
      (organization_id, event_type, category, severity_floor, recipient_resolver, resolver_args,
       channels_override, system_locked, enabled)
    VALUES
      (NULL, p_event_type, p_category, p_severity_floor, p_recipient_resolver, p_resolver_args,
       v_channels, p_system_locked, p_enabled)
    ON CONFLICT (event_type, recipient_resolver, resolver_args)
      WHERE organization_id IS NULL
        AND recipient_resolver IN ('compliance_officer_for_tenant', 'platform_security_owner')
    DO UPDATE SET
      category = EXCLUDED.category,
      severity_floor = EXCLUDED.severity_floor,
      channels_override = EXCLUDED.channels_override,
      system_locked = EXCLUDED.system_locked,
      enabled = EXCLUDED.enabled,
      updated_at = now();
  ELSE
    INSERT INTO alert_rule
      (organization_id, event_type, category, severity_floor, recipient_resolver, resolver_args,
       channels_override, system_locked, enabled)
    VALUES
      (NULL, p_event_type, p_category, p_severity_floor, p_recipient_resolver, p_resolver_args,
       v_channels, p_system_locked, p_enabled)
    ON CONFLICT (event_type)
      WHERE organization_id IS NULL
        AND recipient_resolver NOT IN ('compliance_officer_for_tenant', 'platform_security_owner')
    DO UPDATE SET
      category = EXCLUDED.category,
      severity_floor = EXCLUDED.severity_floor,
      recipient_resolver = EXCLUDED.recipient_resolver,
      resolver_args = EXCLUDED.resolver_args,
      channels_override = EXCLUDED.channels_override,
      system_locked = EXCLUDED.system_locked,
      enabled = EXCLUDED.enabled,
      updated_at = now();
  END IF;
END;
$$;
