-- M26 §3.5/D3 (found while seeding scenario data) — `cap_period_platform_constant` has NEVER been
-- writable by any live caller. Migration 0089 REVOKEs INSERT/UPDATE/DELETE from `wardenx_app` and
-- grants them only to a dedicated `cap_platform_loader` role, with its own comment promising "Granted
-- to the SECURITY DEFINER platform constant manager in the backend only" — but no such function was
-- ever created, and `write-service-drizzle.ts`'s `publishConstant`/`amendConstant` run a PLAIN Drizzle
-- insert/update as `wardenx_app` (its own comment claims "locally the BYPASSRLS dev role suffices",
-- which is wrong: BYPASSRLS bypasses ROW-level security policies, not the separate GRANT-level REVOKE
-- this migration issued). `POST /platform/cap/constants` and its amend sibling have therefore been
-- unconditionally `permission denied for table cap_period_platform_constant` in EVERY environment,
-- local or prod, since 0089 landed — confirmed live.
--
-- Fix mirrors the established pattern for this exact class of problem (migration 0186's
-- `report_writer_insert_platform_outbox_event`, migration 0187/0188's siblings for
-- audit_event/report_run/materialized_view_metadata): a SECURITY DEFINER function owned by the
-- dedicated writer role, EXECUTE granted directly to `wardenx_app`, so the write path routes through
-- the role migration 0089 already created and granted table privileges to, instead of `wardenx_app`
-- attempting the write itself.

CREATE OR REPLACE FUNCTION cap_platform_loader_publish_constant(
  p_cap_year varchar(7),
  p_aggregate_cap_amount_cents bigint,
  p_inpatient_cap_pct numeric(5,4),
  p_source_url text,
  p_recorded_by uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO cap_period_platform_constant
    (cap_year, aggregate_cap_amount_cents, inpatient_cap_pct, source_url, recorded_by)
  VALUES (p_cap_year, p_aggregate_cap_amount_cents, p_inpatient_cap_pct, p_source_url, p_recorded_by)
  ON CONFLICT (cap_year) DO NOTHING;
$$;--> statement-breakpoint
ALTER FUNCTION cap_platform_loader_publish_constant(varchar, bigint, numeric, text, uuid) OWNER TO cap_platform_loader;--> statement-breakpoint
REVOKE ALL ON FUNCTION cap_platform_loader_publish_constant(varchar, bigint, numeric, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cap_platform_loader_publish_constant(varchar, bigint, numeric, text, uuid) TO wardenx_app;--> statement-breakpoint

-- D3: amend is allowed ONLY before first tenant use — mirrors the write service's own
-- `first_tenant_use_at IS NULL` guard; RETURNS the updated cap_year, or no rows if the guard failed
-- (the write service's existing `if (!updated[0]) throw ConflictError("CONSTANT_IN_USE")` logic is
-- unchanged, it just now calls this function instead of a direct Drizzle update).
CREATE OR REPLACE FUNCTION cap_platform_loader_amend_constant(
  p_cap_year varchar(7),
  p_aggregate_cap_amount_cents bigint,
  p_source_url text,
  p_recorded_by uuid
) RETURNS TABLE(cap_year varchar(7))
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE cap_period_platform_constant
  SET aggregate_cap_amount_cents = p_aggregate_cap_amount_cents,
      source_url = p_source_url,
      recorded_by = p_recorded_by,
      recorded_at = now()
  WHERE cap_period_platform_constant.cap_year = p_cap_year
    AND cap_period_platform_constant.first_tenant_use_at IS NULL
  RETURNING cap_period_platform_constant.cap_year;
$$;--> statement-breakpoint
ALTER FUNCTION cap_platform_loader_amend_constant(varchar, bigint, text, uuid) OWNER TO cap_platform_loader;--> statement-breakpoint
REVOKE ALL ON FUNCTION cap_platform_loader_amend_constant(varchar, bigint, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cap_platform_loader_amend_constant(varchar, bigint, text, uuid) TO wardenx_app;
