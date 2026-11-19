-- compat: expand
-- M8 visit-note drafting (ADR-0114, design 3.1): `hearthnote_signed_section`, the sealed per-section rows written at sign next to
-- `hearthnote_assembled_output.final_cipher`. One row per section of a signed note: its id, position, the rendered text SEALED, a
-- SHA-256 of the canonical text, whether the section is `part2_derived` (decided by the writer, fail closed: there is no default) and
-- the ids of its sources. The ordered rows must equal `final_cipher`; the writer (a later PR) pins that.
--   * text_cipher is the SAME envelope as `hearthnote_assembled_output.final_cipher`: the `v1.<dekVersion>.<nonce>.<tag>.<ciphertext>`
--     STRING the narrative cipher (hearthnote-crypto.ts) returns, so the column is `text` like final_cipher, not bytea. This migration
--     only creates the column; it never writes a value. The encounter eraser shreds it to "" (the NOT NULL sentinel) before deleting.
--   * APPEND-ONLY for the application role: it holds SELECT and INSERT and nothing else, so an UPDATE or a DELETE is refused with
--     insufficient_privilege. (`hearthnote_assembled_output` itself keeps UPDATE for its finalize path, frozen after sign by 1521; these
--     rows have no such path.) chartwarden_destruction alone may UPDATE `text_cipher` (the crypto-shred, a column grant) and DELETE, for
--     tenant destruction.
--   * source_refs is a JSON array of {kind, id}: ids only, never text. The row trigger scrubs text_cipher and content_hash from the audit
--     snapshot (an unsalted SHA-256 of low-entropy section text is an offline guessing oracle for anyone with audit.read; the hash stays
--     stored, it is compared at read time). A part2_derived row's audit image also withholds source_refs (the audit read path is not Part 2
--     gated: audit.read returns before/after for every retention class) and is filed under compliance_42cfr_part2, not the 7-year class.
--   * UNIQUE (assembled_output_id, section_id) and (assembled_output_id, position): a note has each section once, in one place.
--   * Three-column tenancy copied from the encounter, the siting pair nullable (mig 0128 / 0226 / 0231). No amends column: the amendment
--     PR adds it.
-- The guard trigger makes the encounter and the assembled output belong to the row's own organization (single-column FKs ignore RLS), the
-- output belong to THAT encounter (a same-organization output of another encounter is refused), and the row's siting pair be the encounter's.
-- Roles are the post-1139 names (chartwarden_*).

CREATE TABLE "hearthnote_signed_section" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid REFERENCES "provider_entity"("id") ON DELETE RESTRICT,
  "location_id" uuid REFERENCES "location"("id") ON DELETE RESTRICT,
  "encounter_id" uuid NOT NULL REFERENCES "encounter"("id") ON DELETE CASCADE,
  "assembled_output_id" uuid NOT NULL REFERENCES "hearthnote_assembled_output"("id") ON DELETE CASCADE,
  "section_id" text NOT NULL,
  "position" integer NOT NULL,
  "text_cipher" text NOT NULL,
  "content_hash" text NOT NULL,
  "part2_derived" boolean NOT NULL,
  "source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "hearthnote_signed_section_output_section_uniq" UNIQUE ("assembled_output_id", "section_id"),
  CONSTRAINT "hearthnote_signed_section_output_position_uniq" UNIQUE ("assembled_output_id", "position"),
  CONSTRAINT "hearthnote_signed_section_position_check" CHECK ("position" >= 0),
  CONSTRAINT "hearthnote_signed_section_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "hearthnote_signed_section_source_refs_array" CHECK (jsonb_typeof("source_refs") = 'array')
);--> statement-breakpoint
-- The assembled-output FK is covered by the unique constraints above; this one covers the encounter FK, and the next leads with the
-- organization (arch:org-indexes).
CREATE INDEX "hearthnote_signed_section_encounter_idx" ON "hearthnote_signed_section" ("encounter_id");--> statement-breakpoint
CREATE INDEX "hearthnote_signed_section_org_encounter_idx"
  ON "hearthnote_signed_section" ("organization_id", "encounter_id");--> statement-breakpoint

ALTER TABLE "hearthnote_signed_section" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hearthnote_signed_section" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hearthnote_signed_section_org_isolation" ON "hearthnote_signed_section"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "hearthnote_signed_section" TO chartwarden_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_hearthnote_signed_section() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_part2 boolean;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY['text_cipher', 'content_hash']::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY['text_cipher', 'content_hash']::text[]) ELSE NULL END;
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
ALTER FUNCTION audit_phi_write_hearthnote_signed_section() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_hearthnote_signed_section"
  AFTER INSERT OR UPDATE OR DELETE ON hearthnote_signed_section
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_hearthnote_signed_section();--> statement-breakpoint

CREATE OR REPLACE FUNCTION hearthnote_signed_section_org_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM encounter e
        WHERE e.id = NEW.encounter_id AND e.organization_id = NEW.organization_id
          AND e.provider_entity_id IS NOT DISTINCT FROM NEW.provider_entity_id
          AND e.location_id IS NOT DISTINCT FROM NEW.location_id)
     OR NOT EXISTS (
       SELECT 1 FROM hearthnote_assembled_output o
        WHERE o.id = NEW.assembled_output_id AND o.organization_id = NEW.organization_id AND o.encounter_id = NEW.encounter_id) THEN
    RAISE EXCEPTION 'hearthnote_signed_section: the encounter and the assembled output must belong to the row''s organization, the output to that encounter, and the siting pair be the encounter''s'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_hearthnote_signed_section_org_guard"
  BEFORE INSERT ON "hearthnote_signed_section"
  FOR EACH ROW EXECUTE FUNCTION hearthnote_signed_section_org_guard();--> statement-breakpoint

-- Tenant destruction: the encounter eraser shreds text_cipher (a COLUMN grant, the 1514 shape: nothing else on the row is writable) and then
-- deletes the rows, as it does for the assembled output.
GRANT SELECT, DELETE ON "hearthnote_signed_section" TO chartwarden_destruction;--> statement-breakpoint
GRANT UPDATE ("text_cipher") ON "hearthnote_signed_section" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "hearthnote_signed_section_destruction" ON "hearthnote_signed_section"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);
