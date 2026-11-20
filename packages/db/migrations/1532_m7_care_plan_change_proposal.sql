-- compat: expand
-- M7 (WF09): a change to the plan of care that a clinician records while documenting a visit. A brand-new table the previous release never
-- reads or writes, so this is a pure expand.
--
--   care_plan_change_proposal  one row per proposed change. `draft` while the visit note is being written (visible to its proposer only),
--                              `pending` once the visit is finalized (the plan's review list), then `accepted` / `dismissed`;
--                              `withdrawn` is a draft the author discarded or whose visit was voided. A proposal is NOT a problem / goal /
--                              intervention: nothing that reads the plan can see it, so a visit never edits the signed plan.
--
-- source_encounter_id is a logical reference (M7 takes no M8 dependency). target_element_id, problem_id and result_element_id each may name
-- a problem, a goal or an intervention, so they are plain uuids the application validates; parent_proposal_id lets a goal or intervention
-- hang off a problem that is itself still a proposal. Values are text + CHECK (no pg enums), so a value set can widen later without ALTER TYPE;
-- the lists mirror the CARE_PLAN_CHANGE_PROPOSAL_* constants of packages/db/src/schema/care-plan/change-proposals.ts and
-- care-plan-change-proposal-rules.test.ts fails when either side drifts.
--
-- Tenancy: PHI, so the three columns. provider_entity_id / location_id are nullable and denormalized from the plan, like `problem`. RLS keys
-- on app.org_id alone, ENABLEd and FORCEd. Free text (description, goal_text, measurable_outcome, revised_text, resolution_note, scope_text,
-- frequency_text, frequency_value, responsible_role, discontinue_reason) and the diagnosis codes (icd10_code, snomed_code: a SUD diagnosis code on a Part 2
-- proposal is as identifying as its description) are stored like the element they become and are scrubbed from the write-audit snapshot.
-- Foreign keys: organization_id and care_plan_id lead an index, parent_proposal_id has a partial one; the membership and siting stamps
-- reference soft-deleted parents (the fk-index-coverage rule sanctions those unindexed).
-- Roles are the post-1139 names (chartwarden_*).
CREATE TABLE "care_plan_change_proposal" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "care_plan_id" uuid NOT NULL REFERENCES "care_plan"("id") ON DELETE RESTRICT,
  "patient_id" uuid NOT NULL,
  "source_encounter_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "sud_related" boolean DEFAULT false NOT NULL,
  "target_element_id" uuid,
  "problem_id" uuid,
  "parent_proposal_id" uuid REFERENCES "care_plan_change_proposal"("id"),
  "goal_refs" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "description" text,
  "icd10_code" text,
  "snomed_code" text,
  "problem_kind" text,
  "problem_source" text,
  "onset_at" timestamptz,
  "resolution_note" text,
  "goal_text" text,
  "goal_source" text,
  "measurable_outcome" text,
  "target_at" timestamptz,
  "revised_text" text,
  "goal_status" text,
  "scope_text" text,
  "frequency_text" text,
  "frequency_value" text,
  "discipline" text,
  "responsible_role" text,
  "discontinue_reason" text,
  "proposed_by_membership_id" uuid NOT NULL REFERENCES "membership"("id"),
  "released_at" timestamptz,
  "decided_by_membership_id" uuid REFERENCES "membership"("id"),
  "decided_at" timestamptz,
  "result_element_id" uuid,
  "dismissal_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "care_plan_change_proposal_kind_known" CHECK (kind IN ('problem_add', 'problem_resolve', 'goal_add', 'goal_update', 'intervention_add', 'intervention_discontinue')),
  CONSTRAINT "care_plan_change_proposal_status_known" CHECK (status IN ('draft', 'pending', 'accepted', 'dismissed', 'withdrawn')),
  CONSTRAINT "care_plan_change_proposal_problem_kind_known" CHECK (problem_kind IS NULL OR problem_kind IN ('terminal', 'related', 'unrelated')),
  CONSTRAINT "care_plan_change_proposal_problem_source_known" CHECK (problem_source IS NULL OR problem_source IN ('clinical', 'patient_reported', 'family_reported', 'history')),
  CONSTRAINT "care_plan_change_proposal_goal_source_known" CHECK (goal_source IS NULL OR goal_source IN ('clinical', 'patient_stated', 'family_stated')),
  CONSTRAINT "care_plan_change_proposal_goal_status_known" CHECK (goal_status IS NULL OR goal_status IN ('in_progress', 'met', 'not_met', 'revised', 'discontinued')),
  CONSTRAINT "care_plan_change_proposal_discipline_known" CHECK (discipline IS NULL OR discipline IN ('rn', 'lpn', 'chha', 'msw', 'chaplain', 'md_np', 'pt', 'ot', 'st', 'volunteer', 'music_therapy', 'dietitian', 'bereavement')),
  CONSTRAINT "care_plan_change_proposal_dismissal_reason_known" CHECK (dismissal_reason IS NULL OR dismissal_reason IN ('not_clinically_appropriate', 'already_addressed', 'duplicate', 'entered_in_error', 'defer_to_idg')),
  -- Each kind carries exactly what the manual Care Plans route for that kind needs.
  CONSTRAINT "care_plan_change_proposal_shape_problem_add" CHECK (kind <> 'problem_add' OR (
    target_element_id IS NULL AND problem_id IS NULL AND parent_proposal_id IS NULL
    AND description IS NOT NULL AND problem_kind IS NOT NULL AND problem_source IS NOT NULL)),
  CONSTRAINT "care_plan_change_proposal_shape_problem_resolve" CHECK (kind <> 'problem_resolve' OR (
    target_element_id IS NOT NULL AND problem_id IS NULL AND parent_proposal_id IS NULL
    AND resolution_note IS NOT NULL)),
  CONSTRAINT "care_plan_change_proposal_shape_goal_add" CHECK (kind <> 'goal_add' OR (
    target_element_id IS NULL AND goal_text IS NOT NULL AND goal_source IS NOT NULL
    AND ((problem_id IS NOT NULL) <> (parent_proposal_id IS NOT NULL)))),
  CONSTRAINT "care_plan_change_proposal_shape_goal_update" CHECK (kind <> 'goal_update' OR (
    target_element_id IS NOT NULL AND problem_id IS NULL AND parent_proposal_id IS NULL
    AND (revised_text IS NOT NULL OR measurable_outcome IS NOT NULL OR goal_status IS NOT NULL OR target_at IS NOT NULL))),
  CONSTRAINT "care_plan_change_proposal_shape_intervention_add" CHECK (kind <> 'intervention_add' OR (
    target_element_id IS NULL AND scope_text IS NOT NULL AND frequency_text IS NOT NULL
    AND frequency_value IS NOT NULL AND discipline IS NOT NULL
    AND ((problem_id IS NOT NULL) <> (parent_proposal_id IS NOT NULL)))),
  CONSTRAINT "care_plan_change_proposal_shape_intervention_discontinue" CHECK (kind <> 'intervention_discontinue' OR (
    target_element_id IS NOT NULL AND problem_id IS NULL AND parent_proposal_id IS NULL
    AND discontinue_reason IS NOT NULL)),
  -- The lifecycle columns move together with the status.
  CONSTRAINT "care_plan_change_proposal_status_shape" CHECK (
    (status = 'draft' AND released_at IS NULL AND decided_by_membership_id IS NULL AND decided_at IS NULL
      AND result_element_id IS NULL AND dismissal_reason IS NULL)
    OR (status = 'pending' AND released_at IS NOT NULL AND decided_by_membership_id IS NULL AND decided_at IS NULL
      AND result_element_id IS NULL AND dismissal_reason IS NULL)
    OR (status = 'accepted' AND released_at IS NOT NULL AND decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL
      AND result_element_id IS NOT NULL AND dismissal_reason IS NULL)
    OR (status = 'dismissed' AND released_at IS NOT NULL AND decided_by_membership_id IS NOT NULL AND decided_at IS NOT NULL
      AND result_element_id IS NULL)
    OR (status = 'withdrawn' AND released_at IS NULL AND decided_by_membership_id IS NULL AND decided_at IS NULL
      AND result_element_id IS NULL AND dismissal_reason IS NULL))
);--> statement-breakpoint
CREATE INDEX "care_plan_change_proposal_encounter_ix" ON "care_plan_change_proposal" ("organization_id", "source_encounter_id", "status");--> statement-breakpoint
CREATE INDEX "care_plan_change_proposal_patient_ix" ON "care_plan_change_proposal" ("organization_id", "patient_id", "status");--> statement-breakpoint
CREATE INDEX "care_plan_change_proposal_plan_status_ix" ON "care_plan_change_proposal" ("care_plan_id", "status");--> statement-breakpoint
CREATE INDEX "care_plan_change_proposal_parent_ix" ON "care_plan_change_proposal" ("parent_proposal_id") WHERE parent_proposal_id IS NOT NULL;--> statement-breakpoint

ALTER TABLE "care_plan_change_proposal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "care_plan_change_proposal" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "care_plan_change_proposal_org_isolation" ON "care_plan_change_proposal"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- Insert (draft), update (replace / release / decide / withdraw); no DELETE: a discarded draft is a `withdrawn` row, and the care-plan
-- tables are append-only for the app role (0029). UPDATE is granted per column, like the wound tables: the change columns a replace writes,
-- the sud flag, and the lifecycle columns (status, release, decision, result, dismissal reason). The row's identity and provenance
-- (organization, siting, plan, patient, visit, proposer, creation time) are not updatable by the application role at all.
GRANT SELECT, INSERT ON "care_plan_change_proposal" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE (
  "kind", "status", "sud_related", "target_element_id", "problem_id", "parent_proposal_id", "goal_refs",
  "description", "icd10_code", "snomed_code", "problem_kind", "problem_source", "onset_at", "resolution_note",
  "goal_text", "goal_source", "measurable_outcome", "target_at", "revised_text", "goal_status",
  "scope_text", "frequency_text", "frequency_value", "discipline", "responsible_role", "discontinue_reason",
  "released_at", "decided_by_membership_id", "decided_at", "result_element_id", "dismissal_reason", "updated_at"
) ON "care_plan_change_proposal" TO chartwarden_app;--> statement-breakpoint

-- Which plan, patient and visit a proposal belongs to, and who proposed it, never change. The column grant already keeps the application role
-- off them; this guard holds for every role (a visit id rewritten after the fact would release a draft with someone else's note). Two more
-- rules, for every role: a decided or withdrawn proposal is final (accepted / dismissed / withdrawn are terminal: nothing about it changes,
-- so a decision cannot be re-opened or rewritten), and the Part 2 flag cannot be cleared once the proposal has left `draft` (a released
-- proposal that was Part 2 stays hidden from a caller without disclosure; only its author, while still drafting, may re-flag it either way).
CREATE OR REPLACE FUNCTION care_plan_change_proposal_update_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status IN ('accepted', 'dismissed', 'withdrawn') THEN
    RAISE EXCEPTION 'care_plan_change_proposal: a decided or withdrawn proposal cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.sud_related AND NOT NEW.sud_related AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'care_plan_change_proposal: the Part 2 flag of a released proposal cannot be cleared' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.care_plan_id, NEW.patient_id, NEW.source_encounter_id, NEW.proposed_by_membership_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.organization_id, OLD.care_plan_id, OLD.patient_id, OLD.source_encounter_id, OLD.proposed_by_membership_id, OLD.created_at) THEN
    RAISE EXCEPTION 'care_plan_change_proposal: the plan, patient, visit and proposer of a proposal cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_care_plan_change_proposal_update_guard"
  BEFORE UPDATE ON "care_plan_change_proposal"
  FOR EACH ROW EXECUTE FUNCTION care_plan_change_proposal_update_guard();--> statement-breakpoint

-- M4 write-audit trigger. The free text a clinician typed never enters the diff: the snapshot records that the column changed.
CREATE OR REPLACE FUNCTION audit_phi_write_care_plan_change_proposal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['description', 'icd10_code', 'snomed_code', 'resolution_note', 'goal_text', 'measurable_outcome', 'revised_text', 'scope_text', 'frequency_text', 'frequency_value', 'responsible_role', 'discontinue_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['description', 'icd10_code', 'snomed_code', 'resolution_note', 'goal_text', 'measurable_outcome', 'revised_text', 'scope_text', 'frequency_text', 'frequency_value', 'responsible_role', 'discontinue_reason']::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_care_plan_change_proposal() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_care_plan_change_proposal"
  AFTER INSERT OR UPDATE OR DELETE ON care_plan_change_proposal
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_care_plan_change_proposal();--> statement-breakpoint

-- Patient destruction: M7's `care_plan_record` eraser deletes the proposals with the rest of the plan's satellites.
GRANT SELECT, DELETE ON "care_plan_change_proposal" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "care_plan_change_proposal_destruction" ON "care_plan_change_proposal"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
