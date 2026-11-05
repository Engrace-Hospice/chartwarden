/**
 * ADR-0108 D8 — LIVE Postgres proof of the claims-billing census pull: M5's `PatientCensusReader` paged into M35's
 * `patient_active_period` as HMAC pseudonyms, and the real `PatientCounterProvider` over it.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m35:claims-billing-census:live
 *
 * Everything below runs as the NOBYPASSRLS `chartwarden_app` role. Proves: only `active` patients are counted
 * (discharged / prospective excluded), only orgs holding the add-on are swept, a rerun inserts nothing, no raw
 * patient id reaches the table, two orgs never see each other's census, the deceased consumer lands on the same
 * period key, and a census that disagrees with M5's own count is reported.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPatientCensusReader } from "../src/modules/05-patient/census-reader";
import { buildDrizzleAddonService } from "../src/modules/35-subscription/addon/addon-service";
import {
  activePeriodKeyFor,
  aggregateAddonForOrg,
  createDrizzlePatientCounterProvider,
  runPatientCensusForOrg,
} from "../src/modules/35-subscription/billing-runtime/census";
import { buildM35PatientActivePeriodConsumer } from "../src/modules/35-subscription/outbox-consumers/m5-patient-active-period";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

const ORG_A = "a1000000-0000-4000-8000-0000000000a1";
const ORG_B = "b2000000-0000-4000-8000-0000000000b2";
const ORG_C = "c3000000-0000-4000-8000-0000000000c3"; // no add-on
const KEY = { keyEpoch: "epoch-20261101T0000Z-test", keyMaterial: "live-suite-only-key-material" };
const keyProvider = { activeKey: async () => KEY };

describe.skipIf(!DB_URL)("ADR-0108 claims-billing census — LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  const patients: Record<string, string[]> = {};

  async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    return (await admin.query(text, params)).rows as T[];
  }
  async function addPatient(org: string, mrn: string, status: string): Promise<string> {
    const [row] = await q<{ id: string }>(
      `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
       VALUES ($1,$2,'Test','Patient','1950-01-01','F',$3) RETURNING id`,
      [org, mrn, status],
    );
    return row?.id ?? "";
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    const [plan] = await q<{ id: string }>(
      `INSERT INTO plan (slug,name,tier,cadence,base_price_cents,is_active)
       VALUES ('starter-monthly','Starter','starter','monthly',29900,true) RETURNING id`,
    );
    const [addon] = await q<{ id: string }>("SELECT id FROM addon WHERE slug='claims_billing'");
    for (const [org, slug] of [
      [ORG_A, "census-a"],
      [ORG_B, "census-b"],
      [ORG_C, "census-c"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
      const [sub] = await q<{ id: string }>(
        "INSERT INTO subscription (organization_id, plan_id, status) VALUES ($1,$2,'active') RETURNING id",
        [org, plan?.id],
      );
      if (org !== ORG_C) {
        await admin.query(
          `INSERT INTO subscription_addon (organization_id, subscription_id, addon_id, status, grant_reason)
           VALUES ($1,$2,$3,'active','live suite')`,
          [org, sub?.id, addon?.id],
        );
      }
    }
    patients[ORG_A] = [
      await addPatient(ORG_A, "A-1", "active"),
      await addPatient(ORG_A, "A-2", "active"),
      await addPatient(ORG_A, "A-3", "active"),
    ];
    await addPatient(ORG_A, "A-4", "discharged");
    await addPatient(ORG_A, "A-5", "prospective");
    patients[ORG_B] = [
      await addPatient(ORG_B, "B-1", "active"),
      await addPatient(ORG_B, "B-2", "active"),
    ];
    patients[ORG_C] = [await addPatient(ORG_C, "C-1", "active")];

    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  const deps = () => ({
    db: app.db,
    census: buildPatientCensusReader(app.db),
    keyProvider,
    pageSize: 2, // forces paging over org A's three active patients
  });

  it("counts only active patients of an add-on org, as pseudonyms, and a rerun inserts nothing", async () => {
    const first = await runPatientCensusForOrg(deps(), ORG_A);
    expect(first).toMatchObject({ counted: true, seen: 3, inserted: 3 });
    const rerun = await runPatientCensusForOrg(deps(), ORG_A);
    expect(rerun).toMatchObject({ counted: true, seen: 3, inserted: 0 });

    const rows = await q<{ patient_pseudonym: string; period_year_month: string }>(
      "SELECT patient_pseudonym, period_year_month FROM patient_active_period WHERE organization_id=$1",
      [ORG_A],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.patient_pseudonym).toMatch(/^[a-f0-9]{32}$/);
      expect(patients[ORG_A]).not.toContain(r.patient_pseudonym);
      expect(r.period_year_month).toBe(activePeriodKeyFor(null, new Date()));
    }
    // No raw patient id anywhere in the table.
    const raw = await q(
      "SELECT 1 FROM patient_active_period WHERE patient_pseudonym = ANY($1::text[])",
      [patients[ORG_A]],
    );
    expect(raw).toHaveLength(0);
  });

  it("skips an org that never held the add-on", async () => {
    expect(await runPatientCensusForOrg(deps(), ORG_C)).toEqual({ counted: false });
    expect(
      await q("SELECT 1 FROM patient_active_period WHERE organization_id=$1", [ORG_C]),
    ).toHaveLength(0);
  });

  it("the PatientCounterProvider counts per org under RLS (two-org fixture)", async () => {
    await runPatientCensusForOrg(deps(), ORG_B);
    const counter = createDrizzlePatientCounterProvider(app.db);
    const now = new Date();
    const args = (organizationId: string) => ({
      organizationId,
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      periodEnd: now.toISOString(),
    });
    expect(await counter.activePatientCountForPeriod(args(ORG_A))).toBe(3);
    expect(await counter.activePatientCountForPeriod(args(ORG_B))).toBe(2);
    expect(await counter.activePatientCountForPeriod(args(ORG_C))).toBe(0);
  });

  it("the deceased consumer stamps the same period key the census used", async () => {
    const consumer = buildM35PatientActivePeriodConsumer({ db: app.db, keyProvider });
    const today = new Date().toISOString().slice(0, 10);
    await consumer.handle({
      eventType: "m5.patient.deceased",
      organizationId: ORG_A,
      payload: { patientId: patients[ORG_A]?.[0], deceasedDate: today },
    });
    const rows = await q<{ inactivity_reason: string | null }>(
      "SELECT inactivity_reason FROM patient_active_period WHERE organization_id=$1 ORDER BY inactivity_reason NULLS LAST",
      [ORG_A],
    );
    // Still three rows: the death landed on the census row of the same period, not a fourth.
    expect(rows).toHaveLength(3);
    expect(rows[0]?.inactivity_reason).toBe("died");
  });

  it("aggregates the month's add-on count as billing_addon_patient, idempotently, and shows it", async () => {
    expect(await aggregateAddonForOrg({ db: app.db }, ORG_A)).toBe(1);
    expect(await aggregateAddonForOrg({ db: app.db }, ORG_A)).toBe(1); // recomputes the open window, no duplicate
    expect(await aggregateAddonForOrg({ db: app.db }, ORG_C)).toBe(0); // never held the add-on
    const rows = await q<{
      total_quantity: string;
      inclusive_quantity: string;
      overage_quantity: string;
    }>(
      `SELECT total_quantity, inclusive_quantity, overage_quantity FROM usage_period_aggregate
        WHERE organization_id=$1 AND event_type='billing_addon_patient'`,
      [ORG_A],
    );
    expect(rows).toEqual([{ total_quantity: "3", inclusive_quantity: "0", overage_quantity: "3" }]);

    const addons = buildDrizzleAddonService(app.db);
    expect(await addons.claimsBillingForOrg(ORG_A)).toMatchObject({
      entitled: true,
      status: "active",
      activePatientCount: 3,
    });
    expect(await addons.claimsBillingForOrg(ORG_C)).toMatchObject({
      entitled: false,
      reason: "never_purchased",
      activePatientCount: null,
    });
    const platform = createDbClient({ connectionString: DB_URL as string });
    try {
      const usage = await buildDrizzleAddonService(app.db, {
        platformRunner: (fn) => platform.db.transaction((tx) => fn(tx as never)),
      }).adminAddonUsage(ORG_A);
      expect(usage).toMatchObject({
        addonSlug: "claims_billing",
        activePatientCount: 3,
        unitPriceCents: null,
      });
      expect(usage?.computedAt).not.toBeNull();
    } finally {
      await platform.close();
    }
  });

  it("reports a census that disagrees with M5's own count by more than 1%", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const reader = buildPatientCensusReader(app.db);
    await runPatientCensusForOrg(
      {
        ...deps(),
        census: { ...reader, activePatientCount: async () => 10 },
        log: (_m, detail) => logs.push(detail),
      },
      ORG_A,
    );
    expect(logs).toEqual([
      expect.objectContaining({
        metric: "m35_patient_census_reconcile_drift",
        organizationId: ORG_A,
        m35Seen: 3,
        m5Count: 10,
      }),
    ]);
  });
});
