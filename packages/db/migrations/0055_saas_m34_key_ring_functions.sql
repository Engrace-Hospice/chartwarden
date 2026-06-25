-- M34 SaaS Tenant Platform §3.2 / §3.5 — the two SECURITY DEFINER DEK-lifecycle functions
-- (M34-T05). These own the *privileged table mutation* for the per-tenant key ring; the actual
-- KMS / envelope-encryption primitive (DEK generation, KEK-wrapping, zeroization of plaintext) is
-- app-layer and owned by M1's `packages/envelope` — M34 wires only the *lifecycle* (creation at
-- provisioning, destruction at cryptographic shred) per §1.1 and the "non-goals" list.
--
-- Privilege boundary (D22, §3.2): both functions are SECURITY DEFINER, owned by `tenant_platform_writer`
-- (created NOLOGIN in 0050), and run with a pinned `search_path`. `wardenx_app` is INSERT-only on
-- `tenant_key_ring` / `tenant_key_destruction_log` per the 0052 grants and does NOT inherit
-- `tenant_platform_writer`, so a request-scoped connection can never UPDATE a key ring to NULL the DEK
-- ciphertext nor write the destruction log directly — the only path to those mutations is EXECUTE on
-- these two functions, which is granted to `wardenx_app` but is callable ONLY through the application
-- job runner (`tenant.provision` / `tenant.shred` workers) that sets the actor context and the wrapped-DEK
-- session GUCs. This mirrors M4's `wardenx_audit_writer` and M40's `mdm_canonical_writer` pattern exactly.

-- m34_provision_tenant_key_ring(tenant_account_id uuid)
--   Inserts the single active `tenant_key_ring` row for a tenant at `provisioning` state entry, before
--   any encrypted-column write may occur for that tenant. The DEK is generated and KEK-wrapped by the
--   M1 envelope helper in the app worker; the worker hands the privileged INSERT to this function and
--   supplies the wrapped material via session GUCs (the same `current_setting('app.*', true)` convention
--   the audit triggers use). The CHECK on `tenant_key_ring` requires an active row to carry ciphertext,
--   so a NULL/blank wrapped-DEK GUC is rejected. Idempotent at the unique index
--   (`tenant_key_ring_tenant_unique`): a second provision for the same tenant raises.
CREATE OR REPLACE FUNCTION m34_provision_tenant_key_ring(p_tenant_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_wrapped_ciphertext bytea;
  v_kek_id text;
  v_key_ring_id uuid;
BEGIN
  -- Wrapped DEK material is produced app-side by the M1 envelope helper and passed via session GUCs;
  -- this function never touches plaintext key material, only the already-KEK-wrapped ciphertext.
  v_wrapped_ciphertext := decode(NULLIF(current_setting('app.dek_kek_wrapped_ciphertext_b64', true), ''), 'base64');
  v_kek_id := NULLIF(current_setting('app.dek_kek_id', true), '');

  IF v_wrapped_ciphertext IS NULL THEN
    RAISE EXCEPTION 'm34_provision_tenant_key_ring: missing app.dek_kek_wrapped_ciphertext_b64 (wrapped DEK is app-supplied)'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF v_kek_id IS NULL THEN
    RAISE EXCEPTION 'm34_provision_tenant_key_ring: missing app.dek_kek_id'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  INSERT INTO tenant_key_ring (
    tenant_account_id,
    current_dek_version,
    current_dek_kek_wrapped_ciphertext,
    current_dek_kek_id,
    prior_dek_versions,
    dek_created_at
  ) VALUES (
    p_tenant_account_id,
    'v1',
    v_wrapped_ciphertext,
    v_kek_id,
    '[]'::jsonb,
    now()
  )
  RETURNING id INTO v_key_ring_id;

  RETURN v_key_ring_id;
END $$;--> statement-breakpoint
ALTER FUNCTION m34_provision_tenant_key_ring(uuid) OWNER TO tenant_platform_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_provision_tenant_key_ring(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m34_provision_tenant_key_ring(uuid) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION m34_provision_tenant_key_ring(uuid) IS
  'SECURITY DEFINER (owner tenant_platform_writer): privileged INSERT of the active tenant_key_ring row at provisioning. Wrapped DEK is app-supplied via app.dek_* GUCs; callable by wardenx_app ONLY through the tenant.provision job runner (M34 §3.5/D5).';--> statement-breakpoint

-- m34_destroy_tenant_key_ring(tenant_account_id uuid, destruction_certificate_id uuid)
--   The irreversible cryptographic-shred mutation (Phase 3 of `services/shred-worker.ts`). Reached ONLY
--   after every M4-registered eraseFn returned a non-refusal outcome (the part-two-retention abort check
--   happens app-side BEFORE this call per §3.5 / M34-F08 / ADR-0014). This function is the ONLY code that
--   may set `current_dek_kek_wrapped_ciphertext = NULL` and clear `prior_dek_versions` — it zeroes the
--   wrapped DEK, stamps `destroyed_at` (the CHECK enforces ciphertext-NULL iff destroyed), records the
--   actor membership + destruction-cert back-reference, and writes the `deks_zeroized` destruction-log row.
CREATE OR REPLACE FUNCTION m34_destroy_tenant_key_ring(p_tenant_account_id uuid, p_destruction_certificate_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_key_ring_id uuid;
  v_destroyed_by uuid;
  v_now timestamptz := now();
BEGIN
  -- Actor membership for the destruction record is supplied by the shred worker via a dedicated GUC
  -- (the canonical RLS GUCs carry app.user_id, not a membership id); NULL when the worker omits it.
  v_destroyed_by := NULLIF(current_setting('app.destroyed_by_membership_id', true), '')::uuid;

  -- Zero the wrapped DEK (cryptographic shred) and mark the ring destroyed. The CHECK constraint
  -- (destroyed_at IS NOT NULL) = (current_dek_kek_wrapped_ciphertext IS NULL) keeps these consistent.
  UPDATE tenant_key_ring SET
    current_dek_kek_wrapped_ciphertext = NULL,
    current_dek_kek_id = NULL,
    prior_dek_versions = '[]'::jsonb,
    destroyed_at = v_now,
    destroyed_by_membership_id = v_destroyed_by,
    destruction_certificate_id = p_destruction_certificate_id
  WHERE tenant_account_id = p_tenant_account_id
    AND destroyed_at IS NULL
  RETURNING id INTO v_key_ring_id;

  IF v_key_ring_id IS NULL THEN
    RAISE EXCEPTION 'm34_destroy_tenant_key_ring: no active key ring for tenant_account % (already destroyed or never provisioned)', p_tenant_account_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Forensic destruction-log row linking the shred to the M4 destruction certificate. The org_id back-
  -- reference is FK-join-scoped via tenant_key_ring this phase (M34-F02 / ADR-0010 adds the column later).
  INSERT INTO tenant_key_destruction_log (
    tenant_key_ring_id,
    destruction_phase,
    occurred_at,
    per_module_eraser_receipts
  ) VALUES (
    v_key_ring_id,
    'deks_zeroized',
    v_now,
    jsonb_build_object('destruction_certificate_id', p_destruction_certificate_id)
  );

  RETURN v_key_ring_id;
END $$;--> statement-breakpoint
ALTER FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) OWNER TO tenant_platform_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) TO wardenx_app;--> statement-breakpoint
COMMENT ON FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) IS
  'SECURITY DEFINER (owner tenant_platform_writer): the irreversible DEK shred. Only code that may NULL current_dek_kek_wrapped_ciphertext and clear prior_dek_versions; writes the deks_zeroized destruction-log row linked to the M4 destruction certificate. Callable by wardenx_app ONLY through the tenant.shred job runner, after the part-two-retention abort check (M34 §3.5/D6/ADR-0014).';--> statement-breakpoint
