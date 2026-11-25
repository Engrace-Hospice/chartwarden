-- compat: contract
-- M40 owner seam: expose a merge-resolved facility kind while retaining row locks during M24 assembly.
-- The application receives only this narrow read operation; it does not receive UPDATE on canonical M40 rows.
CREATE OR REPLACE FUNCTION m40_facility_kind_for_ids_locked(p_facility_ids jsonb)
RETURNS TABLE (
  requested_facility_id uuid,
  resolved_facility_id uuid,
  facility_kind facility_kind,
  facility_status mdm_entity_status
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_requested_id uuid;
  v_current_id uuid;
  v_facility public.facility%ROWTYPE;
  v_hop integer;
BEGIN
  IF jsonb_typeof(p_facility_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'M40_FACILITY_KIND_READ_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_facility_ids) > 500 THEN
    RAISE EXCEPTION 'M40_FACILITY_KIND_READ_LIMIT_EXCEEDED' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_facility_ids) AS item(value)
              WHERE jsonb_typeof(item.value) <> 'string' OR item.value #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'M40_FACILITY_KIND_READ_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_requested_id IN
    SELECT DISTINCT value::uuid AS facility_id
      FROM jsonb_array_elements_text(p_facility_ids) AS ids(value)
     ORDER BY facility_id
  LOOP
    v_current_id := v_requested_id;
    FOR v_hop IN 0..5 LOOP
      SELECT f.* INTO v_facility
        FROM public.facility AS f
       WHERE f.id = v_current_id
       FOR SHARE;
      IF NOT FOUND THEN
        EXIT;
      END IF;
      IF v_facility.merged_into_id IS NULL THEN
        requested_facility_id := v_requested_id;
        resolved_facility_id := v_facility.id;
        facility_kind := v_facility.kind;
        facility_status := v_facility.status;
        RETURN NEXT;
        EXIT;
      END IF;
      v_current_id := v_facility.merged_into_id;
    END LOOP;
  END LOOP;
END;
$$;--> statement-breakpoint
ALTER FUNCTION m40_facility_kind_for_ids_locked(jsonb) OWNER TO mdm_canonical_writer;--> statement-breakpoint
REVOKE ALL ON FUNCTION m40_facility_kind_for_ids_locked(jsonb) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION m40_facility_kind_for_ids_locked(jsonb) TO chartwarden_app;--> statement-breakpoint
COMMENT ON FUNCTION m40_facility_kind_for_ids_locked(jsonb) IS
  'M40-owned merge-resolved facility kind read. SECURITY DEFINER uses the canonical writer role only to acquire row-share locks; callers receive no canonical write capability.';
