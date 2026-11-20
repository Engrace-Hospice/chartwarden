-- compat: expand
-- M8 visit-note drafting (ADR-0114, VN-D7 / VN-D12): `encounter_draft_confirmation`, one row per (encounter, drafted section) saying how
-- the clinician resolved that section: `confirmed` (the draft text, bound to the content hash the clinician saw) or `deselected` (the
-- drafted sentences stay out of the note). A re-confirmation UPSERTS the row (UNIQUE (encounter_id, section_id)), so the app role needs
-- INSERT + UPDATE and, like every M8 table, no DELETE.
--   * content_hash is the SHA-256 (64 lowercase hex) of the section's canonical rendered content; corpus_version is the phrase-corpus
--     release the draft was compiled under. A confirmation whose hash or corpus no longer matches the recomputed draft reads as
--     "needs re-confirmation" and blocks signing (design 3.2); nothing here decides that, the service does. The hash is compared at read
--     time, so it stays stored; it is NOT audited: an unsalted SHA-256 of low-entropy clinical text lets anyone holding audit.read confirm a
--     guessed sentence offline, so the row trigger scrubs it (the M8 denylist mirror agrees).
--   * part2_derived is the compiler's verdict on the section (no default: the writer decides, fail closed), the same flag the sealed
--     section carries. A Part 2 row's audit image withholds its source ids (the audit read path is not Part 2 gated: audit.read returns
--     before/after for every retention class) and is filed under compliance_42cfr_part2, not the 7-year class.
--   * edited records whether the section carried the clinician's own text when it was confirmed (the rubber-stamp indicator, VN-D18).
--   * source_refs is a JSON array of {kind, id} objects: IDS ONLY, never text. It reaches the audit trail through the row trigger
--     (VN-D7: source ids live in the audit trail, never in the signed text) for a plain row; a part2_derived row's audit image withholds it.
--   * Three-column tenancy, copied from the encounter exactly as the other satellites do: provider_entity_id / location_id are nullable
--     (the draft route captures neither when the M6 admission is unsited, mig 0128 / 0231).
-- Two guard checks the single-column FKs cannot express (an FK check ignores RLS): the encounter and the resolving membership must belong
-- to the row's own organization (the 1514 override-guard shape, SECURITY INVOKER so the reads run under the caller's RLS).
-- Roles are the post-1139 names (chartwarden_*).

CREATE TABLE "encounter_draft_confirmation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE CASCADE,
  "section_id" text NOT NULL,
  "resolution" text NOT NULL,
  "content_hash" text NOT NULL,
  "corpus_version" text NOT NULL,
  "edited" boolean NOT NULL,
  "part2_derived" boolean NOT NULL,
  "source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "resolved_by_membership_id" uuid NOT NULL REFERENCES "membership"("id") ON DELETE RESTRICT,
  "resolved_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "encounter_draft_confirmation_encounter_section_uniq" UNIQUE ("encounter_id", "section_id"),
  CONSTRAINT "encounter_draft_confirmation_resolution_check" CHECK ("resolution" IN ('confirmed', 'deselected')),
  CONSTRAINT "encounter_draft_confirmation_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "encounter_draft_confirmation_source_refs_array" CHECK (jsonb_typeof("source_refs") = 'array')
);--> statement-breakpoint
-- organization_id leads an index (the RLS predicate every statement carries, arch:org-indexes); the encounter FK is covered by the
-- unique constraint above.
CREATE INDEX "encounter_draft_confirmation_org_encounter_idx"
  ON "encounter_draft_confirmation" ("organization_id", "encounter_id");--> statement-breakpoint

ALTER TABLE "encounter_draft_confirmation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "encounter_draft_confirmation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "encounter_draft_confirmation_org_isolation" ON "encounter_draft_confirmation"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The upsert needs INSERT + UPDATE; the application role holds DELETE on no M8 table.
GRANT SELECT, INSERT, UPDATE ON "encounter_draft_confirmation" TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_encounter_draft_confirmation() RETURNS trigger
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
ALTER FUNCTION audit_phi_write_encounter_draft_confirmation() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_encounter_draft_confirmation"
  AFTER INSERT OR UPDATE OR DELETE ON encounter_draft_confirmation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_encounter_draft_confirmation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION encounter_draft_confirmation_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM encounter e WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id)
     OR NOT EXISTS (SELECT 1 FROM membership m WHERE m.id = NEW.resolved_by_membership_id AND m.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'encounter_draft_confirmation: the encounter and the resolving member must belong to the row''s organization'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_encounter_draft_confirmation_org_guard"
  BEFORE INSERT OR UPDATE ON "encounter_draft_confirmation"
  FOR EACH ROW EXECUTE FUNCTION encounter_draft_confirmation_org_guard();--> statement-breakpoint

-- Tenant destruction (the 1099 / 1478 / 1514 pattern): the encounter eraser deletes the satellites of a destroyed patient's encounters.
GRANT SELECT, DELETE ON "encounter_draft_confirmation" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "encounter_draft_confirmation_destruction" ON "encounter_draft_confirmation"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
