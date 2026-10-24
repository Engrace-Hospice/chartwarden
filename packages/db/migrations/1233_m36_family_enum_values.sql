-- M36 WP 6.7 (ADR-0099, PROPOSED), slice S1a - the two new enum values family messaging needs. Kept in a file of their own: a value added by ALTER TYPE
-- cannot be used (a CHECK, an index predicate) until the statement that added it has committed, so a later migration is the first to name them.
--   * channel_kind 'family': one conversation per (patient, contact), subject_id = the patient (the existing subject-shape CHECK already requires a
--     subject and the care_related retention class for every kind outside care_team / bereavement / dm / announcement).
--   * message_author_kind 'family_contact': a message written by the consented contact (author_user_id stays NULL; the existing CHECK
--     (author_kind = 'user') = (author_user_id IS NOT NULL) holds).
ALTER TYPE "public"."channel_kind" ADD VALUE IF NOT EXISTS 'family';--> statement-breakpoint
ALTER TYPE "public"."message_author_kind" ADD VALUE IF NOT EXISTS 'family_contact';
