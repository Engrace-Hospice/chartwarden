-- compat: contract
-- The new enum value must commit before a constraint can name it.
ALTER TABLE channel DROP CONSTRAINT channel_kind_subject_shape;
--> statement-breakpoint
ALTER TABLE channel ADD CONSTRAINT channel_kind_subject_shape CHECK (
  CASE channel_kind
    WHEN 'care_team' THEN subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
    WHEN 'bereavement' THEN subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'bereavement' AND archives_at IS NOT NULL
    WHEN 'dm' THEN subject_id IS NULL AND dm_participant_key IS NOT NULL AND retention_class = 'care_related'
    WHEN 'group' THEN subject_id IS NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
    WHEN 'announcement' THEN subject_id IS NULL AND dm_participant_key IS NULL AND retention_class = 'operational'
    ELSE subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
  END
);
