-- M23 §4.1 #42 (GAP-144) — the platform wage-index loader: `POST /admin/billing/wage-indexes/load`.
--
-- `wage_index_factor` is PLATFORM-SHARED reference data (no organization_id): every tenant reads it, and 0078
-- REVOKEs INSERT/UPDATE/DELETE from `wardenx_app` — only the `billing_platform_loader` role writes it. The HTTP
-- route runs as `wardenx_app`, so (in the 0392 `cap_platform_loader_mark_constant_in_use` shape) the write goes
-- through ONE narrow SECURITY DEFINER function owned by the loader role, EXECUTE granted to `wardenx_app`, instead
-- of widening the table grant. The route itself is platform-admin gated (`billing.rule_config.platform_admin` +
-- step-up + Idempotency-Key); the function is only the privilege bridge and validates its own input shape.
--
-- It UPSERTs one CMS CCN + fiscal-year factor and marks it authoritative (the loader is the only authoritative
-- writer; claim assembly never prices from a non-authoritative placeholder). Returns true when a row was INSERTED,
-- false when an existing (ccn, fiscal_year_starting) row was updated.

GRANT USAGE ON SCHEMA public TO billing_platform_loader;--> statement-breakpoint

CREATE OR REPLACE FUNCTION billing_platform_load_wage_index(
  p_ccn text,
  p_fiscal_year_starting integer,
  p_cbsa_code text,
  p_factor_decimal text,
  p_load_source_ref text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inserted boolean;
BEGIN
  IF p_ccn !~ '^[0-9A-Za-z]{6}$' THEN
    RAISE EXCEPTION 'wage index loader: ccn must be the 6-character CMS Certification Number' USING ERRCODE = '22023';
  END IF;
  IF p_fiscal_year_starting IS NULL OR p_fiscal_year_starting < 2000 OR p_fiscal_year_starting > 2100 THEN
    RAISE EXCEPTION 'wage index loader: fiscal_year_starting out of range' USING ERRCODE = '22023';
  END IF;
  IF p_cbsa_code IS NOT NULL AND p_cbsa_code !~ '^[0-9]{5}$' THEN
    RAISE EXCEPTION 'wage index loader: cbsa_code must be a 5-digit CBSA code' USING ERRCODE = '22023';
  END IF;
  IF p_factor_decimal !~ '^[0-9](\.[0-9]{1,4})?$' THEN
    RAISE EXCEPTION 'wage index loader: factor_decimal must be a decimal with at most four places' USING ERRCODE = '22023';
  END IF;
  IF p_load_source_ref IS NULL OR length(btrim(p_load_source_ref)) = 0 THEN
    RAISE EXCEPTION 'wage index loader: load_source_ref is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO wage_index_factor (ccn, fiscal_year_starting, cbsa_code, factor_decimal, load_source_ref, is_authoritative, loaded_at)
  VALUES (p_ccn, p_fiscal_year_starting, p_cbsa_code, p_factor_decimal, p_load_source_ref, true, now())
  ON CONFLICT (ccn, fiscal_year_starting) DO UPDATE
    SET cbsa_code = EXCLUDED.cbsa_code,
        factor_decimal = EXCLUDED.factor_decimal,
        load_source_ref = EXCLUDED.load_source_ref,
        is_authoritative = true,
        loaded_at = now()
  RETURNING (xmax = 0) INTO v_inserted;
  RETURN v_inserted;
END;
$$;--> statement-breakpoint
ALTER FUNCTION billing_platform_load_wage_index(text, integer, text, text, text) OWNER TO billing_platform_loader;--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_platform_load_wage_index(text, integer, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_platform_load_wage_index(text, integer, text, text, text) TO wardenx_app;
