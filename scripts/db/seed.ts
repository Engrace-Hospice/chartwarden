/**
 * WardenX — local dev seed (demo org + users + RBAC). NOT for production.
 *
 * Creates one demo organization, three users (via the running backend's Better Auth sign-up so
 * passwords hash exactly as prod), active memberships, and three roles wired to the real M3
 * permission catalog (`allPermissionMirrorRows()`):
 *   • administrator — every permission (the full catalog)
 *   • clinician     — clinical permissions
 *   • auditor       — compliance permissions
 * Generated passwords are written to `CREDENTIALS.local.md` (gitignored).
 *
 * Idempotent: deletes any prior demo org + demo users first, so re-running gives fresh creds.
 *
 * Prereqs: backend running (bun run dev:backend) + DB migrated (bun run db:migrate).
 * Run:     bun run db:seed
 */
import { randomBytes } from "node:crypto";
import { allPermissionMirrorRows } from "@wardenx/auth";
import { Client } from "pg";
import {
  ACTIVE_KEK_ENV,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../../apps/backend/src/bootstrap/tenant-kek";
import { fetchAuthWithRateLimitRetry } from "./lib/auth-rate-limit";
import { SEED_CREDENTIALS_PATH, seedUsername, writeSeedCredentials } from "./lib/credentials";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

const ORG = {
  slug: "wardenx-demo",
  legal: "Engrace Hospice, Inc.",
  display: "Engrace Hospice",
};

type Cat = "admin" | "clinical" | "compliance" | "platform";
interface SeedUser {
  email: string;
  name: string;
  roleKey: string;
  roleName: string;
  roleCategory: string; // role_category enum
  permCats: Cat[]; // which catalog categories this role grants (ignored when grantAll)
  /** "every permission" — grant the entire catalog regardless of category, so newly added modules
   *  (billing/revenue-cycle, reporting, …) are covered without editing this list. */
  grantAll?: boolean;
  /** Extra role keys (defined by OTHER users below) to also bind to this membership. Used so the demo
   *  admin holds `org_admin` — the top role that supersedes `administrator` (full catalog + the
   *  `hasRole(ctx,"org_admin")` tenant-admin ABAC authority). Bindings resolve role-centrically, so the
   *  single org-scoped `org_admin` role (unique on org+key) is SHARED, never duplicated. */
  alsoRoleKeys?: readonly string[];
}

const USERS: SeedUser[] = [
  {
    email: "admin@wardenx.local",
    name: "Ada Administrator",
    roleKey: "administrator",
    roleName: "Administrator",
    roleCategory: "admin_executive",
    permCats: [],
    grantAll: true,
    // The demo admin ALSO holds `org_admin`, the top role — so the primary admin login carries both the
    // CoP-418.100 clinical authority AND the SaaS tenant-admin authority that supersedes it.
    alsoRoleKeys: ["org_admin"],
  },
  {
    // SaaS tenant/account administrator — the TOP role, superseding the CoP-418.100 `administrator`: it
    // carries the FULL permission catalog (grantAll) PLUS the authority the platform keys on the role for —
    // the `isAdmin` derivation (rbac/drizzle-store.ts), the M2 last-admin lockout guard, and the ~10
    // `hasRole(ctx,"org_admin")` ABAC predicates across M20/M22/M23/M24/M25/M32/M33/M34 (tenant
    // onboarding/account, feature flags, tenant export, DSAR, billing overrides). `administrator` remains a
    // distinct clinical/regulatory role; `org_admin` ⊇ it in every permission.
    email: "orgadmin@wardenx.local",
    name: "Otto OrgAdmin",
    roleKey: "org_admin",
    roleName: "Organization Administrator",
    roleCategory: "admin_executive",
    permCats: [],
    grantAll: true,
  },
  {
    email: "casey@wardenx.local",
    name: "Casey Clinician",
    roleKey: "clinician",
    roleName: "Clinician",
    roleCategory: "clinical_staff",
    permCats: ["clinical"],
  },
  {
    email: "avery@wardenx.local",
    name: "Avery Auditor",
    roleKey: "auditor",
    roleName: "Compliance Auditor",
    roleCategory: "compliance_quality",
    permCats: ["compliance"],
  },
];

function genPassword(): string {
  // >12 chars, mixed classes, random => never an HIBP-breached password.
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
  if (!res.ok) {
    throw new Error(`sign-up failed for ${email}: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { user?: { id?: string } };
  if (!body.user?.id) throw new Error(`sign-up for ${email} returned no user id`);
  return body.user.id;
}

/**
 * The database this run wrote to, host:port/name, with any password removed — for the generated
 * credentials file, so it names the database that was actually seeded.
 */
function seededTarget(): string {
  const raw = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? "";
  if (!raw) return "the local database";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "the local database";
  }
}

/**
 * The M34 tenant spine for the demo org: a `tenant_account` row and the `tenant_key_ring` that hangs
 * off it, provisioned through the SAME `m34_provision_tenant_key_ring` SECURITY DEFINER function the
 * production provision worker calls (`apps/backend/src/modules/34-saas-tenant-platform/jobs/saas-jobs.ts`
 * → `ensureTenantKeyRing`), with a DEK minted and wrapped by the SAME platform KEK adapter.
 *
 * WHY THE SEED HAS TO DO THIS (F-082). In production an organization only ever comes into existence
 * through M34 provisioning, which mints the key ring as step (1) of seven — so "an org with no key
 * ring" is a state the platform cannot reach. This seed reached it anyway, by inserting the
 * organization row directly, and every seeded deployment the repo has ever produced has run without
 * one. `TenantKeyProvider.dekForOrg` answers `TenantKeyMissing` for such an org, which means every
 * envelope-encrypted PHI write on the platform refuses: M8's HearthNote narrative + free text (so an
 * encounter cannot be FINALIZED, and therefore never reaches signing), M27's raw cost-report payloads,
 * M29's stored HL7 payloads, M31's portal contact ciphers, M39's consent notes.
 *
 * It was diagnosed as something else, twice, and written down that way: `seed-scenario-clinical-core.ts`
 * reported the 503 as "#105, no KEK adapter is bound". #105 has been fixed since `bootstrap/tenant-kek.ts`
 * landed — the adapter binds from `M34_TENANT_KEK` — and the refusal survived it, because the missing
 * thing was never the KEK. It was the row the KEK wraps a key INTO. A fail-closed 503 that names the
 * envelope reads the same either way, which is why the stale attribution held.
 *
 * No KEK configured is a SKIP, not a failure: a dev boot that sets no `M34_TENANT_KEK` does no tenant
 * crypto at all (`loadPlatformKekRing` returns null by design), and minting a key ring whose ciphertext
 * this deployment cannot unwrap would be worse than having none — `dekForOrg` would then fail on the
 * KEK id instead of on the absent row, one layer further from the cause.
 */
async function provisionTenantSpine(db: Client, orgId: string): Promise<void> {
  // The tenant_account row is unconditional — M34's lifecycle surfaces read it whether or not this
  // deployment does tenant crypto. Only the key ring below depends on a platform KEK.
  const account = await db.query<{ id: string }>(
    `INSERT INTO tenant_account (
     organization_id,
     status,
     legal_business_name,
     billing_contact_email,
     breach_notification_email,
     provisioned_at,
     activated_at,
     metadata
   )
   VALUES (
     $1,
     'active'::tenant_account_status,
     $2,
     $3,
     $3,
     now(),
     now(),
     $4::json
   )
   ON CONFLICT (organization_id) DO UPDATE SET
     status = EXCLUDED.status,
     legal_business_name = EXCLUDED.legal_business_name,
     billing_contact_email = EXCLUDED.billing_contact_email,
     breach_notification_email = EXCLUDED.breach_notification_email,
     provisioned_at = COALESCE(tenant_account.provisioned_at, EXCLUDED.provisioned_at),
     activated_at = COALESCE(tenant_account.activated_at, EXCLUDED.activated_at),
     updated_at = now()
   RETURNING id`,
    [orgId, ORG.legal, "admin@wardenx.local", JSON.stringify({ source: "dev_seed" })],
  );
  const tenantAccountId = firstRow(account, "seed: tenant_account upsert").id;
  console.log(`tenant account ${ORG.slug} → active`);

  const ring = loadPlatformKekRing();
  if (!ring) {
    console.log(
      `tenant key ring: SKIPPED — ${ACTIVE_KEK_ENV} is unset, so this deployment does no tenant crypto.\n  Encounter finalize, cost-report payloads, HL7 storage, portal contacts and consent notes will 503.`,
    );
    return;
  }

  const { wrappedCiphertextB64, kekId } = await createPlatformKekAdapter(ring).mintAndWrapDek({
    organizationId: orgId,
  });
  // The function reads the wrapped DEK off two transaction-local GUCs rather than taking them as
  // arguments, so the key material never lands in `pg_stat_statements` alongside the call.
  await db.query("BEGIN");
  await db.query(
    "SELECT set_config('app.dek_kek_wrapped_ciphertext_b64', $1, true), set_config('app.dek_kek_id', $2, true)",
    [wrappedCiphertextB64, kekId],
  );
  const keyRing = await db.query<{ id: string }>("SELECT m34_provision_tenant_key_ring($1) AS id", [
    tenantAccountId,
  ]);
  await db.query("COMMIT");
  console.log(
    `tenant account ${tenantAccountId} → key ring ${firstRow(keyRing, "seed: key ring provision").id} (KEK '${kekId}')`,
  );
}

/**
 * Delete every row the prior demo org owns — every table with an `organization_id` — before the org
 * row itself goes. The cleanup below used to delete only the handful of tables that FK the org
 * RESTRICT, then the org, with RI off (replication session). Everything else the demo seeds had written
 * — patients, admissions, the fixed-id provider entity, IPU units, trading-partner credentials, … —
 * survived as orphans carrying a deleted org's id, and a re-seed then tripped over them: the fixed-id
 * rows (`ON CONFLICT (id) DO NOTHING`) stayed bound to the dead org and 404'd under RLS, unique slots
 * stayed taken (500 on re-create), and admin-connection workers picked orphaned units up.
 *
 * Cleanup is deliberately scoped to the demo org id. NULL `organization_id` (platform-level rows) and
 * rows owned by any other tenant are never matched. Each table runs under its own savepoint so one
 * refusal cannot abort the surrounding cleanup transaction.
 */
async function purgeOrgOwnedRows(db: Client, orgId: string): Promise<void> {
  const tables = await db.query<{ schema: string; name: string }>(
    `SELECT n.nspname AS schema, c.relname AS name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attname = 'organization_id' AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND c.relname <> 'organization'`,
  );
  let purged = 0;
  for (const { schema, name } of tables.rows) {
    await db.query("SAVEPOINT purge_org_table");
    try {
      const r = await db.query(
        `DELETE FROM "${schema}"."${name}" WHERE organization_id::text = $1`,
        [orgId],
      );
      purged += r.rowCount ?? 0;
      await db.query("RELEASE SAVEPOINT purge_org_table");
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT purge_org_table");
      console.warn(
        `  ! could not purge prior demo-org rows from ${schema}.${name}: ${String(err)}`,
      );
    }
  }
  console.log(
    `prior demo org ${orgId}: purged ${purged} org-owned row(s) across ${tables.rowCount} tables`,
  );
}

async function main(): Promise<void> {
  // Dev/demo only: this deletes and rebuilds the demo org across all org-owned tables.
  // The only caller that sets the acknowledgement is deploy/production/reseed-demo.sh (the manual
  // `reseed-production` workflow); db:seed:all chains child processes, so it is an env var, not a flag.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.WARDENX_SEED_ALLOW_PRODUCTION !== "yes-reseed-demo"
  ) {
    throw new Error("db:seed is a local dev seed and refuses to run with NODE_ENV=production");
  }
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const dbHost = new URL(ADMIN_URL).hostname;
  const LOCAL_DB_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]", "postgres"];
  if (
    !LOCAL_DB_HOSTS.includes(dbHost) &&
    !process.argv.includes("--i-understand-this-is-production")
  ) {
    throw new Error(
      `db:seed deletes and recreates the demo org; ${dbHost} is not local. Pass --i-understand-this-is-production to proceed.`,
    );
  }
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  // Seed as a replication session: suppress the M4 write-audit triggers (seeding is not an audited
  // user action) and the append-only/RESTRICT guards, so dev data inserts cleanly. Superuser-only.
  await db.query("SET session_replication_role = replica");

  const emails = USERS.map((u) => u.email);
  const allRows = allPermissionMirrorRows();

  // --- Sync the M3 permission catalog into the read-only `permission` table (deploy-time sync).
  // role_permission.permission_key FKs to this; it must be populated before any grant.
  for (const row of allRows) {
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
  console.log(`permission catalog synced (${allRows.length} keys)`);

  // --- Idempotent cleanup: drop prior demo org + demo users (+ Better Auth child rows) ---
  await db.query("BEGIN");
  const soleTenantUserIds = new Set<string>();
  const prior = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG.slug,
  ]);
  const priorOrgId = prior.rowCount
    ? firstRow(prior, "seed: existing organization lookup").id
    : null;
  // Seed emails are global Better Auth identities. If one has been attached to another tenant, abort
  // before deleting any tenant/user data instead of orphaning that tenant under replication mode.
  const crossTenantSeedUsers = priorOrgId
    ? await db.query<{ email: string }>(
        `SELECT DISTINCT u.email
           FROM "user" u
           JOIN membership m ON m.user_id = u.id
          WHERE u.email = ANY($1) AND m.organization_id <> $2`,
        [emails, priorOrgId],
      )
    : await db.query<{ email: string }>(
        `SELECT DISTINCT u.email
           FROM "user" u
           JOIN membership m ON m.user_id = u.id
          WHERE u.email = ANY($1)`,
        [emails],
      );
  if (crossTenantSeedUsers.rowCount) {
    throw new Error(
      `refusing to reset demo identities shared with another organization: ${crossTenantSeedUsers.rows
        .map((row) => row.email)
        .sort()
        .join(", ")}`,
    );
  }
  if (prior.rowCount) {
    const orgId = priorOrgId as string;
    // A user identity is cross-org, so deleting the tenant must not delete an identity that still
    // belongs to another organization. Capture only users whose complete membership set is this
    // demo tenant before purgeOrgOwnedRows removes the membership rows. This also catches persona,
    // reviewer and legacy test accounts that older seed versions created but the current USERS list
    // no longer knows by email.
    const soleTenantUsers = await db.query<{ id: string }>(
      `SELECT m.user_id AS id
         FROM membership m
        WHERE m.organization_id = $1
        GROUP BY m.user_id
       HAVING NOT EXISTS (
         SELECT 1 FROM membership other
          WHERE other.user_id = m.user_id AND other.organization_id <> $1
       )`,
      [orgId],
    );
    for (const row of soleTenantUsers.rows) soleTenantUserIds.add(row.id);
    await purgeOrgOwnedRows(db, orgId);
    await db.query("DELETE FROM membership_role WHERE organization_id = $1", [orgId]);
    await db.query("DELETE FROM role_permission WHERE organization_id = $1", [orgId]);
    await db.query("DELETE FROM membership WHERE organization_id = $1", [orgId]);
    await db.query("DELETE FROM role WHERE organization_id = $1", [orgId]);
    // audit_event has ON DELETE RESTRICT to organization (and is normally append-only);
    // as the seed superuser we clear the demo org's trail so the org row can be removed.
    await db.query("DELETE FROM audit_event WHERE organization_id = $1", [orgId]).catch(() => {});
    // The M34 tenant spine, innermost first: both FK the organization ON DELETE RESTRICT, so without
    // this the re-run's org DELETE fails once the seed has provisioned a key ring even once. The
    // tenant_account's own lifecycle children go before it.
    await db.query("DELETE FROM tenant_key_ring WHERE organization_id = $1", [orgId]);
    const tenantAccounts = await db.query<{ id: string }>(
      "SELECT id FROM tenant_account WHERE organization_id = $1",
      [orgId],
    );
    const tenantAccountIds = tenantAccounts.rows.map((row) => row.id);
    if (tenantAccountIds.length) {
      await db.query("DELETE FROM onboarding_task WHERE tenant_account_id = ANY($1::uuid[])", [
        tenantAccountIds,
      ]);
      await db.query("DELETE FROM tenant_invitation WHERE tenant_account_id = ANY($1::uuid[])", [
        tenantAccountIds,
      ]);
      await db.query(
        "DELETE FROM tenant_account_status_event WHERE tenant_account_id = ANY($1::uuid[])",
        [tenantAccountIds],
      );
    }
    await db.query("DELETE FROM tenant_account WHERE organization_id = $1", [orgId]);
    await db.query("DELETE FROM organization WHERE id = $1", [orgId]);
  }
  // Better Auth child rows (FKs vary) then the user rows.
  const uids = await db.query<{ id: string }>(
    `SELECT u.id
       FROM "user" u
      WHERE u.email = ANY($1)
        AND NOT EXISTS (
          SELECT 1 FROM membership m
           WHERE m.user_id = u.id
             AND ($2::uuid IS NULL OR m.organization_id <> $2::uuid)
        )`,
    [emails, priorOrgId],
  );
  const ids = [...new Set([...soleTenantUserIds, ...uids.rows.map((r) => r.id)])];
  if (ids.length) {
    for (const t of ["session", "account", "two_factor", "passkey"]) {
      await db.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [ids]).catch(() => {});
    }
    await db.query('DELETE FROM "user" WHERE id = ANY($1)', [ids]);
  }
  if (soleTenantUserIds.size > 0) {
    console.log(`prior demo org: removed ${soleTenantUserIds.size} sole-tenant user identities`);
  }
  await db.query("COMMIT");

  // --- Create the org ---
  const org = await db.query<{ id: string }>(
    `INSERT INTO organization (slug, legal_name, display_name, status)
     VALUES ($1,$2,$3,'active') RETURNING id`,
    [ORG.slug, ORG.legal, ORG.display],
  );
  const orgId = firstRow(org, "seed: organization insert").id;
  console.log(`org ${ORG.slug} → ${orgId}`);

  await provisionTenantSpine(db, orgId);

  const creds: Array<{ user: SeedUser; password: string; userId: string; perms: number }> = [];

  // --- Pass 1: create each distinct org-scoped role once (a role is owned by the USER whose primary
  // `roleKey` it is) and grant its permissions. `role` is unique on (organization_id, key), so a role a
  // second user only references via `alsoRoleKeys` must be SHARED, not re-created — hence the role-centric
  // pass. `permKeysByRole` lets the credentials summary report each membership's effective permission count.
  const roleIdByKey = new Map<string, string>();
  const permKeysByRole = new Map<string, Set<string>>();
  for (const u of USERS) {
    const r = await db.query<{ id: string }>(
      `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES ($1,$2,$3,$4::role_category,'organization', true, $5) RETURNING id`,
      [orgId, u.roleKey, u.roleName, u.roleCategory, `${u.roleName} (dev seed)`],
    );
    const roleId = firstRow(r, "seed: role upsert").id;
    roleIdByKey.set(u.roleKey, roleId);

    const keys = u.grantAll
      ? allRows.map((x) => x.key)
      : allRows.filter((row) => u.permCats.includes(row.category as Cat)).map((x) => x.key);
    for (const key of keys) {
      await db.query(
        "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
        [orgId, roleId, key],
      );
    }
    permKeysByRole.set(u.roleKey, new Set(keys));
  }

  // --- Pass 2: create each user + membership and bind its primary role + any `alsoRoleKeys`. ---
  for (const u of USERS) {
    const password = genPassword();
    const userId = await signUp(u.email, password, u.name);

    const m = await db.query<{ id: string }>(
      `INSERT INTO membership (user_id, organization_id, status, accepted_at)
       VALUES ($1,$2,'active', now()) RETURNING id`,
      [userId, orgId],
    );
    const membershipId = firstRow(m, "seed: membership upsert").id;

    const boundRoleKeys = [u.roleKey, ...(u.alsoRoleKeys ?? [])];
    const effectivePerms = new Set<string>();
    for (const key of boundRoleKeys) {
      const roleId = roleIdByKey.get(key);
      if (!roleId) throw new Error(`user ${u.email} references undefined role '${key}'`);
      await db.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [orgId, membershipId, roleId],
      );
      for (const p of permKeysByRole.get(key) ?? []) effectivePerms.add(p);
    }

    creds.push({ user: u, password, userId, perms: effectivePerms.size });
    console.log(
      `user ${u.email} (roles: ${boundRoleKeys.join("+")}, ${effectivePerms.size} perms) → ${userId}`,
    );
  }

  await db.end();

  // --- Write the gitignored credentials file ---
  const lines = [
    "# WardenX — Local Dev Credentials",
    "",
    "> **Gitignored. Local only.** Generated by `bun run db:seed`. Re-running regenerates passwords.",
    // Derived from the connection this run actually used, never a hardcoded container name: the
    // text said `wardenx-postgres` (the retired 5440 container) while the seed wrote to whatever
    // DATABASE_URL named, which under the documented setup was a different database entirely
    // (F-016 / #43).
    `> These are throwaway dev accounts against \`${seededTarget()}\` — not real PHI users.`,
    "",
    "## URLs",
    "",
    "| Surface | URL |",
    "|---|---|",
    "| Web app | http://localhost:5173 |",
    "| Backend API | http://localhost:3000 |",
    "| Sign in | http://localhost:5173/login |",
    "",
    `**Organization:** ${ORG.display} (slug \`${ORG.slug}\`) — select it at login.`,
    "",
    "## Accounts",
    "",
    "| Role | Email | Password | Permissions | Username |",
    "|---|---|---|---|---|",
    ...creds.map(
      (c) =>
        `| ${c.user.roleName} | \`${c.user.email}\` | \`${c.password}\` | ${c.perms} keys (${c.user.permCats.join("+")}) | \`${seedUsername(c.user.email)}\` |`,
    ),
    "",
    "## Notes",
    "",
    "- Sign in with username (or email) + password, then pick the organization above (the session's active org).",
    "- 2FA is not enrolled on these accounts; enroll via `/security` if you want to exercise the MFA flow.",
    "- Reset everything: `bun run db:reset` (`docker compose down -v`, re-migrates, re-seeds).",
    "",
  ];
  const out = SEED_CREDENTIALS_PATH;
  writeSeedCredentials(lines.join("\n"));
  console.log(`\n✓ seed complete — credentials written to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
