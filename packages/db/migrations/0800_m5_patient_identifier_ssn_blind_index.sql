-- GAP-010 / M5 — the SSN envelope writer's searchable half.
--
-- `patient_identifier.value_encrypted` (bytea, AES-256-GCM under the tenant DEK) already exists (0020); what did not
-- exist is any way to ask "is this SSN already on file in my tenant?" without decrypting every row. These two columns
-- add that:
--
--   value_blind_index  HMAC-SHA256 over the nine SSN digits, keyed by an HKDF subkey of the tenant DEK (never by a
--                      platform-wide secret, so a cryptographic shred of the key ring destroys the index with the
--                      ciphertext). Not unique: two patients with the same SSN is the duplicate the §2.3 matcher
--                      exists to surface. Only `ssn` rows carry one; no matching rule uses state_id.
--   value_dek_version  the DEK version the ciphertext AND the index were produced under, so the matcher can probe
--                      every version still on file (correct after any number of rotations, no re-seal job needed)
--                      and a sweep can find stale rows without decrypting.
--
-- The CHECK keeps an ssn row searchable unless it has been crypto-shredded (the eraser rewrites value_encrypted to the
-- empty bytea sentinel and nulls the index in the same UPDATE). No ssn row could be written before this, so VALIDATE
-- has nothing to reject.
--
-- The audit trigger is the control that keeps these columns out of audit_event.before/after: its scrub array gains the
-- two new columns (CREATE OR REPLACE keeps the wardenx_audit_writer owner set by 0021).
ALTER TABLE "patient_identifier"
  ADD COLUMN IF NOT EXISTS "value_blind_index" bytea,
  ADD COLUMN IF NOT EXISTS "value_dek_version" text;--> statement-breakpoint

ALTER TABLE "patient_identifier"
  ADD CONSTRAINT "patient_identifier_ssn_blind_index"
  CHECK ("kind" <> 'ssn' OR "value_blind_index" IS NOT NULL OR octet_length("value_encrypted") = 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "patient_identifier" VALIDATE CONSTRAINT "patient_identifier_ssn_blind_index";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_identifier_ssn_blind_idx"
  ON "patient_identifier" ("organization_id", "value_blind_index")
  WHERE "kind" = 'ssn' AND "effective_to" IS NULL AND "value_blind_index" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_patient_identifier() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), ARRAY['value', 'value_encrypted', 'value_last4', 'value_blind_index', 'value_dek_version']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), ARRAY['value', 'value_encrypted', 'value_last4', 'value_blind_index', 'value_dek_version']::text[]) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'patient_identifier.' || lower(TG_OP),
    'patient_identifier',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;
