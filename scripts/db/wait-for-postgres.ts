#!/usr/bin/env bun
/**
 * ChartWarden — wait for the local compose Postgres, and prove a reset actually reset it (F-016 / #43).
 *
 * `db:reset` used to be `docker rm -f … && docker volume rm … && db:up && sleep 3 && db:migrate`.
 * Two things were wrong with that, and this script replaces both:
 *
 *   1. IT RESET A DIFFERENT DATABASE THAN IT MIGRATED. `db:up` published the standalone
 *      `wardenx-postgres` container on 5440; `db:migrate` connects to
 *      `DATABASE_ADMIN_URL ?? DATABASE_URL`, which the documented local `.env` points at 5432 — the
 *      compose Postgres. So the command destroyed one database's volume and then seeded ANOTHER,
 *      which still held everything it had before. "Start clean" did not. Compose is now the single
 *      path (see docker-compose.yml), so there is one database and this connects to the same URL
 *      the migrator will.
 *
 *   2. `sleep 3` is a guess. It is too long on a warm volume and too short on a cold one, and when
 *      it is too short the failure lands on the migrator with a connection error that looks like a
 *      configuration problem. This polls until the server actually answers.
 *
 * With `--expect-empty` it additionally asserts the database has NO user tables — the check that
 * makes `db:reset`'s reset half honest rather than assumed. `db:reset` passes it, because it runs
 * `docker compose down -v` first; plain `db:up` does not, so the flag is opt-in.
 */
import { Client } from "pg";

const URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/wardenx";

const TIMEOUT_MS = Number(process.env.CHARTWARDEN_DB_WAIT_TIMEOUT_MS ?? 60_000);
const EXPECT_EMPTY = process.argv.includes("--expect-empty");

/** Redact the password so a CI log never carries it. */
const safeUrl = (raw: string): string => raw.replace(/:\/\/([^:@/]+):[^@]*@/, "://$1:***@");

async function tryConnect(): Promise<Client | null> {
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    return null;
  }
}

async function main(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let client: Client | null = null;
  process.stdout.write(`waiting for ${safeUrl(URL)} `);
  while (Date.now() < deadline) {
    client = await tryConnect();
    if (client) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write("\n");

  if (!client) {
    console.error(
      `✗ db:wait: ${safeUrl(URL)} did not accept a connection within ${TIMEOUT_MS / 1000}s.\n  Is the stack up? \`bun run db:up\` (docker compose up -d postgres redis minio).`,
    );
    process.exit(1);
  }

  try {
    if (EXPECT_EMPTY) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      );
      const tables = Number(rows[0]?.n ?? "-1");
      if (tables !== 0) {
        console.error(
          `✗ db:wait --expect-empty: ${tables} table(s) already exist in ${safeUrl(URL)}.\n  A reset is supposed to start from nothing. This is the #43 failure mode — the volume\n  that was destroyed is not the database being migrated. Check that DATABASE_ADMIN_URL\n  points at the compose Postgres (localhost:5432) and that \`docker compose down -v\` ran.`,
        );
        process.exit(1);
      }
      console.log(`✓ db:wait: ${safeUrl(URL)} is up and empty (0 tables) — ready to migrate.`);
      return;
    }
    console.log(`✓ db:wait: ${safeUrl(URL)} is accepting connections.`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`✗ db:wait: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
