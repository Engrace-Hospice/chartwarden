-- M36 WP 4.1 - the urgency model (ADR-0068). Two columns on message, no new table: the acknowledgment request (WP 4.2)
-- will hang off message_id. `urgency` is `routine` for every message; `urgent` is written ONLY by the "Urgent clinical"
-- entry (patient care-team channel + SBAR body + one named qualified recipient). `important` is reserved for WP 4.2's
-- deadline policy and has no writer yet. Neither column is ever derived from message text.
--
-- The database backs the rules the service checks first:
--   * an urgent message names exactly one recipient and nobody else does (CHECK);
--   * both columns are fixed at birth - a trigger refuses any later change, whoever asks (an urgent message is also not
--     editable, enforced in the edit transaction);
--   * non-PHI (an enum and a user id); the existing message audit trigger is unchanged. RLS/FORCE and the org-isolation
--     policy on message are untouched (every row already carries organization_id).

CREATE TYPE "message_urgency" AS ENUM ('routine', 'important', 'urgent');--> statement-breakpoint

ALTER TABLE "message"
  ADD COLUMN "urgency" "message_urgency" DEFAULT 'routine' NOT NULL,
  ADD COLUMN "urgent_recipient_user_id" uuid REFERENCES "user"("id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_urgency_shape"
  CHECK (("urgency" = 'urgent') = ("urgent_recipient_user_id" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "message_urgent_recipient_idx" ON "message" ("organization_id", "urgent_recipient_user_id", "created_at")
  WHERE "urgent_recipient_user_id" IS NOT NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION message_urgency_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.urgency IS DISTINCT FROM OLD.urgency
     OR NEW.urgent_recipient_user_id IS DISTINCT FROM OLD.urgent_recipient_user_id THEN
    RAISE EXCEPTION 'message urgency is fixed at send' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "trg_message_urgency_immutable"
  BEFORE UPDATE ON "message"
  FOR EACH ROW EXECUTE FUNCTION message_urgency_immutable();--> statement-breakpoint

-- ── permissions (1102's shape): catalog rows + grants to role keys wherever a tenant has created them ──────────────────
-- messaging.urgent.send: may raise an urgent clinical message (05 matrix "Initiate urgent escalation": clinician, aide and
--   team lead yes; org admin conditional and compliance no - read the stricter way, so neither gets it by default).
-- messaging.urgent.receive: may be NAMED as its recipient, i.e. take clinical responsibility (matrix "Acknowledge clinical
--   responsibility": qualified role only; aide = receipt only). Deliberately NOT lpn, msw, chaplain, aide, volunteer,
--   org_admin or compliance. PROVISIONAL until the clinical lead signs the role map
--   (docs/messaging-hub/brief-clinical-lead-signoff.md). A tenant tightens by removing a grant from a role it owns.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('messaging.urgent.send', 'urgent_message', 'send', 'clinical', 'none', ''),
  ('messaging.urgent.receive', 'urgent_message', 'receive', 'clinical', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.urgent.receive'
  FROM "role" r
 WHERE r."key" IN ('rn', 'rn_case_manager', 'director_of_nursing', 'don', 'md', 'physician', 'hospice_physician',
                   'medical_director', 'attending_clinician', 'np', 'nurse_practitioner', 'pa', 'clinical_supervisor',
                   'clinical_lead')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", 'messaging.urgent.send'
  FROM "role" r
 WHERE r."key" IN ('rn', 'lpn', 'rn_case_manager', 'director_of_nursing', 'don', 'md', 'physician', 'hospice_physician',
                   'medical_director', 'attending_clinician', 'np', 'nurse_practitioner', 'pa', 'msw', 'chaplain',
                   'clinical_supervisor', 'clinical_lead', 'chha', 'aide', 'hospice_aide', 'home_health_aide')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
