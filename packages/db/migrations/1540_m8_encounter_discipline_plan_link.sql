-- compat: expand
-- M8 visit-note drafting (ADR-0114 S4b, VN-D58 / VN-D61): `encounter_discipline_plan_link`, which M15 goals and interventions a social-work or
-- chaplain visit keeps in its drafted plan. One row names ONE element (a goal or an intervention of the discipline's plan, by the M15 working-row
-- id, which is stable across plan versions). A pure expand: a new table nothing in the previous release reads or writes.
--
--   MEANING. A live row says "the clinician kept this element in this visit's statement of the plan"; a removed row says it was left out. It does
--   NOT say the visit addressed, discussed or provided anything (the draft says no such thing, VN-D48), and no outbox event or consumer reads it.
--   Not the M7 `encounter_care_plan_link`: that table's "at least one of problem, goal, intervention" CHECK would have to be replaced to hold these
--   ids, and a replaced CHECK is not an expand.
--   REMOVAL. Soft, as the M7 table's: the application role holds DELETE on no M8 table, so a removal stamps `removed_at` and the member. A live
--   row is unique per (encounter, element); any number of removed rows may remain.
--   PART 2. `part2_derived` has no default: the writer states it. An element id of a Part 2 goal tied to a patient is withheld from the row's
--   audit image (a Part 2 row files under compliance_42cfr_part2), as the confirmation's source ids are.
-- M15's goal and intervention ids are LOGICAL references (app-validated against the plan in effect at the visit, no cross-module FK), as M7's are.
-- Roles are the post-1139 names (chartwarden_*).
CREATE TABLE "encounter_discipline_plan_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE CASCADE,
  "goal_id" uuid,
  "intervention_id" uuid,
  "part2_derived" boolean NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "removed_at" timestamptz,
  "removed_by_membership_id" uuid REFERENCES "membership"("id") ON DELETE RESTRICT,
  CONSTRAINT "encounter_discipline_plan_link_one_element" CHECK (("goal_id" IS NOT NULL) <> ("intervention_id" IS NOT NULL)),
  CONSTRAINT "encounter_discipline_plan_link_removal_consistent" CHECK (("removed_at" IS NULL) = ("removed_by_membership_id" IS NULL))
);--> statement-breakpoint
-- organization_id leads an index (the RLS predicate every statement carries, arch:org-indexes); the encounter FK (ON DELETE CASCADE) needs a plain
-- index of its own, since the unique indexes below are partial.
CREATE INDEX "encounter_discipline_plan_link_org_encounter_idx"
  ON "encounter_discipline_plan_link" ("organization_id", "encounter_id");--> statement-breakpoint
CREATE INDEX "encounter_discipline_plan_link_encounter_idx"
  ON "encounter_discipline_plan_link" ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_discipline_plan_link_live_goal_uniq"
  ON "encounter_discipline_plan_link" ("encounter_id", "goal_id")
  WHERE "removed_at" IS NULL AND "goal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_discipline_plan_link_live_intervention_uniq"
  ON "encounter_discipline_plan_link" ("encounter_id", "intervention_id")
  WHERE "removed_at" IS NULL AND "intervention_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "encounter_discipline_plan_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_discipline_plan_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "encounter_discipline_plan_link_org_isolation" ON "encounter_discipline_plan_link"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- A removal is an UPDATE of the removal columns (and a Part 2 verdict raises the flag); the application role holds DELETE on no M8 table, and no
-- UPDATE on the columns that name the encounter and the element.
GRANT SELECT, INSERT ON "encounter_discipline_plan_link" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("removed_at", "removed_by_membership_id", "part2_derived") ON "encounter_discipline_plan_link" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_encounter_discipline_plan_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_part2 boolean;
BEGIN
  -- No column is scrubbed unconditionally (the denylist mirror is empty); the empty list keeps the shape every M8 trigger has, which
  -- arch:audit-denylist-sync reads, before the row-conditional scrub below.
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  -- A Part 2 row (either image of an update) withholds its element ids and files under the Part 2 retention class.
  v_part2 := COALESCE(OLD.part2_derived, false) OR COALESCE(NEW.part2_derived, false);
  IF v_part2 AND v_before IS NOT NULL THEN v_before := public.audit_scrub(v_before, ARRAY['goal_id', 'intervention_id']::text[]); END IF;
  IF v_part2 AND v_after IS NOT NULL THEN v_after := public.audit_scrub(v_after, ARRAY['goal_id', 'intervention_id']::text[]); END IF;
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
    CASE WHEN v_part2 THEN 'compliance_42cfr_part2'::audit_retention_class ELSE 'compliance'::audit_retention_class END
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_encounter_discipline_plan_link() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_discipline_plan_link"
  AFTER INSERT OR UPDATE OR DELETE ON encounter_discipline_plan_link
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_discipline_plan_link();--> statement-breakpoint
-- A foreign key check ignores RLS: the encounter and the removing member must belong to the row's own organization, and the siting pair be the
-- encounter's (the 1525 shape). The row is frozen with the note: a signed, cosign-pending, cosigned or voided encounter takes no write (a note is
-- changed only through an addendum), except from the destruction role. An update may change only the removal columns and raise the Part 2 flag:
-- the row's identity stays put, a removed row is not revived, and a flag that is up never comes down (a lowered flag would file the element id of a
-- Part 2 row in the plain audit class on every later write).
CREATE OR REPLACE FUNCTION encounter_discipline_plan_link_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  SELECT e.status::text INTO v_status
    FROM encounter e
   WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
     AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
     AND e.location_id IS NOT DISTINCT FROM NEW.location_id;
  IF NOT FOUND
     OR (NEW.removed_by_membership_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.removed_by_membership_id AND m.organization_id = NEW.organization_id)) THEN
    RAISE EXCEPTION 'encounter_discipline_plan_link: the encounter and the removing member must belong to the row''s organization, and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  IF v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided')
     AND NOT (pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
              AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION 'encounter_discipline_plan_link: the plan items of a signed encounter are frozen (a note is changed only through an addendum)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.encounter_id <> OLD.encounter_id
       OR NEW.goal_id IS DISTINCT FROM OLD.goal_id OR NEW.intervention_id IS DISTINCT FROM OLD.intervention_id
       OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'encounter_discipline_plan_link: a link row names its encounter and element for good (only its removal and its Part 2 flag change)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.removed_at IS NOT NULL
       AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by_membership_id IS DISTINCT FROM OLD.removed_by_membership_id) THEN
      RAISE EXCEPTION 'encounter_discipline_plan_link: a removed link is not revived or re-stamped (keep the element again with a new row)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.part2_derived AND NOT NEW.part2_derived THEN
      RAISE EXCEPTION 'encounter_discipline_plan_link: the Part 2 flag of a row never comes down'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_discipline_plan_link_org_guard"
  BEFORE INSERT OR UPDATE ON "encounter_discipline_plan_link"
  FOR EACH ROW EXECUTE FUNCTION encounter_discipline_plan_link_org_guard();--> statement-breakpoint
-- Tenant destruction (the 1099 / 1478 / 1514 / 1517 pattern): the encounter eraser deletes the satellites of a destroyed patient's encounters.
GRANT SELECT, DELETE ON "encounter_discipline_plan_link" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "encounter_discipline_plan_link_destruction" ON "encounter_discipline_plan_link"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
