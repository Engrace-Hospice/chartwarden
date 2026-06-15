-- M2 Identity §3.8 — RLS, append-only GRANT model, and write-audit triggers for the
-- four Module 2 tables created in 0005. Runs after the Drizzle-generated table DDL,
-- the same two-phase shape M1 uses (0001 RLS + 0004 audit triggers).
--
-- Tenancy classification (check-tenancy.ts NON_ORG_SCOPED set / ARCH-011):
--   • two_factor, passkey                    — USER-owned, cross-org auth credentials
--   • organization_invitation,
--     tenant_step_up_policy_override          — ORG-scoped (carry organization_id)
--
-- AUTHORITY NOTE (architecture > module spec). The M2 spec §3.8 proposes RLS on
-- two_factor/passkey keyed on a per-user session variable (app dot user_id). ADR-0010 D2
-- makes `app.org_id` the ONLY session variable any policy may key on (enforced by
-- check-tenancy.ts), and M1's migration 0001 already establishes the canonical
-- treatment for user-owned, cross-org tables (user/session/account/verification): they
-- are left un-RLS'd and scoped to the authenticated user at the application layer (a
-- user legitimately spans orgs, so org-keyed RLS cannot express user ownership). M2's
-- two_factor/passkey are the same category, so they follow that established pattern —
-- un-RLS'd here, user-scoped in every query through the authenticated session. The
-- org-scoped tables get standard `app.org_id` RLS via the M1 generator shape.

-- Append-only GRANT model ---------------------------------------------------
-- wardenx_app gets full DML; it remains subject to RLS on the org-scoped tables.
GRANT INSERT, SELECT, UPDATE, DELETE ON
  "two_factor", "passkey", "organization_invitation", "tenant_step_up_policy_override"
TO wardenx_app;--> statement-breakpoint

-- Row-Level Security (org-scoped tables only) -------------------------------
-- two_factor / passkey are intentionally NOT under RLS (user-owned, cross-org — see the
-- authority note above; matches user/session/account/verification in 0001).
ALTER TABLE "organization_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_step_up_policy_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- organization_invitation: standard tenant isolation on the canonical app.org_id var.
CREATE POLICY "organization_invitation_org_isolation" ON "organization_invitation"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- tenant_step_up_policy_override: same tenant isolation. The spec further restricts
-- WRITES to compliance_officer/org_admin and adds a tighten-only trigger (§3.7, D9);
-- those are authorization concerns that wire in with Module 3 (deny-stub until M3) —
-- the org-isolation boundary is what M2-T02 owns.
CREATE POLICY "tenant_step_up_policy_override_org_isolation" ON "tenant_step_up_policy_override"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- Write-audit triggers ------------------------------------------------------
-- Reuse M1's wardenx_audit_trigger() (0004): captures the before/after row image into
-- audit_event. Attached to all four tables so identity-credential and invitation/policy
-- mutations are auditable (M4 later supersedes with column-level denylist scrubbing).
-- For the un-org-scoped tables the function falls back to the app.org_id session var
-- for attribution (set by withOrgContext). The fitness gate (phi-guards) requires the
-- trigger on the two org-scoped tables; two_factor/passkey get it for audit completeness
-- (mirrors account_audit/session_audit in 0004).
CREATE TRIGGER "two_factor_audit" AFTER INSERT OR UPDATE OR DELETE ON two_factor
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "passkey_audit" AFTER INSERT OR UPDATE OR DELETE ON passkey
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "organization_invitation_audit" AFTER INSERT OR UPDATE OR DELETE ON organization_invitation
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "tenant_step_up_policy_override_audit" AFTER INSERT OR UPDATE OR DELETE ON tenant_step_up_policy_override
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
