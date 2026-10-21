/**
 * ChartWarden — operator CLI: grant or revoke a PLATFORM-OWNED role (GAP-003 / GAP-096 follow-up).
 *
 * Platform authority (`platform_*` keys, `ai_safety_owner`) confers nothing on a tenant-owned role row,
 * and no tenant route can create or assign one (422 RESERVED_ROLE). This is the one production path that
 * binds a platform role: it upserts the platform-owned row (organization_id IS NULL) and binds it to the
 * user's existing ACTIVE membership. Writes run in one transaction with the M4 write-audit triggers live,
 * correlated to the `--ticket` reference. Procedure: CHARTWARDEN_OPS_RUNBOOK_v0.1.md §16.5.
 *
 *   bun run db:platform-role grant  --email ops@example.com --org wardenx-platform --role platform_ops --ticket CHG-123
 *   bun run db:platform-role revoke --email ops@example.com --org wardenx-platform --role platform_ops --ticket CHG-124
 *
 * Needs an owner/BYPASSRLS connection (platform-owned rows are not writable by `chartwarden_app`):
 * DATABASE_ADMIN_URL, else DATABASE_URL — the same connection the migration runner uses.
 */
import { Client } from "pg";
import {
  PLATFORM_ROLE_USAGE,
  parsePlatformRoleArgs,
  runPlatformRoleCommand,
} from "./lib/platform-role-cli";

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) must be set");
  const command = parsePlatformRoleArgs(process.argv.slice(2));
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await runPlatformRoleCommand(db, command, (line) => console.log(line));
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(PLATFORM_ROLE_USAGE);
  process.exit(1);
});
