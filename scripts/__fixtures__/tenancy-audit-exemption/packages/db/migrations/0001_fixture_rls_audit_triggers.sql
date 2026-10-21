-- FIXTURE — intentional violation. This file has the exact shape of a real WardenX migration:
-- a module's RLS policies and its generated write-audit trigger, together, in one file
-- (`*_rls_audit_triggers.sql` is the repo's own naming convention for it).
--
-- Under the FILE-scoped exemption that shipped before #22, the `INSERT INTO audit_event` below
-- exempted every `current_setting('app.user_id')` in the whole file — the policy predicate
-- included — and check-tenancy.ts reported this file as clean. That is how `user_notif_pref_self`
-- (#21, a confirmed cross-tenant read AND write) sat green in `0017` for the life of the repo.
--
-- The gate must now report `fixture_note_self` and stay silent about the trigger.

-- 1. The generated write-audit trigger. Its attribution GUCs are NOT RLS predicates (M04 §3.3) and
--    must REMAIN exempt — deleting the exemption instead of scoping it would be the other failure.
CREATE OR REPLACE FUNCTION audit_phi_write_fixture_note() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO audit_event (actor_user_id, correlation_id, provider_entity_id, location_id)
  VALUES (
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    NULLIF(current_setting('app.correlation_id', true), '')::uuid,
    NULLIF(current_setting('app.provider_entity_id', true), '')::uuid,
    NULLIF(current_setting('app.location_id', true), '')::uuid
  );
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER trg_audit_fixture_note AFTER INSERT OR UPDATE OR DELETE ON fixture_note
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_fixture_note();--> statement-breakpoint

-- 2. THE VIOLATION — an org-scoped table whose only tenant policy keys on the USER and nothing else.
ALTER TABLE "fixture_note" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY fixture_note_self ON fixture_note
  FOR ALL TO chartwarden_app
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

-- 3. NOT a violation — the same user key as a CONJUNCT beside the org predicate. This is the shape
--    #21 was remediated into, and it is defence in depth, not a hole. It must not be reported.
CREATE POLICY fixture_ok_self ON fixture_ok
  FOR ALL TO chartwarden_app
  USING (
    organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );--> statement-breakpoint

-- 4. Violating when created, DROPped and replaced by 0002 — the end state is what counts.
CREATE POLICY fixture_superseded_self ON fixture_super
  FOR ALL TO chartwarden_app
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
