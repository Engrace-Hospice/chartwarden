-- M34 SaaS Tenant Platform §3.2 — the `tenant_platform_writer` SECURITY DEFINER role (M34-T01).
-- Mirrors M4's `wardenx_audit_writer` / M40's `mdm_canonical_writer` least-privilege writer pattern
-- (D22): ONE new role, NOLOGIN, owning the two SECURITY DEFINER functions that mutate `tenant_key_ring`
-- (DEK lifecycle) and write `tenant_key_destruction_log` on shred. `wardenx_app` is intentionally
-- INSERT-only on those tables and does NOT inherit this role, so a request can never escalate to
-- mutate key material — even buggy code can't. The two functions land in the 0055 migration; the
-- tables + RLS + grants land in 0051/0052.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenant_platform_writer') THEN
    CREATE ROLE tenant_platform_writer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tenant_platform_writer;--> statement-breakpoint
GRANT tenant_platform_writer TO wardenx_admin;--> statement-breakpoint
COMMENT ON ROLE tenant_platform_writer IS
  'Owns the SECURITY DEFINER DEK-lifecycle + shred functions that mutate tenant_key_ring / tenant_key_destruction_log. wardenx_app is INSERT-only and does NOT inherit this role (M34 §3.2/D22).';--> statement-breakpoint
