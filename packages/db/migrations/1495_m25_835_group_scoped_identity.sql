-- compat: contract
-- ST02 is unique inside a functional group, not across the interchange. Keep historical rows
-- without provable GS06 provenance nullable; new ingestion records always persist GS06.
ALTER TABLE remittance_advice
  ADD COLUMN functional_group_control_number varchar(9),
  ADD COLUMN functional_group_metadata jsonb,
  ADD COLUMN transaction_set_position integer,
  ADD COLUMN interchange_sender_code varchar(15),
  ADD COLUMN interchange_receiver_code varchar(15);

-- Historical rows have all new provenance fields NULL. Require provenance to be either wholly
-- absent (historical) or complete (new). NULLS NOT DISTINCT below prevents NULL-keyed inserts
-- from bypassing the scoped uniqueness rule on PostgreSQL 15+ (production uses PostgreSQL 18).
ALTER TABLE remittance_advice
  ADD CONSTRAINT remittance_advice_group_identity_complete CHECK (
    (interchange_sender_code IS NULL AND interchange_receiver_code IS NULL AND functional_group_control_number IS NULL)
    OR
    (interchange_sender_code IS NOT NULL AND interchange_receiver_code IS NOT NULL AND functional_group_control_number IS NOT NULL)
  );

ALTER TABLE claimmd_era_m25_stage
  ADD COLUMN functional_group_control_number varchar(9),
  ADD COLUMN interchange_sender_code varchar(15),
  ADD COLUMN interchange_receiver_code varchar(15);

ALTER TABLE claimmd_era_m25_stage
  ADD CONSTRAINT claimmd_era_m25_stage_group_identity_complete CHECK (
    (interchange_sender_code IS NULL AND interchange_receiver_code IS NULL AND functional_group_control_number IS NULL)
    OR
    (interchange_sender_code IS NOT NULL AND interchange_receiver_code IS NOT NULL AND functional_group_control_number IS NOT NULL)
  );

ALTER TABLE claimmd_era_m25_stage
  DROP CONSTRAINT claimmd_era_m25_stage_component_uq,
  ADD CONSTRAINT claimmd_era_m25_stage_component_uq
    UNIQUE NULLS NOT DISTINCT (source_inbox_id, file_index, interchange_sender_code, interchange_receiver_code,
            functional_group_control_number,
            transaction_set_control_number);

DROP INDEX IF EXISTS ux_remittance_envelope_dedupe;
CREATE UNIQUE INDEX ux_remittance_envelope_dedupe
  ON remittance_advice (organization_id, provider_entity_id, interchange_control_number,
                        interchange_sender_code, interchange_receiver_code,
                        functional_group_control_number, transaction_set_control_number)
  NULLS NOT DISTINCT;
