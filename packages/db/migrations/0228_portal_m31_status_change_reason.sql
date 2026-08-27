-- M31 `portal_account.status_change_reason_cipher` — the reason a portal account was suspended or
-- reinstated, which the API demanded and threw away (F-050 / #117).
--
-- WHAT WAS WRONG. `POST /api/v1/admin/portal-accounts/:id/suspend` and its `reinstate` twin publish
-- `reason` as `required: true` (3..500 chars) and their handlers read only the path param. Every caller
-- sent one, every caller got a 200, and no reason was recorded anywhere — an administrative action
-- against a patient- or caregiver-facing account with no answer to "why", while the UI could truthfully
-- say the operator had been asked. Nothing surfaced it: the contract and the implementation agreed with
-- each other and both were wrong about what the route does.
--
-- WHY THIS COLUMN AND NOT THE SPEC'S TABLE. M31 §2.1 puts the reason on a `portal_account_suspension`
-- row and on the `m31.portal_account.suspended` outbox payload. The manifest is authoritative
-- (ADR-0005) and M31 owns exactly three tables — that one is not among them — and M31 has no
-- producer-side outbox publisher wired. Inventing either to hold one string would be a module-scale
-- change made by a contract fix. The account row already has the M4 write-audit trigger on it, so a
-- column here puts the reason exactly where the audit trail reaches every status transition.
--
-- ONE COLUMN, NOT TWO. It records the reason for the most recent ADMINISTRATIVE status transition, so
-- suspend and reinstate write the same column and each write is an UPDATE the audit trigger captures
-- alongside the `status` it changed. Two columns would keep two values on a row that only ever has one
-- current status.
--
-- CIPHER, NOT PLAINTEXT. It is operator-written free text about an identified caregiver — the same
-- class as `portal_access_grant.revoke_reason_cipher`, which M31 §3.6 already denylists. The trigger
-- function below is replaced to add it to the scrub array; `M31_AUDIT_DENYLIST` in
-- `packages/types/src/portal.ts` gains the same entry, and `arch:audit-denylist-sync` fails if the two
-- ever disagree. Nullable: every row that predates this column has no recorded transition reason, and
-- inventing one would be worse than the absence.
ALTER TABLE "portal_account"
  ADD COLUMN IF NOT EXISTS "status_change_reason_cipher" text;--> statement-breakpoint
COMMENT ON COLUMN "portal_account"."status_change_reason_cipher" IS
  'M31 §4.1 — DEK-envelope-encrypted reason for the most recent administrative status transition (suspend/reinstate). §3.6 audit-denylisted: never enters audit_event.before/after.';--> statement-breakpoint
-- Replace the §3.6 write-audit trigger function so the new cipher column is scrubbed too. Identical to
-- 0139's body apart from the fourth entry in `v_cols`.
CREATE OR REPLACE FUNCTION audit_phi_write_portal_account() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['display_name_cipher','email_cipher','phone_cipher','status_change_reason_cipher']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'portal_account.' || lower(TG_OP),
    'portal_account',
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
ALTER FUNCTION audit_phi_write_portal_account() OWNER TO wardenx_audit_writer;--> statement-breakpoint
-- Re-affirms the existing trigger→function binding (PG14+). The function body above is what actually
-- changed — CREATE OR REPLACE FUNCTION alone would suffice — but restating the trigger keeps this
-- migration self-contained and matches what scripts/check-audit-denylist-sync.ts parses per-file (the
-- 0163 precedent).
CREATE OR REPLACE TRIGGER "trg_audit_portal_account" AFTER INSERT OR UPDATE OR DELETE ON portal_account
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_portal_account();
