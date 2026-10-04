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
 *
 *     WX-PR-025 (M33 §2.4 nightly MV refresh — genuinely cross-tenant): `report_mv.*` materialized
 *     views are also OWNED by `wardenx_platform` here, and — UNLIKE every other use above —
 *     `wardenx_platform` (the CARRIER, not just the login role) is ALSO given BYPASSRLS directly.
 *     Confirmed empirically: `REFRESH MATERIALIZED VIEW CONCURRENTLY` re-executes the MV's defining
 *     query under privileges resolved through the MV's OWNER (view-owner-style semantics), not the
 *     session role that issues the REFRESH command — so `wardenx_platform_login`'s own BYPASSRLS
 *     attribute (sufficient for every ordinary query above, issued directly as that role) does NOT
 *     make a refresh see other tenants' rows; only the OWNER's own BYPASSRLS does. This is narrowly
 *     scoped to REFRESH's internal owner-context execution — `wardenx_platform` stays NOLOGIN, so
 *     nothing can connect directly as it, and nothing in this codebase does `SET ROLE
 *     wardenx_platform` (ordinary queries against `wardenx_platform`'s grants already work correctly
 *     via automatic privilege INHERITANCE through `wardenx_platform_login`, which needs no `SET
 *     ROLE`) — it does not widen what any session can read through the normal connection path.
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
  "patient",
  // M4 destruction ceremony facts (certificate approval + active legal holds).
  "destruction_certificate",
  "legal_hold",
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
  // WX-PR-025 — M33 §2.4 nightly MV refresh source tables (see MV_REFRESH_MATERIALIZED_VIEWS below):
  // the refresh's re-executed defining query needs a real SELECT grant on each MV's source table,
  // independent of (in addition to) the owner-role BYPASSRLS that lets it see every tenant's rows.
  "admission", // mv_census_org_daily
  "encounter", // mv_encounter_productivity_membership_day
  "evv_event", // mv_evv_compliance_org_week
] as const;

/**
 * WX-PR-025 — the `report_mv.*` materialized views `wardenx_platform` must OWN so the nightly
 * `report.mv_refresh` job (M33 §2.4) can genuinely `REFRESH MATERIALIZED VIEW CONCURRENTLY` a
 * cross-tenant rollup. Enumerated like everything else in this script (not a catalog-driven loop) —
 * a new MV added to `materialized_view_metadata` needs its schema-qualified name added here too, or
 * its own nightly refresh will hit the identical `permission denied` this migration fixes.
 */
const MV_REFRESH_MATERIALIZED_VIEWS = [
  "report_mv.mv_census_org_daily",
  "report_mv.mv_encounter_productivity_membership_day",
  "report_mv.mv_evv_compliance_org_week",
] as const;

/**
 * WX-PR-025 — the SECURITY DEFINER platform-writer functions (migrations 0186/0187/0188) that M33's
 * `mvRefresh`/`lagProbe` workers reach when `platformDb` is `wardenx_platform_login`: the mandatory
 * `platform.bypass_invoked` audit write every `withPlatformContext` entry makes, the nullable-org
 * outbox emit (mvRefresh's 3 lifecycle events + lagProbe's threshold-transition events), and the
 * report_run/materialized_view_metadata platform writes WX-PR-024 added. Each is already narrowly
 * scoped in its own migration (organization_id hardcoded, never caller-supplied) — this only extends
 * WHO may call them, not what they can do.
 */
const PLATFORM_WRITER_FUNCTIONS = [
  "audit_writer_insert_platform_event(text, text, uuid, text, text, text, jsonb, text)",
  "report_writer_insert_platform_outbox_event(text, text, uuid, jsonb)",
  "report_writer_insert_platform_report_run(uuid, text, text, uuid, timestamptz, text, int)",
  "report_writer_update_platform_report_run(uuid, timestamptz, jsonb)",
  "report_writer_update_platform_mv_metadata(text, jsonb)",
  // F-033/#93 — the `platform.partition_rotate` cron's two entry points (migration 0224). Creating a
  // partition needs OWNERSHIP of the parent table, which `wardenx_platform` deliberately does not have
  // and should not be given: making it a DDL role to solve a monthly maintenance task would hand every
  // platform job the ability to reshape the schema. `rotate_time_partitions` is SECURITY DEFINER and
  // takes an integer — every identifier it executes comes from `pg_catalog`, none from the caller — so
  // this grant widens WHO may rotate partitions, not what the platform role can do to the schema.
  "rotate_time_partitions(int)",
  "time_partition_coverage()",
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

/** Narrow write surface required by the M34 tenant-provisioning saga and invitation acceptance. */
const PLATFORM_PROVISION_INSERT_TABLES = [
  "organization",
  "outbox_event",
  "tenant_account",
  "tenant_account_status_event",
  "tenant_key_destruction_log",
  "tenant_invitation",
] as const;

const PLATFORM_PROVISION_UPDATE_TABLES = [
  "tenant_account",
  "tenant_key_ring",
  "destruction_certificate",
  "tenant_signup_intent",
  "tenant_invitation",
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
      await run("GRANT USAGE ON SCHEMA public TO wardenx_platform;");
      for (const t of PLATFORM_READ_TABLES) {
        await run(`GRANT SELECT ON "${t}" TO wardenx_platform;`);
      }
      // F-236 — the M32 backend health sweep (worker) is the only writer of these two columns. A COLUMN
      // grant, not table UPDATE: the platform role may record a probe result, never re-pin a model, flip
      // `zdr_status`, or reactivate a backend (those stay `wardenx_admin`, db:sync:ai-backends).
      await run('GRANT SELECT ON "ai_model_backend" TO wardenx_platform;');
      await run(
        'GRANT UPDATE (last_health_status, last_health_check_at) ON "ai_model_backend" TO wardenx_platform;',
      );
      for (const t of PLATFORM_WRITE_TABLES) {
        await run(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO wardenx_platform;`);
      }
      for (const t of PLATFORM_MUTATE_TABLES) {
        await run(`GRANT INSERT, UPDATE ON "${t}" TO wardenx_platform;`);
      }
      for (const t of PLATFORM_PROVISION_INSERT_TABLES) {
        await run(`GRANT INSERT ON "${t}" TO wardenx_platform;`);
      }
      for (const t of PLATFORM_PROVISION_UPDATE_TABLES) {
        await run(`GRANT UPDATE ON "${t}" TO wardenx_platform;`);
      }
      await run(
        "GRANT EXECUTE ON FUNCTION m34_provision_tenant_key_ring(uuid) TO wardenx_platform;",
      );
      await run(
        "GRANT EXECUTE ON FUNCTION m34_destroy_tenant_key_ring(uuid, uuid) TO wardenx_platform;",
      );
      for (const t of PLATFORM_ERASE_TABLES) {
        await run(`GRANT DELETE ON "${t}" TO wardenx_platform;`);
      }
      // Every withPlatformContext entry writes its `platform.bypass_invoked` audit row.
      await run(`GRANT INSERT ON "audit_event" TO wardenx_platform;`);

      // ── WX-PR-025: report_mv.* ownership + BYPASSRLS on the CARRIER (not just the login role) ──
      // `wardenx_platform` must OWN each MV for `REFRESH MATERIALIZED VIEW CONCURRENTLY` to be a
      // permitted command at all — and, because REFRESH re-executes the defining query under
      // privileges resolved through the OWNER (not the issuing session role), the OWNER itself needs
      // BYPASSRLS for that re-executed query to see every tenant's rows. Without this second
      // BYPASSRLS grant, refresh either fails outright (no SELECT on the source table) or silently
      // "succeeds" with an EMPTY/wrong result (SELECT granted but RLS still filters every row) — see
      // this file's header comment for the full reasoning.
      await run("GRANT USAGE ON SCHEMA report_mv TO wardenx_platform;");
      for (const mv of MV_REFRESH_MATERIALIZED_VIEWS) {
        await run(`ALTER MATERIALIZED VIEW ${mv} OWNER TO wardenx_platform;`);
      }
      await run("ALTER ROLE wardenx_platform WITH BYPASSRLS;");
      // wardenx_platform reads materialized_view_metadata directly (not through wardenx_app's
      // materialized_view_metadata_read_all policy — BYPASSRLS skips RLS entirely, but the base
      // table GRANT is still required regardless of BYPASSRLS).
      await run(`GRANT SELECT ON "materialized_view_metadata" TO wardenx_platform;`);

      // ── the SECURITY DEFINER platform-writer functions M33's mvRefresh/lagProbe workers call when
      //    `platformDb` = wardenx_platform_login (apps/backend/src/index.ts, WX-PR-025) — migrations
      //    0186/0187/0188 grant EXECUTE to `wardenx_app` only (every OTHER module's withPlatformContext
      //    caller still runs on the tenant pool), so `wardenx_platform` needs its own EXECUTE grant on
      //    each one it can reach. `wardenx_platform` doesn't exist at migration time, so — like every
      //    other grant in this script — this can't live in a migration file either.
      for (const fn of PLATFORM_WRITER_FUNCTIONS) {
        await run(`GRANT EXECUTE ON FUNCTION ${fn} TO wardenx_platform;`);
      }

      // ── the login role (BYPASSRLS is an attribute — it lives HERE, not on the carrier) ───────
      await run(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wardenx_platform_login') THEN
          CREATE ROLE wardenx_platform_login LOGIN IN ROLE wardenx_platform;
        END IF;
      END $$;`);
      await run(
        `ALTER ROLE wardenx_platform_login LOGIN BYPASSRLS PASSWORD ${quoteLiteral(platformPassword)};`,
      );
      await run("GRANT wardenx_platform TO wardenx_platform_login;");
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
      await run("GRANT wardenx_destruction TO wardenx_destruction_login;");
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
