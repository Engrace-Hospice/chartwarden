-- F-195 (#248) — M11: mitigations for the residual risks of the two-person lab-recovery control (F-194).
--
-- (1) PERMISSION BREADTH. `orders.amend` guarded resend, recover, co-sign and the held-transmission worklist, and the
--     seed grants it to nearly every clinical role. Three dedicated keys now guard them:
--       orders.transmission.recover           file / cancel a recovery, resend, co-sign, read the lab contact's evidence
--       orders.transmission.view_held         read the held-transmission worklist
--       orders.transmission.cosign_escalated  the high-trust co-signer a recovery past the bound requires
--     The `permission` mirror row for each is inserted here (idempotent) so `role_permission`'s FK can be satisfied on a
--     database whose catalog sync has not run yet, and the two roles the catalog sync grants EVERY key to
--     (`administrator`, `org_admin` — scripts/db/sync-permission-catalog.ts GRANT_ALL_ROLE_KEYS) get them in every existing
--     tenant, so no tenant is left without anyone who can recover a lab order. NO other role is granted anything: a
--     tenant grants the narrower keys to a DON / clinical lead / compliance officer on purpose.
--
-- (3) STRANDED REQUESTS. A pending recovery whose order can no longer be recovered (discontinued, corrected, delivered,
--     recovered another way, or its failure reason changed) must not wait out its 24 h TTL to a confusing 409. It becomes
--     `superseded` with a fixed reason token, deterministically, by a trigger on the ORDER's transitions — so EVERY path
--     that moves the order (the routes, M29's applier, the correction trigger, a redelivered event) supersedes it, not only
--     the paths a service function remembered to call. The co-sign's own UPDATE guards on `status = 'pending_cosign'`, so
--     a superseded request can never execute.
--
-- (2) COLLUSION. `cosigned_escalated` records that the co-signature came from a holder of the high-trust key (the service
--     requires it once a requester or a requester/co-signer pair has reached the bound). A database CHECK cannot count a
--     rolling window, so the bound itself is enforced in the service under an advisory lock; this column is the record.

-- ── (1) the permission mirror rows + the admin roles' grants ─────────────────────────────────────────────────────
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('orders.transmission.recover',          'order_transmission', 'recover',          'admin', 'none', ''),
  ('orders.transmission.view_held',        'order_transmission', 'view_held',        'admin', 'none', ''),
  ('orders.transmission.cosign_escalated', 'order_transmission', 'cosign_escalated', 'admin', 'none', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES
   ('orders.transmission.recover'),
   ('orders.transmission.view_held'),
   ('orders.transmission.cosign_escalated')
 ) AS p("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;--> statement-breakpoint

-- ── (2)/(3) the request: a `superseded` terminal state and the escalation record ─────────────────────────────────
ALTER TABLE "order_recovery_request"
  ADD COLUMN IF NOT EXISTS "superseded_reason" text,
  ADD COLUMN IF NOT EXISTS "cosigned_escalated" boolean NOT NULL DEFAULT false;--> statement-breakpoint

ALTER TABLE "order_recovery_request" DROP CONSTRAINT IF EXISTS "order_recovery_request_status_chk";--> statement-breakpoint
ALTER TABLE "order_recovery_request" ADD CONSTRAINT "order_recovery_request_status_chk"
  CHECK ("status" IN ('pending_cosign', 'executed', 'cancelled', 'expired', 'superseded'));--> statement-breakpoint

ALTER TABLE "order_recovery_request" DROP CONSTRAINT IF EXISTS "order_recovery_request_status_agrees_chk";--> statement-breakpoint
ALTER TABLE "order_recovery_request" ADD CONSTRAINT "order_recovery_request_status_agrees_chk" CHECK (
  ("status" = 'pending_cosign' AND "resolved_at" IS NULL AND "cosigned_by_user_id" IS NULL
     AND "cancelled_by_user_id" IS NULL AND "attestation_id" IS NULL)
  OR ("status" = 'executed' AND "resolved_at" IS NOT NULL AND "cosigned_by_user_id" IS NOT NULL
     AND "cancelled_by_user_id" IS NULL AND "attestation_id" IS NOT NULL)
  OR ("status" = 'cancelled' AND "resolved_at" IS NOT NULL AND "cosigned_by_user_id" IS NULL
     AND "cancelled_by_user_id" IS NOT NULL AND "attestation_id" IS NULL)
  OR ("status" = 'expired' AND "resolved_at" IS NOT NULL AND "cosigned_by_user_id" IS NULL
     AND "cancelled_by_user_id" IS NULL AND "attestation_id" IS NULL)
  OR ("status" = 'superseded' AND "resolved_at" IS NOT NULL AND "cosigned_by_user_id" IS NULL
     AND "cancelled_by_user_id" IS NULL AND "attestation_id" IS NULL)
);--> statement-breakpoint

-- A reason exists exactly when the request was superseded, and it is a fixed lowercase token (never free text).
ALTER TABLE "order_recovery_request" ADD CONSTRAINT "order_recovery_request_superseded_reason_chk"
  CHECK (("status" = 'superseded') = ("superseded_reason" IS NOT NULL)
         AND ("superseded_reason" IS NULL OR "superseded_reason" ~ '^[a-z][a-z_]{2,63}$'));--> statement-breakpoint

-- Only an EXECUTED request can carry the escalation record.
ALTER TABLE "order_recovery_request" ADD CONSTRAINT "order_recovery_request_escalated_chk"
  CHECK ("cosigned_escalated" = false OR "status" = 'executed');--> statement-breakpoint

-- The collusion signal's read: executed recoveries per requester / pair inside a window.
CREATE INDEX IF NOT EXISTS "order_transmission_attestation_recent_idx"
  ON "order_transmission_attestation" ("organization_id", "created_at")
  WHERE "attestation" = 'not_received_by_lab' AND "outcome" = 'redispatched';--> statement-breakpoint

-- ── (3) the order's transitions supersede its pending recovery ───────────────────────────────────────────────────
-- Fires only for a lab order that WAS `failed` and whose status, transmission status or failure reason changes — a
-- narrow WHEN, so the hot order_record UPDATE path pays nothing else. Plain invoker (NOT security definer): the UPDATE runs
-- under the caller's own `app.org_id`, so RLS still confines it to the order's tenant, and the explicit organization_id
-- predicate is the belt to that brace. The co-sign updates the REQUEST to `executed` BEFORE it moves the order, so its own
-- transition finds nothing pending.
CREATE OR REPLACE FUNCTION order_record_supersede_recovery_requests() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE order_recovery_request q
     SET status = 'superseded',
         resolved_at = now(),
         superseded_reason = CASE
           WHEN NEW.status IS DISTINCT FROM OLD.status THEN 'order_' || NEW.status::text
           WHEN NEW.transmission_status IS DISTINCT FROM OLD.transmission_status THEN 'transmission_' || NEW.transmission_status::text
           ELSE 'failure_reason_changed'
         END
   WHERE q.organization_id = NEW.organization_id
     AND q.order_record_id = NEW.id
     AND q.status = 'pending_cosign';
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE TRIGGER "trg_order_record_supersede_recovery"
  AFTER UPDATE ON order_record
  FOR EACH ROW
  WHEN (
    OLD.kind = 'lab' AND OLD.transmission_status = 'failed'
    AND (NEW.status IS DISTINCT FROM OLD.status
         OR NEW.transmission_status IS DISTINCT FROM OLD.transmission_status
         OR NEW.transmission_failure_reason IS DISTINCT FROM OLD.transmission_failure_reason)
  )
  EXECUTE FUNCTION order_record_supersede_recovery_requests();
