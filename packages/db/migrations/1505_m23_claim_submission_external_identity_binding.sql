-- compat: contract
-- M23-CM5-T1.2C: preserve internal claim identity while durably binding vendor routing and outbound PCN.
ALTER TABLE claim_submission
  ADD COLUMN external_patient_control_number text,
  ADD COLUMN clearinghouse_vendor text,
  ADD COLUMN clearinghouse_account_reference text,
  ADD COLUMN clearinghouse_mode text,
  ADD COLUMN clearinghouse_config_id uuid,
  ADD COLUMN clearinghouse_config_version integer,
  ADD COLUMN clearinghouse_credential_fingerprint text,
  ADD COLUMN expected_route_fingerprint text;
--> statement-breakpoint
ALTER TABLE claim_submission
  ADD CONSTRAINT claim_submission_external_pcn_shape_ck
    CHECK (external_patient_control_number IS NULL OR external_patient_control_number ~ '^[A-Z0-9]{17}$'),
  ADD CONSTRAINT claim_submission_route_binding_shape_ck CHECK (
    (clearinghouse_vendor IS NULL AND clearinghouse_account_reference IS NULL AND clearinghouse_mode IS NULL
      AND clearinghouse_config_id IS NULL AND clearinghouse_config_version IS NULL
      AND clearinghouse_credential_fingerprint IS NULL AND expected_route_fingerprint IS NULL)
    OR
    (clearinghouse_vendor IS NOT NULL AND clearinghouse_vendor IN ('claimmd','stedi')
      AND clearinghouse_account_reference IS NOT NULL AND clearinghouse_account_reference ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND clearinghouse_mode IS NOT NULL AND clearinghouse_mode IN ('test','production')
      AND expected_route_fingerprint IS NOT NULL AND expected_route_fingerprint ~ '^[0-9a-f]{64}$'
      AND ((clearinghouse_config_id IS NULL AND clearinghouse_config_version IS NULL
            AND clearinghouse_credential_fingerprint IS NULL)
        OR (clearinghouse_config_id IS NOT NULL AND clearinghouse_config_version IS NOT NULL
            AND clearinghouse_config_version > 0 AND clearinghouse_credential_fingerprint IS NOT NULL
            AND clearinghouse_credential_fingerprint ~ '^[0-9a-f]{64}$')))
  );
--> statement-breakpoint
CREATE UNIQUE INDEX claim_submission_external_pcn_uq
  ON claim_submission(provider_entity_id, external_patient_control_number)
  WHERE external_patient_control_number IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION guard_claim_submission_identity_binding() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.external_patient_control_number, NEW.clearinghouse_vendor, NEW.clearinghouse_account_reference,
         NEW.clearinghouse_mode, NEW.clearinghouse_config_id, NEW.clearinghouse_config_version,
         NEW.clearinghouse_credential_fingerprint, NEW.expected_route_fingerprint)
     IS DISTINCT FROM
     ROW(OLD.external_patient_control_number, OLD.clearinghouse_vendor, OLD.clearinghouse_account_reference,
         OLD.clearinghouse_mode, OLD.clearinghouse_config_id, OLD.clearinghouse_config_version,
         OLD.clearinghouse_credential_fingerprint, OLD.expected_route_fingerprint) THEN
    RAISE EXCEPTION 'claim submission routing identity is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_claim_submission_identity_binding_immutable
  BEFORE UPDATE ON claim_submission FOR EACH ROW EXECUTE FUNCTION guard_claim_submission_identity_binding();
