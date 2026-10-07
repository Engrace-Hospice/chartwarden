-- D6 — one survivor's consent never stands in for another's: a `consent_record` backs at most one
-- `bereaved_contact` in a tenant. The write service checks this before every write that links a record
-- (seed, add, confirm) and refuses with 409 CONSENT_RECORD_IN_USE; this index is the backstop for any path
-- that skips the check. Seeds never set `consent_record_id`, so no existing row can collide.
CREATE UNIQUE INDEX IF NOT EXISTS "berv_contact_consent_uniq"
  ON "bereaved_contact" ("organization_id", "consent_record_id")
  WHERE consent_record_id IS NOT NULL;
