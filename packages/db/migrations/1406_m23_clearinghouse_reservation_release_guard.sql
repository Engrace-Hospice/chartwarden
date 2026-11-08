-- compat: contract
-- M23 tenant clearinghouse (security review of cfd943e82, L2; owner decision "add a DB guard"): only the platform-ops release may
-- release a credential reservation. The app role holds a column-level UPDATE grant on released_at (1404) because the release runs
-- on it, scoped to the target organization; that grant alone would let ANY app-role code path (or a tenant-lane bug) free a
-- reservation and so let another organization seal the credential. This trigger refuses setting released_at unless the
-- transaction-local setting app.clearinghouse_release = 'platform' is present, which only the release path
-- (config-store.ts releaseCredentials, reached from the platform onboarding route) sets, with set_config(..., true).
-- Defence in depth, not a privilege boundary: a session that runs arbitrary SQL as the app role can set the GUC itself.
-- 1404's trigger already makes a released row final, so only the NULL -> non-NULL transition is checked here.
-- Declared `contract`: the previous release's release path does not set the setting, so its release route would be refused.
CREATE OR REPLACE FUNCTION tenant_clearinghouse_credential_reservation_release_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
     AND COALESCE(current_setting('app.clearinghouse_release', true), '') <> 'platform' THEN
    RAISE EXCEPTION 'a clearinghouse credential reservation is released only by the platform release'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_clearinghouse_credential_reservation_release_guard" ON tenant_clearinghouse_credential_reservation;--> statement-breakpoint
CREATE TRIGGER "trg_tenant_clearinghouse_credential_reservation_release_guard" BEFORE UPDATE ON tenant_clearinghouse_credential_reservation
  FOR EACH ROW EXECUTE FUNCTION tenant_clearinghouse_credential_reservation_release_guard();
