-- GAP-048 follow-up — M16 `bereaved_contact.unreachable_proposed_through_at`: the `contact_at` of the newest
-- `no_response` contact-log row the nightly `m16-unreachable-detector` (§4.9) has ALREADY proposed
-- `markUnreachable` for. The detector stamps it in the SAME transaction as the
-- `m16.bereavement.contact_unreachable_proposed` outbox publish and re-proposes only when a strictly newer
-- strike exists, so a replayed or overlapping run proposes nothing and a counselor is not re-alerted nightly
-- for the same evidence. NULL = never proposed.
--
-- Additive, nullable, no default; no PHI. Existing RLS policies and the write-audit trigger cover the column.
ALTER TABLE "bereaved_contact" ADD COLUMN IF NOT EXISTS "unreachable_proposed_through_at" timestamp with time zone;
