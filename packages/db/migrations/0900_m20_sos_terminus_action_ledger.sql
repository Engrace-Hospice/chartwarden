-- GAP-032 - M20 SOS emergency terminus: the durable intent ledger behind the three caller-owned terminus
-- effects (`page_wardenx_ops`, `dial_emergency_contact`, `surface_psap_number`). The architecture-25.5 outbox
-- discipline applied to effects that must NOT run inside the tenant transaction (a telephony / webhook
-- round-trip holding a pooled connection is the M21-T05 finding):
--   1. the watchdog tx records an INTENT row (status `pending`) beside the state change, atomically;
--   2. an executor claims the row, performs the call OUTSIDE any tenant tx, and settles it.
-- It is also the INT-031 "terminus fallback record" (the spec's `m20_terminus_fallback_log`, realised here
-- rather than as a 14th table by another name) and what makes the loop idempotent: UNIQUE on
-- (alert, kind, loop_iteration, attempt_no) means twenty 15-second ticks inside one loop period create ONE row.
--
-- NO PHI AND NO CONTACT DETAIL: reason codes and opaque refs only. `external_ref` is a vendor call SID or a
-- pager dedup key - never a phone number. Tenancy: the three-column rule (org + provider_entity NOT NULL,
-- location nullable), FORCE RLS, org policy, M4 audit trigger.
CREATE TABLE IF NOT EXISTS "safety_sos_terminus_action" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "provider_entity_id" uuid NOT NULL,
  "location_id" uuid,
  "sos_alert_id" uuid NOT NULL,
  "action_kind" text NOT NULL,
  "loop_iteration" integer NOT NULL,
  "attempt_no" integer DEFAULT 0 NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "outcome_code" text,
  "external_ref" text,
  "jurisdiction_id" uuid,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_until" timestamptz,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "requested_at" timestamptz DEFAULT now() NOT NULL,
  "settled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "m20_ssta_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "m20_ssta_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "provider_entity"("id") ON DELETE restrict,
  CONSTRAINT "m20_ssta_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE restrict,
  CONSTRAINT "m20_ssta_alert_fk" FOREIGN KEY ("sos_alert_id") REFERENCES "safety_sos_alert"("id") ON DELETE restrict,
  CONSTRAINT "m20_ssta_kind" CHECK ("action_kind" IN ('page_ops','dial_contact','resolve_psap')),
  CONSTRAINT "m20_ssta_status" CHECK ("status" IN ('pending','attempting','succeeded','failed','skipped','superseded')),
  CONSTRAINT "m20_ssta_outcome" CHECK ("outcome_code" IS NULL OR "outcome_code" IN (
    'ok','consent_absent','consent_unavailable','consent_expired_or_revoked','contact_unreadable','number_invalid',
    'voice_unbound','dial_disabled','pager_unbound','vendor_refused','receiver_non_2xx','timeout',
    'superseded_ack','cap_reached','spacing','jurisdiction_none','jurisdiction_unavailable','possible_duplicate')),
  CONSTRAINT "m20_ssta_iteration" CHECK ("loop_iteration" >= 0 AND "attempt_no" >= 0 AND "attempts" >= 0),
  CONSTRAINT "m20_ssta_settled_stamped" CHECK ("status" NOT IN ('succeeded','failed','skipped','superseded') OR "settled_at" IS NOT NULL),
  CONSTRAINT "m20_ssta_skip_has_outcome" CHECK ("status" NOT IN ('skipped','superseded') OR "outcome_code" IS NOT NULL),
  CONSTRAINT "m20_ssta_idem_uq" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "m20_ssta_iteration_uq" UNIQUE ("sos_alert_id", "action_kind", "loop_iteration", "attempt_no")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssta_due_idx" ON "safety_sos_terminus_action" ("organization_id", "status", "next_attempt_at") WHERE "status" IN ('pending','attempting');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssta_alert_idx" ON "safety_sos_terminus_action" ("sos_alert_id", "action_kind", "loop_iteration");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssta_provider_entity_idx" ON "safety_sos_terminus_action" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssta_location_idx" ON "safety_sos_terminus_action" ("location_id") WHERE "location_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_sos_terminus_action" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "safety_sos_terminus_action" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "safety_sos_terminus_action_org" ON "safety_sos_terminus_action";--> statement-breakpoint
CREATE POLICY "safety_sos_terminus_action_org" ON "safety_sos_terminus_action"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "safety_sos_terminus_action" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "safety_sos_terminus_action" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "safety_sos_terminus_action_audit"
  AFTER INSERT OR UPDATE OR DELETE ON safety_sos_terminus_action
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
