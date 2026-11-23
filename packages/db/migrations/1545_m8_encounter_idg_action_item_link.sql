-- compat: expand
-- M8 visit-note drafting (ADR-0114 S5b, VN-D64 / VN-D67): `encounter_idg_action_item_link`, which ONE M14 IDG action item an `idg_followup` visit follows up.
-- One row names ONE action item by its M14 id. A pure expand: a new table nothing in the previous release reads or writes.
--
--   MEANING. A live row says "the author linked this visit to that team follow-up"; the drafted `idg_followup` sentence names the meeting date, the
--   decision kind and the due date and nothing else. It does NOT say the visit completed, addressed or closed the item (M14's own auto-close, which closes
--   an encounter-kind item when the assignee signs ANY encounter, is unchanged and does not read this table), and no outbox event or consumer reads it.
--   ONE LIVE ROW. A live row is unique per encounter (VN-D64); a different item replaces it (the old row is removed, a new one filed). The table could
--   hold more later without a contract change: only this partial unique index would move.
--   REMOVAL. Soft, as the M7 and S4b tables': the application role holds DELETE on no M8 table, so a removal stamps `removed_at` and the member. Any
--   number of removed rows may remain.
--   PART 2. `part2_derived` has no default: the writer states it (the M14 verdict for the item's patient, W-SUD-01). A Part 2 row files under
--   compliance_42cfr_part2, and a DELETE (the erasure) is always filed so, since a flag filed low is raised only when the store next writes the row.
--   THE AUDIT IMAGE NEVER NAMES THE ITEM. The action item id is scrubbed from every image (insert, update before and after, delete), for every row, Part 2 or
--   not: the verdict on a row can be stale at the insert (M14 is asked on its own transaction beside the write) or when a replaced row is removed (the item
--   being left is not asked about again), and the id of an item whose meeting is Part 2 would then reach the plain audit class. The trail names the encounter
--   and the row id; the item stays on the row, under RLS.
-- The M14 action item id is a LOGICAL reference: app-validated against the viewer's own candidates and, at INSERT, checked by the guard trigger below to be an
-- action item of the row's own organization and of the encounter's own patient (no cross-module FK: M8 must not import M14; the check is a read, not a reference).
-- Roles are the post-1139 names (chartwarden_*).
CREATE TABLE "encounter_idg_action_item_link" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE CASCADE,
  "action_item_id" uuid NOT NULL,
  "linked_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "part2_derived" boolean NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "removed_at" timestamptz,
  "removed_by_membership_id" uuid REFERENCES "membership"("id") ON DELETE RESTRICT,
  CONSTRAINT "encounter_idg_action_item_link_removal_consistent" CHECK (("removed_at" IS NULL) = ("removed_by_membership_id" IS NULL))
);--> statement-breakpoint
-- organization_id leads an index (the RLS predicate every statement carries, arch:org-indexes); the encounter FK (ON DELETE CASCADE) needs a plain
-- index of its own, since the unique index below is partial.
CREATE INDEX "encounter_idg_action_item_link_org_encounter_idx"
  ON "encounter_idg_action_item_link" ("organization_id", "encounter_id");--> statement-breakpoint
CREATE INDEX "encounter_idg_action_item_link_encounter_idx"
  ON "encounter_idg_action_item_link" ("encounter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "encounter_idg_action_item_link_live_uniq"
  ON "encounter_idg_action_item_link" ("encounter_id")
  WHERE "removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "encounter_idg_action_item_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_idg_action_item_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "encounter_idg_action_item_link_org_isolation" ON "encounter_idg_action_item_link"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- A removal is an UPDATE of the removal columns (and a Part 2 verdict raises the flag); the application role holds DELETE on no M8 table, and no
-- UPDATE on the columns that name the encounter, the item and the member who linked it.
GRANT SELECT, INSERT ON "encounter_idg_action_item_link" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("removed_at", "removed_by_membership_id", "part2_derived") ON "encounter_idg_action_item_link" TO chartwarden_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_encounter_idg_action_item_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_part2 boolean;
BEGIN
  -- The action item id is scrubbed from EVERY image, whatever the row's flag says (the denylist mirror names it): the row's own verdict can be stale (see the
  -- header), so no image is left to depend on it. What stays in the image is the row id, the encounter, the members and the two flags.
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['action_item_id']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['action_item_id']::text[]) ELSE NULL END;
  -- A Part 2 row (either image of an update) files under the Part 2 retention class. So does EVERY delete, whatever the row's flag says: a row filed while
  -- its patient was not flagged keeps a low flag when the patient is flagged later and nothing writes the row again (the store raises a flag only on the rows
  -- it writes), and the only delete is the destruction role's erasure.
  v_part2 := TG_OP = 'DELETE' OR COALESCE(OLD.part2_derived, false) OR COALESCE(NEW.part2_derived, false);
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
ALTER FUNCTION audit_phi_write_encounter_idg_action_item_link() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_idg_action_item_link"
  AFTER INSERT OR UPDATE OR DELETE ON encounter_idg_action_item_link
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_idg_action_item_link();--> statement-breakpoint
-- A foreign key check ignores RLS: the encounter and the two members must belong to the row's own organization, and the siting pair be the
-- encounter's (the 1525 / 1540 shape); a NEW row's action item must be one of the row's own organization AND of the encounter's own patient (this guard runs
-- invoker-rights, so the read of M14's table is under the caller's own RLS too). The row is frozen with the note: a signed, cosign-pending, cosigned or voided encounter takes no write (a note is
-- changed only through an addendum), except from the destruction role. An update may change only the removal columns and raise the Part 2 flag: the
-- row's identity stays put, a removed row is not revived, and a flag that is up never comes down (a lowered flag would file the action item id of a
-- Part 2 row in the plain audit class on every later write).
CREATE OR REPLACE FUNCTION encounter_idg_action_item_link_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  SELECT e.status::text INTO v_status
    FROM encounter e
   WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
     AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
     AND e.location_id IS NOT DISTINCT FROM NEW.location_id;
  IF NOT FOUND
     OR NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.linked_by_membership_id AND m.organization_id = NEW.organization_id)
     OR (NEW.removed_by_membership_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.removed_by_membership_id AND m.organization_id = NEW.organization_id)) THEN
    RAISE EXCEPTION 'encounter_idg_action_item_link: the encounter and the members must belong to the row''s organization, and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
       SELECT 1 FROM idg_action_item a
        WHERE a.id = NEW.action_item_id AND a.organization_id = NEW.organization_id
          AND a.patient_id = (SELECT e.patient_id FROM encounter e WHERE e.id = NEW.encounter_id)) THEN
    RAISE EXCEPTION 'encounter_idg_action_item_link: the action item must be one of the row''s organization and of the encounter''s patient'
      USING ERRCODE = '23503';
  END IF;
  IF v_status IN ('signed', 'cosign_pending', 'cosigned', 'voided')
     AND NOT (pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
              AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)) THEN
    RAISE EXCEPTION 'encounter_idg_action_item_link: the IDG follow-up link of a signed encounter is frozen (a note is changed only through an addendum)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.encounter_id <> OLD.encounter_id
       OR NEW.action_item_id <> OLD.action_item_id OR NEW.linked_by_membership_id <> OLD.linked_by_membership_id
       OR NEW.provider_entity_id IS DISTINCT FROM OLD.provider_entity_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'encounter_idg_action_item_link: a link row names its encounter and action item for good (only its removal and its Part 2 flag change)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.removed_at IS NOT NULL
       AND (NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by_membership_id IS DISTINCT FROM OLD.removed_by_membership_id) THEN
      RAISE EXCEPTION 'encounter_idg_action_item_link: a removed link is not revived or re-stamped (link the item again with a new row)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.part2_derived AND NOT NEW.part2_derived THEN
      RAISE EXCEPTION 'encounter_idg_action_item_link: the Part 2 flag of a row never comes down'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_idg_action_item_link_org_guard"
  BEFORE INSERT OR UPDATE ON "encounter_idg_action_item_link"
  FOR EACH ROW EXECUTE FUNCTION encounter_idg_action_item_link_org_guard();--> statement-breakpoint
-- Tenant destruction (the 1099 / 1478 / 1514 / 1517 / 1540 pattern): the encounter eraser deletes the satellites of a destroyed patient's encounters.
GRANT SELECT, DELETE ON "encounter_idg_action_item_link" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "encounter_idg_action_item_link_destruction" ON "encounter_idg_action_item_link"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
