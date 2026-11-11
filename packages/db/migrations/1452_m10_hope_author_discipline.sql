-- compat: expand
-- #883: persist the actor-bound discipline used to author each HOPE assessment. Nullable preserves
-- historical rows; all current record/correction paths populate it and edit/sign authorization fails
-- closed when the frozen attribution is absent or does not belong to the acting membership.
CREATE TYPE hope_author_discipline AS ENUM ('RN', 'NP', 'MD', 'LPN', 'LVN');--> statement-breakpoint
ALTER TABLE hope_assessment ADD COLUMN author_discipline hope_author_discipline;
