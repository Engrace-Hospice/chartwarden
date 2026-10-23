-- M25 milestone 7a-1 (hospice ADR/TPE/QIC PRD, milestone 7): two record-keeping tables, no rule encoded.
--
--  * appeal_tier_detail: facts a person records about an ALJ / Council / federal-court case (the OMHA / DAB / docket
--    reference as typed, an amount in controversy that is STORED and never compared to any threshold, the hearing facts as
--    entered, a disposition LABEL, and for federal court the counsel-filing facts). 1:1 with appeal_case, tier-guarded.
--    `disposition_kind` is a label only: the Postgres decision_outcome enum is unchanged, only an unfavorable decision
--    spawns the next tier, and a remand / dismissal never spawns one and shows "needs manual review".
--  * recorded_deadline: a due date the user types FROM A NOTICE (an ALJ hearing notice, a court order, a RAC / UPIC letter)
--    with a mandatory source note, for exactly one appeal_case or audit_request. The general primitive for every date
--    that is not a computed M25 tier deadline. Alerts at the existing T-30/14/7/1 boundaries; last_alerted_boundary makes
--    each boundary alert exactly once. The day ends in the provider's zone (stored at write, like the case does).
--
-- Org scoped (canonical app.org_id RLS, FORCEd, no DELETE for the app role). Closed sets are text + CHECK mirrored in
-- domain/later-tier.ts and domain/recorded-deadline.ts. Idempotent (the 1116/1117 renumber lesson).

CREATE TABLE IF NOT EXISTS "appeal_tier_detail" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  "appeal_case_id" uuid NOT NULL REFERENCES "appeal_case"("id") ON DELETE RESTRICT,
  "tier" text NOT NULL CHECK ("tier" IN ('alj','council','federal_court')),
  "authority_reference" text,
  "amount_in_controversy_cents" bigint CHECK ("amount_in_controversy_cents" IS NULL OR "amount_in_controversy_cents" >= 0),
  "hearing_on" date,
  "hearing_format_note" text,
  "disposition_kind" text CHECK ("disposition_kind" IN ('decision','remand','dismissal','other')),
  "disposition_note" text,
  "filed_by_counsel_on" date,
  "docket_reference" text,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "appeal_tier_detail_one_per_case" UNIQUE ("appeal_case_id"),
  -- Counsel-filing facts exist only on federal court; hearing facts never on federal court (record-only tier).
  CONSTRAINT "appeal_tier_detail_counsel_federal_only" CHECK ("tier" = 'federal_court' OR ("filed_by_counsel_on" IS NULL AND "docket_reference" IS NULL)),
  CONSTRAINT "appeal_tier_detail_no_hearing_in_court" CHECK ("tier" <> 'federal_court' OR ("hearing_on" IS NULL AND "hearing_format_note" IS NULL)),
  CONSTRAINT "appeal_tier_detail_other_needs_note" CHECK ("disposition_kind" IS DISTINCT FROM 'other' OR ("disposition_note" IS NOT NULL AND btrim("disposition_note") <> '')),
  CONSTRAINT "appeal_tier_detail_note_needs_kind" CHECK ("disposition_note" IS NULL OR "disposition_kind" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appeal_tier_detail_org_ix" ON "appeal_tier_detail" ("organization_id", "created_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "recorded_deadline" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "provider_entity_id" uuid NOT NULL,
  -- Exactly one subject.
  "appeal_case_id" uuid REFERENCES "appeal_case"("id") ON DELETE RESTRICT,
  "audit_request_id" uuid REFERENCES "audit_request"("id") ON DELETE RESTRICT,
  "label" text NOT NULL CHECK (btrim("label") <> ''),
  "due_on" date NOT NULL,
  "zone" text NOT NULL CHECK (btrim("zone") <> ''),
  -- Where the date came from (the notice, page, paragraph). Mandatory: a date nobody can trace is not recorded.
  "source_note" text NOT NULL CHECK (btrim("source_note") <> ''),
  "notice_document_id" uuid, -- M22 logical FK
  "satisfied_on" date,
  "last_alerted_boundary" integer CHECK ("last_alerted_boundary" IS NULL OR "last_alerted_boundary" > 0),
  "created_by_membership_id" uuid,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "recorded_deadline_one_subject" CHECK (num_nonnulls("appeal_case_id","audit_request_id") = 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_recorded_deadline_appeal" ON "recorded_deadline" ("appeal_case_id") WHERE "appeal_case_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_recorded_deadline_audit" ON "recorded_deadline" ("audit_request_id") WHERE "audit_request_id" IS NOT NULL;--> statement-breakpoint
-- The nightly watch reads the unsatisfied deadlines of an org.
CREATE INDEX IF NOT EXISTS "ix_recorded_deadline_open" ON "recorded_deadline" ("organization_id", "due_on") WHERE "satisfied_on" IS NULL;--> statement-breakpoint

ALTER TABLE "appeal_tier_detail" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appeal_tier_detail" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "appeal_tier_detail_org" ON "appeal_tier_detail";--> statement-breakpoint
CREATE POLICY "appeal_tier_detail_org" ON "appeal_tier_detail" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
ALTER TABLE "recorded_deadline" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recorded_deadline" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "recorded_deadline_org" ON "recorded_deadline";--> statement-breakpoint
CREATE POLICY "recorded_deadline_org" ON "recorded_deadline" FOR ALL TO chartwarden_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- The subject, tier and provider entity never change after insert; no DELETE.
GRANT SELECT, INSERT ON "appeal_tier_detail" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("authority_reference", "amount_in_controversy_cents", "hearing_on", "hearing_format_note",
  "disposition_kind", "disposition_note", "filed_by_counsel_on", "docket_reference", "version", "updated_at")
  ON "appeal_tier_detail" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "appeal_tier_detail" TO chartwarden_admin;--> statement-breakpoint
GRANT SELECT, INSERT ON "recorded_deadline" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("label", "due_on", "zone", "source_note", "notice_document_id", "satisfied_on", "last_alerted_boundary",
  "version", "updated_at") ON "recorded_deadline" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "recorded_deadline" TO chartwarden_admin;--> statement-breakpoint

-- M4 write-audit triggers (the 0084 shape). The authority / docket references and every free-text note are scrubbed.
CREATE OR REPLACE FUNCTION audit_phi_write_appeal_tier_detail() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['authority_reference','hearing_format_note','disposition_note','docket_reference'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'appeal_tier_detail.' || lower(TG_OP), 'appeal_tier_detail', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_appeal_tier_detail() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_appeal_tier_detail" ON appeal_tier_detail;--> statement-breakpoint
CREATE TRIGGER "trg_audit_appeal_tier_detail" AFTER INSERT OR UPDATE OR DELETE ON appeal_tier_detail FOR EACH ROW EXECUTE FUNCTION audit_phi_write_appeal_tier_detail();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_recorded_deadline() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['label','source_note'];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'recorded_deadline.' || lower(TG_OP), 'recorded_deadline', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_recorded_deadline() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_recorded_deadline" ON recorded_deadline;--> statement-breakpoint
CREATE TRIGGER "trg_audit_recorded_deadline" AFTER INSERT OR UPDATE OR DELETE ON recorded_deadline FOR EACH ROW EXECUTE FUNCTION audit_phi_write_recorded_deadline();--> statement-breakpoint

-- appeal_tier_detail: the row's tier must be the case's tier (a FK cannot prove it), RLS hides another tenant's case so a
-- cross-tenant appeal_case_id fails closed, and a closed case's detail is frozen.
CREATE OR REPLACE FUNCTION m25_appeal_tier_detail_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_tier text; v_state text;
BEGIN
  SELECT tier::text, state::text INTO v_tier, v_state FROM appeal_case WHERE id = NEW.appeal_case_id AND organization_id = NEW.organization_id;
  IF v_tier IS NULL THEN
    RAISE EXCEPTION 'M25_TIER_DETAIL_PARENT: appeal_case % is not visible to this organization', NEW.appeal_case_id;
  END IF;
  IF v_tier <> NEW.tier THEN
    RAISE EXCEPTION 'M25_TIER_DETAIL_TIER: appeal_case % is tier % but the detail says %', NEW.appeal_case_id, v_tier, NEW.tier;
  END IF;
  IF TG_OP = 'UPDATE' AND v_state = 'closed' THEN
    RAISE EXCEPTION 'M25_TIER_DETAIL_FROZEN: appeal_case % is closed; its tier detail cannot change', NEW.appeal_case_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_appeal_tier_detail_guard" ON appeal_tier_detail;--> statement-breakpoint
CREATE TRIGGER "trg_appeal_tier_detail_guard" BEFORE INSERT OR UPDATE ON appeal_tier_detail FOR EACH ROW EXECUTE FUNCTION m25_appeal_tier_detail_guard();--> statement-breakpoint

-- recorded_deadline: the subject must be visible to this organization (cross-tenant ids fail closed), and once satisfied
-- the deadline is frozen except for the alert bookkeeping.
CREATE OR REPLACE FUNCTION m25_recorded_deadline_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.appeal_case_id IS NOT NULL THEN
      SELECT true INTO v_ok FROM appeal_case WHERE id = NEW.appeal_case_id AND organization_id = NEW.organization_id;
    ELSE
      SELECT true INTO v_ok FROM audit_request WHERE id = NEW.audit_request_id AND organization_id = NEW.organization_id;
    END IF;
    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'M25_RECORDED_DEADLINE_PARENT: the subject is not visible to this organization';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.satisfied_on IS NOT NULL AND (
       NEW.label IS DISTINCT FROM OLD.label
    OR NEW.due_on IS DISTINCT FROM OLD.due_on
    OR NEW.zone IS DISTINCT FROM OLD.zone
    OR NEW.source_note IS DISTINCT FROM OLD.source_note
    OR NEW.notice_document_id IS DISTINCT FROM OLD.notice_document_id
    OR NEW.satisfied_on IS DISTINCT FROM OLD.satisfied_on) THEN
    RAISE EXCEPTION 'M25_RECORDED_DEADLINE_FROZEN: recorded_deadline % is satisfied and cannot change', OLD.id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_recorded_deadline_guard" ON recorded_deadline;--> statement-breakpoint
CREATE TRIGGER "trg_recorded_deadline_guard" BEFORE INSERT OR UPDATE ON recorded_deadline FOR EACH ROW EXECUTE FUNCTION m25_recorded_deadline_guard();--> statement-breakpoint

-- appeal.tier_record: record the later-tier facts and the deadlines typed from a notice. Full-catalog roles receive it
-- from the template materializer; existing tenants' roles get it from 1173.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('appeal.tier_record', 'appeal_case', 'tier_record', 'billing', 'provider_entity_scope', '')
ON CONFLICT ("key") DO NOTHING;
