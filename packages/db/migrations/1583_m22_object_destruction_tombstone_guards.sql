-- compat: contract
-- M22 (CW-DS-01): database-side guards on `object_destruction_tombstone` (created by 1560, which is applied and never edited).
--
-- Contract, not expand: it takes things away from the previous release's writers. The eraser of the release that carried 1560 inserted
-- a tombstone for any key of a document it was destroying; this refuses one whose key is not a form the document store writes, one for
-- a document under an active legal hold or a 42 CFR Part 2 document, and any TRUNCATE, and it revokes a privilege. The previous
-- release's eraser never wrote the held and Part 2 cases (its plan excludes them), so in practice only an odd key or a TRUNCATE would
-- notice, but "not sure" is `contract`, and the arch:migration-compat heuristic flags the REVOKE and TRUNCATE below anyway. deploy.sh
-- therefore HOLDS a deploy that carries this file (exit 75, nothing applied); the operator applies it after the deploy's drain with
-- `run --rm --no-deps migrate bun run scripts/db/migrate.ts --strict --schema-only`, then re-runs the deploy.
--
-- DDL on an existing table plus one read-only pre-check: no new table, column or enum, so no manifest or code mirror changes.

-- Pre-check (read-only; counts only, never a key: a key holds a patient's opaque id). A tombstone written since 1560 whose key is not a
-- form the document store writes could never be exported, and it cannot be removed (append-only), so it would keep every other tombstone
-- out of the list: refuse to apply the guards over one and let a database administrator decide first. A document VERSION with such a
-- key is only reported: its document cannot be erased (the erase is refused before anything is destroyed) until its key is fixed.
-- Runs as the migration role; under row security that role must read every organization (the superuser the deploy migrates as does).
DO $$
DECLARE
  bad_tombstones bigint;
  bad_versions bigint;
BEGIN
  SELECT count(*) INTO bad_tombstones FROM public.object_destruction_tombstone
   WHERE length(object_key) > 512 OR object_key !~ '^(documents|intake|uploads)(/[A-Za-z0-9][A-Za-z0-9._-]*){2,6}$';
  IF bad_tombstones > 0 THEN
    RAISE EXCEPTION 'object_destruction_tombstone: % existing tombstone(s) have an object key that is not a form the document store writes, so the list could never be exported; tombstones are append-only, so a database administrator must decide before this migration is applied (docs/runbooks/object-destruction-copies.md)', bad_tombstones USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO bad_versions FROM public.document_version
   WHERE length(object_key) > 512 OR object_key !~ '^(documents|intake|uploads)(/[A-Za-z0-9][A-Za-z0-9._-]*){2,6}$';
  IF bad_versions > 0 THEN
    RAISE NOTICE 'object_destruction_tombstone: % document version(s) have an object key that is not a form the document store writes; their documents cannot be erased until the key is fixed', bad_versions;
  END IF;
END $$;--> statement-breakpoint

-- The version check of 1560 and the audit trigger fire under `session_replication_role = replica` too, like the append-only guard.
ALTER TABLE "object_destruction_tombstone" ENABLE ALWAYS TRIGGER "trg_object_destruction_tombstone_names_a_version";--> statement-breakpoint
ALTER TABLE "object_destruction_tombstone" ENABLE ALWAYS TRIGGER "trg_audit_object_destruction_tombstone";--> statement-breakpoint

-- The key is applied to copies and restores as an object to DESTROY, so it must have a form the document store writes (documents/,
-- intake/ or uploads/ followed by 2 to 6 path segments, each starting with a letter or digit: no `..`, no empty segment, no encoded
-- slash). The same form scripts/lib/object-tombstones.ts (isObjectKeyShape) enforces when the list is exported and loaded; a live test
-- pins the two to each other. Refused HERE, at the erase, where the document version still exists and the operator can act: an
-- object that could not be exported would otherwise keep every other tombstone out of the list. A trigger, not a CHECK: a failing
-- CHECK's error text carries the whole row, key included, and the key holds a patient's opaque id.
CREATE OR REPLACE FUNCTION object_destruction_tombstone_key_form() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF length(NEW.object_key) > 512 OR NEW.object_key !~ '^(documents|intake|uploads)(/[A-Za-z0-9][A-Za-z0-9._-]*){2,6}$' THEN
    RAISE EXCEPTION 'object_destruction_tombstone: the object key is not a form the document store writes (documents/, intake/ or uploads/ followed by 2 to 6 plain path segments)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_object_destruction_tombstone_key_form"
  BEFORE INSERT ON "object_destruction_tombstone"
  FOR EACH ROW EXECUTE FUNCTION object_destruction_tombstone_key_form();--> statement-breakpoint
ALTER TABLE "object_destruction_tombstone" ENABLE ALWAYS TRIGGER "trg_object_destruction_tombstone_key_form";--> statement-breakpoint

-- A tombstone is permanent and is applied by DESTROYING objects on copies and restores, so the database itself refuses one for an
-- object whose document is under an ACTIVE legal hold (status 'legal_hold', or an unreleased document_legal_hold row) or is a
-- 42 CFR Part 2 document (retention_class 'compliance_42cfr_part2'): the same three conditions the eraser reads, now enforced for any
-- writer, the eraser's own re-read included. Fires for every row (also ON CONFLICT DO NOTHING) and, ENABLE ALWAYS, under
-- session_replication_role = replica. SECURITY INVOKER like the version check of 1560: the inserting role must be able to read the
-- document, its versions and its holds (the destruction role can, for its own organization, through org-pinned policies on all three
-- tables). A role without the GRANT fails with a privilege error; a version whose document row is hidden from the role (row security)
-- is refused by the first check below; a HOLD row hidden by row security cannot be told from no hold, which is why only the
-- destruction role and a superuser can insert here at all. Limit: a hold placed AFTER the tombstone was written does not remove it
-- (the export leaves such an unfinished erase out until the document's rows are gone).
CREATE OR REPLACE FUNCTION object_destruction_tombstone_not_preserved() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.document_version v
     WHERE v.organization_id = NEW.organization_id AND v.object_key = NEW.object_key
       AND NOT EXISTS (
         SELECT 1 FROM public.document d WHERE d.id = v.document_id AND d.organization_id = v.organization_id
       )
  ) THEN
    RAISE EXCEPTION 'object_destruction_tombstone: the document of that object cannot be read, so it cannot be shown not to be held' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.document_version v
      JOIN public.document d ON d.id = v.document_id AND d.organization_id = v.organization_id
     WHERE v.organization_id = NEW.organization_id AND v.object_key = NEW.object_key
       AND (
         d.retention_class = 'compliance_42cfr_part2'
         OR d.status = 'legal_hold'
         OR EXISTS (
           SELECT 1 FROM public.document_legal_hold h
            WHERE h.document_id = d.id AND h.released_at IS NULL
         )
       )
  ) THEN
    RAISE EXCEPTION 'object_destruction_tombstone: the object belongs to a document under an active legal hold or a 42 CFR Part 2 document, which is never destroyed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_object_destruction_tombstone_not_preserved"
  BEFORE INSERT ON "object_destruction_tombstone"
  FOR EACH ROW EXECUTE FUNCTION object_destruction_tombstone_not_preserved();--> statement-breakpoint
ALTER TABLE "object_destruction_tombstone" ENABLE ALWAYS TRIGGER "trg_object_destruction_tombstone_not_preserved";--> statement-breakpoint

-- TRUNCATE: the grants of 1560 give no role TRUNCATE (revoked explicitly below as well), and the table owner and a superuser, who need
-- no grant, are stopped by a statement-level BEFORE TRUNCATE trigger (ENABLE ALWAYS, so the replica role does not skip it; it also
-- fires when the table is reached by TRUNCATE ... CASCADE through its foreign key to organization). An event trigger cannot do this:
-- TRUNCATE is not a DDL command an event trigger sees (the schema's one event trigger guards new partitions). What remains: a database
-- administrator who deliberately DISABLEs a trigger of this table or DROPs it or the table.
CREATE OR REPLACE FUNCTION object_destruction_tombstone_no_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'object_destruction_tombstone: a tombstone is append-only (the table cannot be truncated)' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_object_destruction_tombstone_no_truncate"
  BEFORE TRUNCATE ON "object_destruction_tombstone"
  FOR EACH STATEMENT EXECUTE FUNCTION object_destruction_tombstone_no_truncate();--> statement-breakpoint
ALTER TABLE "object_destruction_tombstone" ENABLE ALWAYS TRIGGER "trg_object_destruction_tombstone_no_truncate";--> statement-breakpoint
REVOKE TRUNCATE ON "object_destruction_tombstone" FROM PUBLIC, chartwarden_app, chartwarden_destruction;
