-- compat: expand
-- M34 go-live and the BAA register judge that a linked document is a signed BAA FILED for the tenant. Two review fixes widen what that
-- judgement reads, on the platform carrier (chartwarden_platform), whose SELECT on "document" is otherwise three columns (id,
-- organization_id, aggregate_type):
--   * created_by_membership_id: go-live approval refuses the operator who UPLOADED the signed agreement, not only the one who wrote the
--     register row. A membership id, and nothing of the document's title, patient, object key or content.
--   * status: a document whose content was destroyed (status destroyed_tombstone) is not a filed agreement. A lifecycle word.
-- Idempotent; the carrier exists only where scripts/db/provision-runtime-roles.ts has run (it grants the same on every run).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ("created_by_membership_id", "status") ON "document" TO chartwarden_platform;
  END IF;
END $$;
