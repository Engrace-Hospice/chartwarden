-- compat: expand
-- CW-AC-46 (#1152) — the per-organization ENFORCEMENT MODE of the HOPE signer-licence check (M10, apps/backend/src/modules/10-hope/
-- hope-signer-licence-policy.ts). One row per organization; an ABSENT row means `enforce` (compliant by default: the code applies the
-- default, nothing has to be seeded, and a tenant provisioned later enforces too).
--   enforce   a signer with no active licence in the record's discipline is refused (403), as before.
--   shadow    the signature goes through, and the would-be refusal is recorded as an audit finding (m10.signature.licence_refused,
--             context.mode = 'shadow') that the CW-MON-01 burst rule still counts. Used for the rollout window only: back-fill the
--             licences, read the findings, then switch to enforce.
-- Running below enforce REQUIRES a reason (20-200 characters once trimmed, the CW-AC-24 claims-billing gate's log-only rule), kept on the
-- row while the organization is in shadow and cleared when it returns to enforce (the explicit audit event
-- m10.signature.licence_policy_changed carries it permanently). The CHECK below is the last line behind the service's own validation.
-- Org-level configuration, no patient and no PHI: organization_id only (like documentation_obligation_policy). RLS + grants + audit
-- trigger below; the platform-category permission that writes it is mirrored here too (the 0600 / 1515 shape). It is NOT granted to any
-- role: a `platform` key is never a tenant default (template-materialization.ts), and the tenant's own administrators must not be able to
-- lower a compliance control on their own organization.
CREATE TYPE "public"."hope_signer_licence_mode" AS ENUM ('enforce', 'shadow');--> statement-breakpoint

CREATE TABLE "hope_signer_licence_policy" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organization"("id") ON DELETE RESTRICT,
  "mode" "hope_signer_licence_mode" DEFAULT 'enforce' NOT NULL,
  "shadow_reason" text,
  "configured_by_user_id" uuid NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "hope_signer_licence_policy_reason" CHECK (
    ("mode" = 'enforce' AND "shadow_reason" IS NULL)
    OR ("mode" = 'shadow' AND "shadow_reason" IS NOT NULL
        AND char_length(btrim("shadow_reason")) BETWEEN 20 AND 200 AND char_length("shadow_reason") <= 200)
  )
);--> statement-breakpoint

ALTER TABLE "hope_signer_licence_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_signer_licence_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "hope_signer_licence_policy_org_isolation" ON "hope_signer_licence_policy"
  FOR ALL TO chartwarden_app
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
-- The PUT upserts, so INSERT + UPDATE; no DELETE (an organization returns to the default by writing mode enforce).
GRANT SELECT, INSERT, UPDATE ON "hope_signer_licence_policy" TO chartwarden_app;--> statement-breakpoint

-- M4 write-audit row trigger (the M35 baseline trigger): the row's before and after image, beside the explicit event (which names the
-- operator and the previous mode). The baseline trigger does not scrub, so the screened reason is in that image too.
-- (The table name is unquoted on purpose: arch:gaps recognises an audit trigger by `ON <table>` followed by `audit`.)
CREATE TRIGGER "hope_signer_licence_policy_audit" AFTER INSERT OR UPDATE OR DELETE ON hope_signer_licence_policy
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint

-- Tenant destruction (the 1099 / 1478 / 1514 pattern): the destruction role may read and delete one organization's row.
GRANT SELECT, DELETE ON "hope_signer_licence_policy" TO chartwarden_destruction;--> statement-breakpoint
CREATE POLICY "hope_signer_licence_policy_destruction" ON "hope_signer_licence_policy"
  FOR ALL TO chartwarden_destruction
  USING ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK ("organization_id" = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

-- The permission that sets the mode (category `platform`: cross-tenant operator authority, like hope.admin.late_deadline_override).
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('hope.admin.signer_licence_policy', 'hope_admin', 'signer_licence_policy', 'platform', 'none', '')
ON CONFLICT ("key") DO NOTHING;
