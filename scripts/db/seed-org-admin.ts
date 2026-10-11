/**
 * WardenX — additive dev seed: the `org_admin` (SaaS tenant/account administrator) demo user.
 *
 * Creates ONLY `orgadmin@wardenx.local` against the EXISTING `wardenx-demo` org — it does not touch
 * the other demo users or their passwords (unlike the destructive `db:seed`). Idempotent: drops a prior
 * `orgadmin@wardenx.local` first, then re-creates it and re-binds the org-scoped `org_admin` role.
 *
 * WHY a distinct role: the platform's tenant-admin authorization keys on the `org_admin` role — the
 * `isAdmin` derivation (rbac/drizzle-store.ts), the M2 last-admin lockout guard, and the ~10
 * `hasRole(ctx,"org_admin")` ABAC predicates across M20/M22/M23/M24/M25/M32/M33/M34 (tenant
 * onboarding/account, feature flags, tenant export, DSAR, billing overrides). The CoP-418.100
 * `administrator` role is a DIFFERENT key and satisfies none of those.
 *
 * `org_admin` is the TOP role and SUPERSEDES `administrator`: it is granted the FULL permission catalog
 * (a strict superset of administrator) PLUS the role-keyed tenant-admin authority above. This script also
 * binds the primary demo admin (`admin@wardenx.local`) to `org_admin`, so the main admin login carries it.
 *
 * Prereqs: backend running (bun run dev:backend) + DB migrated. Run: bun run db:seed:org-admin
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { allPermissionMirrorRows } from "@wardenx/auth";
import { Client } from "pg";
import { fetchAuthWithRateLimitRetry } from "./lib/auth-rate-limit";
import { SEED_CREDENTIALS_PATH, seedUsername, writeSeedCredentials } from "./lib/credentials";
import { grantPlatformRole } from "./lib/platform-role";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

const ORG_SLUG = "wardenx-demo";
const USER = {
  email: "orgadmin@wardenx.local",
  name: "Otto OrgAdmin",
  roleKey: "org_admin",
  roleName: "Organization Administrator",
  roleCategory: "admin_executive",
};

function genPassword(): string {
  // ≥12 chars, mixed classes, random ⇒ passes Better Auth's length floor and the HIBP breach check.
  return `Wx-${randomBytes(9).toString("base64url")}-Zq9!`;
}

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await fetchAuthWithRateLimitRetry(
    `${AUTH_URL}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name, username: seedUsername(email) }),
    },
    `sign-up for ${email}`,
  );
  if (!res.ok)
    throw new Error(`sign-up failed for ${email}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user?: { id?: string } };
  if (!body.user?.id) throw new Error(`sign-up for ${email} returned no user id`);
  return body.user.id;
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // suppress M4 audit triggers on seed writes

  const allRows = allPermissionMirrorRows();

  const orgRes = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG_SLUG,
  ]);
  if (!orgRes.rowCount)
    throw new Error(`demo org '${ORG_SLUG}' not found — run 'bun run db:seed' first`);
  const orgId = firstRow(orgRes, "seed-org-admin: organization upsert").id;

  // Idempotent cleanup of any prior orgadmin user (Better Auth child rows first).
  await db.query("BEGIN");
  const prior = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [
    USER.email,
  ]);
  if (prior.rowCount) {
    const ids = prior.rows.map((r) => r.id);
    const externalMembership = await db.query<{ organization_id: string }>(
      `SELECT DISTINCT organization_id
         FROM membership
        WHERE user_id = ANY($1) AND organization_id <> $2`,
      [ids, orgId],
    );
    if (externalMembership.rowCount) {
      throw new Error(
        `${USER.email} belongs to another organization; refusing to delete its global identity`,
      );
    }
    const mem = await db.query<{ id: string }>(
      "SELECT id FROM membership WHERE user_id = ANY($1) AND organization_id = $2",
      [ids, orgId],
    );
    const memberIds = mem.rows.map((r) => r.id);
    if (memberIds.length) {
      await db.query("DELETE FROM membership_role WHERE membership_id = ANY($1)", [memberIds]);
      await db.query("DELETE FROM membership WHERE id = ANY($1)", [memberIds]);
    }
    for (const t of ["session", "account", "two_factor", "passkey"]) {
      await db.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [ids]).catch(() => {});
    }
    await db.query('DELETE FROM "user" WHERE id = ANY($1)', [ids]);
  }
  await db.query("COMMIT");

  const password = genPassword();
  const userId = await signUp(USER.email, password, USER.name);

  const m = await db.query<{ id: string }>(
    `INSERT INTO membership (user_id, organization_id, status, accepted_at)
     VALUES ($1,$2,'active', now()) RETURNING id`,
    [userId, orgId],
  );
  const membershipId = firstRow(m, "seed-org-admin: membership upsert").id;

  // Upsert the org-scoped `org_admin` role (unique on organization_id,key) — shared if it already exists.
  const r = await db.query<{ id: string }>(
    `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
     VALUES ($1,$2,$3,$4::role_category,'organization', true, $5)
     ON CONFLICT (organization_id, key) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [orgId, USER.roleKey, USER.roleName, USER.roleCategory, `${USER.roleName} (dev seed)`],
  );
  const roleId = firstRow(r, "seed-org-admin: role upsert").id;

  // org_admin supersedes administrator → the FULL permission catalog.
  const keys = allRows.map((x) => x.key);
  for (const key of keys) {
    await db.query(
      `INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)
       ON CONFLICT (role_id, permission_key) DO NOTHING`,
      [orgId, roleId, key],
    );
  }

  await db.query(
    `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)
     ON CONFLICT (membership_id, role_id) DO NOTHING`,
    [orgId, membershipId, roleId],
  );

  // Bind the primary demo admin (Ada) to org_admin too, so the main admin login carries the top role.
  const bound = await db.query(
    `INSERT INTO membership_role (organization_id, membership_id, role_id)
     SELECT m.organization_id, m.id, $2
     FROM membership m JOIN "user" u ON u.id = m.user_id
     WHERE u.email = 'admin@wardenx.local' AND m.organization_id = $1
     ON CONFLICT (membership_id, role_id) DO NOTHING`,
    [orgId, roleId],
  );

  // Additionally bind `platform_ops` to orgadmin@ ONLY (not admin@) — the ABAC role the M34
  // platform-ops console (apps/admin) requires on top of a permission key, per
  // `tenant_lifecycle_platform_ops` (apps/backend/.../34-saas-tenant-platform/abac-predicates.ts).
  // No separate role_permission grants needed: org_admin (bound above) already carries the full
  // catalog, and `context.roles` is the union of every role bound to the membership — this role
  // exists purely to add the `platform_ops` key to that union. Gives the local dev environment one
  // account that can actually sign into and use the admin console (none could before).
  // Platform-owned since GAP-003: a tenant `platform_ops` row confers nothing and 0318 refuses it.
  await grantPlatformRole(db, {
    organizationId: orgId,
    membershipId,
    key: "platform_ops",
    name: "Platform Operations",
    description: "Platform-ops console access (dev seed)",
  });

  await db.end();

  // Append to CREDENTIALS.local.md (marker-based replace, same idempotent pattern
  // seed-staff-personas.ts uses — a re-run must not accumulate stale duplicate blocks, and this
  // account's password is regenerated fresh every run, so the file has to track it or every
  // downstream script that signs in as orgadmin@ breaks against a stale credential).
  const credsPath = SEED_CREDENTIALS_PATH;
  const existing = readFileSync(credsPath, "utf8");
  const marker = "\n## Organization Administrator (bun run db:seed:org-admin)\n";
  const [beforeOldBlock = existing, afterOldBlock = ""] = existing.split(marker);
  const nextSectionAt = afterOldBlock.indexOf("\n## ");
  const preservedLaterSections = nextSectionAt >= 0 ? afterOldBlock.slice(nextSectionAt) : "";
  const withoutOldBlock = beforeOldBlock
    .split("\n")
    // `db:seed` creates the same account first, but this script drops and recreates it with a new
    // password. Remove that now-stale table row so the credential file presents exactly one answer.
    .filter((line) => !(line.startsWith("|") && line.includes(`| \`${USER.email}\` |`)))
    .join("\n")
    .replace(/\n+$/, "\n");
  const lines = [
    withoutOldBlock,
    marker.trimStart(),
    "",
    "> The `org_admin` tenant-admin role (full permission catalog + the tenant-admin authority",
    '> `hasRole(ctx,"org_admin")` predicates check) — distinct from the CoP-418.100 `administrator`',
    "> role the original 4 accounts above carry.",
    "",
    "| Persona | Email | Password | Role key(s) | Username |",
    "|---|---|---|---|---|",
    `| Organization Administrator | \`${USER.email}\` | \`${password}\` | ${USER.roleKey}, platform_ops | \`${seedUsername(USER.email)}\` |`,
    "",
    "> This account also carries `platform_ops` — the ABAC role the admin console (apps/admin,",
    "> `:5175`) requires. It's the only local account that can sign into it.",
    "",
  ];
  writeSeedCredentials(`${lines.join("\n")}${preservedLaterSections}`);

  console.log("\n✓ org_admin user created");
  console.log(`  email:    ${USER.email}`);
  console.log(`  role:     ${USER.roleKey} (${keys.length} perms, full catalog) + platform_ops`);
  console.log(
    `  admin@wardenx.local bound to org_admin: ${bound.rowCount ? "yes" : "already bound"}`,
  );
  console.log("  credentials written to CREDENTIALS.local.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
