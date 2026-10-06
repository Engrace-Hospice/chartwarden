-- M26 §3.3/D3 (FY2027 workstream E) — make `cap_period_platform_constant.first_tenant_use_at` REAL.
--
-- D3 says a published cap constant may be amended only BEFORE the first tenant snapshots it, and both
-- the amend path (0189 `cap_platform_loader_amend_constant`) and the FY2026/FY2027 constant fill (0393)
-- guard on `first_tenant_use_at IS NULL`. But nothing ever SET the column: `openPeriod` snapshots the
-- constant into `cap_period` and never marks it, and `wardenx_app` cannot UPDATE the platform table at all
-- (0089 REVOKE). So the guard was vacuous — every constant looked unused forever.
--
-- Fix, in the 0189 shape: a SECURITY DEFINER function owned by `cap_platform_loader` (the only role with
-- UPDATE on the table), EXECUTE granted to `wardenx_app`, that stamps `first_tenant_use_at` exactly once
-- (`IS NULL` guard — the first use wins, a later call is a no-op). `openPeriod` calls it in the same
-- transaction as the cap_period insert. Then a one-time BACKFILL from cap_period rows that already exist
-- (the earliest `opened_at` per cap year), so a constant some tenant already snapshotted is protected
-- from 0393 and from the amend path. Runs as the migration owner (superuser), so it sees every tenant's
-- cap_period row. Idempotent.

CREATE OR REPLACE FUNCTION cap_platform_loader_mark_constant_in_use(p_cap_year varchar(7))
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE cap_period_platform_constant
  SET first_tenant_use_at = now()
  WHERE cap_period_platform_constant.cap_year = p_cap_year
    AND cap_period_platform_constant.first_tenant_use_at IS NULL;
$$;--> statement-breakpoint
ALTER FUNCTION cap_platform_loader_mark_constant_in_use(varchar) OWNER TO cap_platform_loader;--> statement-breakpoint
REVOKE ALL ON FUNCTION cap_platform_loader_mark_constant_in_use(varchar) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cap_platform_loader_mark_constant_in_use(varchar) TO wardenx_app;--> statement-breakpoint

-- Backfill: a cap year some tenant already opened a period against is in use from that first open.
UPDATE cap_period_platform_constant AS c
SET first_tenant_use_at = u.first_opened_at
FROM (
  SELECT cap_year, min(opened_at) AS first_opened_at
  FROM cap_period
  GROUP BY cap_year
) AS u
WHERE c.cap_year = u.cap_year
  AND c.first_tenant_use_at IS NULL;
