-- F-071 (#174) — M37 §2.3 D3: give the RN-coverage break-glass override somewhere to live.
--
-- WHAT WAS BROKEN. `invokeRnBreakGlass` published one outbox event and wrote nothing:
--
--     // … there is no dedicated persistence table, so the ABAC predicate reads the coverage window
--     // + this event stream.
--     await outbox.publish(tx, { eventName: "m37.rn_coverage.break_glass_invoked", … });
--     return { unitId, invoked: true };
--
-- That comment describes a reader that no longer exists. The `m37.ipu.rn_coverage_active` ABAC predicate
-- it names was REMOVED (`ipu.routes.ts` explains why: `requireAbac`'s `getTarget` is synchronous and
-- cannot query a table, so it saw an empty target and denied every caller unconditionally). The
-- service-layer coverage check that replaced it reads ONLY `ipu_rn_coverage_window` and never an event
-- stream. So break-glass was a 200 that changed no gate's answer — the documented escape hatch from a
-- state that blocks admission, transfer and restraint, itself inert.
--
-- WHY A SEPARATE TABLE, AND NOT `is_covered = true` ON THE COVERAGE WINDOW. The window answers exactly
-- one question — "was an RN on duty for this hour?" — and the spec calls it "the platform's only
-- computational answer to *was an RN on duty every hour of last quarter?*". Writing an override into it
-- would make a surveyor's coverage report say an RN was present when one was not. The override is a
-- DIFFERENT fact: a named person accepted the risk of operating uncovered, for a bounded window, with a
-- reason. Keeping them apart is what lets the gate pass while the compliance record still shows the gap.
--
-- SHAPE follows `device_attestation` (0222) and `membership_elevated_approval` (0204): one LIVE row per
-- unit via a partial unique index, expired and revoked rows retained in place as the trail. STAFF-scoped,
-- so `organization_id` only — the ARCH-011 three-column rule scopes PHI-bearing tables, and "this unit ran
-- short-staffed between 02:00 and 06:00" names no patient.
CREATE TABLE IF NOT EXISTS "ipu_rn_break_glass" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "unit_id" uuid NOT NULL,
  "invoked_by_membership_id" uuid NOT NULL,
  "invoked_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "reason" text NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by_membership_id" uuid,
  "version" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ipu_rn_break_glass_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "ipu_rn_break_glass_unit_fk"
    FOREIGN KEY ("unit_id") REFERENCES "inpatient_unit"("id") ON DELETE restrict,
  -- An override MUST expire. §2.3 caps it at 4 hours; a break-glass with no horizon is a policy change
  -- made by one person in a hurry, which is the opposite of what breaking glass means.
  CONSTRAINT "ipu_rn_break_glass_window_ordered" CHECK ("expires_at" > "invoked_at"),
  CONSTRAINT "ipu_rn_break_glass_max_window" CHECK (
    "expires_at" <= "invoked_at" + interval '4 hours'
  ),
  -- A reason a surveyor can read. The same floor `ipu_restraint_event` uses for its justification, scaled
  -- to a staffing decision rather than a clinical one.
  CONSTRAINT "ipu_rn_break_glass_reason_min" CHECK (length(btrim("reason")) >= 40),
  -- Revocation is all-or-nothing (the 0204/0222 invariant): "revoked, by nobody" makes the trail useless.
  CONSTRAINT "ipu_rn_break_glass_revocation_consistent" CHECK (
    ("revoked_at" IS NULL AND "revoked_by_membership_id" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by_membership_id" IS NOT NULL)
  )
);--> statement-breakpoint
-- At most one LIVE override per unit. A second invocation while one is running is a no-op the route
-- reports, not a stacked extension — otherwise "break glass again" silently becomes an unbounded window.
CREATE UNIQUE INDEX IF NOT EXISTS "ipu_rn_break_glass_live_uq"
  ON "ipu_rn_break_glass" ("organization_id", "unit_id")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ipu_rn_break_glass_unit_expiry_idx"
  ON "ipu_rn_break_glass" ("unit_id", "expires_at")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "ipu_rn_break_glass" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ipu_rn_break_glass" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "ipu_rn_break_glass_org" ON "ipu_rn_break_glass";--> statement-breakpoint
CREATE POLICY "ipu_rn_break_glass_org" ON "ipu_rn_break_glass"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- No DELETE grant: an override is revoked or expires, never erased. "Did anyone override the RN-coverage
-- requirement last quarter, and who?" is precisely the question a post-incident review asks.
GRANT SELECT, INSERT, UPDATE ON "ipu_rn_break_glass" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "ipu_rn_break_glass" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "ipu_rn_break_glass_audit"
  AFTER INSERT OR UPDATE OR DELETE ON ipu_rn_break_glass
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
