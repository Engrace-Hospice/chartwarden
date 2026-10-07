-- M18 §4.8 `m18.dek-rotation` — the ONE sanctioned write path that re-seals an `evv_event` GPS coordinate
-- (and the `evv_geofence_evaluation` snapshot that carries the same envelope) under the tenant's CURRENT M34
-- DEK after a key-ring rotation.
--
-- WHY A MIGRATION IS NEEDED. 0047's §3.2 Phase C append-only trigger (widened once, by 0351, for the D9 spoof
-- flag) refuses every `evv_event` UPDATE except the two supersede markers, so `coords_cipher` /
-- `coords_dek_version` could never be rewritten — a rotated tenant's rows stayed sealed under the old DEK for
-- ever, and the M34 prior-version list could never shrink. The re-seal does not change WHAT was captured:
-- the plaintext ("lat,lng") is byte-identical before and after; only the key it is sealed under moves.
--
-- WHY NOT A GUC-GATED TRIGGER EXCEPTION. The app role can SET any custom GUC, so a trigger that trusted one
-- would let any `wardenx_app` code path rewrite captured evidence. Instead (the 0199 / 0186 / 0013 shape): a
-- NARROW, DEDICATED NOLOGIN role `evv_coords_rekeyer` owns ONE SECURITY DEFINER function; `wardenx_app` gets
-- EXECUTE on it and NEVER role membership. The trigger's new exception keys on `current_user`, which inside
-- the definer body (and the triggers its UPDATE fires) is the owner — a value the app role cannot assume.
--
-- WHAT THE FUNCTION REFUSES. It is a compare-and-swap: the row must still hold `p_expected_cipher` (so a
-- concurrent re-seal or a re-run is a no-op, never a double write), the new value must be a v1 envelope
-- whose embedded version equals `p_dek_version`, and a 'legacy-unencrypted' stamp can be neither the source
-- nor the target (legacy rows are never re-sealed — they hold no ciphertext to open). Only the two coordinate
-- columns change; the widened trigger still refuses every other column, for this role too. The target
-- version must be the tenant's CURRENT, non-destroyed `tenant_key_ring.current_dek_version` (read through the
-- org-filtered `tenant_key_ring_metadata_v`), so the function can only move a row onto the live key.
--
-- RESIDUAL RISK (accepted, documented). SQL cannot prove the new ciphertext decrypts to the same plaintext,
-- so a caller that holds the tenant's current DEK and runs as `wardenx_app` in that tenant could re-seal a
-- row to a different coordinate through this function. Outside it the coordinates stay UPDATE-proof. The
-- M4 write-audit trigger records every re-seal (`evv_event.update`, dek version before/after), and the only
-- caller is the m18.dek-rotation worker, which re-seals the plaintext it just opened.
--
-- TENANCY. The function never takes an organization: the rekeyer's own RLS policies key ONLY on
-- `app.org_id` (set by `withOrgContext`), exactly like `wardenx_app`'s, so a caller in tenant A cannot reach
-- tenant B's row by passing its id. The M4 write-audit triggers still fire (`evv_event.update`,
-- `evv_geofence_evaluation.update`) with the cipher columns scrubbed by their §3.6 denylists.--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'evv_coords_rekeyer') THEN
    CREATE ROLE evv_coords_rekeyer NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO evv_coords_rekeyer;--> statement-breakpoint
COMMENT ON ROLE evv_coords_rekeyer IS
  'M18 §4.8 m18.dek-rotation — NOLOGIN owner of evv_reseal_coords(); the only role the evv_event append-only trigger lets rewrite coords_cipher/coords_dek_version.';--> statement-breakpoint

-- Column-narrow grants: read what the compare-and-swap matches on, write only the coordinate columns.
GRANT SELECT (id, event_at, organization_id, coords_cipher, coords_dek_version) ON "evv_event" TO evv_coords_rekeyer;--> statement-breakpoint
GRANT UPDATE (coords_cipher, coords_dek_version) ON "evv_event" TO evv_coords_rekeyer;--> statement-breakpoint
GRANT SELECT (id, organization_id, evv_event_id, device_coords_cipher) ON "evv_geofence_evaluation" TO evv_coords_rekeyer;--> statement-breakpoint
GRANT UPDATE (device_coords_cipher) ON "evv_geofence_evaluation" TO evv_coords_rekeyer;--> statement-breakpoint
-- The current-version check reads the org-filtered, ciphertext-free key-ring metadata view (never the base table).
GRANT SELECT ON "tenant_key_ring_metadata_v" TO evv_coords_rekeyer;--> statement-breakpoint

-- Org-scope RLS for the rekeyer (both tables are FORCEd since 0118). SELECT + UPDATE only — never INSERT/DELETE.
DROP POLICY IF EXISTS "evv_event_rekeyer_select" ON "evv_event";--> statement-breakpoint
CREATE POLICY "evv_event_rekeyer_select" ON "evv_event"
  FOR SELECT TO evv_coords_rekeyer
  USING (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "evv_event_rekeyer_update" ON "evv_event";--> statement-breakpoint
CREATE POLICY "evv_event_rekeyer_update" ON "evv_event"
  FOR UPDATE TO evv_coords_rekeyer
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "evv_geofence_evaluation_rekeyer_select" ON "evv_geofence_evaluation";--> statement-breakpoint
CREATE POLICY "evv_geofence_evaluation_rekeyer_select" ON "evv_geofence_evaluation"
  FOR SELECT TO evv_coords_rekeyer
  USING (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "evv_geofence_evaluation_rekeyer_update" ON "evv_geofence_evaluation";--> statement-breakpoint
CREATE POLICY "evv_geofence_evaluation_rekeyer_update" ON "evv_geofence_evaluation"
  FOR UPDATE TO evv_coords_rekeyer
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- The append-only trigger, widened by exactly the two coordinate columns AND only for the rekeyer role.
-- Everything 0351 allowed (the supersede markers; gps_quality -> 'suspected_spoof') is unchanged.
CREATE OR REPLACE FUNCTION evv_event_enforce_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_cmp jsonb;
  new_cmp jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EVV_EVENT_APPEND_ONLY_NO_DELETE';
  END IF;
  old_cmp := to_jsonb(OLD) - 'superseded_at' - 'superseded_by_event_id';
  new_cmp := to_jsonb(NEW) - 'superseded_at' - 'superseded_by_event_id';
  IF NEW.gps_quality = 'suspected_spoof' AND OLD.gps_quality IS DISTINCT FROM NEW.gps_quality THEN
    old_cmp := old_cmp - 'gps_quality';
    new_cmp := new_cmp - 'gps_quality';
  END IF;
  IF current_user = 'evv_coords_rekeyer' THEN
    old_cmp := old_cmp - 'coords_cipher' - 'coords_dek_version';
    new_cmp := new_cmp - 'coords_cipher' - 'coords_dek_version';
  END IF;
  IF new_cmp IS DISTINCT FROM old_cmp THEN
    RAISE EXCEPTION 'EVV_EVENT_APPEND_ONLY_IMMUTABLE_COLUMN';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- The re-seal. Returns 1 when the event row moved, 0 when it no longer held `p_expected_cipher` (already
-- re-sealed by an earlier/concurrent run, or not visible in this tenant) — the caller counts, never retries.
CREATE OR REPLACE FUNCTION evv_reseal_coords(
  p_event_id uuid,
  p_event_at timestamptz,
  p_expected_cipher text,
  p_cipher text,
  p_dek_version text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_moved integer;
BEGIN
  IF p_dek_version IS NULL OR p_dek_version = '' OR p_dek_version = 'legacy-unencrypted'
     OR position('.' IN p_dek_version) > 0 THEN
    RAISE EXCEPTION 'EVV_RESEAL_INVALID_DEK_VERSION';
  END IF;
  IF p_cipher IS NULL OR left(p_cipher, length('v1.' || p_dek_version || '.')) <> 'v1.' || p_dek_version || '.' THEN
    RAISE EXCEPTION 'EVV_RESEAL_ENVELOPE_VERSION_MISMATCH';
  END IF;
  IF p_expected_cipher IS NULL OR left(p_expected_cipher, 3) <> 'v1.' THEN
    RAISE EXCEPTION 'EVV_RESEAL_SOURCE_NOT_AN_ENVELOPE';
  END IF;
  IF p_dek_version IS DISTINCT FROM (
       SELECT v.current_dek_version
         FROM public.tenant_key_ring_metadata_v v
        WHERE v.destroyed_at IS NULL
        LIMIT 1
     ) THEN
    RAISE EXCEPTION 'EVV_RESEAL_NOT_CURRENT_DEK_VERSION';
  END IF;

  UPDATE public.evv_event
     SET coords_cipher = p_cipher,
         coords_dek_version = p_dek_version
   WHERE id = p_event_id
     AND event_at = p_event_at
     AND coords_cipher = p_expected_cipher
     AND coords_dek_version <> 'legacy-unencrypted';
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- The geofence snapshot carries the SAME envelope (written in the capture tx); keep the two in step.
  IF v_moved > 0 THEN
    UPDATE public.evv_geofence_evaluation
       SET device_coords_cipher = p_cipher
     WHERE evv_event_id = p_event_id
       AND device_coords_cipher = p_expected_cipher;
  END IF;
  RETURN v_moved;
END $$;--> statement-breakpoint
ALTER FUNCTION evv_reseal_coords(uuid, timestamptz, text, text, text) OWNER TO evv_coords_rekeyer;--> statement-breakpoint
REVOKE ALL ON FUNCTION evv_reseal_coords(uuid, timestamptz, text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION evv_reseal_coords(uuid, timestamptz, text, text, text) TO wardenx_app;--> statement-breakpoint

-- The worker's selection: "this org's rows not sealed under the current version". Propagates to every leaf.
CREATE INDEX IF NOT EXISTS "evv_event_org_dek_version_idx" ON "evv_event" USING btree ("organization_id","coords_dek_version");
