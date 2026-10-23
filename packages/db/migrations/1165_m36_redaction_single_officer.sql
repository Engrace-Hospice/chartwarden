-- M36 WP 5.6 (ADR-0055 item 7, D9; ADR-0086, PROVISIONAL pending compliance sign-off) - the single-officer redaction fallback.
-- ADR-0055 (accepted 2026-10-11): when an agency has only ONE eligible person, that person may approve their own request, but the redaction is
-- not final until a SECOND ROLE (org admin or privacy officer) countersigns within 72 hours; a lapsed countersign leaves it non-final.
--   * message_redaction gains self_approved_at / countersign_deadline_at (the officer's own approval) and countersigned_by / countersigned_at.
--     `approved_at` keeps meaning "FINAL": every reader that masks a body already keys on it, so a self-approved, uncountersigned redaction
--     masks NOTHING (it still blocks edits and stays out of search, like any request). On countersign the guard sets approved_by := the
--     self-approving officer and approved_at := now(), so the history reads requester = approver = officer, countersigned_by = second role.
--   * The two-people CHECK is relaxed ONLY for a row that carries self_approved_at, and the guard re-states the rule for the ordinary path.
--   * The database enforces who and when (the self-approver is the requester; the countersigner is a different person, bound to app.user_id,
--     within the 72 h deadline on the DATABASE clock, once; a lapsed row can still get an ordinary two-person approval). WHETHER the fallback
--     is allowed (the tenant flag, exactly one eligible officer, a fresh step-up) is the service's, not a trigger's: it is a deployment policy.
--   * New permission messaging.redact.countersign: org_admin and the privacy officer, never the compliance officer (a second role).
ALTER TABLE "message_redaction"
  ADD COLUMN "self_approved_at" timestamptz,
  ADD COLUMN "countersign_deadline_at" timestamptz,
  ADD COLUMN "countersigned_by" uuid REFERENCES "user"("id"),
  ADD COLUMN "countersigned_at" timestamptz;--> statement-breakpoint
CREATE INDEX "message_redaction_countersigned_by_idx" ON "message_redaction" ("countersigned_by") WHERE "countersigned_by" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "message_redaction" DROP CONSTRAINT "message_redaction_two_people";--> statement-breakpoint
ALTER TABLE "message_redaction"
  ADD CONSTRAINT "message_redaction_two_people"
    CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by" OR "self_approved_at" IS NOT NULL),
  ADD CONSTRAINT "message_redaction_self_approval_pair"
    CHECK (("self_approved_at" IS NULL) = ("countersign_deadline_at" IS NULL)),
  ADD CONSTRAINT "message_redaction_countersign_pair"
    CHECK (("countersigned_by" IS NULL) = ("countersigned_at" IS NULL)),
  ADD CONSTRAINT "message_redaction_countersign_needs_self_approval"
    CHECK ("countersigned_by" IS NULL OR "self_approved_at" IS NOT NULL),
  ADD CONSTRAINT "message_redaction_countersigner_is_another"
    CHECK ("countersigned_by" IS NULL OR "countersigned_by" <> "requested_by"),
  ADD CONSTRAINT "message_redaction_self_final_needs_countersign"
    CHECK ("approved_by" IS NULL OR "approved_by" <> "requested_by" OR "countersigned_by" IS NOT NULL);--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_redaction_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'message_redaction_actor: a request is recorded only by its own requester' USING ERRCODE = 'check_violation';
    END IF;
    NEW.requested_at := now();
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
    NEW.self_approved_at := NULL;
    NEW.countersign_deadline_at := NULL;
    NEW.countersigned_by := NULL;
    NEW.countersigned_at := NULL;
    RETURN NEW;
  END IF;
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'message_redaction_final: an approved redaction cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['approved_by', 'approved_at', 'self_approved_at', 'countersign_deadline_at', 'countersigned_by', 'countersigned_at'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['approved_by', 'approved_at', 'self_approved_at', 'countersign_deadline_at', 'countersigned_by', 'countersigned_at']) THEN
    RAISE EXCEPTION 'message_redaction_immutable: the only change allowed is the approval' USING ERRCODE = 'check_violation';
  END IF;

  -- (1) the fallback: the REQUESTER approves their own request. Not final; the countersign deadline starts here (72 h, database clock).
  IF OLD.self_approved_at IS NULL AND NEW.self_approved_at IS NOT NULL THEN
    IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.countersigned_by IS NOT NULL OR NEW.countersigned_at IS NOT NULL THEN
      RAISE EXCEPTION 'message_redaction_immutable: a self-approval is not final and carries no countersign' USING ERRCODE = 'check_violation';
    END IF;
    IF v_user IS DISTINCT FROM OLD.requested_by THEN
      RAISE EXCEPTION 'message_redaction_actor: a self-approval is recorded only by the requester' USING ERRCODE = 'check_violation';
    END IF;
    NEW.self_approved_at := now();
    NEW.countersign_deadline_at := now() + interval '72 hours';
    RETURN NEW;
  END IF;
  IF NEW.self_approved_at IS DISTINCT FROM OLD.self_approved_at OR NEW.countersign_deadline_at IS DISTINCT FROM OLD.countersign_deadline_at THEN
    RAISE EXCEPTION 'message_redaction_immutable: the self-approval cannot be changed' USING ERRCODE = 'check_violation';
  END IF;

  -- (2) the countersign: a DIFFERENT person, within the deadline, once. It makes the redaction final (the officer is recorded as approver).
  IF NEW.countersigned_by IS NOT NULL THEN
    IF OLD.self_approved_at IS NULL OR OLD.countersigned_by IS NOT NULL THEN
      RAISE EXCEPTION 'message_redaction_immutable: only a self-approved redaction is countersigned, once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.countersigned_by IS DISTINCT FROM v_user OR NEW.countersigned_by = OLD.requested_by THEN
      RAISE EXCEPTION 'message_redaction_actor: a countersign is recorded only by a different person than the requester' USING ERRCODE = 'check_violation';
    END IF;
    IF now() > OLD.countersign_deadline_at THEN
      RAISE EXCEPTION 'message_redaction_lapsed: the countersign period has passed' USING ERRCODE = 'check_violation';
    END IF;
    NEW.approved_by := OLD.requested_by;
    NEW.approved_at := now();
    NEW.countersigned_at := now();
    RETURN NEW;
  END IF;

  -- (3) the ordinary approval: a different person than the requester (also the way out of a LAPSED self-approval).
  IF NEW.approved_by IS NULL OR NEW.approved_by = OLD.requested_by THEN
    RAISE EXCEPTION 'message_redaction_immutable: the only change allowed is the approval' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approved_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'message_redaction_actor: an approval is recorded only by the approving user' USING ERRCODE = 'check_violation';
  END IF;
  NEW.approved_at := now();
  RETURN NEW;
END $$;--> statement-breakpoint

GRANT UPDATE ("self_approved_at", "countersign_deadline_at", "countersigned_by", "countersigned_at") ON "message_redaction" TO chartwarden_app;--> statement-breakpoint

INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.redact.countersign', 'message_redaction', 'countersign', 'compliance', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.redact.countersign'
  FROM "role" r
 WHERE r."key" IN ('org_admin', 'hipaa_privacy_officer')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
