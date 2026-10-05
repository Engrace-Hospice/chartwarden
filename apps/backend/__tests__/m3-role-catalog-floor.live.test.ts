/**
 * F-093 — the §3.4.1 `system_locked` CoP permission floor, enforced by the store production mounts.
 *
 * THE FINDING. Two files each named the other as the enforcer. `role-store.ts` (the Drizzle store the
 * composition root binds) said "the route layer enforces the `system_locked` CoP floor (RoleLockedError)
 * before calling the store"; `authz-routes.ts` says "the §3.4.1 floor check IN THE STORE is what refuses
 * it", and its handler only TRANSLATES a `RoleLockedError` into a 409 — it never raises one. The store
 * that raises it is `createInMemoryRoleStore`, the slice every route test runs against. The production
 * store deleted and re-inserted `role_permission` unconditionally and deleted any role row handed to it.
 *
 * So on a live deployment `PATCH /api/v1/roles/:id { permissionKeys: [] }` stripped the Medical
 * Director's `patient.read` / `cti.sign` / `idg.participate` / `order.cosign`, and `DELETE` removed the
 * Compliance Officer role outright — M03-F06, the control CoP 418.102 / 418.64(a) / 418.52 compliance
 * rests on. Every unit and route suite passed throughout, because they all exercise the double that has
 * the check.
 *
 * WHICH IS EXACTLY WHY THIS SUITE IS LIVE. A test against the in-memory store proves the double
 * behaves; it has proved that all along, and the defect lived in the difference. The only way to make a
 * statement about the deployed control is to drive the Drizzle store over real `role` /
 * `role_permission` rows as the NOBYPASSRLS `wardenx_app` role.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m3:role-floor:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { SYSTEM_LOCKED_FLOORS, allPermissionMirrorRows } from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RoleStore } from "../src/modules/03-authorization/authz-ports";
import { createDbRoleStore } from "../src/modules/03-authorization/role-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f0930001";
const ACTOR = "33333333-3333-4333-8333-3333f0930003";
const MD_FLOOR = SYSTEM_LOCKED_FLOORS.medical_director;

describe.skipIf(!DB_URL)("F-093 M3 role catalog floor — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: RoleStore;
  /** The store's update/delete resolve the org from the AMBIENT request context, as the routes do. */
  const asActor = <T>(fn: () => T): T =>
    runWithRequestContext({ organizationId: ORG_A, userId: ACTOR } as never, fn);

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  /** Create a role row and grant it a permission set, as the seed/provisioning path would. */
  async function seedRole(
    key: string,
    grants: readonly string[],
    over: { organizationId?: string | null; systemLocked?: boolean } = {},
  ): Promise<string> {
    const orgId = over.organizationId === undefined ? ORG_A : over.organizationId;
    const { rows } = await admin.query(
      `INSERT INTO role (organization_id, key, name, category, scope_level, system_default, system_locked)
       VALUES ($1,$2,$3,'clinical_leadership','organization',true,$4) RETURNING id`,
      [orgId, key, key, over.systemLocked ?? false],
    );
    const roleId = rows[0].id as string;
    for (const k of grants) {
      await admin.query(
        "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
        [orgId, roleId, k],
      );
    }
    return roleId;
  }

  const grantsOf = async (roleId: string): Promise<string[]> =>
    (
      await admin.query("SELECT permission_key FROM role_permission WHERE role_id=$1", [roleId])
    ).rows
      .map((r: { permission_key: string }) => r.permission_key)
      .sort();

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f093-a','A','A','active')",
      [ORG_A],
    );
    // The M4 write-audit trigger on `role`/`role_permission` stamps `app.user_id` as `actor_user_id`,
    // which FKs to `user` — so the acting user has to exist before any write does.
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'ops@f093.test')`, [ACTOR]);
    // `role_permission.permission_key` REFERENCES `permission.key`, so the catalog mirror has to exist
    // before any grant does — the same projection `db:sync:permissions` writes on a deployment.
    for (const row of allPermissionMirrorRows()) {
      await admin.query(
        `INSERT INTO permission (key, resource, action, category, default_abac, description)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
        [row.key, row.resource, row.action, row.category, row.defaultAbac, row.description],
      );
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDbRoleStore(handle.db);
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM role_permission");
    await admin.query("DELETE FROM role");
  });

  it("refuses to strip a CoP-required key from a system_locked role, and the grants survive", async () => {
    const roleId = await seedRole("medical_director", [...MD_FLOOR, "report.dashboard.read"]);

    await expect(
      asActor(() => store.update(roleId, { permissionKeys: ["report.dashboard.read"] })),
    ).rejects.toMatchObject({ kind: "floor", strippedKeys: expect.arrayContaining([...MD_FLOOR]) });

    // The security property, read back from the table rather than the return value: the edit did not
    // partially apply. The old code deleted every `role_permission` row before inserting the new set,
    // so a refusal arriving after that delete would have been worse than no check at all.
    expect(await grantsOf(roleId)).toEqual([...MD_FLOOR, "report.dashboard.read"].sort());
  });

  it("refuses `permissionKeys: []` — the strip-to-nothing edit the route deliberately forwards", async () => {
    const roleId = await seedRole("compliance_officer", [
      ...SYSTEM_LOCKED_FLOORS.compliance_officer,
    ]);
    await expect(asActor(() => store.update(roleId, { permissionKeys: [] }))).rejects.toMatchObject(
      { kind: "floor" },
    );
    expect(await grantsOf(roleId)).toEqual([...SYSTEM_LOCKED_FLOORS.compliance_officer].sort());
  });

  it("allows an edit that keeps the floor, and allows widening", async () => {
    // The floor is a MINIMUM, not a fixed set: the control must narrow what a tenant can remove
    // without freezing what they can add.
    const roleId = await seedRole("director_of_nursing", [
      ...SYSTEM_LOCKED_FLOORS.director_of_nursing,
    ]);
    const next = [...SYSTEM_LOCKED_FLOORS.director_of_nursing, "report.dashboard.read"];
    await asActor(() => store.update(roleId, { permissionKeys: next }));
    expect(await grantsOf(roleId)).toEqual([...next].sort());
  });

  it("leaves a rename / disable alone — the floor is about what the role GRANTS", async () => {
    const roleId = await seedRole("medical_director", [...MD_FLOOR]);
    const updated = await asActor(() =>
      store.update(roleId, { name: "Hospice Medical Director", enabled: false }),
    );
    expect(updated.name).toBe("Hospice Medical Director");
    expect(updated.enabled).toBe(false);
    expect(await grantsOf(roleId)).toEqual([...MD_FLOOR].sort());
  });

  it("an unlocked role is fully editable — the check narrows, it does not freeze the catalog", async () => {
    const roleId = await seedRole("volunteer_coordinator", [
      "report.dashboard.read",
      "patient.read",
    ]);
    await asActor(() => store.update(roleId, { permissionKeys: [] }));
    expect(await grantsOf(roleId)).toEqual([]);
  });

  it("refuses to DELETE a system_locked role, and the row is still there", async () => {
    const roleId = await seedRole("compliance_officer", [
      ...SYSTEM_LOCKED_FLOORS.compliance_officer,
    ]);
    await expect(asActor(() => store.delete(roleId))).rejects.toMatchObject({ kind: "delete" });
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM role WHERE id=$1", [roleId]);
    expect(rows[0].n).toBe(1);
  });

  it("deletes an unlocked role and its grants", async () => {
    const roleId = await seedRole("volunteer_coordinator", ["report.dashboard.read"]);
    await asActor(() => store.delete(roleId));
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM role WHERE id=$1", [roleId]);
    expect(rows[0].n).toBe(0);
    expect(await grantsOf(roleId)).toEqual([]);
  });

  it("the DB `system_locked` column locks a role the code catalog does not name", async () => {
    // The second arm. It fires for nothing today — every row in every database is org-owned with
    // `system_locked` FALSE, because nothing materializes `ROLE_TEMPLATES` — and it is here so the
    // check does not go inert the moment a materializer starts writing the column.
    const roleId = await seedRole("survey_coordinator", ["report.dashboard.read"], {
      systemLocked: true,
    });
    await expect(asActor(() => store.delete(roleId))).rejects.toMatchObject({ kind: "delete" });
  });

  it("refuses to write a PLATFORM TEMPLATE, rather than raising an invalid-uuid 500", async () => {
    // An org-NULL row has no org to scope the write to. The previous `row.organizationId ?? ""` handed
    // `set_config('app.org_id','')` to withOrgContext, where the policy's `::uuid` cast raises 22P02 —
    // a tenant editing a template got invalid-input-syntax rather than a refusal.
    // An UNLOCKED key, so the refusal can only come from the org-NULL arm — a locked one would be
    // refused by `lockedKey` first and prove nothing about template scoping.
    const templateId = await seedRole("volunteer_coordinator", [], { organizationId: null });
    await expect(
      asActor(() => store.update(templateId, { name: "Renamed" })),
    ).rejects.toMatchObject({ kind: "template" });
    await expect(asActor(() => store.delete(templateId))).rejects.toMatchObject({
      kind: "template",
    });
  });

  it("a delete of a role that does not exist is refused, not silently reported as done", async () => {
    await expect(
      asActor(() => store.delete("99999999-9999-4999-8999-999999999999")),
    ).rejects.toThrow(/not found/);
  });

  // GAP-017 — the payer write moved from `patient.edit` to `patient.edit_payers`. Migration 0325 keeps
  // every tenant role that could edit payers able to, by copying the grant. Re-running the migration's
  // SQL over staged rows is the only way to exercise the backfill (a fresh replay finds no roles).
  it("GAP-017 migration 0325 copies patient.edit → patient.edit_payers for tenant roles only, idempotently", async () => {
    const sql = readFileSync(
      join(MIGRATIONS_DIR, "0325_m5_patient_edit_payers_backfill.sql"),
      "utf8",
    );
    const editor = await seedRole("intake_editor", ["patient.edit", "patient.read"]);
    const readerOnly = await seedRole("chart_reader", ["patient.read"]);
    const already = await seedRole("billing_lead", ["patient.edit", "patient.edit_payers"]);
    // A platform template (organization_id NULL) is not a tenant grant and is left alone.
    const template = await seedRole("tmpl", ["patient.edit"], { organizationId: null });

    await admin.query(sql);
    await admin.query(sql); // idempotent: a second run adds nothing

    expect(await grantsOf(editor)).toEqual(["patient.edit", "patient.edit_payers", "patient.read"]);
    expect(await grantsOf(readerOnly)).toEqual(["patient.read"]);
    expect(await grantsOf(already)).toEqual(["patient.edit", "patient.edit_payers"]);
    expect(await grantsOf(template)).toEqual(["patient.edit"]);
  });
});
