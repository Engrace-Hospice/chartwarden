-- GAP-006 follow-up — at most ONE open portal amendment request per patient per requested change
-- (M5 §7.7 / HIPAA §164.526; M31 §7.9 portal submit).
--
-- A same-Idempotency-Key retry is replayed by the middleware, but a resubmit under a new key opened a
-- second pending request for the same change. The portal intake now stamps every portal row with
-- `requested_changes ->> 'portalDedupeKey'` (sha256 over target kind, target ref and the requested change
-- trimmed + whitespace-collapsed) and inserts with ON CONFLICT DO NOTHING; this partial unique index is
-- what makes that race-safe — two concurrent submits serialize on the index entry, and the loser reads
-- the winner's row back. Only `pending` rows are in the predicate, so once a request is accepted, denied
-- or withdrawn the same change may be requested again. Staff-submitted rows (no key) are untouched, and
-- pre-existing portal rows carry no key, so the index builds over any duplicates already present.
CREATE UNIQUE INDEX IF NOT EXISTS "patient_amendment_request_portal_open_dedupe_uq"
  ON "patient_amendment_request" ("organization_id", "patient_id", ("requested_changes" ->> 'portalDedupeKey'))
  WHERE "status" = 'pending' AND ("requested_changes" ->> 'portalDedupeKey') IS NOT NULL;
