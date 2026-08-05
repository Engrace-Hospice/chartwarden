-- WX-PR-008: durable, replay-safe M34 key rotation / cryptographic shred evidence.
ALTER TABLE destruction_certificate
  ADD COLUMN IF NOT EXISTS dek_destroyed_at timestamptz,
  ADD COLUMN IF NOT EXISTS refusal_reason text,
  ADD COLUMN IF NOT EXISTS refused_rows_by_module jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint

ALTER TABLE tenant_key_destruction_log
  ADD COLUMN IF NOT EXISTS destruction_certificate_id uuid;--> statement-breakpoint

-- Preserve pre-live legacy rows under one stable synthetic attempt per key ring when the ring has no
-- completed certificate reference yet.
WITH attempt_by_ring AS (
  SELECT l.tenant_key_ring_id,
         COALESCE(max(k.destruction_certificate_id::text)::uuid, gen_random_uuid()) AS destruction_certificate_id
    FROM tenant_key_destruction_log l
    LEFT JOIN tenant_key_ring k ON k.id = l.tenant_key_ring_id
   WHERE l.destruction_certificate_id IS NULL
   GROUP BY l.tenant_key_ring_id
)
UPDATE tenant_key_destruction_log l
   SET destruction_certificate_id = a.destruction_certificate_id
  FROM attempt_by_ring a
 WHERE l.tenant_key_ring_id = a.tenant_key_ring_id
   AND l.destruction_certificate_id IS NULL;--> statement-breakpoint

ALTER TABLE tenant_key_destruction_log
  ALTER COLUMN destruction_certificate_id SET NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS tenant_key_destruction_log_keyring_phase_idx;--> statement-breakpoint
CREATE UNIQUE INDEX tenant_key_destruction_log_keyring_phase_idx
  ON tenant_key_destruction_log (
    tenant_key_ring_id,
    destruction_certificate_id,
    destruction_phase
  );--> statement-breakpoint

-- The NOLOGIN function owner needs only the rows used by the in-function authorization checks.
GRANT SELECT ON tenant_account, destruction_certificate TO tenant_platform_writer;--> statement-breakpoint

DROP POLICY IF EXISTS tenant_key_ring_platform_writer_update ON tenant_key_ring;--> statement-breakpoint
CREATE POLICY tenant_key_ring_platform_writer_update ON tenant_key_ring
  FOR UPDATE TO tenant_platform_writer USING (true) WITH CHECK (true);--> statement-breakpoint

DROP POLICY IF EXISTS destruction_certificate_platform_writer_select ON destruction_certificate;--> statement-breakpoint
CREATE POLICY destruction_certificate_platform_writer_select ON destruction_certificate
  FOR SELECT TO tenant_platform_writer USING (true);--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_destroy_tenant_key_ring(
  p_tenant_account_id uuid,
  p_destruction_certificate_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_key_ring_id uuid;
  v_organization_id uuid;
  v_destroyed_at timestamptz;
  v_existing_certificate_id uuid;
  v_destroyed_by uuid;
  v_certificate_status destruction_status;
  v_certificate_org_id uuid;
  v_account_status tenant_account_status;
BEGIN
  v_destroyed_by := NULLIF(current_setting('app.destroyed_by_membership_id', true), '')::uuid;
  IF v_destroyed_by IS NULL THEN
    RAISE EXCEPTION 'm34_destroy_tenant_key_ring: missing app.destroyed_by_membership_id'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id, organization_id, destroyed_at, destruction_certificate_id
    INTO v_key_ring_id, v_organization_id, v_destroyed_at, v_existing_certificate_id
    FROM tenant_key_ring
   WHERE tenant_account_id = p_tenant_account_id
   FOR UPDATE;

  IF v_key_ring_id IS NULL THEN
    RAISE EXCEPTION 'm34_destroy_tenant_key_ring: key ring for tenant account % not found', p_tenant_account_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Replay after the irreversible commit is a no-op only for the same certificate.
  IF v_destroyed_at IS NOT NULL THEN
    IF v_existing_certificate_id IS DISTINCT FROM p_destruction_certificate_id THEN
      RAISE EXCEPTION 'm34_destroy_tenant_key_ring: destroyed key ring belongs to another certificate'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN v_key_ring_id;
  END IF;

  SELECT status, organization_id
    INTO v_certificate_status, v_certificate_org_id
    FROM destruction_certificate
   WHERE id = p_destruction_certificate_id;
  IF v_certificate_status IS DISTINCT FROM 'approved'::destruction_status
     OR v_certificate_org_id IS DISTINCT FROM v_organization_id THEN
    RAISE EXCEPTION 'm34_destroy_tenant_key_ring: certificate is not approved for this organization'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status INTO v_account_status
    FROM tenant_account
   WHERE id = p_tenant_account_id AND organization_id = v_organization_id;
  IF v_account_status IS DISTINCT FROM 'destruction_pending'::tenant_account_status THEN
    RAISE EXCEPTION 'm34_destroy_tenant_key_ring: tenant is not destruction_pending'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE tenant_key_ring SET
    current_dek_kek_wrapped_ciphertext = NULL,
    current_dek_kek_id = NULL,
    prior_dek_versions = '[]'::jsonb,
    destroyed_at = now(),
    destroyed_by_membership_id = v_destroyed_by,
    destruction_certificate_id = p_destruction_certificate_id
  WHERE id = v_key_ring_id;

  -- The worker owns the one-per-phase forensic row. Keeping the function mutation-only makes a
  -- crash between this call and the marker safe: the transaction rolls back, or replay no-ops.
  RETURN v_key_ring_id;
END $$;--> statement-breakpoint

ALTER FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) OWNER TO tenant_platform_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) FROM wardenx_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) TO wardenx_admin;--> statement-breakpoint

-- Provisioning also runs only on the separately pooled platform credential; request-role execution
-- would bypass the command/step-up/capability ceremony.
REVOKE EXECUTE ON FUNCTION m34_provision_tenant_key_ring(uuid) FROM wardenx_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m34_provision_tenant_key_ring(uuid) TO wardenx_admin;
