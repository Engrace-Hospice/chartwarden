-- compat: expand
-- Historical transport acknowledgments lack trustworthy source provenance; preserve that uncertainty.
ALTER TABLE commercial_acknowledgment ADD COLUMN source_representation text NOT NULL DEFAULT 'unknown_legacy'
  CHECK (source_representation IN ('unknown_legacy','claimmd_normalized_api'));
