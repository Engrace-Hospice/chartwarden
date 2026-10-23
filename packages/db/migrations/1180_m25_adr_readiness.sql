-- M25 milestone 8a-1 (hospice ADR/TPE/QIC PRD, milestone 8): ADVISORY ADR documentation READINESS. Two tables that sit
-- BESIDE the human packet and never inside it: nothing here is a column of adr_case, adr_case_document or the checklist,
-- and no trigger or grant lets a readiness row change them.
--
--   adr_readiness_review   one row per requested review: who asked, which case version it looked at, whether an assistant
--                          answered (source 'ai') or not (source 'deterministic', status 'unavailable'/'failed'), and the
--                          M32 invocation id / prompt template version / model pin when one did (all NULL while AI is off).
--   adr_readiness_finding  the findings that survived the citation filter (domain/readiness.ts), each with the packet
--                          documents it cites and the human disposition (acknowledged / dismissed / disputed).
--
-- NO CMS REQUIREMENT IS ENCODED. checklist_key is free text on purpose: it names an item of the SME-unconfirmed
-- ADR_CHECKLIST_KEYS list (adr-packet-rules.ts), and this table must not hard-code that list. Statuses are presence-only
-- ("looks present" / "possibly missing" / "cannot tell"); nothing here judges sufficiency.
--
-- Org scoped (canonical app.org_id RLS, FORCEd). A review is immutable once written (no UPDATE grant); a finding takes
-- only its disposition. Free text (the finding note) is scrubbed from the audit trail. Closed sets are text + CHECK
-- mirrored in domain/readiness.ts, so there is no new pgEnum. Idempotent on purpose (the 1116/1117 renumber lesson).

CREATE TABLE IF NOT EXISTS "adr_readiness_review" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "adr_case_id" uuid NOT NULL REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "requested_by_membership_id" uuid NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('requested','ready','unavailable','failed')),
  "source" text NOT NULL CHECK ("source" IN ('deterministic','ai')),
  -- The adr_case.version the review looked at: a later packet change makes the review visibly stale.
  "case_version" integer NOT NULL,
  -- Logical FK to the M32 ai_invocation ledger. NULL for every review while AI is off.
  "invocation_id" uuid,
  "prompt_template_version" text,
  "model_version_pin" text,
  -- Closed set, mirrored in domain/readiness.ts READINESS_UNAVAILABLE_REASONS and the event schema.
  "unavailable_reason" text CHECK ("unavailable_reason" IN ('capability_unavailable','kill_switch_active','tenant_not_opted_in','budget_exhausted','timeout','schema_invalid','assistant_error')),
  -- How many assistant findings the citation filter refused (a count, never content).
  "dropped_finding_count" integer NOT NULL DEFAULT 0 CHECK ("dropped_finding_count" >= 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "adr_readiness_review_ai_has_invocation" CHECK ("source" <> 'ai' OR "invocation_id" IS NOT NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "adr_readiness_review_case_ix" ON "adr_readiness_review" ("adr_case_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adr_readiness_review_org_ix" ON "adr_readiness_review" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "adr_readiness_finding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "review_id" uuid NOT NULL REFERENCES "adr_readiness_review"("id") ON DELETE RESTRICT,
  "adr_case_id" uuid NOT NULL REFERENCES "adr_case"("id") ON DELETE RESTRICT,
  "checklist_key" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('looks_present','possibly_missing','cannot_tell')),
  -- Packet documents the finding cites (M22 document ids). A presence claim must cite at least one.
  "cited_document_ids" uuid[] NOT NULL DEFAULT '{}',
  "note" text NOT NULL CHECK (char_length("note") <= 500),
  "disposition" text CHECK ("disposition" IN ('acknowledged','dismissed','disputed')),
  "disposed_by_membership_id" uuid,
  "disposed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "adr_readiness_finding_presence_is_cited" CHECK ("status" <> 'looks_present' OR cardinality("cited_document_ids") >= 1),
  CONSTRAINT "adr_readiness_finding_disposition_complete" CHECK (("disposition" IS NULL) = ("disposed_at" IS NULL) AND ("disposition" IS NULL) = ("disposed_by_membership_id" IS NULL))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "adr_readiness_finding_review_ix" ON "adr_readiness_finding" ("review_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adr_readiness_finding_case_ix" ON "adr_readiness_finding" ("adr_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adr_readiness_finding_org_ix" ON "adr_readiness_finding" ("organization_id", "created_at");--> statement-breakpoint

-- RLS: the canonical single-shape org policy, FORCEd; the app role has no DELETE on either.
ALTER TABLE "adr_readiness_review" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adr_readiness_review" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "adr_readiness_review_org" ON "adr_readiness_review";--> statement-breakpoint
CREATE POLICY "adr_readiness_review_org" ON "adr_readiness_review" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "adr_readiness_finding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "adr_readiness_finding" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "adr_readiness_finding_org" ON "adr_readiness_finding";--> statement-breakpoint
CREATE POLICY "adr_readiness_finding_org" ON "adr_readiness_finding" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- A review is immutable (8b adds the UPDATE grant it needs for an asynchronous model call, deliberately not now).
-- A finding takes only its human disposition.
GRANT SELECT, INSERT ON "adr_readiness_review" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "adr_readiness_review" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "adr_readiness_finding" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("disposition", "disposed_by_membership_id", "disposed_at") ON "adr_readiness_finding" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "adr_readiness_finding" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). The assistant's note is free text: scrubbed. (The unavailable reason is a closed set and is not.)
CREATE OR REPLACE FUNCTION audit_phi_write_adr_readiness_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'adr_readiness_review.' || lower(TG_OP), 'adr_readiness_review', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_adr_readiness_review() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_adr_readiness_review" ON adr_readiness_review;--> statement-breakpoint
CREATE TRIGGER "trg_audit_adr_readiness_review" AFTER INSERT OR UPDATE OR DELETE ON adr_readiness_review FOR EACH ROW EXECUTE FUNCTION audit_phi_write_adr_readiness_review();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_adr_readiness_finding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'adr_readiness_finding.' || lower(TG_OP), 'adr_readiness_finding', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_adr_readiness_finding() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_adr_readiness_finding" ON adr_readiness_finding;--> statement-breakpoint
CREATE TRIGGER "trg_audit_adr_readiness_finding" AFTER INSERT OR UPDATE OR DELETE ON adr_readiness_finding FOR EACH ROW EXECUTE FUNCTION audit_phi_write_adr_readiness_finding();--> statement-breakpoint

-- Org-consistency: a FK does not prove the parent belongs to organization_id, and RLS hides another tenant's parent from
-- these SELECTs, so a cross-tenant adr_case_id / review_id fails closed. A finding must also name its review's case.
CREATE OR REPLACE FUNCTION m25_adr_readiness_review_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM adr_case WHERE id = NEW.adr_case_id AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'M25_READINESS_PARENT: adr_case % is not visible to this organization', NEW.adr_case_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_adr_readiness_review_guard" ON adr_readiness_review;--> statement-breakpoint
CREATE TRIGGER "trg_adr_readiness_review_guard" BEFORE INSERT ON adr_readiness_review FOR EACH ROW EXECUTE FUNCTION m25_adr_readiness_review_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION m25_adr_readiness_finding_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM adr_readiness_review WHERE id = NEW.review_id AND organization_id = NEW.organization_id AND adr_case_id = NEW.adr_case_id) THEN
    RAISE EXCEPTION 'M25_READINESS_PARENT: review % is not visible to this organization for that case', NEW.review_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_adr_readiness_finding_guard" ON adr_readiness_finding;--> statement-breakpoint
CREATE TRIGGER "trg_adr_readiness_finding_guard" BEFORE INSERT ON adr_readiness_finding FOR EACH ROW EXECUTE FUNCTION m25_adr_readiness_finding_guard();--> statement-breakpoint

-- adr.readiness_read: see the documentation-readiness view and any stored review. adr.readiness_request: ask for a
-- review. adr.readiness_dispose: acknowledge / dismiss / dispute a finding. None of them touches the packet, the
-- checklist, sign-off or filing, and none gates them. Existing tenants' roles get them from 1181.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('adr.readiness_read', 'adr_readiness', 'read', 'billing', 'provider_entity_scope', ''),
  ('adr.readiness_request', 'adr_readiness', 'request', 'billing', 'provider_entity_scope', ''),
  ('adr.readiness_dispose', 'adr_readiness', 'dispose', 'billing', 'provider_entity_scope', '')
ON CONFLICT ("key") DO NOTHING;
