/**
 * WardenX — grant / revoke a PLATFORM-OWNED role (GAP-003, GAP-096). The shared core of the operator CLI
 * (`scripts/db/platform-role.ts`) and the dev seeds (`seed-org-admin.ts`, `seed-scenario-billing.ts`).
 *
 * Since GAP-003 a platform role key (`platform_*`, or the exact key `ai_safety_owner`) or the
 * `platform_staff` category confers authority only on a row with `organization_id IS NULL`: the
 * enrichment reader and the effective-permission store drop a tenant-owned one (`roleConfersKey`),
 * migration 0318's CHECK refuses to insert a `platform_*` one, and the M3 role routes refuse to create or
 * assign one (422 RESERVED_ROLE). So no tenant surface can grant platform authority; this is the
 * out-of-band path. The platform-owned row is upserted on migration 0320's `role_platform_key_idx` (one
 * platform-owned row per key) and bound to an existing ACTIVE membership.
 *
 * AUDIT. Nothing here disables triggers. Every `role`, `role_permission` and `membership_role` write is
 * captured by the M4 write-audit triggers into `audit_event`; callers set `app.correlation_id` (see
 * {@link withPlatformRoleAudit}) so the trail names the operator action. The dev seeds run with
 * `session_replication_role = replica`, which skips those triggers — that is their choice, not this file's.
 */
import {
  PLATFORM_GRANTABLE_ROLE_KEYS,
  PLATFORM_OPS_ROLE_GRANTS,
  type PlatformGrantableRoleKey,
  ROLE_TEMPLATES,
  isPlatformGrantableRoleKey,
} from "@wardenx/auth";
import type { Client } from "pg";
import { firstRow } from "./query-rows";

export interface PlatformRoleGrant {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly key: PlatformGrantableRoleKey;
  readonly name: string;
  readonly description: string;
}

export interface PlatformRoleGrantResult {
  readonly roleId: string;
  /** True when this call inserted the platform-owned role row (false: it already existed). */
  readonly roleCreated: boolean;
  /** True when this call inserted the membership binding (false: it was already bound). */
  readonly bound: boolean;
  /** Legacy tenant-owned rows carrying the same key in this org, deleted (they conferred nothing). */
  readonly legacyRowsRemoved: number;
  /** Template permission keys newly granted to the platform-owned row. */
  readonly permissionsGranted: number;
  /** Template permission keys that could not be granted because the `permission` mirror lacks them. */
  readonly permissionsMissing: readonly string[];
}

/** Display name + description for a platform role key that has no M3 template (§4.7 templates first). */
const NON_TEMPLATE_PLATFORM_ROLES: Readonly<
  Record<string, { readonly name: string; readonly description: string }>
> = {
  platform_security_owner: {
    name: "Platform Security Owner",
    description: "M34 platform security alert audience (cross-tenant).",
  },
  ai_safety_owner: {
    name: "AI Safety Owner",
    description: "M32 §4.7 cross-tenant AI safety authority (kill switch, lifecycle, prompts).",
  },
};

/** The canonical name/description an operator grant uses for `key`. */
export function platformRoleLabel(key: PlatformGrantableRoleKey): {
  readonly name: string;
  readonly description: string;
} {
  const template = ROLE_TEMPLATES.find((t) => t.key === key);
  if (template) return { name: template.name, description: template.description };
  const label = NON_TEMPLATE_PLATFORM_ROLES[key];
  if (!label) throw new Error(`platform role ${key} has no template and no label`);
  return label;
}

/** The M35 template grants a platform-ops key carries (`PLATFORM_OPS_ROLE_GRANTS`); `[]` otherwise. */
function templateGrantsFor(key: PlatformGrantableRoleKey): readonly string[] {
  return (PLATFORM_OPS_ROLE_GRANTS as Readonly<Record<string, readonly string[]>>)[key] ?? [];
}

/** Refuse anything outside {@link PLATFORM_GRANTABLE_ROLE_KEYS} — the keys a platform predicate reads. */
export function assertPlatformGrantableKey(key: string): PlatformGrantableRoleKey {
  if (isPlatformGrantableRoleKey(key)) return key;
  throw new Error(
    `refusing role key '${key}': not a platform role. Allowed: ${PLATFORM_GRANTABLE_ROLE_KEYS.join(", ")}`,
  );
}

/**
 * Drop a legacy tenant-owned row for `key` in the grant's org, upsert the platform-owned row (plus its
 * template permission grants), and bind it to the membership. Idempotent: a re-run creates nothing.
 */
export async function grantPlatformRole(
  db: Client,
  grant: PlatformRoleGrant,
): Promise<PlatformRoleGrantResult> {
  const key = assertPlatformGrantableKey(grant.key);
  const legacy = await db.query<{ id: string }>(
    `SELECT id FROM role WHERE organization_id = $1 AND key = $2`,
    [grant.organizationId, key],
  );
  for (const { id } of legacy.rows) {
    await db.query(`DELETE FROM membership_role WHERE role_id = $1`, [id]);
    await db.query(`DELETE FROM role_permission WHERE role_id = $1`, [id]);
    await db.query(`DELETE FROM role WHERE id = $1`, [id]);
  }
  // DO NOTHING, then look the row up: a re-run writes nothing (a no-op DO UPDATE would still fire the
  // write-audit trigger). `role_platform_key_idx` makes the pair race-safe — one row per key.
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
     VALUES (NULL, $1, $2, 'platform_staff'::role_category, 'organization', true, $3)
     ON CONFLICT (key) WHERE organization_id IS NULL DO NOTHING
     RETURNING id`,
    [key, grant.name, grant.description],
  );
  const role =
    inserted.rows[0] ??
    firstRow(
      await db.query<{ id: string }>(
        `SELECT id FROM role WHERE organization_id IS NULL AND key = $1`,
        [key],
      ),
      `platform role ${key}`,
    );
  const wanted = templateGrantsFor(key);
  const granted = await db.query(
    `INSERT INTO role_permission (organization_id, role_id, permission_key)
     SELECT NULL, $1, p.key FROM permission p WHERE p.key = ANY($2::text[])
     ON CONFLICT (role_id, permission_key) DO NOTHING`,
    [role.id, wanted],
  );
  const present = await db.query<{ key: string }>(
    `SELECT key FROM permission WHERE key = ANY($1::text[])`,
    [wanted],
  );
  const presentKeys = new Set(present.rows.map((r) => r.key));
  const binding = await db.query(
    `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)
     ON CONFLICT (membership_id, role_id) DO NOTHING`,
    [grant.organizationId, grant.membershipId, role.id],
  );
  return {
    roleId: role.id,
    roleCreated: inserted.rows.length > 0,
    bound: (binding.rowCount ?? 0) > 0,
    legacyRowsRemoved: legacy.rows.length,
    permissionsGranted: granted.rowCount ?? 0,
    permissionsMissing: wanted.filter((k) => !presentKeys.has(k)),
  };
}

/**
 * Remove the membership's binding to the PLATFORM-OWNED row for `key`. The role row itself stays (other
 * operators may hold it). Returns false when there was no such binding — revoke is idempotent too.
 */
export async function revokePlatformRole(
  db: Client,
  input: { readonly membershipId: string; readonly key: PlatformGrantableRoleKey },
): Promise<boolean> {
  const key = assertPlatformGrantableKey(input.key);
  const deleted = await db.query(
    `DELETE FROM membership_role mr USING role r
      WHERE mr.role_id = r.id AND r.organization_id IS NULL AND r.key = $2
        AND mr.membership_id = $1`,
    [input.membershipId, key],
  );
  return (deleted.rowCount ?? 0) > 0;
}

export interface ActiveMembership {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly membershipId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve (user email, org slug or id) to an ACTIVE membership, or throw naming what is missing. A
 * platform role is bound to a membership, so an operator must already be an active member somewhere.
 */
export async function resolveActiveMembership(
  db: Client,
  email: string,
  orgRef: string,
): Promise<ActiveMembership> {
  const user = await db.query<{ id: string }>(
    `SELECT id FROM "user" WHERE lower(email) = lower($1)`,
    [email],
  );
  if (user.rows.length === 0) throw new Error(`no user with email ${email}`);
  const userId = firstRow(user, `user ${email}`).id;
  const org = await db.query<{ id: string; slug: string }>(
    UUID_RE.test(orgRef)
      ? `SELECT id, slug FROM organization WHERE id = $1::uuid`
      : `SELECT id, slug FROM organization WHERE slug = $1`,
    [orgRef],
  );
  if (org.rows.length === 0) throw new Error(`no organization ${orgRef}`);
  const { id: organizationId, slug: organizationSlug } = firstRow(org, `organization ${orgRef}`);
  const membership = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM membership WHERE user_id = $1 AND organization_id = $2`,
    [userId, organizationId],
  );
  const row = membership.rows[0];
  if (!row) throw new Error(`${email} has no membership in ${organizationSlug}`);
  if (row.status !== "active") {
    throw new Error(`${email}'s membership in ${organizationSlug} is ${row.status}, not active`);
  }
  return { userId, organizationId, organizationSlug, membershipId: row.id };
}

/**
 * Run `fn` in one transaction whose write-audit rows carry `correlationId` (the M4 triggers read
 * `app.correlation_id`; `app.org_id` scopes the tenant rows). Rolls back on any error, so a refused grant
 * leaves neither a role row nor an audit row behind. `actor_user_id` stays NULL: the operator acts on a
 * database connection, not a WardenX session — the correlation id carries the change ticket instead.
 */
export async function withPlatformRoleAudit<T>(
  db: Client,
  audit: { readonly correlationId: string; readonly organizationId: string },
  fn: () => Promise<T>,
): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query(
      `SELECT set_config('app.correlation_id', $1, true), set_config('app.org_id', $2, true)`,
      [audit.correlationId, audit.organizationId],
    );
    const result = await fn();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
