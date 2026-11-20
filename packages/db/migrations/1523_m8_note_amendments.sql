-- compat: expand
-- M8 visit-note drafting (ADR-0114 VN-D30, design 3.1 "Amendment"): amendments of a signed drafted note ride the existing addendum path.
-- Three additions, all additive (the previous release writes none of it and reads none of it):
--
--  1. `encounter_amendment`: one row per (addendum, section the addendum names). INSERTed when the addendum is created (the naming), UPDATEd
--     once by the addendum's author when they resolve the section (`confirmed` against the content hash they saw, or `deselected`), exactly as
--     `encounter_draft_confirmation` does for a note (1517; same columns, same audit shape), but keyed by the addendum. A row with no
--     resolution is a named section nobody has resolved yet: sign refuses until it is. The resolution columns are all set or all null. Once the
--     addendum is signed or voided the guard refuses any change (a signed amendment is as frozen as the note).
--  2. `hearthnote_signed_section.addendum_id` / `amends_section_id`: an AMENDMENT row is a sealed section like any other (same envelope, same hash,
--     same Part 2 flag) written in the addendum's sign transaction. `amends_section_id` names the amended ORIGINAL row of the parent's own pin, so
--     the current view of a section is its latest signed version and the history is every version. Original rows are never updated (the
--     application role still holds SELECT and INSERT only). An amendment row hangs off the ADDENDUM's own assembled output (`addendum_finalize`),
--     which is why the guard below learns that an output may belong to an addendum; the parent's pin and the rows that equal it are untouched.
--     The guard: the amended row is in the same organization and encounter, is a row of the parent's own `primary_finalize` pin, is itself an
--     ORIGINAL (an amendment is never amended, a second amendment of a section names the original again), carries the same section id and
--     position; the addendum belongs to that encounter and is `finalized` (rows are written in its sign transaction, before it flips to signed, so
--     a signed addendum can never gain a row); `addendum_id` and `amends_section_id` are both set or both null. No audit-trigger change is needed:
--     the two new columns are ids, `text_cipher` / `content_hash` are scrubbed and a `part2_derived` row's `source_refs` withheld as 1518 already does.
--  3. `addendum_cosignature_request`: the cosignature request an AMENDING addendum opens when its parent needed one (design 3.1). It is a sibling of
--     `cosignature_request`, not a column on it, because that table is `UNIQUE (encounter_id)` (one request per encounter) and relaxing that is a
--     DROP CONSTRAINT, a contract migration an `expand` release cannot carry. Same columns and lifecycle as the parent's request, so the parent's
--     request and its clock are untouched by construction; `routed_at` is the addendum's own clock. UNIQUE (addendum_id): one request per addendum.
-- Every new PHI table follows the 1517 / 1518 shape: three-column tenancy copied from the encounter (the siting pair nullable, mig 0128), RLS
-- enabled and FORCEd on `app.org_id`, a row audit trigger that scrubs what must not reach the audit diff, a SECURITY INVOKER org guard (a single-column
-- FK ignores RLS), and the destruction role's SELECT/DELETE under its own policy so the encounter eraser can remove them. Roles are the post-1139
-- names (chartwarden_*).

-- ── 1. encounter_amendment ───────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "encounter_amendment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE CASCADE,
  "addendum_id" uuid NOT NULL REFERENCES "encounter_addendum"("id") ON DELETE CASCADE,
  "section_id" text NOT NULL,
  "resolution" text,
  "content_hash" text,
  "corpus_version" text,
  "edited" boolean,
  "part2_derived" boolean,
  "source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "resolved_by_membership_id" uuid REFERENCES "membership"("id") ON DELETE RESTRICT,
  "resolved_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "encounter_amendment_addendum_section_uniq" UNIQUE ("addendum_id", "section_id"),
  CONSTRAINT "encounter_amendment_resolution_check" CHECK ("resolution" IS NULL OR "resolution" IN ('confirmed', 'deselected')),
  CONSTRAINT "encounter_amendment_resolved_together" CHECK (
    ("resolution" IS NULL) = ("content_hash" IS NULL) AND ("resolution" IS NULL) = ("corpus_version" IS NULL)
    AND ("resolution" IS NULL) = ("edited" IS NULL) AND ("resolution" IS NULL) = ("part2_derived" IS NULL)
    AND ("resolution" IS NULL) = ("resolved_by_membership_id" IS NULL) AND ("resolution" IS NULL) = ("resolved_at" IS NULL)),
  CONSTRAINT "encounter_amendment_content_hash_check" CHECK ("content_hash" IS NULL OR "content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "encounter_amendment_source_refs_array" CHECK (jsonb_typeof("source_refs") = 'array')
);--> statement-breakpoint
-- The addendum FK is covered by the unique constraint above; these cover the encounter FK and lead with the organization (arch:org-indexes).
CREATE INDEX "encounter_amendment_encounter_idx" ON "encounter_amendment" ("encounter_id");--> statement-breakpoint
CREATE INDEX "encounter_amendment_org_encounter_idx" ON "encounter_amendment" ("organization_id", "encounter_id");--> statement-breakpoint

ALTER TABLE "encounter_amendment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_amendment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "encounter_amendment_org_isolation" ON "encounter_amendment"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- INSERT names a section, UPDATE of the resolution columns and nothing else resolves it; the application role holds DELETE on no M8 table.
GRANT SELECT, INSERT ON "encounter_amendment" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("resolution", "content_hash", "corpus_version", "edited", "part2_derived", "source_refs", "resolved_by_membership_id", "resolved_at")
  ON "encounter_amendment" TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_encounter_amendment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_part2 boolean;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['content_hash']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['content_hash']::text[]) ELSE NULL END;
  -- A Part 2 row (either image of an update) withholds its source ids and files under the Part 2 retention class.
  v_part2 := COALESCE(OLD.part2_derived, false) OR COALESCE(NEW.part2_derived, false);
  IF v_part2 AND v_before IS NOT NULL THEN v_before := public.audit_scrub(v_before, ARRAY['source_refs']::text[]); END IF;
  IF v_part2 AND v_after IS NOT NULL THEN v_after := public.audit_scrub(v_after, ARRAY['source_refs']::text[]); END IF;
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
ALTER FUNCTION audit_phi_write_encounter_amendment() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_amendment"
  AFTER INSERT OR UPDATE OR DELETE ON encounter_amendment
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_amendment();--> statement-breakpoint

CREATE OR REPLACE FUNCTION encounter_amendment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  SELECT a.status::text INTO v_status
    FROM encounter_addendum a
   WHERE a.id = NEW.addendum_id AND a.organization_id = NEW.organization_id AND a.encounter_id = NEW.encounter_id;
  IF v_status IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM encounter e
        WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
          AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
          AND e.location_id IS NOT DISTINCT FROM NEW.location_id)
     OR (NEW.resolved_by_membership_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM membership m WHERE m.id = NEW.resolved_by_membership_id AND m.organization_id = NEW.organization_id)) THEN
    RAISE EXCEPTION 'encounter_amendment: the encounter, the addendum (of that encounter) and the resolving member must belong to the row''s organization, and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  IF TG_OP = 'INSERT' AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'encounter_amendment: sections are named when the addendum is created (a draft), not after'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND v_status IN ('signed', 'voided') THEN
    RAISE EXCEPTION 'encounter_amendment: the resolutions of a signed or voided addendum are frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.addendum_id <> OLD.addendum_id OR NEW.encounter_id <> OLD.encounter_id OR NEW.section_id <> OLD.section_id) THEN
    RAISE EXCEPTION 'encounter_amendment: the addendum, the encounter and the section of a row are fixed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_amendment_guard"
  BEFORE INSERT OR UPDATE ON "encounter_amendment"
  FOR EACH ROW EXECUTE FUNCTION encounter_amendment_guard();--> statement-breakpoint

GRANT SELECT, DELETE ON "encounter_amendment" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "encounter_amendment_destruction" ON "encounter_amendment"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. hearthnote_signed_section: amendment rows ─────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE "hearthnote_signed_section"
  ADD COLUMN "addendum_id" uuid REFERENCES "encounter_addendum"("id") ON DELETE CASCADE,
  ADD COLUMN "amends_section_id" uuid REFERENCES "hearthnote_signed_section"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Both FKs cascade, so each leads an index (arch FK-index rule).
CREATE INDEX "hearthnote_signed_section_addendum_idx" ON "hearthnote_signed_section" ("addendum_id") WHERE "addendum_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hearthnote_signed_section_amends_idx" ON "hearthnote_signed_section" ("amends_section_id") WHERE "amends_section_id" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION hearthnote_signed_section_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_amended record;
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM encounter e
        WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
          AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
          AND e.location_id IS NOT DISTINCT FROM NEW.location_id) THEN
    RAISE EXCEPTION 'hearthnote_signed_section: the encounter must belong to the row''s organization and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  IF (NEW.addendum_id IS NULL) <> (NEW.amends_section_id IS NULL) THEN
    RAISE EXCEPTION 'hearthnote_signed_section: addendum_id and amends_section_id are both set (an amendment) or both null (an original)'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.addendum_id IS NULL THEN
    -- An original row: its output is the encounter's own pin.
    IF NOT EXISTS (
         SELECT 1 FROM hearthnote_assembled_output o
          WHERE o.id = NEW.assembled_output_id AND o.organization_id = NEW.organization_id AND o.encounter_id = NEW.encounter_id) THEN
      RAISE EXCEPTION 'hearthnote_signed_section: the assembled output must belong to the row''s organization and to that encounter'
        USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
  END IF;
  -- An amendment row: the addendum is the encounter's and is finalized (its sign transaction writes the rows, before it flips to signed), its own
  -- assembled output carries the row, and the amended row is an ORIGINAL row of the parent's own primary pin with the same section and position.
  IF NOT EXISTS (
       SELECT 1 FROM encounter_addendum a
        WHERE a.id = NEW.addendum_id AND a.organization_id = NEW.organization_id AND a.encounter_id = NEW.encounter_id
          AND a.status::text = 'finalized')
     OR NOT EXISTS (
       SELECT 1 FROM hearthnote_assembled_output o
        WHERE o.id = NEW.assembled_output_id AND o.organization_id = NEW.organization_id AND o.addendum_id = NEW.addendum_id) THEN
    RAISE EXCEPTION 'hearthnote_signed_section: an amendment belongs to a finalized addendum of that encounter, sealed against that addendum''s own output'
      USING ERRCODE = '23503';
  END IF;
  SELECT s.section_id, s."position", s.amends_section_id INTO v_amended
    FROM hearthnote_signed_section s
    JOIN hearthnote_assembled_output po ON po.id = s.assembled_output_id
   WHERE s.id = NEW.amends_section_id AND s.organization_id = NEW.organization_id AND s.encounter_id = NEW.encounter_id
     AND po.encounter_id = NEW.encounter_id AND po.kind::text = 'primary_finalize';
  IF NOT FOUND OR v_amended.amends_section_id IS NOT NULL
     OR v_amended.section_id <> NEW.section_id OR v_amended."position" <> NEW."position" THEN
    RAISE EXCEPTION 'hearthnote_signed_section: an amendment names an original row of the parent''s own pin (never an amendment), with the same section and position'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── 3. addendum_cosignature_request ──────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE "addendum_cosignature_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE RESTRICT,
  "addendum_id" uuid NOT NULL REFERENCES "encounter_addendum"("id") ON DELETE RESTRICT,
  "routed_to_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "status" "cosignature_status" DEFAULT 'pending' NOT NULL,
  "routed_at" timestamptz DEFAULT now() NOT NULL,
  "acknowledged_at" timestamptz,
  "escalated_at" timestamptz,
  "hard_cap_at" timestamptz,
  "supervisor_released_at" timestamptz,
  "supervisor_released_by" uuid REFERENCES "membership"("id") ON DELETE SET NULL,
  "supervisor_released_reason" text,
  "signed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "version" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "addendum_cosignature_request_addendum_uniq" UNIQUE ("addendum_id"),
  CONSTRAINT "addendum_cosignature_request_supervisor_release_consistency" CHECK (
    ("status" <> 'supervisor_released')
    OR ("supervisor_released_at" IS NOT NULL AND "supervisor_released_by" IS NOT NULL
        AND "supervisor_released_reason" IS NOT NULL AND char_length("supervisor_released_reason") >= 40))
);--> statement-breakpoint
CREATE INDEX "addendum_cosignature_request_encounter_idx" ON "addendum_cosignature_request" ("encounter_id");--> statement-breakpoint
CREATE INDEX "addendum_cosignature_request_routed_to_idx"
  ON "addendum_cosignature_request" ("organization_id", "routed_to_membership_id", "status");--> statement-breakpoint
CREATE INDEX "addendum_cosignature_request_released_by_idx" ON "addendum_cosignature_request" ("supervisor_released_by");--> statement-breakpoint

ALTER TABLE "addendum_cosignature_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "addendum_cosignature_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "addendum_cosignature_request_org_isolation" ON "addendum_cosignature_request"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "addendum_cosignature_request" TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_addendum_cosignature_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['supervisor_released_reason']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['supervisor_released_reason']::text[]) ELSE NULL END;
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
ALTER FUNCTION audit_phi_write_addendum_cosignature_request() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_addendum_cosignature_request"
  AFTER INSERT OR UPDATE OR DELETE ON addendum_cosignature_request
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_addendum_cosignature_request();--> statement-breakpoint

CREATE OR REPLACE FUNCTION addendum_cosignature_request_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM encounter e
        WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
          AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
          AND e.location_id IS NOT DISTINCT FROM NEW.location_id)
     OR NOT EXISTS (
       SELECT 1 FROM encounter_addendum a
        WHERE a.id = NEW.addendum_id AND a.organization_id = NEW.organization_id AND a.encounter_id = NEW.encounter_id)
     OR NOT EXISTS (
       SELECT 1 FROM membership m WHERE m.id = NEW.routed_to_membership_id AND m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'addendum_cosignature_request: the encounter, the addendum (of that encounter) and the routed-to member must belong to the row''s organization, and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_addendum_cosignature_request_org_guard"
  BEFORE INSERT ON "addendum_cosignature_request"
  FOR EACH ROW EXECUTE FUNCTION addendum_cosignature_request_org_guard();--> statement-breakpoint

GRANT SELECT, DELETE ON "addendum_cosignature_request" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "addendum_cosignature_request_destruction" ON "addendum_cosignature_request"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
