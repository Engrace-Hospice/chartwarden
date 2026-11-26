-- compat: expand
-- M22 (CW-DS-01): the durable record that an object was destroyed. A brand-new table the previous release never reads or writes, so
-- this is a pure expand.
--
-- WHY. A document erase (a destruction certificate, D12) destroys every version of the object in the primary store and deletes the
-- rows. Nothing remembered THAT it did: a restore from a second copy, a hand-loaded backup or a store that was re-provisioned brings
-- the destroyed objects back, and the restore tooling had nothing to check them against. This table is that memory: one row per
-- destroyed (bucket, object key), written BEFORE the object is destroyed (so a crash mid-erase still leaves the record) and never
-- changed. `scripts/storage/object-tombstones.ts` exports it and `scripts/object-store-copy.ts --tombstones` applies it on both the
-- forward copy and a restore. An object under an active legal hold, or a 42 CFR Part 2 document, is never destroyed and so never
-- gets a row.
--
--   object_key        the opaque D11 key (documents/<patientId>/...): it carries the patient's id, so the audit snapshot below scrubs it.
--   document_id,
--   document_version_id   plain uuids, NO foreign key: the document rows are deleted right after, and the record must outlive them.
--   bucket            pinned by CHECK to the tenant's own bucket (`tenant-<organization_id>`), so the destruction role cannot write a
--                     tombstone aimed at another tenant's bucket even with its policy.
--
-- Tenancy, audit and roles: the 1529 (encounter_nutrition) pattern, except the table is APPEND-ONLY for every role.
CREATE TABLE "object_destruction_tombstone" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "document_id" uuid,
  "document_version_id" uuid,
  "basis" text DEFAULT 'patient_erasure' NOT NULL,
  "destroyed_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "object_destruction_tombstone_object_unique" UNIQUE ("organization_id", "bucket", "object_key"),
  CONSTRAINT "object_destruction_tombstone_tenant_bucket" CHECK (bucket = 'tenant-' || organization_id::text),
  CONSTRAINT "object_destruction_tombstone_key_present" CHECK (length(object_key) > 0),
  CONSTRAINT "object_destruction_tombstone_basis" CHECK (basis IN ('patient_erasure'))
);--> statement-breakpoint

ALTER TABLE "object_destruction_tombstone" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "object_destruction_tombstone" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The application role may only READ its own tenant's tombstones (it never destroys objects itself): SELECT is the whole grant below.
CREATE POLICY "object_destruction_tombstone_org_isolation" ON "object_destruction_tombstone"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT ON "object_destruction_tombstone" TO chartwarden_app;--> statement-breakpoint

-- Append-only for every role: UPDATE and DELETE are refused by a trigger that fires for a superuser too and is ENABLE ALWAYS (so
-- `session_replication_role = replica` does not skip it). The limits, as for every guard in this schema: no application or destruction
-- role holds TRUNCATE (the grants below give none), but the table owner or a superuser can still TRUNCATE it, and a database
-- administrator who deliberately DROPs or DISABLEs the trigger, or drops the table, can remove rows.
CREATE OR REPLACE FUNCTION object_destruction_tombstone_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'object_destruction_tombstone: a tombstone is append-only (it cannot be updated or deleted)' USING ERRCODE = '23514';
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_object_destruction_tombstone_append_only"
  BEFORE UPDATE OR DELETE ON "object_destruction_tombstone"
  FOR EACH ROW EXECUTE FUNCTION object_destruction_tombstone_append_only();--> statement-breakpoint
ALTER TABLE "object_destruction_tombstone" ENABLE ALWAYS TRIGGER "trg_object_destruction_tombstone_append_only";--> statement-breakpoint

-- A tombstone is destruction evidence that is later APPLIED to copies and restores, so it cannot be planted: it must name an object a
-- document version of the SAME organization really records. The eraser writes it before it deletes those rows (and a held document's
-- rows are never deleted), so it always matches; a row for any other key, or another tenant's, is refused here, not just by the policy.
CREATE OR REPLACE FUNCTION object_destruction_tombstone_names_a_version() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.document_version v
     WHERE v.organization_id = NEW.organization_id AND v.object_key = NEW.object_key
  ) THEN
    RAISE EXCEPTION 'object_destruction_tombstone: no document version of this organization records that object key' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_object_destruction_tombstone_names_a_version"
  BEFORE INSERT ON "object_destruction_tombstone"
  FOR EACH ROW EXECUTE FUNCTION object_destruction_tombstone_names_a_version();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_object_destruction_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_after jsonb;
BEGIN
  v_after := public.audit_scrub(to_jsonb(NEW), ARRAY['object_key']::text[]);
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
    NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, v_after,
    '{}'::jsonb,
    'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_object_destruction_tombstone() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_object_destruction_tombstone"
  AFTER INSERT ON object_destruction_tombstone
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_object_destruction_tombstone();--> statement-breakpoint

-- The destruction role records a tombstone for one organization (the eraser runs as this role): read and INSERT, no UPDATE, no DELETE.
GRANT SELECT, INSERT ON "object_destruction_tombstone" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "object_destruction_tombstone_destruction" ON "object_destruction_tombstone"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
