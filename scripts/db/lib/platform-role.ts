/**
 * WardenX — grant a PLATFORM-OWNED role to a dev-seed membership (GAP-003).
 *
 * Since GAP-003 a `platform_*` key (or a `platform_staff` category) confers authority only on a row with
 * `organization_id IS NULL`: the enrichment reader drops a tenant-owned one (`roleConfersKey`) and
 * migration 0318's CHECK refuses to insert it. Seeds that used to mint a tenant `platform_ops` /
 * `platform_admin` row therefore remove any such row left by an older run and grant the platform-owned
 * row instead (found-or-created: `(organization_id, key)` is unique, but NULLs are distinct in that
 * index, so ON CONFLICT cannot be used to upsert it).
 */
import type { Client } from "pg";
import { firstRow } from "./query-rows";

export interface PlatformRoleGrant {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly key: `platform_${string}`;
  readonly name: string;
  readonly description: string;
}

/** Drop a legacy tenant-owned row for `key`, find-or-create the platform-owned one, bind it. */
export async function grantPlatformRole(db: Client, grant: PlatformRoleGrant): Promise<void> {
  const legacy = await db.query<{ id: string }>(
    `SELECT id FROM role WHERE organization_id = $1 AND key = $2`,
    [grant.organizationId, grant.key],
  );
  for (const { id } of legacy.rows) {
    await db.query(`DELETE FROM membership_role WHERE role_id = $1`, [id]);
    await db.query(`DELETE FROM role_permission WHERE role_id = $1`, [id]);
    await db.query(`DELETE FROM role WHERE id = $1`, [id]);
  }
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM role WHERE organization_id IS NULL AND key = $1 LIMIT 1`,
    [grant.key],
  );
  const role =
    existing.rows.length > 0
      ? existing
      : await db.query<{ id: string }>(
          `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
           VALUES (NULL, $1, $2, 'platform_staff'::role_category, 'organization', true, $3)
           RETURNING id`,
          [grant.key, grant.name, grant.description],
        );
  await db.query(
    `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)
     ON CONFLICT (membership_id, role_id) DO NOTHING`,
    [grant.organizationId, grant.membershipId, firstRow(role, `platform role ${grant.key}`).id],
  );
}
