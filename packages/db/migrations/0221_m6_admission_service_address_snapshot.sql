ALTER TABLE admission
  ADD COLUMN IF NOT EXISTS patient_residence_address_id uuid REFERENCES patient_address(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS service_address_line1 text,
  ADD COLUMN IF NOT EXISTS service_address_line2 text,
  ADD COLUMN IF NOT EXISTS service_address_city text,
  ADD COLUMN IF NOT EXISTS service_address_state text,
  ADD COLUMN IF NOT EXISTS service_address_postal_code text,
  ADD COLUMN IF NOT EXISTS service_address_country text;

CREATE INDEX IF NOT EXISTS admission_patient_residence_address_idx
  ON admission(patient_residence_address_id);

ALTER TYPE document_aggregate_type ADD VALUE IF NOT EXISTS 'notice_of_rights';
