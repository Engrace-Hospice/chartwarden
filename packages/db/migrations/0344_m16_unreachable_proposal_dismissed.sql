-- M16 route 34 — `bereaved_contact.unreachable_proposal_dismissed_at`: the counselor's "keep trying" decision on the
-- nightly detector's unreachable PROPOSAL. Route 34 stamps it with the proposal's own `unreachable_proposed_through_at`
-- (the newest `no_response` strike the dismissed proposal covered). A proposal is dismissed while
-- `unreachable_proposal_dismissed_at >= unreachable_proposed_through_at`; the detector re-proposes only on a strictly
-- newer strike, which advances `unreachable_proposed_through_at` past the dismissal and surfaces the proposal again.
-- NULL = never dismissed.
--
-- Additive, nullable, no default; no PHI. Existing RLS policies and the write-audit trigger cover the column.
ALTER TABLE "bereaved_contact" ADD COLUMN IF NOT EXISTS "unreachable_proposal_dismissed_at" timestamp with time zone;
