-- Phase 7: manual iQIES XML/ZIP package lifecycle + external Final Validation Report results.

ALTER TYPE hope_submission_status ADD VALUE IF NOT EXISTS 'ready';
ALTER TYPE hope_submission_status ADD VALUE IF NOT EXISTS 'packaged';
ALTER TYPE hope_submission_status ADD VALUE IF NOT EXISTS 'exported';
ALTER TYPE hope_submission_status ADD VALUE IF NOT EXISTS 'submitted_pending_result';
ALTER TYPE hope_submission_status ADD VALUE IF NOT EXISTS 'accepted_with_warnings';
ALTER TYPE hope_submission_status ADD VALUE IF NOT EXISTS 'file_error';

ALTER TYPE hope_submission_item_status ADD VALUE IF NOT EXISTS 'accepted_with_warnings';
ALTER TYPE hope_submission_item_status ADD VALUE IF NOT EXISTS 'blocked';
ALTER TYPE hope_submission_item_status ADD VALUE IF NOT EXISTS 'unmatched';

ALTER TABLE hope_submission
  ADD COLUMN IF NOT EXISTS transport_mode text NOT NULL DEFAULT 'manual_iqies_upload',
  ADD COLUMN IF NOT EXISTS validation_profile text,
  ADD COLUMN IF NOT EXISTS package_filename text,
  ADD COLUMN IF NOT EXISTS package_storage_uri text,
  ADD COLUMN IF NOT EXISTS package_sha256 text,
  ADD COLUMN IF NOT EXISTS package_size_bytes integer,
  ADD COLUMN IF NOT EXISTS exported_at timestamptz,
  ADD COLUMN IF NOT EXISTS exported_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS iqies_submission_reference text,
  ADD COLUMN IF NOT EXISTS result_imported_at timestamptz,
  ADD COLUMN IF NOT EXISTS result_imported_by_membership_id uuid,
  ADD COLUMN IF NOT EXISTS result_report_hash text,
  ADD COLUMN IF NOT EXISTS file_level_result jsonb;

ALTER TABLE hope_submission_item
  ADD COLUMN IF NOT EXISTS operation text,
  ADD COLUMN IF NOT EXISTS spec_version_id uuid,
  ADD COLUMN IF NOT EXISTS assessment_version text,
  ADD COLUMN IF NOT EXISTS validation_profile text,
  ADD COLUMN IF NOT EXISTS xml_filename text,
  ADD COLUMN IF NOT EXISTS xml_storage_uri text,
  ADD COLUMN IF NOT EXISTS xml_sha256 text,
  ADD COLUMN IF NOT EXISTS xml_size_bytes integer,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_hope_sub_item_result
  ON hope_submission_item (organization_id, item_status, updated_at);

CREATE TABLE IF NOT EXISTS hope_submission_result_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE restrict,
  hope_submission_id uuid NOT NULL REFERENCES hope_submission(id) ON DELETE restrict,
  hope_submission_item_id uuid REFERENCES hope_submission_item(id) ON DELETE restrict,
  source text NOT NULL DEFAULT 'iqies',
  report_hash text NOT NULL,
  report_reference text,
  result_scope text NOT NULL DEFAULT 'record',
  result_status text NOT NULL,
  cms_severity text,
  cms_edit_code text,
  item_code text,
  message text,
  raw_result jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hope_sub_result_submission
  ON hope_submission_result_event (hope_submission_id, result_status);

CREATE INDEX IF NOT EXISTS idx_hope_sub_result_item
  ON hope_submission_result_event (hope_submission_item_id, cms_edit_code);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_hope_sub_result_event_import
  ON hope_submission_result_event (
    hope_submission_id,
    hope_submission_item_id,
    report_hash,
    result_scope,
    cms_edit_code,
    item_code
  )
  WHERE cms_edit_code IS NOT NULL;
