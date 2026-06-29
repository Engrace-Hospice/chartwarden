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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { allPermissionMirrorRows } from "@wardenx/auth";
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

const ORG = {
  slug: "wardenx-demo",
  legal: "WardenX Demo Hospice, Inc.",
  display: "WardenX Demo Hospice",
};

type Cat = "admin" | "clinical" | "compliance" | "platform";
interface SeedUser {
  email: string;
  name: string;
  roleKey: string;
  roleName: string;
  roleCategory: string; // role_category enum
  permCats: Cat[]; // which catalog categories this role grants (ignored when grantAll)
  /** The administrator is "every permission" — grant the entire catalog regardless of category, so newly
   *  added modules (billing/revenue-cycle, reporting, …) are covered without editing this list. */
  grantAll?: boolean;
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
  const res = await fetch(`${AUTH_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    throw new Error(`sign-up failed for ${email}: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { user?: { id?: string } };
  if (!body.user?.id) throw new Error(`sign-up for ${email} returned no user id`);
  return body.user.id;
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
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
  const prior = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG.slug,
  ]);
  if (prior.rowCount) {
    const orgId = prior.rows[0].id;
    await db.query("DELETE FROM membership_role WHERE organization_id = $1", [orgId]);
    await db.query("DELETE FROM role_permission WHERE organization_id = $1", [orgId]);
    await db.query("DELETE FROM membership WHERE organization_id = $1", [orgId]);
    await db.query("DELETE FROM role WHERE organization_id = $1", [orgId]);
    // audit_event has ON DELETE RESTRICT to organization (and is normally append-only);
    // as the seed superuser we clear the demo org's trail so the org row can be removed.
    await db.query("DELETE FROM audit_event WHERE organization_id = $1", [orgId]).catch(() => {});
    await db.query("DELETE FROM organization WHERE id = $1", [orgId]);
  }
  // Better Auth child rows (FKs vary) then the user rows.
  const uids = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email = ANY($1)', [
    emails,
  ]);
  const ids = uids.rows.map((r) => r.id);
  if (ids.length) {
    for (const t of ["session", "account", "two_factor", "passkey"]) {
      await db.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [ids]).catch(() => {});
    }
    await db.query('DELETE FROM "user" WHERE id = ANY($1)', [ids]);
  }
  await db.query("COMMIT");

  // --- Create the org ---
  const org = await db.query<{ id: string }>(
    `INSERT INTO organization (slug, legal_name, display_name, status)
     VALUES ($1,$2,$3,'active') RETURNING id`,
    [ORG.slug, ORG.legal, ORG.display],
  );
  const orgId = org.rows[0].id;
  console.log(`org ${ORG.slug} → ${orgId}`);

  const creds: Array<{ user: SeedUser; password: string; userId: string; perms: number }> = [];

  for (const u of USERS) {
    const password = genPassword();
    const userId = await signUp(u.email, password, u.name);

    // membership (active)
    const m = await db.query<{ id: string }>(
      `INSERT INTO membership (user_id, organization_id, status, accepted_at)
       VALUES ($1,$2,'active', now()) RETURNING id`,
      [userId, orgId],
    );
    const membershipId = m.rows[0].id;

    // role (org-scoped so grants are org-wide)
    const r = await db.query<{ id: string }>(
      `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES ($1,$2,$3,$4::role_category,'organization', true, $5) RETURNING id`,
      [orgId, u.roleKey, u.roleName, u.roleCategory, `${u.roleName} (dev seed)`],
    );
    const roleId = r.rows[0].id;

    // role_permission rows: the administrator grants the whole catalog; others by category.
    const keys = u.grantAll
      ? allRows.map((x) => x.key)
      : allRows.filter((row) => u.permCats.includes(row.category as Cat)).map((x) => x.key);
    for (const key of keys) {
      await db.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)`,
        [orgId, roleId, key],
      );
    }

    // bind membership → role
    await db.query(
      `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
      [orgId, membershipId, roleId],
    );

    creds.push({ user: u, password, userId, perms: keys.length });
    console.log(`user ${u.email} (${u.roleName}, ${keys.length} perms) → ${userId}`);
  }

  await db.end();

  // --- Write the gitignored credentials file ---
  const lines = [
    "# WardenX — Local Dev Credentials",
    "",
    "> **Gitignored. Local only.** Generated by `bun run db:seed`. Re-running regenerates passwords.",
    "> These are throwaway dev accounts against the local `wardenx-postgres` container — not real PHI users.",
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
    "| Role | Email | Password | Permissions |",
    "|---|---|---|---|",
    ...creds.map(
      (c) =>
        `| ${c.user.roleName} | \`${c.user.email}\` | \`${c.password}\` | ${c.perms} keys (${c.user.permCats.join("+")}) |`,
    ),
    "",
    "## Notes",
    "",
    "- Sign in with email + password, then pick the organization above (the session's active org).",
    "- 2FA is not enrolled on these accounts; enroll via `/security` if you want to exercise the MFA flow.",
    "- Reset everything: `bun run db:reset` (drops the container volume, re-migrates, re-seeds).",
    "",
  ];
  const out = join(process.cwd(), "CREDENTIALS.local.md");
  writeFileSync(out, lines.join("\n"));
  console.log(`\n✓ seed complete — credentials written to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
