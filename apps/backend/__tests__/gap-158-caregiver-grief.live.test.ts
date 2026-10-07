/**
 * GAP-158 - the caregiver -> M2 user link (M5, migration 0462) and the M40 grief-resource catalog (migration 0463),
 * LIVE Postgres, driven as the RLS-enforced `wardenx_app` role.
 *
 * Proves what unit tests cannot: the link UPDATE actually matches a row (first writer wins, idempotent, a different
 * user conflicts, an unknown caregiver is not-found), the seam read resolves the PRIMARY current caregiver's user
 * (and nobody else's, and nothing across tenants), and the grief catalog's Drizzle paths - create / list / update /
 * deactivate - assert their row counts and are tenant-isolated by RLS. Gated on a live DB:
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:gap-158:live
 * (SUPERUSER url to a THROWAWAY database - the suite drops and recreates `public` and the roles.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPatientCaregiverReader,
  linkCaregiverToUserInTx,
} from "../src/modules/05-patient/caregiver-user-link";
import {
  buildGriefResourceReader,
  createGriefResourceStore,
} from "../src/modules/40-mdm/grief-resources";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];

const ORG_A = "11111111-1111-4111-8111-111111115801";
const ORG_B = "22222222-2222-4222-8222-222222225802";
const USER_1 = "a0000000-0000-4000-8000-000000005801";
const USER_2 = "a0000000-0000-4000-8000-000000005802";

describe.skipIf(!DB_URL)("GAP-158 caregiver link + grief catalog, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let patientA = "";
  let caregiverPrimary = "";
  let caregiverSecondary = "";
  let caregiverB = "";
  let patientB = "";

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "g158a"],
      [ORG_B, "g158b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [org, slug, slug],
      );
    }
    for (const u of [USER_1, USER_2]) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
        u,
        `${u.slice(-4)}@g158.test`,
      ]);
    }
    const mkPatient = async (org: string, mrn: string) =>
      (
        await admin.query(
          "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,$2,'G','Pat','1990-01-01','M','active') RETURNING id",
          [org, mrn],
        )
      ).rows[0].id as string;
    const mkCaregiver = async (org: string, first: string) =>
      (
        await admin.query(
          "INSERT INTO caregiver (organization_id, first_name, last_name) VALUES ($1,$2,'Cg') RETURNING id",
          [org, first],
        )
      ).rows[0].id as string;
    patientA = await mkPatient(ORG_A, "G158-A");
    patientB = await mkPatient(ORG_B, "G158-B");
    caregiverPrimary = await mkCaregiver(ORG_A, "Prim");
    caregiverSecondary = await mkCaregiver(ORG_A, "Sec");
    caregiverB = await mkCaregiver(ORG_B, "Bee");
    const link = (org: string, patient: string, cg: string, primary: boolean) =>
      admin.query(
        "INSERT INTO patient_caregiver (patient_id, caregiver_id, organization_id, relationship, is_primary, involvement_from) VALUES ($1,$2,$3,'child',$4,'2026-01-01')",
        [patient, cg, org, primary],
      );
    await link(ORG_A, patientA, caregiverPrimary, true);
    await link(ORG_A, patientA, caregiverSecondary, false);
    await link(ORG_B, patientB, caregiverB, true);
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const linkAs = (org: string, caregiverId: string, userId: string) =>
    withOrgContext(app.db, { organizationId: org, userId }, (tx) =>
      linkCaregiverToUserInTx(tx, { organizationId: org, caregiverId, userId }),
    );

  it("links a caregiver once, idempotently, and refuses a different user or a foreign/unknown caregiver", async () => {
    expect(await linkAs(ORG_A, caregiverPrimary, USER_1)).toBe("linked");
    expect(await linkAs(ORG_A, caregiverPrimary, USER_1)).toBe("already_linked");
    expect(await linkAs(ORG_A, caregiverPrimary, USER_2)).toBe("conflict");
    expect(await linkAs(ORG_A, "99999999-9999-4999-8999-999999999999", USER_1)).toBe(
      "caregiver_not_found",
    );
    // A caregiver of ANOTHER tenant is invisible under RLS - not-found, never a cross-tenant write.
    expect(await linkAs(ORG_A, caregiverB, USER_1)).toBe("caregiver_not_found");
    const { rows } = await admin.query("SELECT user_id FROM caregiver WHERE id = $1", [caregiverB]);
    expect(rows[0].user_id).toBeNull();
  });

  it("PatientCaregiverReader resolves the PRIMARY caregiver's linked user, null for an unlinked primary", async () => {
    const reader = buildPatientCaregiverReader(app.db);
    expect(await reader.primaryCaregiverUserId(ORG_A, patientA)).toBe(USER_1);
    // The secondary caregiver being linked must NOT make them the primary.
    expect(await linkAs(ORG_A, caregiverSecondary, USER_2)).toBe("linked");
    expect(await reader.primaryCaregiverUserId(ORG_A, patientA)).toBe(USER_1);
    // Org B's primary has no login yet, and org A cannot read org B's patient.
    expect(await reader.primaryCaregiverUserId(ORG_B, patientB)).toBeNull();
    expect(await reader.primaryCaregiverUserId(ORG_A, patientB)).toBeNull();
  });

  it("an ended involvement is no longer 'primary' for the seam read", async () => {
    await admin.query(
      "UPDATE patient_caregiver SET involvement_to = '2026-02-01' WHERE patient_id = $1 AND caregiver_id = $2",
      [patientA, caregiverPrimary],
    );
    expect(
      await buildPatientCaregiverReader(app.db).primaryCaregiverUserId(ORG_A, patientA),
    ).toBeNull();
  });

  it("grief catalog: create / list / update / deactivate with row-count-asserting writes, per tenant", async () => {
    const store = createGriefResourceStore(app.db);
    const created = await store.create(ORG_A, null, {
      name: "  Hospice Grief Circle ",
      resourceKind: "community_group",
      url: "https://grief.example.org",
      description: "Weekly support group",
    });
    expect(created.name).toBe("Hospice Grief Circle");
    expect(created.isActive).toBe(true);
    await store.create(ORG_B, null, { name: "Org B Camp", resourceKind: "child_camp" });

    expect((await store.list(ORG_A)).map((r) => r.name)).toEqual(["Hospice Grief Circle"]);
    expect((await store.list(ORG_B)).map((r) => r.name)).toEqual(["Org B Camp"]);

    const renamed = await store.update(ORG_A, created.id, {
      name: "Circle of Hope",
      phone: "555-0100",
    });
    expect(renamed).toMatchObject({ name: "Circle of Hope", phone: "555-0100" });

    // A tenant cannot touch another tenant's row: 404, not a silent no-op.
    await expect(store.update(ORG_B, created.id, { name: "hijack" })).rejects.toThrow(/not found/i);
    await expect(store.setActive(ORG_B, created.id, false)).rejects.toThrow(/not found/i);

    const reader = buildGriefResourceReader(app.db);
    expect((await reader.resourcesForOrg(ORG_A)).map((r) => r.name)).toEqual(["Circle of Hope"]);

    const off = await store.setActive(ORG_A, created.id, false);
    expect(off.isActive).toBe(false);
    expect(await reader.resourcesForOrg(ORG_A)).toEqual([]);
    expect((await store.list(ORG_A, { includeInactive: true })).map((r) => r.isActive)).toEqual([
      false,
    ]);
    expect((await store.setActive(ORG_A, created.id, true)).isActive).toBe(true);
  });

  it("the DB refuses a non-http url and an unknown kind (the CHECKs hold under the app role)", async () => {
    const store = createGriefResourceStore(app.db);
    await expect(
      store.create(ORG_A, null, {
        name: "x",
        resourceKind: "community_group",
        url: "javascript:alert(1)",
      }),
    ).rejects.toThrow();
    await expect(
      store.create(ORG_A, null, { name: "x", resourceKind: "nonsense" as never }),
    ).rejects.toThrow();
  });
});
