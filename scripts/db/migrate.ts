/**
 * WardenX — the production migration path (TASK-040E, OPS-016; also usable for local dev).
 *
 * Applies every `packages/db/migrations/*.sql` in lexical order against a Postgres DB, connecting
 * as a SUPERUSER/OWNER (the files CREATE EXTENSION / CREATE ROLE / own tables — genuinely elevated
 * DDL, not something this script can downgrade without rewriting every historical migration; the
 * PR-reviewed SQL running through a gated CI/CD pipeline is the real safety boundary here, not the
 * connecting role). What IS split out is the one thing that touches live credentials/policy on
 * EVERY invocation: enabling LOGIN, setting the password, and toggling BYPASSRLS on `wardenx_app`
 * (`bootstrapAppRole`, below). That is a ONE-TIME bootstrap (or a deliberate password rotation), not
 * a per-deploy action, so `--schema-only` skips it — the per-deploy pipeline runs ONLY
 * `applyMigrations()`, touching no role/credential state. A plain (no-flag) run does both, for
 * local/first-time-environment convenience.
 *
 * IDEMPOTENT: each applied migration is recorded in a `_wardenx_migration` tracking table (filename
 * + sha256 checksum), so a re-run applies only the NEW files and skips the rest — the runner is safe
 * to invoke against a populated DB. Each migration + its tracking row commit in a single
 * transaction, so a crash mid-file never leaves it half-recorded.
 *
 * DRIFT: an already-applied file whose contents changed since is detected via checksum mismatch. By
 * default this only warns (a developer's local DB drifting after a rebase shouldn't hard-fail their
 * afternoon). Pass `--strict` — the pre-deploy `migration-gate` CI job always does — to turn drift
 * into a hard failure instead of a warning.
 *
 * ADOPTING AN ALREADY-MIGRATED DB (`--baseline`): a DB migrated before this tracker existed has an
 * empty tracking table, so a normal run would try to re-apply everything and fail on the first
 * CREATE that already exists. Run `bun run db:migrate:baseline` ONCE to RECORD every current
 * migration as applied WITHOUT running it — asserting "this DB is already at head". Only do this
 * when the DB truly is fully migrated; afterwards plain `db:migrate` is a no-op until new files land.
 *
 * Flags:
 *   --baseline      record every current migration as applied WITHOUT running it (see above)
 *   --strict        checksum drift on an already-applied file is a hard failure, not a warning
 *   --schema-only   apply pending migrations only; skip the wardenx_app LOGIN/password/BYPASSRLS
 *                   bootstrap (the per-deploy step — see header)
 *
 * Env (Bun auto-loads `.env`):
 *   DATABASE_ADMIN_URL   superuser/owner conn string for DDL (falls back to DATABASE_URL)
 *   WARDENX_APP_PASSWORD password set on the wardenx_app login role (default "wardenx_app";
 *                        irrelevant with --schema-only)
 *
 * Run:
 *   bun run db:migrate                              one-time/local: apply + bootstrap wardenx_app
 *   bun run db:migrate:baseline                      adopt an already-migrated DB
 *   bun run db:migrate:deploy                        per-deploy: apply only, fail on any drift
 *     (= bun run scripts/db/migrate.ts --strict --schema-only)
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "..", "packages", "db", "migrations");
const APP_ROLE = "wardenx_app";
/** Runtime bookkeeping table (created by this script, not a migration; unowned by any module). */
const TRACK_TABLE = "_wardenx_migration";

export interface ApplyMigrationsOptions {
  /** Defaults to the repo's real `packages/db/migrations` — override only for tests. */
  readonly migrationsDir?: string;
  /** Record every current migration as applied WITHOUT running it (adopt an already-migrated DB). */
  readonly baseline?: boolean;
  /** Checksum drift on an already-applied file throws instead of only warning. */
  readonly strict?: boolean;
}

export interface ApplyMigrationsResult {
  /** Migration files actually executed this run (empty on a no-op re-run or a --baseline run). */
  readonly ran: readonly string[];
  /** Migration files that were pending before this run started. */
  readonly pending: readonly string[];
  /** Already-applied files whose on-disk contents no longer match their recorded checksum. */
  readonly drifted: readonly string[];
}

/**
 * The schema-application core — no role/credential logic, no `process.exit`. Throws on a migration
 * SQL failure (already rolled back) or, with `strict: true`, on any checksum drift. Callable
 * directly by tests against a throwaway database; the CLI below is a thin wrapper over it.
 */
export async function applyMigrations(
  db: Client,
  opts: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;

  // The tracking table records which migrations have run (filename + content checksum). Created
  // here rather than in a migration so the runner can consult it before applying anything.
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

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (opts.baseline) {
    const untracked = files.filter((f) => !applied.has(f));
    for (const f of untracked) {
      const checksum = createHash("sha256")
        .update(readFileSync(join(migrationsDir, f), "utf8"))
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
    return { ran: [], pending: [], drifted: [] };
  }

  const pending = files.filter((f) => !applied.has(f));
  console.log(
    `${files.length} migration file(s) in ${migrationsDir}; ${applied.size} already applied, ` +
      `${pending.length} pending.`,
  );
  const ran: string[] = [];
  const drifted: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const priorChecksum = applied.get(f);
    if (priorChecksum !== undefined) {
      if (priorChecksum !== checksum) {
        console.log(`  ⚠ ${f} already applied, but its contents changed since (checksum drift)`);
        drifted.push(f);
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
      ran.push(f);
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      console.log("FAIL");
      throw new Error(
        `Migration ${f} failed (rolled back): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  console.log(`Applied ${ran.length} new migration(s).`);

  if (opts.strict && drifted.length > 0) {
    throw new Error(
      `--strict: ${drifted.length} already-applied migration(s) have checksum drift: ` +
        drifted.join(", "),
    );
  }
  return { ran, pending, drifted };
}

export interface BootstrapAppRoleOptions {
  readonly appPassword: string;
  readonly isProduction: boolean;
  /** BYPASSRLS is an explicit, development-only opt-in — see the branch below. */
  readonly bypassRlsRequested: boolean;
}

/**
 * Enable LOGIN + set the password on the RLS app role (`wardenx_app`) so the backend can connect
 * directly as it, and set its BYPASSRLS attribute per policy. This is the ONE-TIME (or
 * rotation-time) step `--schema-only` skips — see the file header for why it's split out.
 */
export async function bootstrapAppRole(db: Client, opts: BootstrapAppRoleOptions): Promise<void> {
  console.log(`Enabling LOGIN on ${APP_ROLE} …`);
  // Both the role name and the password are escaped BY POSTGRES (`%I` / `%L`) rather than
  // interpolated: ALTER ROLE takes no bind parameters, so the statement is built with `format()`
  // server-side and then executed. A password containing a quote is a broken migration at best.
  const { rows } = await db.query<{ stmt: string }>(
    "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS stmt",
    [APP_ROLE, opts.appPassword],
  );
  await db.query(rows[0].stmt);
  // CONNECT on the database (PUBLIC has it by default, but be explicit/idempotent).
  await db.query(`GRANT CONNECT ON DATABASE ${db.database} TO ${APP_ROLE}`);

  // BYPASSRLS makes all RLS policies decorative for the connecting role, so it is opt-in and
  // refused outside development. Several pre-org / cross-org reads (`/auth/memberships` —
  // membership-repository.ts; M26 cap) genuinely need a connection RLS cannot scope; the production
  // answer is a SECOND pooled credential for those reads, not a blanket bypass on the app role.
  // Until that pool exists, a local single-org demo opts in explicitly with WARDENX_DEV_BYPASSRLS=1.
  if (opts.bypassRlsRequested && !opts.isProduction) {
    console.log(
      `⚠️  DEV ONLY: granting BYPASSRLS to ${APP_ROLE} (RLS is not enforced for this role)`,
    );
    await db.query(`ALTER ROLE ${APP_ROLE} WITH BYPASSRLS`);
  } else {
    // Idempotent and safe to run against a cluster where a previous migrate granted it.
    await db.query(`ALTER ROLE ${APP_ROLE} WITH NOBYPASSRLS`);
    if (opts.bypassRlsRequested) {
      console.log("✗ WARDENX_DEV_BYPASSRLS ignored: NODE_ENV=production. BYPASSRLS revoked.");
    } else {
      console.log(
        `RLS enforced for ${APP_ROLE} (set WARDENX_DEV_BYPASSRLS=1 for the local single-org demo;\n` +
          "  without it, pre-org reads such as /auth/memberships return no rows and org-select is empty).",
      );
    }
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────────────────────────────

const BASELINE = process.argv.includes("--baseline");
const STRICT = process.argv.includes("--strict");
const SCHEMA_ONLY = process.argv.includes("--schema-only");
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const BYPASSRLS_REQUESTED = process.env.WARDENX_DEV_BYPASSRLS === "1";

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  // A guessable default password on a LOGIN role is only tolerable on a throwaway local cluster.
  if (IS_PRODUCTION && !SCHEMA_ONLY && !process.env.WARDENX_APP_PASSWORD) {
    throw new Error(
      "WARDENX_APP_PASSWORD is required when NODE_ENV=production — refusing to set the default " +
        `login password on ${APP_ROLE}. (Pass --schema-only for the per-deploy step, which never ` +
        "touches this credential.)",
    );
  }
  const appPassword = process.env.WARDENX_APP_PASSWORD ?? "wardenx_app";

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await applyMigrations(db, {
      migrationsDir: MIGRATIONS_DIR,
      baseline: BASELINE,
      strict: STRICT,
    });
    if (SCHEMA_ONLY) {
      console.log(
        "--schema-only: skipping wardenx_app LOGIN/password/BYPASSRLS bootstrap (run a plain " +
          "`bun run db:migrate` once per environment, or after a password rotation).",
      );
      console.log("✓ migrations complete.");
    } else {
      await bootstrapAppRole(db, {
        appPassword,
        isProduction: IS_PRODUCTION,
        bypassRlsRequested: BYPASSRLS_REQUESTED,
      });
      console.log("✓ migrations complete; wardenx_app is LOGIN-enabled.");
    }
  } finally {
    await db.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
