/**
 * WardenX — discipline-persona staff seed (local dev). NOT for production.
 *
 * `scripts/db/seed.ts` creates 4 demo logins (administrator, org_admin, clinician, auditor), all
 * with broad permission-CATEGORY grants. What none of them carry is a **discipline role-key token**
 * — the clinical write routes across M7/M8/M9/M10/M11/M12/M13/M15/M17 all separately check
 * `context.roles` for a specific key like `"rn"`/`"lpn"`/`"md"`/`"msw"`/`"chaplain"` (M7's
 * `DISCIPLINE_ROLE_TOKENS`, M8's `isRn()`, M9's `discipline_can_record_scale` ABAC, M10's
 * `hope.authorDisciplineAllowed`, M11's `discipline_can_order`/cosign-role re-derivation, M14's IDG
 * quorum, M15's required-signer quorum) — none of the 4 existing roles carry ANY of these tokens, so
 * every one of those routes 403s regardless of how many permission keys the caller holds. This was
 * confirmed by tracing `context.roles` end-to-end through `packages/auth/src/identity/
 * db-session-store.ts` — it's the literal `role.key` values bound to the membership, and
 * `context.attributes.disciplines` (which some ABAC predicates also consult) is never populated
 * anywhere in the backend.
 *
 * This script adds distinct staff logins, one per discipline persona, each granted the same
 * `clinical` permission-category set `casey@wardenx.local` already gets (so the route's
 * `requirePermission` check passes) PLUS the specific role-key token(s) the ABAC/discipline checks
 * actually look for. Separate logins (not just extra roles bolted onto the existing 4) so
 * different-person-required scenarios — M11 cosign (drafter ≠ cosigner), M13 witness (different
 * membership), M15 supervisory visit (aide ≠ RN), M14 IDG quorum (4 distinct disciplines in one
 * meeting) — have a real second/third/fourth actor to use, not the same demo account role-juggling
 * against itself.
 *
 * Idempotent: additive-only — deletes/recreates just these fixed emails' Better Auth + membership
 * rows, never touches the org or the original 4 `db:seed` accounts.
 * Prereqs: bun run db:seed (org + admin@wardenx.local must exist — admin holds role.manage/role.assign
 * and every permission, so no anti-escalation block) AND bun run db:seed:org-structure (each
 * persona's membership is scoped to that script's fixed provider_entity/location).
 * Run:     bun run db:seed:staff
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { allPermissionMirrorRows } from "@wardenx/auth";
import { Client } from "pg";
import { group } from "../lib/strict";
import { fetchAuthWithRateLimitRetry } from "./lib/auth-rate-limit";
import { SEED_CREDENTIALS_PATH } from "./lib/credentials";
import { firstRow } from "./lib/query-rows";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const ORG_SLUG = "wardenx-demo";
const PROVIDER_ENTITY_ID = "44444444-0000-4000-8000-000000000001"; // db:seed:org-structure
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001"; // db:seed:org-structure

interface Persona {
  email: string;
  name: string;
  /** All role-key tokens this persona holds. First one is the "primary" role name/category label. */
  roleKeys: string[];
  roleName: string;
}

const PERSONAS: Persona[] = [
  {
    email: "rita@wardenx.local",
    name: "Rita Alvarez, RN",
    roleKeys: ["rn", "rn_case_manager"],
    roleName: "RN Case Manager",
  },
  { email: "dana@wardenx.local", name: "Dana Kim, LPN", roleKeys: ["lpn"], roleName: "LPN" },
  {
    email: "drharris@wardenx.local",
    name: "Dr. Sam Harris",
    roleKeys: ["md", "hospice_physician", "medical_director"],
    roleName: "Hospice Medical Director",
  },
  {
    email: "nora@wardenx.local",
    name: "Nora Patel, NP",
    roleKeys: ["np"],
    roleName: "Nurse Practitioner",
  },
  {
    email: "mira@wardenx.local",
    name: "Mira Chen, MSW",
    roleKeys: ["msw"],
    roleName: "Medical Social Worker",
  },
  {
    email: "cole@wardenx.local",
    name: "Cole Jennings, Chaplain",
    roleKeys: ["chaplain"],
    roleName: "Chaplain",
  },
  {
    email: "vera@wardenx.local",
    name: "Vera Simmons",
    roleKeys: ["volunteer_coordinator"],
    roleName: "Volunteer Coordinator",
  },
  {
    email: "valentina@wardenx.local",
    name: "Valentina Okafor",
    roleKeys: ["volunteer"],
    roleName: "Volunteer",
  },
  {
    email: "supervisor@wardenx.local",
    name: "Sam Rivera",
    // `compliance_officer` added for M30's `capVerifyAuthority` two-person-control predicate
    // (incident resolve/close) — a role-key check, not a permission, so granting the `quality`
    // permission category alone (above) isn't sufficient on its own.
    roleKeys: ["clinical_supervisor", "compliance_officer"],
    roleName: "Clinical Supervisor",
  },
  {
    email: "amy@wardenx.local",
    name: "Amy Torres, CHHA",
    roleKeys: ["chha"],
    roleName: "Home Health Aide",
  },
];

function genPassword(): string {
  return `Wx-${randomBytes(9).toString("base64url")}-Zq9!`;
}

function adminPassword(): string {
  const md = readFileSync(SEED_CREDENTIALS_PATH, "utf8");
  const line = md.split("\n").find((l) => l.includes("admin@wardenx.local"));
  const m = line?.match(/`([^`]+)`\s*\|\s*`([^`]+)`/);
  if (!m)
    throw new Error("could not read admin password from CREDENTIALS.local.md (run db:seed first)");
  return group(m, 2, "CREDENTIALS.local.md password cell");
}

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await fetchAuthWithRateLimitRetry(
    `${AUTH_URL}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    },
    `sign-up for ${email}`,
  );
  if (!res.ok)
    throw new Error(`sign-up failed for ${email}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user?: { id?: string } };
  if (!body.user?.id) throw new Error(`sign-up for ${email} returned no user id`);
  return body.user.id;
}

/**
 * F-014 (#39) — the demo caseload's primary RN.
 *
 * `caseload_or_scope` (the predicate behind M7's care plans, M8's encounters and their siblings) is
 * satisfied by an org-wide role, a session scope attribute, or an OPEN `patient_assignment` row for
 * the calling user. `seed-clinical.ts` anchors that row to `casey@wardenx.local` because at its point
 * in the chain no persona exists yet — but every scenario seed acts as `rita@wardenx.local`, who had
 * no assignment. The denial then arrived as `NOT_FOUND`, because those routes use
 * `{ notFoundOnDeny: true }` (the §6.6 existence-non-leak convention), so four seed steps reported a
 * missing resource for a patient that was verifiably there.
 *
 * Re-anchoring HERE rather than only in `seed-clinical.ts` is what makes it order-independent. The
 * chain runs this script immediately BEFORE `db:seed:clinical` (#39 moved it there so rita exists by
 * then), but this script deletes and re-creates her user row on every run — so an assignment written
 * against a previous run's rita would point at a user id that no longer exists, whatever the order.
 */
const RN_CASE_MANAGER_EMAIL = "rita@wardenx.local";

async function anchorDemoCaseload(
  db: Client,
  orgId: string,
  rnUserId: string | undefined,
): Promise<void> {
  if (!rnUserId) return;
  const patients = await db.query<{ id: string }>(
    "SELECT id FROM patient WHERE organization_id = $1",
    [orgId],
  );
  if (patients.rowCount === 0) {
    console.log(
      "  · no demo patients yet — caseload anchoring skipped (re-run db:seed:staff after db:seed:clinical)",
    );
    return;
  }
  // `patient_assignment_primary_rn_unique` allows exactly one open primary_rn per patient, so the
  // prior anchor has to go before this one lands. Scoped to primary_rn: the attending_clinician rows
  // seed-clinical.ts writes are a different question and are left alone.
  await db.query(
    `DELETE FROM patient_assignment
      WHERE organization_id = $1 AND role = 'primary_rn' AND patient_id = ANY($2)`,
    [orgId, patients.rows.map((r) => r.id)],
  );
  for (const { id } of patients.rows) {
    await db.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn', CURRENT_DATE)`,
      [id, orgId, rnUserId],
    );
  }
  console.log(
    `  ✓ demo caseload anchored: ${RN_CASE_MANAGER_EMAIL} is primary RN for ${patients.rowCount} patient(s)`,
  );
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica");

  const orgRes = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG_SLUG,
  ]);
  const orgId = orgRes.rows[0]?.id;
  if (!orgId) throw new Error(`demo org '${ORG_SLUG}' not found — run db:seed first`);

  // Field-staff-relevant categories — not just "clinical". Discovered live: M15 volunteer-compliance
  // keys are "compliance" category, M17 visit keys are "scheduling", M18 device keys are "evv", M19
  // shift keys are "oncall", M20 incident keys are "field_safety" — a clinical-only grant 403'd every
  // one of those routes for these personas even though the discipline-role-token gate (the actual
  // reason these accounts exist) was satisfied.
  const FIELD_STAFF_CATEGORIES = [
    "clinical",
    "scheduling",
    "evv",
    "oncall",
    "field_safety",
    "compliance",
    "self_service",
    "triage",
    "quality",
  ];
  const allRows = allPermissionMirrorRows();
  const clinicalKeys = allRows
    .filter((r) => FIELD_STAFF_CATEGORIES.includes(r.category))
    .map((r) => r.key);

  // --- Idempotent cleanup: drop any prior run of these specific persona accounts only. ---
  const emails = PERSONAS.map((p) => p.email);
  await db.query("BEGIN");
  const priorUsers = await db.query<{ id: string }>('SELECT id FROM "user" WHERE email = ANY($1)', [
    emails,
  ]);
  const priorIds = priorUsers.rows.map((r) => r.id);
  if (priorIds.length) {
    const priorMemberships = await db.query<{ id: string }>(
      "SELECT id FROM membership WHERE user_id = ANY($1) AND organization_id = $2",
      [priorIds, orgId],
    );
    const membershipIds = priorMemberships.rows.map((r) => r.id);
    if (membershipIds.length) {
      await db.query("DELETE FROM membership_role WHERE membership_id = ANY($1)", [membershipIds]);
      await db.query("DELETE FROM membership WHERE id = ANY($1)", [membershipIds]);
    }
    for (const t of ["session", "account", "two_factor", "passkey"]) {
      await db.query(`DELETE FROM ${t} WHERE user_id = ANY($1)`, [priorIds]).catch(() => {});
    }
    // F-014 (#39) — `patient_assignment.clinician_user_id` REFERENCES "user" ON DELETE RESTRICT
    // (migration 0020). Once this script started anchoring the demo caseload (below), a re-run would
    // have been blocked by that constraint on its own previous output. Dropping the assignments here
    // is safe precisely because the anchoring step at the end re-creates them from scratch.
    await db.query("DELETE FROM patient_assignment WHERE clinician_user_id = ANY($1)", [priorIds]);
    await db.query('DELETE FROM "user" WHERE id = ANY($1)', [priorIds]);
  }
  // Drop any prior persona-owned roles too (role.key is unique per org — a re-run must not collide).
  const priorRoleKeys = [...new Set(PERSONAS.flatMap((p) => p.roleKeys))];
  const priorRoles = await db.query<{ id: string }>(
    "SELECT id FROM role WHERE organization_id = $1 AND key = ANY($2)",
    [orgId, priorRoleKeys],
  );
  const priorRoleIds = priorRoles.rows.map((r) => r.id);
  if (priorRoleIds.length) {
    await db.query("DELETE FROM role_permission WHERE role_id = ANY($1)", [priorRoleIds]);
    await db.query("DELETE FROM role WHERE id = ANY($1)", [priorRoleIds]);
  }
  await db.query("COMMIT");

  // --- Create one role per distinct role-key token (shared across personas if two happen to list
  // the same key — none do today, but this mirrors seed.ts's role-centric-not-user-centric pattern). ---
  const userIdByEmail = new Map<string, string>();
  const roleIdByKey = new Map<string, string>();
  for (const key of priorRoleKeys) {
    const owner =
      PERSONAS.find((p) => p.roleKeys[0] === key) ?? PERSONAS.find((p) => p.roleKeys.includes(key));
    const r = await db.query<{ id: string }>(
      `INSERT INTO role (organization_id, key, name, category, scope_level, enabled, description)
       VALUES ($1,$2,$3,'clinical_staff'::role_category,'organization', true, $4) RETURNING id`,
      [orgId, key, owner?.roleName ?? key, `${owner?.roleName ?? key} (dev seed persona)`],
    );
    roleIdByKey.set(key, firstRow(r, `seed-staff-personas: role ${key}`).id);
    for (const permKey of clinicalKeys) {
      await db.query(
        "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
        [orgId, firstRow(r, `seed-staff-personas: role ${key}`).id, permKey],
      );
    }
  }

  // --- Create each user + membership + all its role bindings. ---
  const creds: Array<{ persona: Persona; password: string }> = [];
  for (const p of PERSONAS) {
    const password = genPassword();
    const userId = await signUp(p.email, password, p.name);
    // `default_provider_entity_id`/`default_location_ids` feed `context.providerEntityIds`/
    // `.locationIds` (the M2 authenticate hook, apps/backend/src/bootstrap/plugins/authenticate.ts) —
    // left at their empty defaults, EVERY location/PE-scoped ABAC predicate denies unconditionally
    // ("an empty scope array can never contain a target's id", per that file's own comment). Found
    // live: M14's `idg_meeting_scope` 403'd for every persona until this was set. Scoped to the one
    // demo provider_entity/location `seed-org-structure.ts` creates.
    const m = await db.query<{ id: string }>(
      `INSERT INTO membership
         (user_id, organization_id, status, accepted_at, default_provider_entity_id, default_location_ids)
       VALUES ($1,$2,'active', now(), $3, $4::jsonb) RETURNING id`,
      [userId, orgId, PROVIDER_ENTITY_ID, JSON.stringify([LOCATION_MAIN_ID])],
    );
    const membershipId = firstRow(m, "seed-staff-personas: membership upsert").id;
    for (const key of p.roleKeys) {
      const roleId = roleIdByKey.get(key);
      if (!roleId) throw new Error(`role '${key}' was not created`);
      await db.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [orgId, membershipId, roleId],
      );
    }
    creds.push({ persona: p, password });
    console.log(`  ✓ ${p.email} (${p.roleKeys.join("+")}, ${clinicalKeys.length} perms per role)`);
    userIdByEmail.set(p.email, userId);
  }

  await anchorDemoCaseload(db, orgId, userIdByEmail.get(RN_CASE_MANAGER_EMAIL));

  await db.end();

  // --- Append to CREDENTIALS.local.md (don't clobber the original 4 accounts' block). ---
  const credsPath = SEED_CREDENTIALS_PATH;
  const existing = readFileSync(credsPath, "utf8");
  const marker = "\n## Discipline personas (bun run db:seed:staff)\n";
  const withoutOldPersonas = (existing.split(marker)[0] ?? existing).replace(/\n+$/, "\n");
  const lines = [
    withoutOldPersonas,
    marker.trimStart(),
    "",
    "> Additive staff logins carrying the discipline role-key tokens (`rn`, `lpn`, `md`, `msw`, …)",
    "> the clinical write routes gate on — the original 4 accounts above hold broad permission",
    "> categories but no discipline token, so M7/M8/M9/M10/M11/M12/M13/M15/M17 writes 403 for them.",
    "",
    "| Persona | Email | Password | Role key(s) |",
    "|---|---|---|---|",
    ...creds.map(
      (c) =>
        `| ${c.persona.roleName} | \`${c.persona.email}\` | \`${c.password}\` | ${c.persona.roleKeys.join(", ")} |`,
    ),
    "",
  ];
  writeFileSync(credsPath, lines.join("\n"));
  console.log(`\n✓ staff persona seed: ${creds.length} accounts created.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
