/**
 * WardenX — runtime LOGIN-role provisioning (task-15; the deployment precondition the
 * production-readiness audit left open).
 *
 * The migrations define NOLOGIN carrier roles (`wardenx_app`, `wardenx_admin`,
 * `wardenx_destruction` — migration 0157, `tenant_platform_writer`, …) but deliberately never a
 * LOGIN credential (passwords do not belong in migrations). This script, run by an operator with a
 * superuser/owner connection, creates the two runtime login roles the composition root's optional
 * pools connect as:
 *
 *   · `wardenx_platform_login` → DATABASE_PLATFORM_URL. Inherits the `wardenx_platform` carrier
 *     (created here, grants enumerated below) and carries the BYPASSRLS ATTRIBUTE — an attribute is
 *     NOT inherited through role membership, so it must sit on the login role itself. Powers: the
 *     M35 §5.2 admin console's cross-tenant reads/writes, the platform-context enumerators (active
 *     orgs for the outbox relay + crons; the M36 D9 sole-tenant membership read), the M34
 *     org-offboarding eraser, and the `platform.bypass_invoked` audit INSERT every
 *     withPlatformContext entry writes.
 *   · `wardenx_destruction_login` → DATABASE_DESTRUCTION_URL. Plain `IN ROLE wardenx_destruction`
 *     (0157 already enumerates its DELETE/UPDATE grants + org-pinned RLS policies). NO BYPASSRLS —
 *     destruction is org-scoped by design.
 *
 * Usage:
 *   PROVISION_DATABASE_URL=postgres://postgres:...@host/db \
 *   WARDENX_PLATFORM_PASSWORD=... WARDENX_DESTRUCTION_PASSWORD=... \
 *   bun run db:provision-roles
 *
 * Idempotent: roles are created only when absent; passwords/attributes are re-ALTERed on every run
 * (so a rotation is just a re-run with a new password); grants are additive re-grants.
 *
 * LEAST-PRIVILEGE POSTURE (documented, deliberate): the `wardenx_platform` carrier's grant list is
 * ENUMERATED below — it is not `wardenx_admin`. If a platform code path hits a missing grant it
 * fails loudly with 42501 and the fix is one line HERE, reviewed — never a blanket ALL.
 */
import { Client } from "pg";

const url = process.env.PROVISION_DATABASE_URL ?? process.env.DATABASE_SUPERUSER_URL;
const platformPassword = process.env.WARDENX_PLATFORM_PASSWORD;
const destructionPassword = process.env.WARDENX_DESTRUCTION_PASSWORD;

if (!url) {
  console.error("PROVISION_DATABASE_URL (superuser/owner) is required");
  process.exit(1);
}
if (!platformPassword && !destructionPassword) {
  console.error(
    "set WARDENX_PLATFORM_PASSWORD and/or WARDENX_DESTRUCTION_PASSWORD (≥16 chars) — nothing to provision otherwise",
  );
  process.exit(1);
}
for (const [name, pw] of [
  ["WARDENX_PLATFORM_PASSWORD", platformPassword],
  ["WARDENX_DESTRUCTION_PASSWORD", destructionPassword],
] as const) {
  if (pw !== undefined && pw.length < 16) {
    console.error(`${name} must be ≥16 characters`);
    process.exit(1);
  }
}

/** The M35 §5.2 / M34 platform surface the carrier may read cross-tenant (SELECT). */
const PLATFORM_READ_TABLES = [
  // M1/M2 spine — the enumerators (active orgs; the M36 D9 sole-tenant membership read).
  "organization",
  "membership",
  // M34 control plane.
  "tenant_account",
  "tenant_account_status_event",
  "tenant_signup_intent",
  "tenant_signup_token",
  "tenant_invitation",
  "onboarding_task",
  "onboarding_task_template",
  "support_consent_grant",
  "support_session",
  "support_session_event",
  "platform_tenant_baa_record",
  "tenant_key_ring",
  "tenant_key_destruction_log",
  "tenant_export_job",
  "tenant_export_job_event",
  "dsar_export_job",
  "dsar_export_job_event",
  // M35 subscription billing (org-scoped rows read cross-tenant by the admin console).
  "plan",
  "plan_meter",
  "subscription",
  "subscription_state_history",
  "invoice",
  "invoice_line",
  "payment_method",
  "refund",
  "dunning_state",
  "promo_code",
  "promo_code_application",
  "usage_event",
  "usage_period_aggregate",
  "patient_active_period",
  "user_active_period",
] as const;

/** The M35 platform-only tables (migration 0143 — RLS with no wardenx_app grant): full write. */
const PLATFORM_WRITE_TABLES = [
  "revenue_recognition_snapshot",
  "stripe_webhook_event",
  "patient_pseudonym_key",
  "stripe_api_call_audit",
  "platform_retained_invoice",
  "platform_retained_invoice_line",
] as const;

/** The §5.2 admin ACTIONS' mutation surface (refunds / dunning / promos) — INSERT+UPDATE only. */
const PLATFORM_MUTATE_TABLES = [
  "refund",
  "dunning_state",
  "promo_code",
  "promo_code_application",
] as const;

/** The M34 org-offboarding eraser's DELETE targets (its 8 erase* methods). */
const PLATFORM_ERASE_TABLES = [
  "onboarding_task",
  "support_consent_grant",
  "support_session",
  "platform_tenant_baa_record",
  "tenant_invitation",
  "tenant_signup_intent",
  "tenant_signup_token",
  "tenant_export_job",
  "tenant_export_job_event",
] as const;

async function main(): Promise<void> {
  const db = new Client({ connectionString: url });
  await db.connect();
  const run = async (sqlText: string): Promise<void> => {
    await db.query(sqlText);
  };
  const quoteLiteral = (v: string): string => `'${v.replaceAll("'", "''")}'`;

  try {
    if (platformPassword) {
      // ── the wardenx_platform carrier + its enumerated grants ─────────────────────────────────
      await run(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_platform') THEN
          CREATE ROLE wardenx_platform NOLOGIN;
        END IF;
      END $$;`);
      await run(`GRANT USAGE ON SCHEMA public TO wardenx_platform;`);
      for (const t of PLATFORM_READ_TABLES) {
        await run(`GRANT SELECT ON "${t}" TO wardenx_platform;`);
      }
      for (const t of PLATFORM_WRITE_TABLES) {
        await run(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO wardenx_platform;`);
      }
      for (const t of PLATFORM_MUTATE_TABLES) {
        await run(`GRANT INSERT, UPDATE ON "${t}" TO wardenx_platform;`);
      }
      for (const t of PLATFORM_ERASE_TABLES) {
        await run(`GRANT DELETE ON "${t}" TO wardenx_platform;`);
      }
      // Every withPlatformContext entry writes its `platform.bypass_invoked` audit row.
      await run(`GRANT INSERT ON "audit_event" TO wardenx_platform;`);

      // ── the login role (BYPASSRLS is an attribute — it lives HERE, not on the carrier) ───────
      await run(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_platform_login') THEN
          CREATE ROLE wardenx_platform_login LOGIN IN ROLE wardenx_platform;
        END IF;
      END $$;`);
      await run(
        `ALTER ROLE wardenx_platform_login LOGIN BYPASSRLS PASSWORD ${quoteLiteral(platformPassword)};`,
      );
      await run(`GRANT wardenx_platform TO wardenx_platform_login;`);
      console.log("✓ wardenx_platform_login provisioned (carrier wardenx_platform + BYPASSRLS)");
      console.log(
        "  → set DATABASE_PLATFORM_URL=postgres://wardenx_platform_login:<pw>@<host>/<db>",
      );
    }

    if (destructionPassword) {
      const carrier = await db.query(
        `SELECT 1 FROM pg_roles WHERE rolname = 'wardenx_destruction'`,
      );
      if (carrier.rowCount === 0) {
        throw new Error(
          "the wardenx_destruction carrier does not exist — run migrations through 0157 first",
        );
      }
      await run(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_destruction_login') THEN
          CREATE ROLE wardenx_destruction_login LOGIN IN ROLE wardenx_destruction;
        END IF;
      END $$;`);
      // Deliberately NO BYPASSRLS: 0157's policies pin destruction to the org context it runs under.
      await run(
        `ALTER ROLE wardenx_destruction_login LOGIN NOBYPASSRLS PASSWORD ${quoteLiteral(destructionPassword)};`,
      );
      await run(`GRANT wardenx_destruction TO wardenx_destruction_login;`);
      console.log(
        "✓ wardenx_destruction_login provisioned (carrier wardenx_destruction, NOBYPASSRLS)",
      );
      console.log(
        "  → set DATABASE_DESTRUCTION_URL=postgres://wardenx_destruction_login:<pw>@<host>/<db>",
      );
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
