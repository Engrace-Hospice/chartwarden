/**
 * scripts/db/sync-permission-catalog.ts — ADDITIVE permission-catalog sync for a local dev database.
 *
 * `db:seed` syncs the catalog too, but it also DROPS and recreates the demo org and users, which
 * regenerates every password and invalidates CREDENTIALS.local.md. When a module contributes new
 * permission keys after the initial seed (M30's 33 quality/incident keys were the case that prompted
 * this), the catalog goes stale and every screen gated on a new key 403s — with no way to refresh it
 * short of losing your dev credentials.
 *
 * This does the two additive halves and nothing else:
 *   1. UPSERT every key from `allPermissionMirrorRows()` into the read-only `permission` mirror.
 *   2. Grant any key the full-catalog admin roles are missing (`ON CONFLICT DO NOTHING`), per org.
 *
 * The full-catalog roles are `administrator` AND `org_admin` — `org_admin` is the top role that
 * SUPERSEDES `administrator` (a strict superset), so both must receive every new key or the sync would
 * make administrator (widened here) outgrow org_admin and break the supersede invariant.
 *
 * It creates no users, deletes nothing, and touches no password. Reversing it is a DELETE of the rows
 * it added. The clinician/auditor roles are deliberately left alone — their grants are a curated
 * subset, and widening them here would misrepresent what those roles can do.
 *
 * Usage: bun run db:sync:permissions   (DATABASE_ADMIN_URL — needs write on `permission`)
 */
import { allPermissionMirrorRows } from "@wardenx/auth";
import { Client } from "pg";

/** Roles granted the ENTIRE catalog — kept in lockstep so `org_admin ⊇ administrator` always holds. */
const GRANT_ALL_ROLE_KEYS = ["administrator", "org_admin"];

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) must be set");

  const db = new Client({ connectionString: url });
  await db.connect();
  // The `permission` mirror is read-only to the app role and carries the M4 write-audit trigger; a
  // catalog sync is a deploy action, not an audited user action (the same posture db:seed takes).
  await db.query("SET session_replication_role = replica");

  const rows = allPermissionMirrorRows();
  const before = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM permission");

  for (const row of rows) {
    await db.query(
      `INSERT INTO permission (key, resource, action, category, default_abac, description)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (key) DO UPDATE SET
         resource = EXCLUDED.resource, action = EXCLUDED.action,
         category = EXCLUDED.category, default_abac = EXCLUDED.default_abac,
         description = EXCLUDED.description`,
      [row.key, row.resource, row.action, row.category, row.defaultAbac, row.description],
    );
  }

  const after = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM permission");
  console.log(
    `permission catalog synced: ${rows.length} keys projected (${before.rows[0]!.n} -> ${after.rows[0]!.n} rows)`,
  );

  // Grant every catalog key to each org's full-catalog admin roles (administrator + org_admin).
  // ON CONFLICT DO NOTHING keeps it idempotent and preserves any abac_override already set on a grant.
  const admins = await db.query<{ id: string; organization_id: string; key: string }>(
    "SELECT id, organization_id, key FROM role WHERE key = ANY($1) AND organization_id IS NOT NULL",
    [GRANT_ALL_ROLE_KEYS],
  );
  let granted = 0;
  for (const role of admins.rows) {
    for (const row of rows) {
      const r = await db.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key)
         VALUES ($1,$2,$3) ON CONFLICT (role_id, permission_key) DO NOTHING`,
        [role.organization_id, role.id, row.key],
      );
      granted += r.rowCount ?? 0;
    }
  }
  console.log(
    `full-catalog admin grants (${GRANT_ALL_ROLE_KEYS.join(", ")}): +${granted} new across ${admins.rowCount} role(s) (existing left untouched)`,
  );

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
