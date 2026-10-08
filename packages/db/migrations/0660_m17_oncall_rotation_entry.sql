-- GAP-029 — M17 owns the on-call rotation source M19's roster-sync reads through
-- `VisitAssignmentReader.tonightsOnCallRoster` (M17 spec §4.3). Until now M17 owned no such table, so the
-- reader refused unconditionally and M19's shift-sync was permanently degraded.
--
-- One row = one person covering one discipline over one window. STAFF-scoped (organization_id + membership_id
-- only; the `membership_credential` precedent, migration 0191 — PE/location are attributes of a patient
-- visit, and M19 fans a roster entry out per ProviderEntity itself). Rows are cancelled, never deleted
-- (`cancelled_at`), so the sync can tell "the roster dropped this" from "this was never on the roster".
CREATE TABLE IF NOT EXISTS "oncall_rotation_entry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "discipline" text NOT NULL,
  "starts_at" timestamptz NOT NULL,
  "ends_at" timestamptz NOT NULL,
  "created_by_membership_id" uuid NOT NULL,
  "cancelled_at" timestamptz,
  "cancelled_by_membership_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "oncall_rotation_entry_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "oncall_rotation_entry_membership_fk"
    FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE cascade,
  CONSTRAINT "oncall_rotation_entry_window_chk" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "oncall_rotation_entry_discipline_chk"
    CHECK ("discipline" IN ('clinical_rn', 'clinical_lpn', 'medical_director', 'msw', 'chaplain')),
  CONSTRAINT "oncall_rotation_entry_cancelled_chk"
    CHECK (("cancelled_at" IS NULL) = ("cancelled_by_membership_id" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oncall_rotation_entry_current_uq"
  ON "oncall_rotation_entry" ("organization_id", "membership_id", "discipline", "starts_at", "ends_at")
  WHERE "cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oncall_rotation_entry_roster_idx"
  ON "oncall_rotation_entry" ("organization_id", "ends_at")
  WHERE "cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oncall_rotation_entry_membership_idx"
  ON "oncall_rotation_entry" ("membership_id");--> statement-breakpoint
ALTER TABLE "oncall_rotation_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oncall_rotation_entry" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "oncall_rotation_entry_org" ON "oncall_rotation_entry";--> statement-breakpoint
CREATE POLICY "oncall_rotation_entry_org" ON "oncall_rotation_entry"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "oncall_rotation_entry" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "oncall_rotation_entry" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "oncall_rotation_entry_audit"
  AFTER INSERT OR UPDATE OR DELETE ON oncall_rotation_entry
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
