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

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
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
  console.log(`Enabling LOGIN on ${APP_ROLE} …`);
  await db.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${appPassword}'`);
  // CONNECT on the database (PUBLIC has it by default, but be explicit/idempotent).
  await db.query(`GRANT CONNECT ON DATABASE ${db.database} TO ${APP_ROLE}`);
  // LOCAL-DEV ONLY: let wardenx_app bypass RLS. The app's queries already scope explicitly by
  // org/user (RLS is defense-in-depth here), and several pre-org / cross-org reads (e.g.
  // /auth/memberships — see membership-repository.ts) are documented to require a BYPASSRLS/platform
  // connection. For a single-org local demo this makes the whole surface work. NOT for production
  // (prod uses a dedicated platform pool for cross-org reads); the live RLS suite uses its own DB.
  await db.query(`ALTER ROLE ${APP_ROLE} WITH BYPASSRLS`);

  await db.end();
  console.log("✓ migrations complete; wardenx_app is LOGIN-enabled.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
