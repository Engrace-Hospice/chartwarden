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
-- Hardening against defeating the guard from the app role (which holds UPDATE on claim / claim_line):
--   * trg_claim_no_revert_to_draft: no UPDATE may move a claim INTO 'DRAFT' from another state. The claim machine has no
--     transition into draft (only draft -> validating), so this forbids nothing legitimate; without it an app-role
--     session could flip a SUBMITTED claim to DRAFT and then delete it in the same transaction.
--   * trg_claim_line_no_reparent: claim_line.claim_id / organization_id are immutable (no re-parenting a line onto a
--     draft). The other seven tables already reject every UPDATE (m23_enforce_append_only_unless_draft_claim / 0079).
--   * m23_claim_is_deletable() also requires that no claim_submission or claim_acknowledgment row references the claim.
--   * Every guard function is SECURITY INVOKER with `SET search_path = pg_catalog, pg_temp` and schema-qualified
--     table references, so a TEMP table or a changed search_path cannot shadow `claim`. (No REVOKE TEMP ON DATABASE:
--     the repo has no such convention and provisioning does not manage database-level privileges.)
-- Further hardening (security re-review):
--   * `claim` is partitioned by provider_entity_id with PK (id, provider_entity_id) and no unique index on id alone, so a
--     "decoy" DRAFT row with the same id under another provider entity could satisfy an "a DRAFT row exists" check.
--     m23_claim_is_deletable() therefore also requires that NO row with that id is non-DRAFT, and
--     trg_claim_no_duplicate_id rejects a second row with an existing id under a different provider entity (no flow
--     does this: claim ids are fresh uuids generated at assembly). claim.provider_entity_id is frozen (no partition move).
--   * m23_claim_is_deletable() is VOLATILE and takes FOR SHARE on the claim row(s), so it waits for any concurrent
--     state change and then re-reads the committed state (READ COMMITTED); the application handlers additionally take
--     SELECT ... FOR UPDATE on the claim before deleting or rewriting lines.
-- DEPLOYMENT ASSUMPTION (the same one every guard in this repo makes): the migrator is a superuser or a separate table
-- OWNER, never wardenx_app (an owner could DISABLE these triggers), and wardenx_app must NEVER be granted
-- wardenx_destruction (members of it are admitted by the guards).
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
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
$$;--> statement-breakpoint

-- A claim's subtree may be deleted only while the claim is DRAFT, no row with that id is anything else, and nothing was
-- ever transmitted or acknowledged for it. VOLATILE + FOR SHARE: see the header.
CREATE OR REPLACE FUNCTION m23_claim_is_deletable(p_claim_id uuid, p_org_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.claim c WHERE c.id = p_claim_id AND c.organization_id = p_org_id FOR SHARE;
  RETURN EXISTS (SELECT 1 FROM public.claim c WHERE c.id = p_claim_id AND c.organization_id = p_org_id AND c.state = 'DRAFT')
     AND NOT EXISTS (SELECT 1 FROM public.claim c WHERE c.id = p_claim_id AND c.organization_id = p_org_id AND c.state <> 'DRAFT')
     AND NOT EXISTS (SELECT 1 FROM public.claim_submission s WHERE s.claim_id = p_claim_id)
     AND NOT EXISTS (SELECT 1 FROM public.claim_acknowledgment a WHERE a.claim_id = p_claim_id);
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF public.m23_is_destruction_role() THEN
    RETURN OLD;
  END IF;
  IF OLD.state = 'DRAFT' AND public.m23_claim_is_deletable(OLD.id, OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'M23_CLAIM_NOT_DRAFT: claim % is % (or has a submission on record) and cannot be deleted', OLD.id, OLD.state
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_delete_guard" ON "claim";--> statement-breakpoint
CREATE TRIGGER "trg_claim_delete_guard" BEFORE DELETE ON "claim"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_delete_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_no_revert_to_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id THEN
    RAISE EXCEPTION 'M23_CLAIM_IDENTITY: claim id, organization and provider entity are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state = 'DRAFT' AND OLD.state <> 'DRAFT' THEN
    RAISE EXCEPTION 'M23_CLAIM_STATE_REVERT: claim % cannot return to DRAFT from %', OLD.id, OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_no_revert_to_draft" ON "claim";--> statement-breakpoint
CREATE TRIGGER "trg_claim_no_revert_to_draft" BEFORE UPDATE ON "claim"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_no_revert_to_draft();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_no_duplicate_id() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Serialise inserters of the same id: without this, two concurrent inserts under different provider entities both
  -- pass the read below (neither sees the other's uncommitted row) and both commit. The second inserter blocks here
  -- until the first commits or aborts, then sees its row.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.id::text, 0));
  IF EXISTS (SELECT 1 FROM public.claim c WHERE c.id = NEW.id AND c.provider_entity_id <> NEW.provider_entity_id) THEN
    RAISE EXCEPTION 'M23_CLAIM_DUPLICATE_ID: a claim with id % already exists under another provider entity', NEW.id
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_no_duplicate_id" ON "claim";--> statement-breakpoint
CREATE TRIGGER "trg_claim_no_duplicate_id" BEFORE INSERT ON "claim"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_no_duplicate_id();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_line_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF public.m23_is_destruction_role() OR public.m23_claim_is_deletable(OLD.claim_id, OLD.organization_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'M23_CLAIM_NOT_DRAFT: claim_line % belongs to a claim that is not a deletable DRAFT', OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_line_delete_guard" ON "claim_line";--> statement-breakpoint
CREATE TRIGGER "trg_claim_line_delete_guard" BEFORE DELETE ON "claim_line"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_line_delete_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m23_claim_line_no_reparent() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'M23_CLAIM_LINE_REPARENT: claim_line % cannot move to another claim or organization', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_claim_line_no_reparent" ON "claim_line";--> statement-breakpoint
CREATE TRIGGER "trg_claim_line_no_reparent" BEFORE UPDATE ON "claim_line"
  FOR EACH ROW EXECUTE FUNCTION m23_claim_line_no_reparent();--> statement-breakpoint

-- Append-only children: UPDATE always rejected; DELETE only for a row owned by a deletable DRAFT claim. TG_ARGV[0] says
-- how the row reaches its claim: 'claim' (own claim_id), 'run' (validation_run_id), 'result' (result_id via
-- validation_result). Fail closed: an unresolvable owner is not a draft.
CREATE OR REPLACE FUNCTION m23_enforce_append_only_unless_draft_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_row jsonb := to_jsonb(OLD);
  v_claim uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_ARGV[0] = 'claim' THEN
      v_claim := (v_row ->> 'claim_id')::uuid;
    ELSIF TG_ARGV[0] = 'run' THEN
      SELECT r.claim_id INTO v_claim FROM public.validation_run r
       WHERE r.id = (v_row ->> 'validation_run_id')::uuid AND r.organization_id = OLD.organization_id;
    ELSIF TG_ARGV[0] = 'result' THEN
      SELECT r.claim_id INTO v_claim FROM public.validation_result vr
        JOIN public.validation_run r ON r.id = vr.validation_run_id AND r.organization_id = vr.organization_id
       WHERE vr.id = (v_row ->> 'result_id')::uuid AND vr.organization_id = OLD.organization_id;
    END IF;
    IF v_claim IS NOT NULL AND public.m23_claim_is_deletable(v_claim, OLD.organization_id) THEN
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
