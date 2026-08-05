-- M34 tenant provisioning: the original SECURITY DEFINER function predated the mandatory
-- tenant_key_ring.organization_id column and therefore could not insert a production key ring.
-- Resolve the org from the tenant_account spine inside the function and grant its NOLOGIN owner only
-- the two RLS operations required by this function.
DROP POLICY IF EXISTS tenant_account_platform_writer_select ON tenant_account;--> statement-breakpoint
CREATE POLICY tenant_account_platform_writer_select ON tenant_account
  FOR SELECT TO tenant_platform_writer USING (true);--> statement-breakpoint

DROP POLICY IF EXISTS tenant_key_ring_platform_writer_insert ON tenant_key_ring;--> statement-breakpoint
CREATE POLICY tenant_key_ring_platform_writer_insert ON tenant_key_ring
  FOR INSERT TO tenant_platform_writer WITH CHECK (true);--> statement-breakpoint

DROP POLICY IF EXISTS tenant_key_ring_platform_writer_select ON tenant_key_ring;--> statement-breakpoint
CREATE POLICY tenant_key_ring_platform_writer_select ON tenant_key_ring
  FOR SELECT TO tenant_platform_writer USING (true);--> statement-breakpoint

GRANT INSERT ON tenant_key_ring TO tenant_platform_writer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m34_provision_tenant_key_ring(p_tenant_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_organization_id uuid;
  v_wrapped_ciphertext bytea;
  v_kek_id text;
  v_key_ring_id uuid;
BEGIN
  SELECT organization_id INTO v_organization_id
    FROM tenant_account
   WHERE id = p_tenant_account_id;
  IF v_organization_id IS NULL THEN
    RAISE EXCEPTION 'm34_provision_tenant_key_ring: tenant account % not found', p_tenant_account_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_wrapped_ciphertext := decode(
    NULLIF(current_setting('app.dek_kek_wrapped_ciphertext_b64', true), ''),
    'base64'
  );
  v_kek_id := NULLIF(current_setting('app.dek_kek_id', true), '');
  IF v_wrapped_ciphertext IS NULL THEN
    RAISE EXCEPTION 'm34_provision_tenant_key_ring: missing wrapped DEK'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF v_kek_id IS NULL THEN
    RAISE EXCEPTION 'm34_provision_tenant_key_ring: missing KEK id'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  INSERT INTO tenant_key_ring (
    organization_id, tenant_account_id, current_dek_version,
    current_dek_kek_wrapped_ciphertext, current_dek_kek_id,
    prior_dek_versions, dek_created_at
  ) VALUES (
    v_organization_id, p_tenant_account_id, 'v1',
    v_wrapped_ciphertext, v_kek_id, '[]'::jsonb, now()
  )
  ON CONFLICT (tenant_account_id) DO NOTHING
  RETURNING id INTO v_key_ring_id;

  IF v_key_ring_id IS NULL THEN
    SELECT id INTO v_key_ring_id
      FROM tenant_key_ring
     WHERE tenant_account_id = p_tenant_account_id;
  END IF;
  RETURN v_key_ring_id;
END $$;--> statement-breakpoint

ALTER FUNCTION m34_provision_tenant_key_ring(uuid) OWNER TO tenant_platform_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION m34_provision_tenant_key_ring(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m34_provision_tenant_key_ring(uuid) TO wardenx_app;--> statement-breakpoint
