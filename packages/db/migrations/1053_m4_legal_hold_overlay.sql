-- 1053 - M4 GAP-008: legal-hold supremacy over the append-only audit trail, as an OVERLAY (ADR-0051).
--
-- Architecture 24.3 and M4 2.6 / 10.6 say matching records are "flipped to legal_hold". That cannot be a column write:
--   * `wardenx_app` holds no UPDATE on `audit_event` (0001's append-only guarantee), and
--   * `retention_class` is part of the INTEGRITY HASH - db-chain-reader.ts selects it and feeds it to `hashAuditRow`, and
--     the monthly seal (`audit_seal`) covers it. Mutating the column on apply and again on release would break chain
--     verification for every sealed month it touched and turn the tamper-detection job (M4 10.4) into a false-positive
--     generator, destroying its value as evidence.
-- What the architecture needs is "retention and erasure skip held records, and reporting shows them as held". An
-- append-only OVERLAY gives exactly that with no mutation of any audit row:
--   `legal_hold_audit_event`   one row per (hold, audit row), written by a tenant-context job that matches the hold's
--                              criteria in day windows (packages/audit hold-overlay.ts). No released_at: a row is
--                              "held" while its legal_hold.status = 'active', so releasing the hold is the single
--                              existing UPDATE and takes effect for every row at once. Overlay rows stay as history.
--   DELETE guard               the only DELETE path (drizzle-erase.ts) excludes held rows, and a BEFORE DELETE trigger on
--                              `audit_event` refuses any row that is held, whoever deletes it - a backstop for a bug or an
--                              out-of-band delete. Not covered, stated plainly: DROP / TRUNCATE of a partition or
--                              session_replication_role = replica by a superuser (procedural control); M1 never drops.
--   `audit_event_effective`    a security_invoker view exposing effective_retention_class = 'legal_hold' for held rows.
-- Un-materialised rows (written after the hold, or before the job caught up) are still covered by the existing structural
-- group check (`holdCoversGroup`, GAP-008), so supremacy never depends on the job being current.
--
-- The new table is named `legal_hold_audit_event`, NOT `audit_event_*`: `wardenx_audit_trigger()` skips every table whose
-- name starts with `audit_event` (its recursion guard), so an `audit_event_hold` table could never be audited.

-- 1. Materialisation state on the hold. Pre-existing active holds default to 'pending', so the reconcile job backfills
--    their overlay on its first tick.
ALTER TABLE "legal_hold"
  ADD COLUMN IF NOT EXISTS "materialisation_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "materialised_through" timestamptz,
  ADD COLUMN IF NOT EXISTS "materialised_count" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "legal_hold" DROP CONSTRAINT IF EXISTS "chk_legal_hold_materialisation_status";--> statement-breakpoint
ALTER TABLE "legal_hold"
  ADD CONSTRAINT "chk_legal_hold_materialisation_status"
  CHECK ("materialisation_status" IN ('pending', 'running', 'complete', 'failed'));--> statement-breakpoint

-- 2. The overlay. No FK to the partitioned `audit_event` (it would block deletes and complicate partition detach); the
--    (audit_event_id, audit_event_created_at) pair is the row's identity across the partition key.
CREATE TABLE IF NOT EXISTS "legal_hold_audit_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "legal_hold_id" uuid NOT NULL REFERENCES "legal_hold"("id") ON DELETE RESTRICT,
  "audit_event_id" uuid NOT NULL,
  "audit_event_created_at" timestamptz NOT NULL,
  "held_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_legal_hold_audit_event"
  ON "legal_hold_audit_event" ("legal_hold_id", "audit_event_id", "audit_event_created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_legal_hold_audit_event_row"
  ON "legal_hold_audit_event" ("organization_id", "audit_event_id", "audit_event_created_at");--> statement-breakpoint

ALTER TABLE "legal_hold_audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_hold_audit_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "legal_hold_audit_event_org" ON "legal_hold_audit_event";--> statement-breakpoint
CREATE POLICY "legal_hold_audit_event_org" ON "legal_hold_audit_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The destruction credential reads the overlay inside its own DELETE (the NOT EXISTS guard), pinned to the context org.
DROP POLICY IF EXISTS "legal_hold_audit_event_destruction" ON "legal_hold_audit_event";--> statement-breakpoint
CREATE POLICY "legal_hold_audit_event_destruction" ON "legal_hold_audit_event"
  FOR ALL TO wardenx_destruction
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- The DELETE-guard trigger function below is SECURITY DEFINER owned by wardenx_admin, and must see EVERY tenant's rows
-- whatever RLS context the deleting session carries (a missing GUC must not read as "no hold"): its dedicated policy.
DROP POLICY IF EXISTS "legal_hold_audit_event_admin_all" ON "legal_hold_audit_event";--> statement-breakpoint
CREATE POLICY "legal_hold_audit_event_admin_all" ON "legal_hold_audit_event"
  FOR ALL TO wardenx_admin USING (true) WITH CHECK (true);--> statement-breakpoint
DROP POLICY IF EXISTS "legal_hold_admin_read" ON "legal_hold";--> statement-breakpoint
CREATE POLICY "legal_hold_admin_read" ON "legal_hold"
  FOR SELECT TO wardenx_admin USING (true);--> statement-breakpoint

-- Append-only for the tenant role: it can record that a row is held, never un-hold one.
GRANT SELECT, INSERT ON "legal_hold_audit_event" TO wardenx_app;--> statement-breakpoint
GRANT SELECT ON "legal_hold_audit_event" TO wardenx_destruction;--> statement-breakpoint
GRANT ALL ON "legal_hold_audit_event" TO wardenx_admin;--> statement-breakpoint

-- The overlay is bulk-written by the materialiser, so auditing every INSERT would write one audit row per held row (the
-- hold's own apply / release are audited, with counts). What IS audited is anything that changes or removes an overlay row:
-- the app role cannot, so this fires only for an administrative correction - exactly the event worth a trail.
CREATE TRIGGER "legal_hold_audit_event_audit" AFTER UPDATE OR DELETE ON legal_hold_audit_event
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- 3. Reporting: the effective retention class (a held row reads 'legal_hold'); the hashed base column is untouched.
CREATE OR REPLACE VIEW "audit_event_effective" WITH (security_invoker = true) AS
SELECT a.*,
       CASE
         WHEN EXISTS (
           SELECT 1
             FROM legal_hold_audit_event h
             JOIN legal_hold l ON l.id = h.legal_hold_id AND l.status = 'active'
            WHERE h.organization_id = a.organization_id
              AND h.audit_event_id = a.id
              AND h.audit_event_created_at = a.created_at
         ) THEN 'legal_hold'
         ELSE a.retention_class::text
       END AS effective_retention_class
  FROM audit_event a;--> statement-breakpoint
GRANT SELECT ON "audit_event_effective" TO wardenx_app, wardenx_destruction, wardenx_admin;--> statement-breakpoint

-- 4. The DELETE backstop. SECURITY DEFINER owned by wardenx_admin with a pinned search_path (the 0224 / 0432 pattern), so it
--    sees the overlay whatever RLS context the destruction credential carries. A BEFORE ROW trigger on the partitioned
--    parent is cloned onto every monthly leaf (and onto leaves created later). `audit_event_audit` is an AFTER trigger that
--    is a no-op for audit tables (its recursion guard), so there is no recursion or ordering hazard, and the exception
--    raised here writes no audit row.
CREATE OR REPLACE FUNCTION audit_event_legal_hold_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.organization_id IS NOT NULL AND EXISTS (
       SELECT 1
         FROM legal_hold_audit_event h
         JOIN legal_hold l ON l.id = h.legal_hold_id AND l.status = 'active'
        WHERE h.organization_id = OLD.organization_id
          AND h.audit_event_id = OLD.id
          AND h.audit_event_created_at = OLD.created_at
     ) THEN
    RAISE EXCEPTION 'audit_event row % is under an active legal hold and cannot be deleted', OLD.id
      USING ERRCODE = '23001',
            HINT = 'release the legal hold first (M4 spec 10.6: a legal hold outranks retention and erasure)';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
ALTER FUNCTION audit_event_legal_hold_guard() OWNER TO wardenx_admin;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_event_legal_hold_guard() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_event_legal_hold_guard" ON audit_event;--> statement-breakpoint
CREATE TRIGGER "audit_event_legal_hold_guard" BEFORE DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_legal_hold_guard();--> statement-breakpoint

-- 5. Partition detach refuses a partition that holds actively-held rows unless the caller attests that the archive
--    manifest was written AND read back verified (the archive job passes true only after `putAndVerify` of the manifest).
--    Detach is not destruction (the partition is kept, never dropped), but a held row leaving the hot table must already be
--    safe in a verified archive. The old two-argument function is DROPPED so it cannot be called to skip the check.
DROP FUNCTION IF EXISTS audit_archive_detach(text, bigint);--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_archive_detach(
  p_partition text,
  p_expected_rows bigint,
  p_manifest_verified boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  actual bigint;
  held bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_archive_closed_partitions() c WHERE c.partition_name = p_partition) THEN
    RAISE EXCEPTION 'audit_archive_detach: % is not a closed audit_event partition', p_partition;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I', p_partition) INTO actual;
  IF actual <> p_expected_rows THEN
    RAISE EXCEPTION 'audit_archive_detach: % holds % rows but % were archived - refusing to detach',
      p_partition, actual, p_expected_rows;
  END IF;
  EXECUTE format(
    'SELECT count(*) FROM %I p WHERE EXISTS (
       SELECT 1 FROM legal_hold_audit_event h
         JOIN legal_hold l ON l.id = h.legal_hold_id AND l.status = ''active''
        WHERE h.organization_id = p.organization_id
          AND h.audit_event_id = p.id
          AND h.audit_event_created_at = p.created_at)', p_partition) INTO held;
  IF held > 0 AND NOT COALESCE(p_manifest_verified, false) THEN
    RAISE EXCEPTION 'audit_archive_detach: % holds % row(s) under an active legal hold - refusing to detach without a verified archive manifest',
      p_partition, held
      USING ERRCODE = '23001';
  END IF;
  EXECUTE format('ALTER TABLE audit_event DETACH PARTITION %I', p_partition);
  RETURN 'detached';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_archive_detach(text, bigint, boolean) FROM PUBLIC;--> statement-breakpoint
COMMENT ON FUNCTION audit_archive_detach(text, bigint, boolean) IS
  'GAP-113 / GAP-008: detach a closed audit_event partition after it was archived and verified; refuses on a row-count mismatch, and refuses a partition holding actively-held rows unless the verified archive manifest is attested. Never drops.';
