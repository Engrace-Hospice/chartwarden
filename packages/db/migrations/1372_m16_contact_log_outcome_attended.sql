-- compat: expand
-- ADR-0109 D10 - `bereavement_contact_log_outcome` gains `attended`: the outcome of a PROGRAM ACTIVITY row on the contact log (a mailing sent, an email
-- sent, a group session or memorial attended). Activity rows have no outreach and satisfy no cadence item; only the activity-shape CHECK (1373)
-- admits these three values, and the write routes never accept them (`LogDirectContactBody`). Own file: PG forbids using a value added earlier in
-- the same transaction (the 1305 / 1340 precedent), and 1373 uses all three.
ALTER TYPE "public"."bereavement_contact_log_outcome" ADD VALUE IF NOT EXISTS 'attended';
