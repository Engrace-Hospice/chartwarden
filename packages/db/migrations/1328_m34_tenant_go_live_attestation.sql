-- compat: contract
-- Declared `contract` because arch:migration-compat reads CREATE UNIQUE INDEX on the EXISTING tenant_account (below) as
-- contracting. It cannot reject a write the previous release makes (`id` is already unique, so the pair is too); the gate
-- is a text heuristic and says so. Consequence, deliberate: deploy.sh halts for an operator (exit 75) instead of
-- auto-restoring the previous release over the batch that carries 1327-1329. Everything else here is additive.
-- M34 two-party go-live (slice 1a). onboarding -> active used to be automatic once the sweep saw every step settled.
-- It now takes two people: the tenant's compliance officer ATTESTS readiness (step-up), then a platform operator
-- APPROVES (step-up, human, reason) and the tenant goes active only if the activation guards pass at that moment. A
-- platform operator can also REVOKE a pending attestation.
--
-- tenant_go_live_attestation: one row per attempt, never deleted (a revoked attestation stays as history, and an
-- approved one is the evidence of who authorised the go-live; like tenant_account_status_event it survives offboarding).
-- Tenant-scoped on organization_id (no PHI). RLS ENABLE + FORCE. The tenant role may READ its own rows, INSERT a PENDING
-- one and VOID a pending one (pending -> revoked, nothing else: it can never approve, and it cannot touch the attester,
-- the time or the note); approve and revoke are also written on the BYPASSRLS platform login (scripts/db/
-- provision-runtime-roles.ts grants it SELECT and a COLUMN-level UPDATE). Write audit: the M1 baseline trigger, whose
-- after-image carries both actors' membership AND user ids.
--
-- WHY THE TENANT ROLE MAY VOID. An attestation states "the onboarding data was ready" at one moment. Any later write to that
-- data (a provider entity, a location, a MAC credential, the org profile; by the tenant's own admin or by an operator
-- entering it for them) voids a pending attestation IN THE SAME TRANSACTION as the write, so approval can only ever rest
-- on data nobody has touched since the officer looked. Those writes run on the tenant pool, so the tenant role needs this
-- one narrow UPDATE. The policy pins the revoker to the session's own user (app.user_id), a named revoking membership to that
-- user's active membership of this organisation, and a non-empty reason.
--
-- TWO PEOPLE, NOT TWO MEMBERSHIPS. A user has a different membership in every organisation they belong to, so a platform
-- operator invited into the tenant as its compliance officer holds two memberships and is one person. Each party is
-- therefore stored as a membership id AND the user behind it, and the approved-state CHECK compares BOTH pairs.
--
-- AUTHENTICITY IS A DATABASE FACT, not only an application check:
--   * (tenant_account_id, organization_id) is a composite FK to tenant_account(id, organization_id) (the unique index on
--     that pair is the key it needs, and the reason this file is `contract`), so a row cannot name another organisation's
--     tenant;
--   * the tenant's INSERT policy pins status pending, every approve/revoke column to NULL, the attester's user to the
--     session user (app.user_id), and the attester's membership to an ACTIVE membership of THIS organisation held by that
--     very user, so a tenant session cannot file an attestation in anyone else's name or from another organisation;
--   * the state CHECK makes the machine a database fact: pending has no approval or revocation, approved has a reason and
--     a different approver (user AND membership) than the attester, revoked has a reason and the USER who revoked it (the
--     membership is recorded where the caller has one; an automatic void on a data change knows only the session's user).
--
-- tenant_account.compliance_officer_membership_id: the tenant's org_admin assigns the compliance officer, so
-- chartwarden_app gets a COLUMN-level UPDATE on that one column (and updated_at) with an own-org UPDATE policy. It still
-- cannot write status or any other column. The policy also requires the tenant to be `onboarding` or `active` (an officer
-- legitimately changes after go-live; a suspended or closing tenant is frozen) and the NEW officer to be an active
-- membership of the same organisation, so the column can never point at a stranger.
-- An (id, organization_id) key on tenant_account: `id` is already unique, this only makes the pair referenceable.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_account_id_organization_id_uq" ON "tenant_account" ("id", "organization_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant_go_live_attestation" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attested_by_membership_id" uuid NOT NULL,
	"attested_by_user_id" uuid NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attestation_note" text,
	"approved_by_membership_id" uuid,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_reason" text,
	"revoked_by_membership_id" uuid,
	"revoked_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_go_live_attestation_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "tenant_go_live_attestation_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "tenant_go_live_attestation_tenant_org_fk" FOREIGN KEY ("tenant_account_id", "organization_id") REFERENCES "public"."tenant_account"("id", "organization_id") ON DELETE restrict,
	CONSTRAINT "tenant_go_live_attestation_status_ck" CHECK ("status" IN ('pending', 'approved', 'revoked')),
	CONSTRAINT "tenant_go_live_attestation_note_ck" CHECK ("attestation_note" IS NULL OR length("attestation_note") <= 2000),
	CONSTRAINT "tenant_go_live_attestation_approval_reason_ck" CHECK ("approval_reason" IS NULL OR length(btrim("approval_reason")) BETWEEN 8 AND 1000),
	CONSTRAINT "tenant_go_live_attestation_revoke_reason_ck" CHECK ("revoke_reason" IS NULL OR length(btrim("revoke_reason")) BETWEEN 8 AND 1000),
	CONSTRAINT "tenant_go_live_attestation_state_ck" CHECK (
	  ("status" = 'pending'
	     AND "approved_by_membership_id" IS NULL AND "approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approval_reason" IS NULL
	     AND "revoked_by_membership_id" IS NULL AND "revoked_by_user_id" IS NULL AND "revoked_at" IS NULL AND "revoke_reason" IS NULL)
	  OR ("status" = 'approved'
	     AND "approved_by_membership_id" IS NOT NULL AND "approved_by_user_id" IS NOT NULL
	     AND "approved_at" IS NOT NULL AND "approval_reason" IS NOT NULL
	     AND "approved_by_membership_id" <> "attested_by_membership_id"
	     AND "approved_by_user_id" <> "attested_by_user_id"
	     AND "revoked_by_membership_id" IS NULL AND "revoked_by_user_id" IS NULL AND "revoked_at" IS NULL AND "revoke_reason" IS NULL)
	  OR ("status" = 'revoked'
	     AND "revoked_by_user_id" IS NOT NULL AND "revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL
	     AND "approved_by_membership_id" IS NULL AND "approved_by_user_id" IS NULL AND "approved_at" IS NULL AND "approval_reason" IS NULL)
	)
);--> statement-breakpoint
-- At most one open attestation per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_go_live_attestation_pending_uq" ON "tenant_go_live_attestation" ("tenant_account_id")
  WHERE "status" = 'pending';--> statement-breakpoint
-- Leads with the composite FK's own columns (tenant_account_id, organization_id) so a parent tenant_account delete or key update
-- does not scan this table (fk-index-coverage), and its attested_at tail serves the wizard's "attestations, newest first" read.
CREATE INDEX IF NOT EXISTS "tenant_go_live_attestation_tenant_ix" ON "tenant_go_live_attestation" ("tenant_account_id", "organization_id", "attested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_go_live_attestation_org_ix" ON "tenant_go_live_attestation" ("organization_id");--> statement-breakpoint

ALTER TABLE "tenant_go_live_attestation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_go_live_attestation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_go_live_attestation_org_read" ON "tenant_go_live_attestation";--> statement-breakpoint
CREATE POLICY "tenant_go_live_attestation_org_read" ON "tenant_go_live_attestation"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_go_live_attestation_org_attest" ON "tenant_go_live_attestation";--> statement-breakpoint
CREATE POLICY "tenant_go_live_attestation_org_attest" ON "tenant_go_live_attestation"
  FOR INSERT TO chartwarden_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status = 'pending'
    AND approved_by_membership_id IS NULL AND approved_by_user_id IS NULL AND approved_at IS NULL AND approval_reason IS NULL
    AND revoked_by_membership_id IS NULL AND revoked_by_user_id IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL
    -- the attester is the session's own user, acting through an active membership of THIS organisation that user holds
    AND attested_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM membership m
       WHERE m.id = tenant_go_live_attestation.attested_by_membership_id
         AND m.organization_id = tenant_go_live_attestation.organization_id
         AND m.user_id = tenant_go_live_attestation.attested_by_user_id
         AND m.status = 'active'
    )
  );--> statement-breakpoint
-- The tenant role may void its own pending attestation, and only that: pending -> revoked, by the session's own user, with a
-- reason. The column list leaves out every approve column and the attester's.
DROP POLICY IF EXISTS "tenant_go_live_attestation_org_void" ON "tenant_go_live_attestation";--> statement-breakpoint
CREATE POLICY "tenant_go_live_attestation_org_void" ON "tenant_go_live_attestation"
  FOR UPDATE TO chartwarden_app
  USING (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status = 'pending'
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status = 'revoked'
    AND revoked_by_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    AND revoked_at IS NOT NULL
    AND revoke_reason IS NOT NULL AND length(btrim(revoke_reason)) >= 8
    -- a membership may be named only if it is the session user's own ACTIVE membership of THIS organisation (an operator's own
    -- membership is in their home organisation, so an operator's void names the user alone)
    AND (
      revoked_by_membership_id IS NULL
      OR EXISTS (
        SELECT 1 FROM membership m
         WHERE m.id = tenant_go_live_attestation.revoked_by_membership_id
           AND m.organization_id = tenant_go_live_attestation.organization_id
           AND m.user_id = tenant_go_live_attestation.revoked_by_user_id
           AND m.status = 'active'
      )
    )
    AND approved_by_membership_id IS NULL AND approved_by_user_id IS NULL AND approved_at IS NULL AND approval_reason IS NULL
  );--> statement-breakpoint
-- INSERT is a column list: the attester's identity and note. Everything else (status, attested_at, the approve and revoke columns)
-- takes its default, so a tenant session can neither back-date an attestation (attested_at stays now()) nor set a state it must
-- not. The repository inserts through a narrow table object because Drizzle lists every column with DEFAULT, which needs
-- privilege on each.
GRANT SELECT ON "tenant_go_live_attestation" TO chartwarden_app;--> statement-breakpoint
GRANT INSERT ("organization_id", "tenant_account_id", "attested_by_membership_id", "attested_by_user_id", "attestation_note") ON "tenant_go_live_attestation" TO chartwarden_app;--> statement-breakpoint
GRANT UPDATE ("status", "revoked_by_membership_id", "revoked_by_user_id", "revoked_at", "revoke_reason", "updated_at") ON "tenant_go_live_attestation" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "tenant_go_live_attestation" TO chartwarden_admin;--> statement-breakpoint
-- The platform carrier exists only where provision-runtime-roles.ts has run; that script re-grants on every run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ON "tenant_go_live_attestation" TO chartwarden_platform;
    -- UPDATE is column-level (approve / revoke only): an attestation's attester, time and note can never be rewritten.
    GRANT UPDATE ("status", "approved_by_membership_id", "approved_by_user_id", "approved_at", "approval_reason", "revoked_by_membership_id", "revoked_by_user_id", "revoked_at", "revoke_reason", "updated_at") ON "tenant_go_live_attestation" TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "tenant_go_live_attestation_audit" ON tenant_go_live_attestation;--> statement-breakpoint
CREATE TRIGGER "tenant_go_live_attestation_audit" AFTER INSERT OR UPDATE OR DELETE ON tenant_go_live_attestation
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint

-- The compliance-officer assignment: one column, own org only, onboarding or active tenants only, and only to an active
-- membership of that same organisation.
GRANT UPDATE ("compliance_officer_membership_id", "updated_at") ON "tenant_account" TO chartwarden_app;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_account_assign_compliance_officer" ON "tenant_account";--> statement-breakpoint
CREATE POLICY "tenant_account_assign_compliance_officer" ON "tenant_account"
  FOR UPDATE TO chartwarden_app
  USING (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status IN ('onboarding', 'active')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status IN ('onboarding', 'active')
    AND compliance_officer_membership_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM membership m
       WHERE m.id = tenant_account.compliance_officer_membership_id
         AND m.organization_id = tenant_account.organization_id
         AND m.status = 'active'
    )
  );
