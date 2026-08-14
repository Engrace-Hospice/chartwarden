-- M38 §4.1/§4.2 admin surface + §3.7 (GAP-063) — the write door the `terminology_loader` role was
-- created to own, and the cross-tenant governance read the extension board needs.
--
-- WHAT WAS MISSING. Migration 0015 created `terminology_loader NOLOGIN`, granted it
-- `SELECT, INSERT, UPDATE` on all twelve platform reference tables, and said in prose that the grant
-- belongs to "the SECURITY DEFINER load functions in packages/terminology only". Those functions were
-- never written, so there has been no mechanism of any kind to register a new ICD-10-CM / SNOMED /
-- LOINC / RxNorm version — content arrives ONLY through the static seed corpus
-- (`packages/terminology/src/seed/`). That is the substance of GAP-063's admin half.
--
-- AND THE GRANT ITSELF IS DEAD. 0015 enabled RLS on those twelve tables and created exactly ONE policy
-- per table: `<t>_read FOR SELECT TO wardenx_app USING (true)`. No policy names `terminology_loader`.
-- RLS-enabled with no permissive policy for a role is default-deny for that role, so every
-- `terminology_loader` write matches zero rows — and since 0159's catalog sweep FORCE'd RLS on every
-- table that had it enabled, not even table ownership exempts it any more. This is the same
-- GRANT-is-not-a-POLICY shape as GAP-099's `mdm_canonical_writer` finding: had the load functions been
-- written back at M38-T03 they would have appeared to work and written nothing.
--
-- SCOPED TO THE TWO TABLES THE FUNCTIONS BELOW ACTUALLY WRITE (`code_system_version`,
-- `terminology_update_log`). The other ten (`code_system`, the four concept tables, `value_set`,
-- `value_set_member`, `value_set_expansion`, `deprecation_mapping`, `concept_embedding`) carry the
-- identical grant-without-policy gap, and no function owns them yet — a policy there would be exactly
-- as inert as the grant is today. Whoever writes the concept-ingestion half (the fetch/stage/diff in
-- `packages/terminology-loader`, which does not exist) needs those ten lines in the same diff. Same
-- deliberate stance 0202 took toward `facility`/`payer`.
--
-- WHAT THIS DOES *NOT* CLAIM. Registering a version is not ingesting one. These functions record that a
-- version exists and what was asked for; the row lands `status = 'loading'` and NOTHING is activated, so
-- as-of resolution is untouched until a real loader flips it. That is precisely the spec's own §4.2
-- contract for the route (`200 -> { versionId, status: 'loading' }`) — the enqueue side is honest, the
-- worker behind it is still absent and the route says so.

-- ── (0a) the missing schema USAGE ──────────────────────────────────────────────────────────────────────
-- Found by this migration's live suite, and it is the more basic of the two 0015 omissions: the role has
-- SELECT/INSERT/UPDATE on twelve tables and no USAGE on the schema those tables live in. A SECURITY
-- DEFINER function runs as its OWNER, so with `SET search_path = pg_catalog, public` and no USAGE on
-- public, unqualified name resolution SKIPS the schema entirely and the body fails with
-- `relation "…" does not exist` — pointing at a table that is plainly there.
--
-- Every other writer role in the repo got this line in the migration that created it (0019
-- mdm_canonical_writer, 0023 consent_catalog_writer, 0050 tenant_platform_writer, 0056 report_writer,
-- 0157 wardenx_destruction, 0199 nppes_sync_writer). 0015 did not — and neither did 0078
-- (`billing_platform_loader`), 0089 (`cap_platform_loader`) or M24's `medicaid_platform_loader`. Those
-- three carry the identical omission and, like the policies below, it is inert until someone writes a
-- function they own — but unlike a missing policy, a missing USAGE fails LOUDLY, so it is a trap rather
-- than a silent data-loss shape. Named here so whoever writes those functions recognises the error.
GRANT USAGE ON SCHEMA public TO terminology_loader;--> statement-breakpoint

-- ── (0b) the missing loader policies ───────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['code_system_version', 'terminology_update_log'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_loader_write ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_loader_write ON %I FOR ALL TO terminology_loader USING (true) WITH CHECK (true)',
      t, t);
  END LOOP;
END $$;--> statement-breakpoint
-- `code_system` is READ by the registration function (the catalog check below) and never written by it.
-- Without this the catalog probe returns zero rows for a system that plainly exists and the function
-- refuses every load as `TERMINOLOGY_UNKNOWN_SYSTEM` — the silent-policy trap wearing a different hat:
-- a missing SELECT policy does not error, it just makes the table look empty.
DROP POLICY IF EXISTS "code_system_loader_read" ON "code_system";--> statement-breakpoint
CREATE POLICY "code_system_loader_read" ON "code_system"
  FOR SELECT TO terminology_loader
  USING (true);--> statement-breakpoint
COMMENT ON POLICY "code_system_version_loader_write" ON "code_system_version" IS
  'GAP-063 — the row policy migration 0015 granted privileges for but never created. Without it every terminology_loader write silently matches zero rows.';--> statement-breakpoint
COMMENT ON POLICY "terminology_update_log_loader_write" ON "terminology_update_log" IS
  'GAP-063 — see code_system_version_loader_write. The append-only load ledger is written by the same SECURITY DEFINER functions.';--> statement-breakpoint

-- ── (1) register a source version (§4.2 POST /api/v1/admin/terminology/:system/load) ───────────────────
-- IDEMPOTENT ON (system, version), which the spec states as a route behaviour ("409 VERSION_ALREADY_LOADED
-- … returns existing versionId"). It is enforced HERE rather than by a read-then-write in the route: two
-- concurrent loads of the same release would both find nothing and both insert, and
-- `code_system_version_unique` would turn the loser into a 500. ON CONFLICT DO NOTHING + a follow-up read
-- makes the second caller a clean 409 carrying the first caller's version id.
--
-- `p_checksum` is REQUIRED and has no default. The spec's request body is `{version, sourceFileRef,
-- reauthToken}`, but `code_system_version.checksum` is NOT NULL and exists so a re-load can be proven
-- byte-identical to what was loaded before; defaulting it to '' would put a lie in the provenance column
-- on every row this path writes. The route therefore asks for it (a documented, narrow spec extension).
CREATE OR REPLACE FUNCTION terminology_loader_register_version(
  p_system code_system_id,
  p_version text,
  p_source_file_ref text,
  p_checksum text,
  p_released_on date,
  p_effective_from date,
  p_loaded_by uuid
) RETURNS TABLE(version_id uuid, created boolean, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
  v_created boolean := false;
  v_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM code_system WHERE id = p_system) THEN
    RAISE EXCEPTION 'TERMINOLOGY_UNKNOWN_SYSTEM: % is not in the code_system catalog', p_system
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO code_system_version (
    code_system_id, version, released_on, effective_from, effective_to,
    source_file_ref, checksum, status, loaded_by
  ) VALUES (
    p_system, p_version, p_released_on, p_effective_from, NULL,
    p_source_file_ref, p_checksum, 'loading', p_loaded_by
  )
  ON CONFLICT (code_system_id, version) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    v_created := true;
    v_status := 'loading';
    -- The append-only ledger entry (§3.6). Counts stay 0: nothing has been ingested, and a non-zero
    -- concept_count here would misreport an empty version as loaded content.
    INSERT INTO terminology_update_log (system_id, version_id, action, summary)
    VALUES (
      p_system, v_id, 'loaded',
      jsonb_build_object(
        'phase', 'registered',
        'version', p_version,
        'source_file_ref', p_source_file_ref,
        'note', 'version registered; concept ingestion is performed by the loader worker'
      )
    );
  ELSE
    -- Alias the table: `status` is ALSO an OUT column of this function's RETURNS TABLE, and an
    -- unqualified reference is ambiguous between the two (42702).
    SELECT v.id, v.status::text INTO v_id, v_status
    FROM code_system_version v
    WHERE v.code_system_id = p_system AND v.version = p_version;
  END IF;

  RETURN QUERY SELECT v_id, v_created, v_status;
END;
$$;--> statement-breakpoint
ALTER FUNCTION terminology_loader_register_version(code_system_id, text, text, text, date, date, uuid)
  OWNER TO terminology_loader;--> statement-breakpoint
REVOKE ALL ON FUNCTION terminology_loader_register_version(code_system_id, text, text, text, date, date, uuid)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION terminology_loader_register_version(code_system_id, text, text, text, date, date, uuid)
  TO wardenx_app;--> statement-breakpoint

-- ── (2) request an embeddings refresh (§4.2 POST …/:system/refresh-embeddings) ─────────────────────────
-- "recompute embeddings for a system AT ITS CURRENT VERSION" — so the target is resolved server-side from
-- the active version, never supplied by the caller. No active version ⇒ no row and `logged = false`: the
-- route turns that into a 409 rather than logging a refresh of nothing.
--
-- Like (1) this records the REQUEST. `concept_embedding` is untouched: the embeddings worker
-- (architecture §12) is not built, and writing an `embedded` ledger row while no vector changed would be
-- the exact "wired-but-fake" shape this batch exists to remove — so the ledger says `requested`.
CREATE OR REPLACE FUNCTION terminology_loader_request_embedding_refresh(
  p_system code_system_id,
  p_requested_by uuid
) RETURNS TABLE(version_id uuid, logged boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
  FROM code_system_version
  WHERE code_system_id = p_system AND status = 'active' AND effective_to IS NULL
  ORDER BY effective_from DESC
  LIMIT 1;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, false;
    RETURN;
  END IF;

  INSERT INTO terminology_update_log (system_id, version_id, action, summary)
  VALUES (
    p_system, v_id, 'embedded',
    jsonb_build_object(
      'phase', 'requested',
      'requested_by', p_requested_by,
      'note', 'embedding refresh requested; the embeddings worker performs the recompute'
    )
  );
  RETURN QUERY SELECT v_id, true;
END;
$$;--> statement-breakpoint
ALTER FUNCTION terminology_loader_request_embedding_refresh(code_system_id, uuid)
  OWNER TO terminology_loader;--> statement-breakpoint
REVOKE ALL ON FUNCTION terminology_loader_request_embedding_refresh(code_system_id, uuid)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION terminology_loader_request_embedding_refresh(code_system_id, uuid)
  TO wardenx_app;--> statement-breakpoint

-- ── (3) the cross-tenant extension governance read (§4.2 GET /api/v1/admin/terminology/value-set-extensions)
-- `value_set_tenant_extension` is M38's ONE org-scoped table, under `app.org_id` RLS. A platform-ops
-- governance view is by definition cross-tenant, so it cannot be a SELECT on the tenant pool — the policy
-- would scope it to the operator's own org and the page would silently show one tenant's rows while
-- claiming to show every tenant's.
--
-- A FUNCTION, NOT A GRANT (the GAP-060 `merge_request` precedent): `wardenx_app` keeps its org-scoped
-- policy untouched, and the only cross-tenant path is this definer function, whose whole surface is a
-- read with no org parameter to widen. The route gates it on `terminology.admin.read` + the
-- `terminology_admin_platform_ops` predicate; the live suite asserts a direct cross-tenant SELECT on the
-- table still returns nothing.
GRANT SELECT ON value_set_tenant_extension TO terminology_loader;--> statement-breakpoint
DROP POLICY IF EXISTS "value_set_tenant_extension_governance_read" ON "value_set_tenant_extension";--> statement-breakpoint
CREATE POLICY "value_set_tenant_extension_governance_read" ON "value_set_tenant_extension"
  FOR SELECT TO terminology_loader
  USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION terminology_admin_list_value_set_extensions(
  p_value_set text,
  p_organization_id uuid,
  p_include_removed boolean,
  p_limit integer,
  p_after_created_at timestamptz,
  p_after_id uuid
) RETURNS TABLE(
  extension_id uuid,
  value_set_id text,
  organization_id uuid,
  system_id text,
  code text,
  reason text,
  added_by uuid,
  removed_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT x.id, x.value_set_id, x.organization_id, x.system_id::text, x.code, x.reason,
         x.added_by, x.removed_at, x.created_at
  FROM value_set_tenant_extension x
  WHERE (p_value_set IS NULL OR x.value_set_id = p_value_set)
    AND (p_organization_id IS NULL OR x.organization_id = p_organization_id)
    AND (p_include_removed OR x.removed_at IS NULL)
    -- Keyset pagination on the same (created_at, id) tuple the ORDER BY uses, so a page boundary cannot
    -- skip or repeat a row when two extensions share a created_at.
    AND (
      p_after_created_at IS NULL
      OR (x.created_at, x.id) < (p_after_created_at, COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT GREATEST(LEAST(COALESCE(p_limit, 100), 500), 1);
$$;--> statement-breakpoint
ALTER FUNCTION terminology_admin_list_value_set_extensions(text, uuid, boolean, integer, timestamptz, uuid)
  OWNER TO terminology_loader;--> statement-breakpoint
REVOKE ALL ON FUNCTION terminology_admin_list_value_set_extensions(text, uuid, boolean, integer, timestamptz, uuid)
  FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION terminology_admin_list_value_set_extensions(text, uuid, boolean, integer, timestamptz, uuid)
  TO wardenx_app;--> statement-breakpoint

COMMENT ON FUNCTION terminology_loader_register_version(code_system_id, text, text, text, date, date, uuid) IS
  'M38 §4.2 (GAP-063) — idempotent (system, version) registration of a source version. Lands status=loading and NEVER activates: concept ingestion belongs to the loader worker.';--> statement-breakpoint
COMMENT ON FUNCTION terminology_loader_request_embedding_refresh(code_system_id, uuid) IS
  'M38 §4.2 (GAP-063) — records an embeddings-refresh request against the system''s ACTIVE version (resolved server-side). Writes no vectors.';--> statement-breakpoint
COMMENT ON FUNCTION terminology_admin_list_value_set_extensions(text, uuid, boolean, integer, timestamptz, uuid) IS
  'M38 §4.2 (GAP-063) — cross-tenant platform-ops governance view of value_set_tenant_extension. A definer function, not a wardenx_app grant: the tenant pool keeps its org-scoped policy.';
