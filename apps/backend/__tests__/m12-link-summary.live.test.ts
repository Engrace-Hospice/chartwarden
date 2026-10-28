/**
 * M12 `MedicationOrderProvider.linkSummary` (M36 WP 3.2) — the Drizzle query proven against real Postgres as
 * the NOBYPASSRLS `chartwarden_app` role. Rows are seeded as superuser through the real `medication_order` table.
 *
 * Both orgs hold an order each; org B's order is asked for with org A's id and vice versa. The explicit
 * organization_id predicate is a second wall that RLS masks here, so this suite proves RLS plus the shape
 * (ids and status only), not the predicate in isolation.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m12-link-summary.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleDoseSpotSeamStore } from "../src/modules/12-dosespot/seams/drizzle-store";
import { createMedicationOrderProvider } from "../src/modules/12-dosespot/seams/providers";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT_A = "44444444-4444-4444-4444-444444444444";
const PATIENT_B = "55555555-5555-5555-5555-555555555555";
const ADMISSION = "66666666-6666-6666-6666-666666666666";
const PHYSICIAN_MDM = "77777777-7777-7777-7777-777777777777";
const UNKNOWN_ID = "99999999-9999-9999-9999-999999999999";
const SENSITIVE_DRUG = "Zzzmorphine-SENTINEL";

describe.skipIf(!DB_URL)("M12 linkSummary — LIVE Postgres as chartwarden_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let provider: ReturnType<typeof createMedicationOrderProvider>;
  const memberOf: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function seedMedOrder(org: string, patientId: string, activatedAt: string | null) {
    const {
      rows: [row],
    } = await admin.query(
      `INSERT INTO medication_order
         (organization_id, patient_id, admission_id, med_class, drug_name, strength, dose_form, route, data,
          prescriber_membership_id, prescribing_physician_mdm_id, status, activated_at)
       VALUES ($1,$2,$3,'standard',$4,'SENTINEL-5mg','tablet','oral',
               '{"sig_free_text":"SENTINEL free text","sigStructured":{"doseQuantity":2,"doseUnit":"tablet","route":"oral","frequencyCode":"BID","asNeeded":false}}'::jsonb,
               $5,$6,'active',$7)
       RETURNING id`,
      [org, patientId, ADMISSION, SENSITIVE_DRUG, memberOf[org], PHYSICIAN_MDM, activatedAt],
    );
    return row.id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12-ls@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    ids.a = await seedMedOrder(ORG_A, PATIENT_A, "2026-03-01T12:10:00Z");
    ids.aNoActivation = await seedMedOrder(ORG_A, PATIENT_A, null);
    ids.b = await seedMedOrder(ORG_B, PATIENT_B, "2026-04-01T12:10:00Z");

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    provider = createMedicationOrderProvider(createDrizzleDoseSpotSeamStore(handle.db));
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("returns the order's id, patient, status and activated_at", async () => {
    expect(await provider.linkSummary(ORG_A, ids.a)).toEqual({
      id: ids.a,
      patientId: PATIENT_A,
      status: "active",
      occurredAt: "2026-03-01T12:10:00.000Z",
    });
  });

  it("falls back to created_at when the order was never activated", async () => {
    const got = await provider.linkSummary(ORG_A, ids.aNoActivation);
    const {
      rows: [r],
    } = await admin.query("SELECT created_at FROM medication_order WHERE id = $1", [
      ids.aNoActivation,
    ]);
    expect(got?.occurredAt).toBe((r.created_at as Date).toISOString());
  });

  it("withholds a SUD-treatment order exactly like a missing one (42 CFR Part 2)", async () => {
    const id = await seedMedOrder(ORG_A, PATIENT_A, "2026-03-01T12:10:00.000Z");
    expect((await provider.linkSummary(ORG_A, id))?.id).toBe(id);
    await admin.query("UPDATE medication_order SET is_sud_treatment = true WHERE id = $1", [id]);
    expect(await provider.linkSummary(ORG_A, id)).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    expect(await provider.linkSummary(ORG_A, UNKNOWN_ID)).toBeNull();
  });

  it("never returns another tenant's row: wrong org gives null, each org sees only its own", async () => {
    expect(await provider.linkSummary(ORG_A, ids.b)).toBeNull();
    expect(await provider.linkSummary(ORG_B, ids.a)).toBeNull();
    expect((await provider.linkSummary(ORG_B, ids.b))?.patientId).toBe(PATIENT_B);
  });

  it("returns exactly the four contract keys and none of the seeded sensitive columns", async () => {
    const got = await provider.linkSummary(ORG_A, ids.a);
    expect(Object.keys(got ?? {}).sort()).toEqual(["id", "occurredAt", "patientId", "status"]);
    const json = JSON.stringify(got);
    expect(json).not.toContain("SENTINEL");
    expect(json).not.toContain(SENSITIVE_DRUG);
  });

  it("fails closed on a blank organization or id", async () => {
    await expect(provider.linkSummary("", ids.a)).rejects.toThrow();
    await expect(provider.linkSummary(ORG_A, "")).rejects.toThrow();
  });
});
