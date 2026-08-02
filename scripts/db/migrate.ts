/**
 * WardenX — local migration runner (dev convenience; NOT the production migrator).
 *
 * Applies every `packages/db/migrations/*.sql` in lexical order against a Postgres DB,
 * connecting as a SUPERUSER (the files CREATE EXTENSION / CREATE ROLE / own tables). After the
 * chain it makes the RLS-enforced app role (`wardenx_app`) a LOGIN role so the backend can connect
 * directly as it (production policies are `TO wardenx_app`; the app sets `app.org_id` per request
 * via withOrgContext but never `SET ROLE`).
 *
 * IDEMPOTENT: each applied migration is recorded in a `_wardenx_migration` tracking table (filename
 * + sha256 checksum), so a re-run applies only the NEW files and skips the rest — the runner is safe
 * to invoke against a populated DB. Each migration + its tracking row commit in a single transaction,
 * so a crash mid-file never leaves it half-recorded. An already-applied file whose contents changed
 * since is warned about (its checksum no longer matches), not silently re-run.
 *
 * ADOPTING AN ALREADY-MIGRATED DB (`--baseline`): a DB migrated before this tracker existed has an
 * empty tracking table, so a normal run would try to re-apply everything and fail on the first
 * CREATE that already exists. Run `bun run db:migrate -- --baseline` (or `db:migrate:baseline`) ONCE
 * to RECORD every current migration as applied WITHOUT running it — asserting "this DB is already at
 * head". Only do this when the DB truly is fully migrated; afterwards plain `db:migrate` is a no-op
 * until new files land.
 *
 * Env (Bun auto-loads `.env`):
 *   DATABASE_ADMIN_URL  superuser conn string for DDL (falls back to DATABASE_URL)
 *   WARDENX_APP_PASSWORD password set on the wardenx_app login role (default "wardenx_app")
 *
 * Run:  bun run db:migrate            (apply pending)
 *       bun run db:migrate:baseline   (adopt an already-migrated DB — record all as applied)
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "packages", "db", "migrations");
const APP_ROLE = "wardenx_app";
/** Runtime bookkeeping table (created by this script, not a migration; unowned by any module). */
const TRACK_TABLE = "_wardenx_migration";
/** `--baseline`: record every current migration as applied WITHOUT running it (adopt a migrated DB). */
const BASELINE = process.argv.includes("--baseline");
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

  // The tracking table records which migrations have run (filename + content checksum). Created here
  // rather than in a migration so the runner can consult it before applying anything.
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${TRACK_TABLE} (
       filename   text PRIMARY KEY,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Map<string, string>();
  for (const row of (
    await db.query<{ filename: string; checksum: string }>(
      `SELECT filename, checksum FROM ${TRACK_TABLE}`,
    )
  ).rows) {
    applied.set(row.filename, row.checksum);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (BASELINE) {
    const untracked = files.filter((f) => !applied.has(f));
    for (const f of untracked) {
      const checksum = createHash("sha256")
        .update(readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
        .digest("hex");
      await db.query(
        `INSERT INTO ${TRACK_TABLE}(filename, checksum) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [f, checksum],
      );
    }
    console.log(
      `Baselined: recorded ${untracked.length} migration(s) as applied WITHOUT running them ` +
        `(${applied.size} already tracked). Assuming this DB is at head.`,
    );
  } else {
    const pending = files.filter((f) => !applied.has(f));
    console.log(
      `${files.length} migration file(s) in ${MIGRATIONS_DIR}; ${applied.size} already applied, ` +
        `${pending.length} pending.`,
    );
    let ran = 0;
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const priorChecksum = applied.get(f);
      if (priorChecksum !== undefined) {
        if (priorChecksum !== checksum) {
          console.log(`  ⚠ ${f} already applied, but its contents changed since (checksum drift)`);
        }
        continue; // already applied — skip
      }
      process.stdout.write(`  • ${f} … `);
      try {
        // The migration and its tracking row commit atomically: a crash never half-records a file.
        await db.query("BEGIN");
        await db.query(sql);
        await db.query(`INSERT INTO ${TRACK_TABLE}(filename, checksum) VALUES ($1,$2)`, [
          f,
          checksum,
        ]);
        await db.query("COMMIT");
        console.log("ok");
        ran++;
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        console.log("FAIL");
        console.error(`\nMigration ${f} failed (rolled back):\n`, err);
        await db.end();
        process.exit(1);
      }
    }
    console.log(`Applied ${ran} new migration(s).`);
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
