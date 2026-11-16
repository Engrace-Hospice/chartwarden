/**
 * ChartWarden — additive dev seed: the `superadmin` user (the platform-owned `superadmin` role).
 *
 * `superadmin` belongs to ChartWarden, NOT to a tenant. This seed upserts the ChartWarden platform organization
 * (`chartwarden-platform`, an `organization` row only: no tenant_account and no key ring, so it is never listed,
 * billed or provisioned as a tenant) and gives `superadmin@chartwarden.local` its only membership there. It does
 * not touch the demo tenant (`chartwarden-demo`), the other demo users or their passwords. Idempotent: drops a
 * prior `superadmin@chartwarden.local`, re-creates it with a fresh password and re-binds the role. The login is
 * written to the gitignored CREDENTIALS.local.md.
 *
 * `superadmin` SUPERSEDES `sysadmin` (admin@chartwarden.local, the `administrator` role) and `orgadmin`
 * (orgadmin@chartwarden.local, `org_admin`): at request time the actor reads as `administrator`, `org_admin` and
 * every platform role (`expandSuperadminRoles`), so every existing predicate admits it, and its permissions are the
 * code catalog (`effectivePermissionKeys`, less the keys withheld from the admin roles), so it never falls behind a
 * module's new keys.
 *
 * It is bound through `grantPlatformRole` (GAP-003): a platform-owned row (organization_id IS NULL), refused for
 * any organization that has a tenant_account. The role_permission rows written there are a visible record; the
 * resolver does not read them for `superadmin`. It does NOT reach a tenant's PHI: RLS, the consented support
 * session and break-glass are untouched.
 *
 * NOT AUDITED, and never for production. This seed runs as a replication session (below), so the M4 write-audit
 * triggers do not fire. It runs only with NODE_ENV unset, development or test, against a local database
 * (`assertLocalDevSeed`, an allow-list: staging, prod and the like are refused too), and is
 * deliberately absent from `db:seed:all`, which production's reseed workflow expands and runs. The production path
 * is the ticketed, audited `bun run db:platform-role grant --role superadmin` (OPS_RUNBOOK §16.5).
 *
 * Prereqs: DB migrated through 1495. Run: bun run db:seed:superadmin (needs the backend up, for sign-up).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { SUPERADMIN_ROLE_KEY } from "@chartwarden/auth";
import { Client } from "pg";
import { fetchAuthWithRateLimitRetry } from "./lib/auth-rate-limit";
import { SEED_CREDENTIALS_PATH, seedUsername, writeSeedCredentials } from "./lib/credentials";
import { assertLocalDevSeed } from "./lib/local-seed-guard";
import {
  assertSuperadminOrg,
  grantPlatformRole,
  platformRoleGrantKeys,
  platformRoleLabel,
} from "./lib/platform-role";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

/** ChartWarden's own organization — the platform home of its operators, not a tenant. */
const PLATFORM_ORG = {
  slug: "chartwarden-platform",
  legalName: "ChartWarden",
  displayName: "ChartWarden Platform",
};
const USER = { email: "superadmin@chartwarden.local", name: "Sam Superadmin" };
const CREDENTIALS_MARKER = "\n## Superadmin (bun run db:seed:superadmin)\n";

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

/** The platform org's id, creating the bare organization row on first run (never a tenant_account). */
async function ensurePlatformOrg(db: Client): Promise<string> {
  // DO NOTHING + a read: an existing row (a suspended org, or a slug a tenant took) is neither touched nor trusted.
  await db.query(
    `INSERT INTO organization (slug, legal_name, display_name, status)
     VALUES ($1,$2,$3,'active')
     ON CONFLICT (slug) DO NOTHING`,
    [PLATFORM_ORG.slug, PLATFORM_ORG.legalName, PLATFORM_ORG.displayName],
  );
  const org = await db.query<{ id: string; status: string }>(
    "SELECT id, status FROM organization WHERE slug = $1",
    [PLATFORM_ORG.slug],
  );
  const row = firstRow(org, "seed-superadmin: platform organization lookup");
  // A seed must not quietly reactivate an organization someone suspended or closed on purpose.
  if (row.status !== "active") {
    throw new Error(
      `the ${PLATFORM_ORG.slug} organization is ${row.status}, not active; fix that deliberately, a seed will not reactivate it`,
    );
  }
  // Before any user is dropped or created: a slug that collides with a tenant must leave nothing behind.
  await assertSuperadminOrg(db, row.id);
  return row.id;
}

/** Refuse before anything is created when the `permission` mirror lacks catalog keys the role row would record. */
async function assertPermissionMirrorComplete(db: Client): Promise<void> {
  const wanted = platformRoleGrantKeys(SUPERADMIN_ROLE_KEY);
  const present = await db.query<{ key: string }>(
    "SELECT key FROM permission WHERE key = ANY($1::text[])",
    [wanted],
  );
  const missing = wanted.length - present.rows.length;
  if (missing > 0) {
    throw new Error(
      `${missing} catalog permission(s) missing from the permission mirror — run 'bun run db:sync:permissions' first`,
    );
  }
}

/** Drop a prior seeded superadmin (Better Auth child rows first). Refuses a user that belongs to another org. */
async function dropPriorUser(db: Client, orgId: string): Promise<void> {
  const prior = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [
    USER.email,
  ]);
  if (!prior.rowCount) return;
  const ids = prior.rows.map((r) => r.id);
  const external = await db.query(
    "SELECT 1 FROM membership WHERE user_id = ANY($1) AND organization_id <> $2 LIMIT 1",
    [ids, orgId],
  );
  if (external.rowCount) {
    throw new Error(
      `${USER.email} belongs to another organization; refusing to delete its global identity`,
    );
  }
  await db.query("BEGIN");
  try {
    const mem = await db.query<{ id: string }>(
      "SELECT id FROM membership WHERE user_id = ANY($1) AND organization_id = $2",
      [ids, orgId],
    );
    const memberIds = mem.rows.map((r) => r.id);
    if (memberIds.length) {
      await db.query("DELETE FROM membership_role WHERE membership_id = ANY($1)", [memberIds]);
      await db.query("DELETE FROM membership WHERE id = ANY($1)", [memberIds]);
    }
    // A failed statement aborts the whole transaction, so a table this schema lacks is skipped up front rather than
    // swallowed afterwards. The names are a fixed list, never input.
    for (const t of ["session", "account", "two_factor", "passkey"]) {
      const exists = await db.query<{ t: string | null }>("SELECT to_regclass($1) AS t", [
        `public.${t}`,
      ]);
      if (exists.rows[0]?.t) await db.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [ids]);
    }
    await db.query('DELETE FROM "user" WHERE id = ANY($1)', [ids]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

/** Replace this seed's block in CREDENTIALS.local.md, leaving every other section as it was. */
function writeCredentialsBlock(password: string): void {
  const existing = existsSync(SEED_CREDENTIALS_PATH)
    ? readFileSync(SEED_CREDENTIALS_PATH, "utf8")
    : "";
  const [before = existing, afterOldBlock = ""] = existing.split(CREDENTIALS_MARKER);
  const nextSectionAt = afterOldBlock.indexOf("\n## ");
  const laterSections = nextSectionAt >= 0 ? afterOldBlock.slice(nextSectionAt) : "";
  const block = [
    CREDENTIALS_MARKER.trim(),
    "",
    `> Belongs to ChartWarden (the \`${PLATFORM_ORG.slug}\` org), not to a tenant. Supersedes \`sysadmin\``,
    "> (`administrator`) and `orgadmin` (`org_admin`): it reads as both plus every platform role and holds the",
    "> permission catalog (less the keys withheld from the admin roles). A tenant's PHI still needs a consented support session or break-glass.",
    "> A passkey is required once `CHARTWARDEN_MFA_ENFORCEMENT=true`.",
    "",
    "| Persona | Email | Password | Org | Role key(s) | Username |",
    "|---|---|---|---|---|---|",
    `| Superadmin | \`${USER.email}\` | \`${password}\` | ${PLATFORM_ORG.slug} | ${SUPERADMIN_ROLE_KEY} | \`${seedUsername(USER.email)}\` |`,
    "",
  ].join("\n");
  writeSeedCredentials(`${before.replace(/\n+$/, "\n")}\n${block}${laterSections}`);
}

async function main(): Promise<void> {
  assertLocalDevSeed({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: ADMIN_URL,
    productionSeedAck: process.env.CHARTWARDEN_SEED_ALLOW_PRODUCTION,
    authUrl: AUTH_URL,
  });
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("SET session_replication_role = replica"); // suppress M4 audit triggers on seed writes
    await assertPermissionMirrorComplete(db);
    const orgId = await ensurePlatformOrg(db);
    await dropPriorUser(db, orgId);
    const password = genPassword();
    const userId = await signUp(USER.email, password, USER.name);
    const membership = await db.query<{ id: string }>(
      `INSERT INTO membership (user_id, organization_id, status, accepted_at)
       VALUES ($1,$2,'active', now()) RETURNING id`,
      [userId, orgId],
    );
    await grantPlatformRole(db, {
      organizationId: orgId,
      membershipId: firstRow(membership, "seed-superadmin: membership insert").id,
      key: SUPERADMIN_ROLE_KEY,
      ...platformRoleLabel(SUPERADMIN_ROLE_KEY),
    });
    writeCredentialsBlock(password);
    console.log("\n✓ superadmin user created");
    console.log(`  email:  ${USER.email}`);
    console.log(`  org:    ${PLATFORM_ORG.slug} (ChartWarden platform, not a tenant)`);
    console.log(
      `  role:   ${SUPERADMIN_ROLE_KEY} (${platformRoleGrantKeys(SUPERADMIN_ROLE_KEY).length} perms, platform-owned)`,
    );
    console.log("  credentials written to CREDENTIALS.local.md");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
