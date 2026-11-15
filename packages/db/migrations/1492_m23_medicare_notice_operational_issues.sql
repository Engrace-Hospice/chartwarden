-- compat: expand
-- M23-CM-4C.3B: durable operational follow-up. This is not DDE work and never records filing/acceptance.
CREATE TABLE medicare_notice_operational_issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  notice_type text NOT NULL CHECK (notice_type IN ('noe','notr','transfer','cancellation')),
  notice_id uuid NOT NULL,
  issue_code text NOT NULL CHECK (length(issue_code) BETWEEN 1 AND 80),
  occurrence_key text NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','acknowledged','assigned','resolved','superseded')),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  responsible_area text NOT NULL CHECK (responsible_area IN ('billing','organization_administration','platform_integration','reconciliation')),
  dde_work_item_id uuid,
  assigned_membership_id uuid,
  acknowledged_by_membership_id uuid,
  acknowledged_at timestamptz,
  resolved_by_membership_id uuid,
  resolved_at timestamptz,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT med_notice_issue_org_id_uq UNIQUE (organization_id,id),
  CONSTRAINT med_notice_issue_ack_ck CHECK ((acknowledged_by_membership_id IS NULL) = (acknowledged_at IS NULL)),
  CONSTRAINT med_notice_issue_resolved_ck CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX med_notice_issue_open_occurrence_uq ON medicare_notice_operational_issue
  (organization_id,notice_type,notice_id,issue_code) WHERE status IN ('active','acknowledged','assigned');
CREATE INDEX med_notice_issue_history_ix ON medicare_notice_operational_issue
  (organization_id,notice_type,notice_id,created_at DESC,id DESC);
CREATE INDEX med_notice_issue_worklist_ix ON medicare_notice_operational_issue
  (organization_id,status,severity,last_evaluated_at DESC);
CREATE INDEX med_notice_issue_assignee_ix ON medicare_notice_operational_issue
  (organization_id,assigned_membership_id) WHERE assigned_membership_id IS NOT NULL;

ALTER TABLE medicare_notice_operational_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicare_notice_operational_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY medicare_notice_operational_issue_org ON medicare_notice_operational_issue FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT,INSERT ON medicare_notice_operational_issue TO chartwarden_app;
GRANT UPDATE (status,severity,responsible_area,dde_work_item_id,assigned_membership_id,acknowledged_by_membership_id,acknowledged_at,
  resolved_by_membership_id,resolved_at,last_evaluated_at,version,updated_at) ON medicare_notice_operational_issue TO chartwarden_app;

CREATE FUNCTION medicare_notice_operational_issue_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.assigned_membership_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM membership m WHERE m.id=NEW.assigned_membership_id AND m.organization_id=NEW.organization_id AND m.status='active'
  ) THEN RAISE EXCEPTION 'issue assignee must be an active same-organization membership' USING ERRCODE='23514'; END IF;
  IF NEW.notice_type='noe' AND NOT EXISTS(SELECT 1 FROM noe_record n WHERE n.id=NEW.notice_id AND n.organization_id=NEW.organization_id) THEN
    RAISE EXCEPTION 'operational issue must reference an NOE in the same organization' USING ERRCODE='23503';
  ELSIF NEW.notice_type='notr' AND NOT EXISTS(SELECT 1 FROM notr_record n WHERE n.id=NEW.notice_id AND n.organization_id=NEW.organization_id) THEN
    RAISE EXCEPTION 'operational issue must reference a NOTR in the same organization' USING ERRCODE='23503';
  ELSIF NEW.notice_type IN ('transfer','cancellation') AND NOT EXISTS(SELECT 1 FROM transfer_notice_record t WHERE t.id=NEW.notice_id AND t.organization_id=NEW.organization_id) THEN
    RAISE EXCEPTION 'operational issue must reference a transfer notice in the same organization' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER medicare_notice_operational_issue_guard BEFORE INSERT OR UPDATE ON medicare_notice_operational_issue
  FOR EACH ROW EXECUTE FUNCTION medicare_notice_operational_issue_guard();

CREATE TABLE medicare_notice_operational_issue_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  issue_id uuid NOT NULL,
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (event_type IN ('detected','severity_changed','escalated','assigned','reassigned','acknowledged','resolved','superseded','reopened')),
  actor_membership_id uuid,
  reason_code text NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 100),
  previous_state text,
  next_state text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT med_notice_issue_event_parent_fk FOREIGN KEY (organization_id,issue_id)
    REFERENCES medicare_notice_operational_issue(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT med_notice_issue_event_once_uq UNIQUE (organization_id,event_key)
);
CREATE INDEX med_notice_issue_event_history_ix ON medicare_notice_operational_issue_event
  (organization_id,issue_id,occurred_at,id);
ALTER TABLE medicare_notice_operational_issue_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicare_notice_operational_issue_event FORCE ROW LEVEL SECURITY;
CREATE POLICY medicare_notice_operational_issue_event_org ON medicare_notice_operational_issue_event FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT,INSERT ON medicare_notice_operational_issue_event TO chartwarden_app;
CREATE FUNCTION medicare_notice_operational_issue_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'Medicare notice operational issue history is append-only'; END $fn$;
CREATE TRIGGER medicare_notice_operational_issue_event_immutable BEFORE UPDATE OR DELETE ON medicare_notice_operational_issue_event
  FOR EACH ROW EXECUTE FUNCTION medicare_notice_operational_issue_event_immutable();

-- Transactional delivery outbox: the issue/event commit and notification intent share one PostgreSQL transaction.
CREATE TABLE medicare_notice_operational_issue_notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  issue_event_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','published')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT med_notice_issue_notification_event_fk FOREIGN KEY (organization_id,issue_event_id)
    REFERENCES medicare_notice_operational_issue_event(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT med_notice_issue_notification_delivery_ck CHECK ((state='published') = (published_at IS NOT NULL)),
  CONSTRAINT med_notice_issue_notification_event_uq UNIQUE (organization_id,issue_event_id)
);
CREATE INDEX med_notice_issue_notification_pending_ix ON medicare_notice_operational_issue_notification(organization_id,created_at)
  WHERE state='pending';
ALTER TABLE medicare_notice_operational_issue_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE medicare_notice_operational_issue_notification FORCE ROW LEVEL SECURITY;
CREATE POLICY medicare_notice_operational_issue_notification_org ON medicare_notice_operational_issue_notification FOR ALL TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id',true),'')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id',true),'')::uuid);
GRANT SELECT,INSERT ON medicare_notice_operational_issue_notification TO chartwarden_app;
GRANT UPDATE (state,attempts,last_attempt_at,published_at) ON medicare_notice_operational_issue_notification TO chartwarden_app;
