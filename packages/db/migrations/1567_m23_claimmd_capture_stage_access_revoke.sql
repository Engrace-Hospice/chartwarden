-- compat: contract
-- CW-AC-10: platform Claim.MD response capture does not read tenant-owned M25 ERA stages.
-- Migration 1356 granted this shared capture role table-wide SELECT, including protected_details_cipher.
REVOKE SELECT ON claimmd_era_m25_stage FROM claimmd_capture;
DO $$
DECLARE column_name text;
BEGIN
  -- Clear any older column-only grants too; table-level REVOKE does not remove those.
  FOR column_name IN
    SELECT attname
      FROM pg_attribute
     WHERE attrelid = 'claimmd_era_m25_stage'::regclass
       AND attnum > 0
       AND NOT attisdropped
       AND has_column_privilege('claimmd_capture', attrelid, attnum, 'SELECT')
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%I) ON TABLE claimmd_era_m25_stage FROM claimmd_capture',
      column_name
    );
  END LOOP;
END $$;
DROP POLICY IF EXISTS claimmd_era_m25_stage_capture_read ON claimmd_era_m25_stage;
