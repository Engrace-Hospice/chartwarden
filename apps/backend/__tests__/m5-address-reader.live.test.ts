/**
 * F-229 (#248) — LIVE Postgres proof of M5's `PatientAddressReader.primaryAddress` (the full-street-address
 * read `m21 <- m11.order.supply_fulfillment_requested` needs and no published seam answered).
 *
 * Runs as the real NOBYPASSRLS `wardenx_app` role:
 *   - returns the current PRIMARY address in full, and only that row (history, non-primary and mailing
 *     rows never leak in);
 *   - null when the patient has no current primary address;
 *   - cross-tenant: org B asking for org A's patient gets null (RLS + the explicit organization_id
 *     predicate — a second wall), and the other tenant's own data still resolves.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m5:address-reader:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPatientAddressReader } from "../src/modules/05-patient/address-reader";
import { countActivePatientsWithoutGeocode } from "../src/modules/05-patient/geocode-coverage";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("F-229 — M5 PatientAddressReader.primaryAddress — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function seedPatient(organizationId: string): Promise<string> {
    const row = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1, $2, 'Test', 'Patient', '1950-01-01', 'female') RETURNING id`,
      [organizationId, `MRN-${Math.random().toString(36).slice(2, 10)}`],
    );
    return row.rows[0].id as string;
  }

  async function seedAddress(
    organizationId: string,
    patientId: string,
    a: {
      line1: string;
      kind?: string;
      primary?: boolean;
      from?: string;
      to?: string | null;
      line2?: string | null;
    },
  ): Promise<void> {
    await admin.query(
      `INSERT INTO patient_address
         (patient_id, organization_id, kind, line1, line2, city, state, postal_code, is_primary,
          effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,'Portland','OR','97000',$6,$7,$8)`,
      [
        patientId,
        organizationId,
        a.kind ?? "home",
        a.line1,
        a.line2 ?? null,
        a.primary ?? true,
        a.from ?? "2026-01-01",
        a.to ?? null,
      ],
    );
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'m5-addr-a','M5 ADDR A','M5 ADDR A'), ($2,'m5-addr-b','M5 ADDR B','M5 ADDR B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("returns the current PRIMARY address in full", async () => {
    const pid = await seedPatient(ORG_A);
    await seedAddress(ORG_A, pid, { line1: "1 Current St", line2: "Apt 4" });
    const a = await buildPatientAddressReader(handle.db).primaryAddress(ORG_A, pid);
    expect(a).toMatchObject({
      kind: "home",
      line1: "1 Current St",
      line2: "Apt 4",
      city: "Portland",
      state: "OR",
      postalCode: "97000",
      country: "US",
      facilityId: null,
    });
  });

  it("ignores history, non-primary and closed rows — only the current primary resolves", async () => {
    const pid = await seedPatient(ORG_A);
    await seedAddress(ORG_A, pid, { line1: "9 Old St", from: "2020-01-01", to: "2025-12-31" });
    await seedAddress(ORG_A, pid, { line1: "2 Now St", from: "2026-01-01" });
    // Seeded AFTER the primary row, same effective_from: a non-primary row must still never win.
    await seedAddress(ORG_A, pid, {
      line1: "8 Mailing St",
      kind: "mailing",
      primary: false,
      from: "2026-02-01",
    });
    const a = await buildPatientAddressReader(handle.db).primaryAddress(ORG_A, pid);
    expect(a?.line1).toBe("2 Now St");
  });

  it("is null when the patient has no current primary address", async () => {
    const none = await seedPatient(ORG_A);
    expect(await buildPatientAddressReader(handle.db).primaryAddress(ORG_A, none)).toBeNull();
    const closedOnly = await seedPatient(ORG_A);
    await seedAddress(ORG_A, closedOnly, {
      line1: "3 Closed St",
      from: "2020-01-01",
      to: "2021-01-01",
    });
    expect(await buildPatientAddressReader(handle.db).primaryAddress(ORG_A, closedOnly)).toBeNull();
  });

  it("is tenant-isolated: org B cannot read org A's patient address; org B's own still resolves", async () => {
    const pa = await seedPatient(ORG_A);
    await seedAddress(ORG_A, pa, { line1: "4 A Only St" });
    const pb = await seedPatient(ORG_B);
    await seedAddress(ORG_B, pb, { line1: "5 B Only St" });
    const reader = buildPatientAddressReader(handle.db);
    expect(await reader.primaryAddress(ORG_B, pa)).toBeNull();
    expect(await reader.primaryAddress(ORG_A, pb)).toBeNull();
    expect((await reader.primaryAddress(ORG_B, pb))?.line1).toBe("5 B Only St");
  });

  // GAP-054 rollout signal — counts active patients with no geocoded current primary address. Delta-based so the
  // earlier cases' seed rows (prospective patients) cannot disturb it.
  it("counts only ACTIVE patients lacking a geocoded current primary address, tenant-scoped", async () => {
    const before = await countActivePatientsWithoutGeocode(handle.db, ORG_A);
    const activate = (id: string) =>
      admin.query("UPDATE patient SET status = 'active' WHERE id = $1", [id]);
    const geocode = (id: string) =>
      admin.query(
        "UPDATE patient_address SET geocode_lat = 45.523000, geocode_lng = -122.678900 WHERE patient_id = $1",
        [id],
      );
    const noAddress = await seedPatient(ORG_A);
    const ungeocoded = await seedPatient(ORG_A);
    await seedAddress(ORG_A, ungeocoded, { line1: "6 Ungeocoded St" });
    const geocoded = await seedPatient(ORG_A);
    await seedAddress(ORG_A, geocoded, { line1: "7 Geocoded St" });
    await geocode(geocoded);
    const prospective = await seedPatient(ORG_A);
    await seedAddress(ORG_A, prospective, { line1: "8 Prospective St" });
    for (const id of [noAddress, ungeocoded, geocoded]) await activate(id);

    const after = await countActivePatientsWithoutGeocode(handle.db, ORG_A);
    expect(after.activePatients - before.activePatients).toBe(3);
    expect(after.ungeocoded - before.ungeocoded).toBe(2); // no-address + ungeocoded; geocoded and prospective excluded

    const otherOrg = await countActivePatientsWithoutGeocode(handle.db, ORG_B);
    expect(otherOrg.activePatients).toBe(0);
  });
});
