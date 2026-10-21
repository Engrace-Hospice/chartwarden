-- M36 WP 5.7 (ADR-0089, PROPOSED), slice S1 - restricted messaging export: a scoped, two-person-approved export of messages to ONE encrypted,
-- expiring artefact. The tenant flag messaging.export (absent = off) gates REQUESTING only; approve, reject, cancel, download and the expiry sweep
-- never depend on it.
--   * message_export_job: who asked for what (exactly one of a channel or a patient scope, an optional date range of at most 366 days, a
--     20..280 char justification), who decided (never the requester: CHECK), and the artefact's life: pending_approval -> approved|rejected|cancelled,
--     approved -> building -> ready|failed, ready -> expired. Forward only, enforced by a guard trigger that also fixes the scope and request
--     columns for good and stamps every instant from the DATABASE clock. expires_at is set only on the building -> ready transition and is
--     ready_at + 24 hours (CHECK). The artefact itself lives in object storage (artefact_key), encrypted with a per-job data key kept wrapped
--     here (wrapped_dek); the DEK is dropped at expiry. The app role holds no DELETE (only chartwarden_destruction deletes).
--   * message_export_download: one insert-only row per download. Its guard refuses a row unless the actor (app.user_id) is the job's requester
--     and the job is ready and unexpired NOW, so a download that cannot be recorded is refused.
--     The guard also binds the actor: an insert needs requested_by = app.user_id and an approve/reject needs decided_by = app.user_id, so
--     the two-person rule holds in the database even if a caller passes another user's id. System transitions (building/ready/failed/expired)
--     do not look at the actor.
--   * Every guard is SECURITY INVOKER: its reads run under the caller's own org RLS, so another organization's job is invisible.
CREATE TABLE "message_export_job" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "requested_by" uuid NOT NULL REFERENCES "user"("id"),
  "scope_kind" text NOT NULL,
  "channel_id" uuid,
  "patient_id" uuid,
  "date_from" date,
  "date_to" date,
  "justification" text NOT NULL,
  "status" text DEFAULT 'pending_approval' NOT NULL,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "decided_by" uuid REFERENCES "user"("id"),
  "decided_at" timestamptz,
  "decision_note" text,
  "building_at" timestamptz,
  "ready_at" timestamptz,
  "expires_at" timestamptz,
  "artefact_key" text,
  "artefact_sha256" text,
  "artefact_bytes" integer,
  "wrapped_dek" text,
  "message_count" integer,
  "held_excluded" integer,
  "part2_excluded" integer,
  "failure_code" text,
  "download_count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "message_export_job_org_id_unique" UNIQUE ("organization_id", "id"),
  CONSTRAINT "message_export_job_scope_kind" CHECK ("scope_kind" IN ('channel', 'patient')),
  CONSTRAINT "message_export_job_scope" CHECK (
    ("scope_kind" = 'channel' AND "channel_id" IS NOT NULL AND "patient_id" IS NULL)
    OR ("scope_kind" = 'patient' AND "patient_id" IS NOT NULL AND "channel_id" IS NULL)),
  CONSTRAINT "message_export_job_status" CHECK ("status" IN ('pending_approval', 'approved', 'rejected', 'cancelled', 'building', 'ready', 'failed', 'expired')),
  CONSTRAINT "message_export_job_justification" CHECK (char_length(btrim("justification")) BETWEEN 20 AND 280),
  CONSTRAINT "message_export_job_range_pair" CHECK (("date_from" IS NULL) = ("date_to" IS NULL)),
  CONSTRAINT "message_export_job_range_order" CHECK ("date_to" IS NULL OR "date_to" >= "date_from"),
  CONSTRAINT "message_export_job_range_max" CHECK ("date_to" IS NULL OR "date_to" - "date_from" <= 366),
  CONSTRAINT "message_export_job_two_people" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
  CONSTRAINT "message_export_job_decision_note_len" CHECK ("decision_note" IS NULL OR char_length("decision_note") <= 1000),
  CONSTRAINT "message_export_job_decision_state" CHECK (
    ("status" IN ('pending_approval', 'cancelled') AND "decided_by" IS NULL)
    OR ("status" NOT IN ('pending_approval', 'cancelled') AND "decided_by" IS NOT NULL)),
  CONSTRAINT "message_export_job_expiry_pair" CHECK (("expires_at" IS NULL) = ("ready_at" IS NULL)),
  CONSTRAINT "message_export_job_expiry_24h" CHECK ("expires_at" IS NULL OR "expires_at" = "ready_at" + interval '24 hours'),
  CONSTRAINT "message_export_job_counts" CHECK (
    coalesce("message_count", 0) >= 0 AND coalesce("held_excluded", 0) >= 0 AND coalesce("part2_excluded", 0) >= 0
    AND coalesce("artefact_bytes", 0) >= 0 AND "download_count" >= 0),
  CONSTRAINT "message_export_job_channel_fk"
    FOREIGN KEY ("organization_id", "channel_id")
    REFERENCES "channel"("organization_id", "id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX "message_export_job_requester_idx" ON "message_export_job" ("organization_id", "requested_by", "requested_at");--> statement-breakpoint
CREATE INDEX "message_export_job_status_idx" ON "message_export_job" ("organization_id", "status", "requested_at");--> statement-breakpoint
CREATE INDEX "message_export_job_expiry_idx" ON "message_export_job" ("expires_at") WHERE "status" = 'ready';--> statement-breakpoint
CREATE INDEX "message_export_job_channel_idx" ON "message_export_job" ("organization_id", "channel_id") WHERE "channel_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_export_job_requested_by_idx" ON "message_export_job" ("requested_by");--> statement-breakpoint
CREATE INDEX "message_export_job_decided_by_idx" ON "message_export_job" ("decided_by") WHERE "decided_by" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_export_job_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
      RAISE EXCEPTION 'message_export_job_actor: a request is recorded only by its own requester' USING ERRCODE = 'check_violation';
    END IF;
    NEW.status := 'pending_approval';
    NEW.requested_at := now();
    NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.decision_note := NULL;
    NEW.building_at := NULL; NEW.ready_at := NULL; NEW.expires_at := NULL;
    NEW.artefact_key := NULL; NEW.artefact_sha256 := NULL; NEW.artefact_bytes := NULL; NEW.wrapped_dek := NULL;
    NEW.message_count := NULL; NEW.held_excluded := NULL; NEW.part2_excluded := NULL;
    NEW.failure_code := NULL; NEW.download_count := 0;
    RETURN NEW;
  END IF;
  -- The scope, the requester, the justification and the request instant never change.
  IF (to_jsonb(NEW) - ARRAY['status','decided_by','decided_at','decision_note','building_at','ready_at','expires_at','artefact_key',
        'artefact_sha256','artefact_bytes','wrapped_dek','message_count','held_excluded','part2_excluded','failure_code','download_count'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','decided_by','decided_at','decision_note','building_at','ready_at','expires_at','artefact_key',
        'artefact_sha256','artefact_bytes','wrapped_dek','message_count','held_excluded','part2_excluded','failure_code','download_count']) THEN
    RAISE EXCEPTION 'message_export_job_immutable: the scope, requester and justification cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ready' AND NEW.status = 'ready' THEN
    v_allowed := ARRAY['download_count'];
    IF NEW.download_count IS DISTINCT FROM OLD.download_count + 1 THEN
      RAISE EXCEPTION 'message_export_job_download_count: the count only goes up by one' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected') THEN
    v_allowed := ARRAY['status','decided_by','decided_at','decision_note'];
    IF NEW.decided_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
      RAISE EXCEPTION 'message_export_job_actor: a decision is recorded only by the deciding user' USING ERRCODE = 'check_violation';
    END IF;
    NEW.decided_at := now();
  ELSIF OLD.status = 'pending_approval' AND NEW.status = 'cancelled' THEN
    v_allowed := ARRAY['status','decided_at','decision_note'];
    NEW.decided_at := now();
  ELSIF OLD.status = 'approved' AND NEW.status = 'building' THEN
    v_allowed := ARRAY['status','building_at'];
    NEW.building_at := now();
  ELSIF OLD.status = 'building' AND NEW.status = 'ready' THEN
    v_allowed := ARRAY['status','ready_at','expires_at','artefact_key','artefact_sha256','artefact_bytes','wrapped_dek',
                       'message_count','held_excluded','part2_excluded'];
    IF NEW.artefact_key IS NULL OR NEW.artefact_sha256 IS NULL OR NEW.artefact_bytes IS NULL OR NEW.wrapped_dek IS NULL
       OR NEW.message_count IS NULL OR NEW.held_excluded IS NULL OR NEW.part2_excluded IS NULL THEN
      RAISE EXCEPTION 'message_export_job_incomplete: a ready export records its artefact and counts' USING ERRCODE = 'check_violation';
    END IF;
    NEW.ready_at := now();
    NEW.expires_at := NEW.ready_at + interval '24 hours';
  ELSIF OLD.status = 'building' AND NEW.status = 'failed' THEN
    v_allowed := ARRAY['status','failure_code'];
    IF coalesce(NEW.failure_code, '') = '' THEN
      RAISE EXCEPTION 'message_export_job_incomplete: a failed export records its code' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'ready' AND NEW.status = 'expired' THEN
    v_allowed := ARRAY['status','wrapped_dek'];
    IF OLD.expires_at > now() THEN
      RAISE EXCEPTION 'message_export_job_not_expired: the link has not expired yet' USING ERRCODE = 'check_violation';
    END IF;
    NEW.wrapped_dek := NULL;
  ELSE
    RAISE EXCEPTION 'message_export_job_transition: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION 'message_export_job_transition: only % change in this step', v_allowed USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_export_job_guard"
  BEFORE INSERT OR UPDATE ON "message_export_job"
  FOR EACH ROW EXECUTE FUNCTION message_export_job_guard();--> statement-breakpoint

CREATE TABLE "message_export_download" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "job_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id"),
  "downloaded_at" timestamptz DEFAULT now() NOT NULL,
  "bytes" integer,
  CONSTRAINT "message_export_download_job_fk"
    FOREIGN KEY ("organization_id", "job_id")
    REFERENCES "message_export_job"("organization_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_export_download_bytes" CHECK ("bytes" IS NULL OR "bytes" >= 0)
);--> statement-breakpoint
CREATE INDEX "message_export_download_job_idx" ON "message_export_download" ("organization_id", "job_id", "downloaded_at");--> statement-breakpoint
CREATE INDEX "message_export_download_user_idx" ON "message_export_download" ("user_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_export_download_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.downloaded_at := now();
  IF NEW.user_id IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid
     OR NOT EXISTS (
       SELECT 1 FROM message_export_job j
        WHERE j.organization_id = NEW.organization_id AND j.id = NEW.job_id
          AND j.requested_by = NEW.user_id
          AND j.status = 'ready' AND j.expires_at > now()) THEN
    RAISE EXCEPTION 'message_export_download_job: a download is recorded only by the requester against a ready, unexpired export' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_export_download_guard"
  BEFORE INSERT ON "message_export_download"
  FOR EACH ROW EXECUTE FUNCTION message_export_download_guard();--> statement-breakpoint

-- RLS on app.org_id (FORCEd); the app role reads and inserts (the job: only the lifecycle columns update); destruction by privilege.
ALTER TABLE "message_export_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_export_job" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_export_download" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_export_download" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "message_export_job_org_isolation" ON "message_export_job"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_export_download_org_isolation" ON "message_export_download"
  FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "message_export_job" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_note", "building_at", "ready_at", "expires_at", "artefact_key", "artefact_sha256",
  "artefact_bytes", "wrapped_dek", "message_count", "held_excluded", "part2_excluded", "failure_code", "download_count") ON "message_export_job" TO chartwarden_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "message_export_download" TO chartwarden_app;--> statement-breakpoint

-- The 1107 PHI audit pattern. Free text (justification, decision_note) and the wrapped key are left out of the audit row; ids, status, counts
-- and instants stay. The download trail is also audited (the arch:gaps rule for every org-scoped table).
CREATE OR REPLACE FUNCTION audit_phi_write_message_export_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD) - 'justification' - 'decision_note' - 'wrapped_dek', ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW) - 'justification' - 'decision_note' - 'wrapped_dek', ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_export_job.' || lower(TG_OP), 'message_export_job',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'warn', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_message_export_job() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_export_job"
  AFTER INSERT OR UPDATE OR DELETE ON message_export_job
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_export_job();--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_message_export_download() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb;
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN public.audit_scrub(to_jsonb(OLD), ARRAY[]::text[]) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN public.audit_scrub(to_jsonb(NEW), ARRAY[]::text[]) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
    correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    CASE WHEN COALESCE(current_setting('app.user_id', true), '') = '' THEN 'system' ELSE 'user' END::audit_actor_kind,
    'message_export_download.' || lower(TG_OP), 'message_export_download',
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
ALTER FUNCTION audit_phi_write_message_export_download() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_message_export_download"
  AFTER INSERT OR UPDATE OR DELETE ON message_export_download
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_message_export_download();--> statement-breakpoint

GRANT SELECT, DELETE ON "message_export_job" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "message_export_download" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "message_export_job_destruction" ON "message_export_job"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_export_download_destruction" ON "message_export_download"
  FOR ALL TO chartwarden_destruction
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The permissions (mirrors 1129 / 1138 / 1140). Request and approve also demand a fresh step-up in the route; the approver is never the
-- requester (CHECK + service). Download is the requester's own, checked in the service. PROVISIONAL until compliance confirms the approver
-- role set (ADR-0089 open items). No clinical, aide or other default role holds any of the three.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.export.request', 'message_export', 'request', 'compliance', 'none', ''),
  ('messaging.export.approve', 'message_export', 'approve', 'compliance', 'none', ''),
  ('messaging.export.download', 'message_export', 'download', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.export.request'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.export.approve'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.export.download'
  FROM "role" r
 WHERE r."key" IN ('compliance_officer', 'administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
