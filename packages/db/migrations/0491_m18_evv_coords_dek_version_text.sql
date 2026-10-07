-- GAP-133 — M18 §D10: `evv_event.coords_cipher` becomes real per-tenant envelope encryption.
--
-- Until now the capture wrote `base64("lat,lng")` into `coords_cipher` and stamped `coords_dek_version = 1`
-- beside it — encoding, not encryption, under a version stamp that claimed otherwise. The capture now seals
-- the coordinate with AES-256-GCM under the tenant's M34 DEK (apps/backend/src/modules/18-evv/coords.ts) and
-- stamps the DEK version the key ring returned. M34 DEK versions are TEXT (`tenant_key_ring.current_dek_version`,
-- e.g. 'v1'), so the integer column cannot carry the real one: it becomes text.
--
-- EXISTING ROWS. Every row present when this runs was written by the old code, so every one of them is
-- base64, never encrypted. They are re-stamped 'legacy-unencrypted' (not cast to '1') so the schema stops
-- asserting they were sealed under a DEK. There is deliberately NO backfill/re-encryption: prod is demo data
-- and is fixed by reseeding. The reader recognises a legacy row by format (base64 has no '.', an envelope is
-- `v1.<ver>.<nonce>.<tag>.<ct>`) and answers "coordinate unavailable" (null) for it — it never decodes it.
-- `coords_cipher` itself is unchanged (already text); `evv_geofence_evaluation.device_coords_cipher` carries
-- the same envelope and has no version column (the version travels inside the envelope).
--
-- ALTER COLUMN TYPE on the PARTITIONED PARENT propagates to every leaf; the table rewrite fires no row
-- triggers, so the §3.2 Phase C append-only immutability trigger and the M4 write-audit trigger are not
-- engaged. Guarded on the current type so a re-run never overwrites real versions written after it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'evv_event'
      AND column_name = 'coords_dek_version'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE "evv_event"
      ALTER COLUMN "coords_dek_version" TYPE text USING 'legacy-unencrypted';
  END IF;
END
$$;--> statement-breakpoint

COMMENT ON COLUMN "evv_event"."coords_dek_version" IS
  'GAP-133: the M34 tenant_key_ring DEK version coords_cipher was sealed under (AES-256-GCM envelope, see apps/backend/src/modules/18-evv/coords.ts); ''legacy-unencrypted'' marks a pre-GAP-133 base64 row, which reads as coordinate-unavailable.';
