-- M23 — a DRAFT claim can be deleted (DELETE /billing/claims/:id) and re-assembled (PUT /billing/claims/:id).
--
-- ROOT CAUSE. 0077 granted `wardenx_app` only SELECT/INSERT/UPDATE on `claim` and `claim_line` ("rows are never
-- SQL-deleted") and 0079 made the compliance-evidence children append-only for everyone. But two shipped
-- code paths legitimately remove rows of a claim that has never left DRAFT: `deleteDraftClaim` (discard an unbilled
-- draft) and `updateDraftClaim` (re-assembly rewrites the lines). Both died with 42501 `permission denied for table
-- claim_line`. M24 solved the same need (0096) with a bare DELETE grant on its line tables; that is not enough here,
-- because (a) a bare grant would let the app role erase the lines/claim of a SUBMITTED or PAID claim, which is exactly
-- what "rows are never SQL-deleted" protects, and (b) a draft assembled by `claim-assembly.ts` also owns append-only
-- children (hipps_calculation, sia_calculation, validation_run/result/override, claim_state_history) that a delete of
-- the claim would otherwise orphan or be blocked by.
--
-- FIX (least privilege, enforced in the database, not the handler):
--   1. DELETE is granted to `wardenx_app` on claim, claim_line and the six draft-owned children. RLS is unchanged:
--      the existing FORCEd `<table>_org` policies are FOR ALL, so DELETE is org-scoped by `app.org_id` exactly like
--      SELECT/INSERT/UPDATE (a cross-tenant delete matches zero rows).
--   2. A BEFORE DELETE guard on `claim` and `claim_line` admits a delete only while the claim is DRAFT. The
--      `wardenx_destruction` erase role (0157) is admitted unconditionally (the compliance-class erasure cascade,
--      a NON-superuser member only, the 1056 shape) so the per-patient eraser is unchanged.
--   3. The six append-only children keep rejecting UPDATE outright and now admit DELETE only when the owning claim is
--      DRAFT (`m23_enforce_append_only_unless_draft_claim`). `claim_submission` / `claim_acknowledgment` keep the
--      unconditional `m23_enforce_append_only`: a draft has none, and a transmitted claim's wire record is never
--      deletable. Every delete still lands in `audit_event` (compliance class) through the existing M4 triggers, so
--      the evidence that a draft existed and was discarded is preserved there.
-- Delete order (children first, so each guard can still resolve its owning claim): validation_override ->
-- validation_result -> validation_run -> claim_state_history -> sia_calculation -> hipps_calculation -> claim_line ->
-- claim. Idempotent.

GRANT DELETE ON "claim" TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON "claim_line" TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON "claim_state_history" TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON "validation_run" TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON "validation_result" TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON "validation_override" TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON "hipps_calculation" TO wardenx_app;--> statement-breakpoint
GRANT DELETE ON "sia_calculation" TO wardenx_app;--> statement-breakpoint

-- The erase role on the guarded tables (the 1056 shape): a NON-superuser member of wardenx_destruction only.
CREATE OR REPLACE FUNCTION m23_is_destruction_role() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF m23_is_destruction_role() OR OLD.state = 'DRAFT' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'M23_CLAIM_NOT_DRAFT: claim % is % and cannot be deleted (only a DRAFT claim may be)', OLD.id, OLD.state
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_delete_guard" ON "claim";--> statement-breakpoint
CREATE TRIGGER "trg_claim_delete_guard" BEFORE DELETE ON "claim"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_delete_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_line_delete_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF m23_is_destruction_role() THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM claim c WHERE c.id = OLD.claim_id AND c.organization_id = OLD.organization_id AND c.state = 'DRAFT') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'M23_CLAIM_NOT_DRAFT: claim_line % belongs to a claim that is not DRAFT and cannot be deleted', OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_line_delete_guard" ON "claim_line";--> statement-breakpoint
CREATE TRIGGER "trg_claim_line_delete_guard" BEFORE DELETE ON "claim_line"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_line_delete_guard();--> statement-breakpoint

-- Append-only children: UPDATE always rejected; DELETE only for a row owned by a DRAFT claim. TG_ARGV[0] says how the
-- row reaches its claim: 'claim' (own claim_id), 'run' (validation_run_id), 'result' (result_id via validation_result).
-- Fail closed: an unresolvable owner is not a draft.
CREATE OR REPLACE FUNCTION m23_enforce_append_only_unless_draft_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_row jsonb := to_jsonb(OLD);
  v_claim uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_ARGV[0] = 'claim' THEN
      v_claim := (v_row ->> 'claim_id')::uuid;
    ELSIF TG_ARGV[0] = 'run' THEN
      SELECT r.claim_id INTO v_claim FROM validation_run r
       WHERE r.id = (v_row ->> 'validation_run_id')::uuid AND r.organization_id = OLD.organization_id;
    ELSIF TG_ARGV[0] = 'result' THEN
      SELECT r.claim_id INTO v_claim FROM validation_result vr
        JOIN validation_run r ON r.id = vr.validation_run_id AND r.organization_id = vr.organization_id
       WHERE vr.id = (v_row ->> 'result_id')::uuid AND vr.organization_id = OLD.organization_id;
    END IF;
    IF v_claim IS NOT NULL AND EXISTS (
      SELECT 1 FROM claim c WHERE c.id = v_claim AND c.organization_id = OLD.organization_id AND c.state = 'DRAFT'
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'M23_TABLE_APPEND_ONLY: % is append-only; % is forbidden (only a delete of a DRAFT claim''s own rows is permitted; corrections go through the D14 replacement chain)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_append_only_claim_state_history" ON "claim_state_history";--> statement-breakpoint
CREATE TRIGGER "trg_append_only_claim_state_history" BEFORE UPDATE OR DELETE ON "claim_state_history"
  FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only_unless_draft_claim('claim');--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_append_only_hipps_calculation" ON "hipps_calculation";--> statement-breakpoint
CREATE TRIGGER "trg_append_only_hipps_calculation" BEFORE UPDATE OR DELETE ON "hipps_calculation"
  FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only_unless_draft_claim('claim');--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_append_only_sia_calculation" ON "sia_calculation";--> statement-breakpoint
CREATE TRIGGER "trg_append_only_sia_calculation" BEFORE UPDATE OR DELETE ON "sia_calculation"
  FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only_unless_draft_claim('claim');--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_append_only_validation_run" ON "validation_run";--> statement-breakpoint
CREATE TRIGGER "trg_append_only_validation_run" BEFORE UPDATE OR DELETE ON "validation_run"
  FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only_unless_draft_claim('claim');--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_append_only_validation_result" ON "validation_result";--> statement-breakpoint
CREATE TRIGGER "trg_append_only_validation_result" BEFORE UPDATE OR DELETE ON "validation_result"
  FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only_unless_draft_claim('run');--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_append_only_validation_override" ON "validation_override";--> statement-breakpoint
CREATE TRIGGER "trg_append_only_validation_override" BEFORE UPDATE OR DELETE ON "validation_override"
  FOR EACH ROW EXECUTE FUNCTION m23_enforce_append_only_unless_draft_claim('result');
