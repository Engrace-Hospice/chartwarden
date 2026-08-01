/**
 * WardenX — local migration runner (dev convenience; NOT the production migrator).
 *
 * Applies every `packages/db/migrations/*.sql` in lexical order against a Postgres DB,
 * connecting as a SUPERUSER (the files CREATE EXTENSION / CREATE ROLE / own tables). After the
 * chain it makes the RLS-enforced app role (`wardenx_app`) a LOGIN role so the backend can connect
 * directly as it (production policies are `TO wardenx_app`; the app sets `app.org_id` per request
 * via withOrgContext but never `SET ROLE`).
 *
 * Env (Bun auto-loads `.env`):
 *   DATABASE_ADMIN_URL  superuser conn string for DDL (falls back to DATABASE_URL)
 *   WARDENX_APP_PASSWORD password set on the wardenx_app login role (default "wardenx_app")
 *
 * Run:  bun run db:migrate
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "packages", "db", "migrations");
const APP_ROLE = "wardenx_app";
/** BYPASSRLS is an explicit, development-only opt-in — see the grant block below. */
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const BYPASSRLS_REQUESTED = process.env.WARDENX_DEV_BYPASSRLS === "1";

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  // A guessable default password on a LOGIN role is only tolerable on a throwaway local cluster.
  if (IS_PRODUCTION && !process.env.WARDENX_APP_PASSWORD) {
    throw new Error(
      "WARDENX_APP_PASSWORD is required when NODE_ENV=production — refusing to set the default " +
        `login password on ${APP_ROLE}.`,
    );
  }
  const appPassword = process.env.WARDENX_APP_PASSWORD ?? "wardenx_app";

  const db = new Client({ connectionString: url });
  await db.connect();

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  console.log(`Applying ${files.length} migrations from ${MIGRATIONS_DIR}`);

  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    process.stdout.write(`  • ${f} … `);
    try {
      await db.query(sql);
      console.log("ok");
    } catch (err) {
      console.log("FAIL");
      console.error(`\nMigration ${f} failed:\n`, err);
      await db.end();
      process.exit(1);
    }
  }

  // Make the RLS app role connectable so DATABASE_URL can be wardenx_app directly.
  // Both the role name and the password are escaped BY POSTGRES (`%I` / `%L`) rather than
  // interpolated: ALTER ROLE takes no bind parameters, so the statement is built with `format()`
  // server-side and then executed. A password containing a quote is a broken migration at best.
  console.log(`Enabling LOGIN on ${APP_ROLE} …`);
  const { rows } = await db.query<{ stmt: string }>(
    "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS stmt",
    [APP_ROLE, appPassword],
  );
  await db.query(rows[0].stmt);
  // CONNECT on the database (PUBLIC has it by default, but be explicit/idempotent).
  await db.query(`GRANT CONNECT ON DATABASE ${db.database} TO ${APP_ROLE}`);

  // BYPASSRLS makes all 357 RLS policies decorative for the connecting role, so it is opt-in and
  // refused outside development. Several pre-org / cross-org reads (`/auth/memberships` —
  // membership-repository.ts; M26 cap) genuinely need a connection RLS cannot scope; the production
  // answer is a SECOND pooled credential for those reads, not a blanket bypass on the app role.
  // Until that pool exists, a local single-org demo opts in explicitly with WARDENX_DEV_BYPASSRLS=1.
  if (BYPASSRLS_REQUESTED && !IS_PRODUCTION) {
    console.log(`⚠️  DEV ONLY: granting BYPASSRLS to ${APP_ROLE} (RLS is not enforced for this role)`);
    await db.query(`ALTER ROLE ${APP_ROLE} WITH BYPASSRLS`);
  } else {
    // Idempotent and safe to run against a cluster where a previous migrate granted it.
    await db.query(`ALTER ROLE ${APP_ROLE} WITH NOBYPASSRLS`);
    if (BYPASSRLS_REQUESTED) {
      console.log("✗ WARDENX_DEV_BYPASSRLS ignored: NODE_ENV=production. BYPASSRLS revoked.");
    } else {
      console.log(
        `RLS enforced for ${APP_ROLE} (set WARDENX_DEV_BYPASSRLS=1 for the local single-org demo;\n` +
          "  without it, pre-org reads such as /auth/memberships return no rows and org-select is empty).",
      );
    }
  }

  await db.end();
  console.log("✓ migrations complete; wardenx_app is LOGIN-enabled.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
