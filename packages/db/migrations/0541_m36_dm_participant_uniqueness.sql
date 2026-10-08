-- M36: one canonical direct-message channel per unordered pair inside an organization.
-- The key is derived exclusively from active channel membership; clients never supply it.
ALTER TABLE "channel" ADD COLUMN "dm_participant_key" text;
--> statement-breakpoint
WITH dm_pairs AS (
  SELECT
    c.id,
    string_agg(cm.user_id::text, ':' ORDER BY cm.user_id::text) AS participant_key
  FROM "channel" c
  JOIN "channel_member" cm
    ON cm.channel_id = c.id
   AND cm.organization_id = c.organization_id
   AND cm.removed_at IS NULL
  WHERE c.channel_kind = 'dm'
  GROUP BY c.id
  HAVING count(*) = 2
)
UPDATE "channel" c
SET dm_participant_key = p.participant_key
FROM dm_pairs p
WHERE c.id = p.id;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "channel"
    WHERE channel_kind = 'dm' AND dm_participant_key IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot enforce M36 DM uniqueness: an existing DM does not have exactly two active members';
  END IF;
END $$;
--> statement-breakpoint
CREATE TEMP TABLE m36_duplicate_dm ON COMMIT DROP AS
SELECT duplicate_id, keeper_id
FROM (
  SELECT
    id AS duplicate_id,
    first_value(id) OVER (
      PARTITION BY organization_id, dm_participant_key
      ORDER BY created_at, id
    ) AS keeper_id,
    row_number() OVER (
      PARTITION BY organization_id, dm_participant_key
      ORDER BY created_at, id
    ) AS duplicate_rank
  FROM "channel"
  WHERE channel_kind = 'dm'
) ranked
WHERE duplicate_rank > 1;
--> statement-breakpoint
UPDATE "message" m
SET channel_id = d.keeper_id
FROM m36_duplicate_dm d
WHERE m.channel_id = d.duplicate_id;
--> statement-breakpoint
DELETE FROM "channel_member" cm
USING m36_duplicate_dm d
WHERE cm.channel_id = d.duplicate_id;
--> statement-breakpoint
DELETE FROM "channel" c
USING m36_duplicate_dm d
WHERE c.id = d.duplicate_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_unique_dm_participants"
  ON "channel" (organization_id, dm_participant_key)
  WHERE channel_kind = 'dm' AND dm_participant_key IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel" DROP CONSTRAINT "channel_kind_subject_shape";
--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_kind_subject_shape" CHECK (
  CASE channel_kind
    WHEN 'care_team'    THEN subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
    WHEN 'bereavement'  THEN subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'bereavement' AND archives_at IS NOT NULL
    WHEN 'dm'           THEN subject_id IS NULL AND dm_participant_key IS NOT NULL AND retention_class = 'care_related'
    WHEN 'announcement' THEN subject_id IS NULL AND dm_participant_key IS NULL AND retention_class = 'operational'
    ELSE                     subject_id IS NOT NULL AND dm_participant_key IS NULL AND retention_class = 'care_related'
  END
);
