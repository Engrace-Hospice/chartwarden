-- compat: contract
-- M25-671: preserve 835 source dates and scope envelope identity through ISA06/ISA08 + GS06 + ST02.
-- This replaces an old uniqueness target, so old M25 writers must be drained before this migration.

ALTER TABLE remittance_advice
  ADD COLUMN interchange_sender_code varchar(15),
  ADD COLUMN interchange_receiver_code varchar(15),
  ADD COLUMN functional_group_control_number varchar(9),
  ADD COLUMN functional_group_metadata jsonb,
  ADD COLUMN transaction_set_position integer,
  ADD COLUMN payment_effective_date date,
  ADD COLUMN adjudication_cutoff_date date,
  ADD COLUMN functional_group_creation_date date,
  ADD COLUMN payee_identity_evidence jsonb;

-- Existing production_date values predate source-specific provenance. Do not infer or rewrite their source.
ALTER TABLE remittance_advice ALTER COLUMN production_date DROP NOT NULL;

ALTER TABLE remittance_advice
  ADD CONSTRAINT remittance_advice_group_identity_complete CHECK (
    (interchange_sender_code IS NULL AND interchange_receiver_code IS NULL AND functional_group_control_number IS NULL)
    OR
    (interchange_sender_code IS NOT NULL AND interchange_receiver_code IS NOT NULL AND functional_group_control_number IS NOT NULL)
  );

ALTER TABLE claimmd_era_m25_stage
  ADD COLUMN interchange_sender_code varchar(15),
  ADD COLUMN interchange_receiver_code varchar(15),
  ADD COLUMN functional_group_control_number varchar(9);

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
      functional_group_control_number, transaction_set_control_number);

DROP INDEX ux_remittance_envelope_dedupe;
CREATE UNIQUE INDEX ux_remittance_envelope_dedupe
  ON remittance_advice (organization_id, provider_entity_id, interchange_control_number,
    interchange_sender_code, interchange_receiver_code, functional_group_control_number,
    transaction_set_control_number) NULLS NOT DISTINCT;
