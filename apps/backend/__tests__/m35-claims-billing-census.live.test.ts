/**
 * ADR-0110 D8 — LIVE Postgres proof of the claims-billing census pull: M5's `PatientCensusReader` paged into M35's
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
import { registerSeam } from "../src/bootstrap/seams/registry";
import { buildPatientCensusReader } from "../src/modules/05-patient/census-reader";
import { buildDrizzleAddonService } from "../src/modules/35-subscription/addon/addon-service";
import {
  CENSUS_AUDIT_EVENT,
  activePeriodKeyFor,
  aggregateAddonForOrg,
  createDrizzlePatientCounterProvider,
  runPatientCensusForOrg,
} from "../src/modules/35-subscription/billing-runtime/census";
import { runM35Fanout } from "../src/modules/35-subscription/billing-runtime/jobs";
import { buildM35PatientActivePeriodConsumer } from "../src/modules/35-subscription/outbox-consumers/m5-patient-active-period";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

const ORG_A = "a1000000-0000-4000-8000-0000000000a1";
const ORG_B = "b2000000-0000-4000-8000-0000000000b2";
const ORG_C = "c3000000-0000-4000-8000-0000000000c3"; // no add-on
const ORG_D = "d4000000-0000-4000-8000-0000000000d4"; // add-on canceled this window
const NOW = new Date();
const D_ENDED_AT = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 2));
const KEY = { keyEpoch: "epoch-20261101T0000Z-test", keyMaterial: "live-suite-only-key-material" };
const keyProvider = { activeKey: async () => KEY };

describe.skipIf(!DB_URL)("ADR-0110 claims-billing census — LIVE Postgres", () => {
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
      [ORG_D, "census-d"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
      const [sub] = await q<{ id: string }>(
        "INSERT INTO subscription (organization_id, plan_id, status) VALUES ($1,$2,'active') RETURNING id",
        [org, plan?.id],
      );
      if (org === ORG_D) {
        await admin.query(
          `INSERT INTO subscription_addon (organization_id, subscription_id, addon_id, status, grant_reason,
             started_at, canceled_at, ends_at)
           VALUES ($1,$2,$3,'canceled','live suite',$4,$5,$5)`,
          [org, sub?.id, addon?.id, new Date(D_ENDED_AT.getTime() - 86_400_000), D_ENDED_AT],
        );
      } else if (org !== ORG_C) {
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
    patients[ORG_D] = [await addPatient(ORG_D, "D-1", "active")];

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

  const censusAudit = (org: string) =>
    q<{
      outcome: string;
      actor_kind: string;
      resource_id: string;
      context: Record<string, unknown>;
    }>(
      `SELECT outcome::text AS outcome, actor_kind::text AS actor_kind, resource_id::text AS resource_id, context
         FROM audit_event WHERE organization_id = $1 AND event_type = $2 ORDER BY created_at`,
      [org, CENSUS_AUDIT_EVENT],
    );

  it("the bulk read leaves ONE audit event per org per pass: org, period and counts, never an id or a pseudonym", async () => {
    // The two passes of the first test: one event each, the rerun's inserted count being 0.
    const events = await censusAudit(ORG_A);
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.outcome, e.actor_kind])).toEqual([
      ["success", "system"],
      ["success", "system"],
    ]);
    expect(events.map((e) => [e.context.seen, e.context.inserted])).toEqual([
      [3, 3],
      [3, 0],
    ]);
    expect(events[0]?.context.periodYearMonth).toBe(activePeriodKeyFor(null, new Date()));
    // Nothing that identifies a patient is in the audit row: no patient id and no stored pseudonym.
    const pseudonyms = (
      await q<{ patient_pseudonym: string }>(
        "SELECT patient_pseudonym FROM patient_active_period WHERE organization_id=$1",
        [ORG_A],
      )
    ).map((r) => r.patient_pseudonym);
    const written = JSON.stringify(events);
    for (const needle of [...(patients[ORG_A] ?? []), ...pseudonyms]) {
      expect(written).not.toContain(needle);
    }
    // Another org's pass is its own event, under its own org; an org with no add-on is never read, so it records nothing.
    expect(await censusAudit(ORG_B)).toHaveLength(0);
  });

  it("a pass that fails records a failure event (a pass was attempted) and still throws the original error", async () => {
    const failing = {
      ...deps(),
      census: {
        activePatientIdsPage: async () => {
          throw new Error("census read failed");
        },
        activePatientCount: async () => 0,
      },
    };
    await expect(runPatientCensusForOrg(failing, ORG_A)).rejects.toThrow("census read failed");
    const events = await censusAudit(ORG_A);
    expect(events.at(-1)).toMatchObject({ outcome: "failure", actor_kind: "system" });
    expect(events.at(-1)?.context.seen).toBeUndefined();
  });

  it("a failure BEFORE any id is read (a missing pseudonym key) also records that a pass was attempted", async () => {
    const before = (await censusAudit(ORG_A)).length;
    const noKey = {
      ...deps(),
      keyProvider: {
        activeKey: async () => {
          throw new Error("the pseudonym KEK is not configured");
        },
      },
    };
    await expect(runPatientCensusForOrg(noKey, ORG_A)).rejects.toThrow("pseudonym KEK");
    const events = await censusAudit(ORG_A);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({ outcome: "failure", actor_kind: "system" });
  });

  // A trigger that refuses ONE org's census audit insert, so the audit write fails while the census itself works.
  const blockCensusAudit = async (org: string) => {
    await admin.query(
      `CREATE OR REPLACE FUNCTION test_block_census_audit() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'census audit blocked for the test'; END $$`,
    );
    await admin.query(
      `CREATE TRIGGER test_block_census_audit BEFORE INSERT ON audit_event FOR EACH ROW
         WHEN (NEW.event_type = '${CENSUS_AUDIT_EVENT}' AND NEW.organization_id = '${org}')
         EXECUTE FUNCTION test_block_census_audit()`,
    );
    return async () => {
      await admin.query("DROP TRIGGER test_block_census_audit ON audit_event");
      await admin.query("DROP FUNCTION test_block_census_audit()");
    };
  };

  it("a failed audit write on the success path surfaces as a failure, after the drift check, and never touches another org", async () => {
    const unblock = await blockCensusAudit(ORG_A);
    try {
      const logs: Array<{ message: string; detail: Record<string, unknown> }> = [];
      const log = (message: string, detail: Record<string, unknown>) =>
        logs.push({ message, detail });
      // M5's own count disagrees with the 3 ids seen: the drift check has something to report even though the audit fails.
      const drifting = {
        ...deps(),
        log,
        census: { ...buildPatientCensusReader(app.db), activePatientCount: async () => 99 },
      };
      const auditedBefore = (await censusAudit(ORG_B)).length;
      let fanoutError: unknown;
      try {
        await runM35Fanout(
          { listOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }], log },
          (org) =>
            runPatientCensusForOrg(org === ORG_A ? drifting : { ...deps(), log }, org).then(
              () => undefined,
            ),
          "patient_census",
        );
      } catch (err) {
        fanoutError = err;
      }
      // Exactly one org failed (A, the unaudited one); the fan-out still finished B.
      expect(fanoutError).toBeInstanceOf(AggregateError);
      expect((fanoutError as AggregateError).errors).toHaveLength(1);
      // Drizzle wraps the database error: the block's message is its cause.
      const thrown = (fanoutError as AggregateError).errors[0] as { cause?: { message?: string } };
      expect(thrown.cause?.message).toMatch(/census audit blocked/);
      expect((await censusAudit(ORG_B)).length).toBe(auditedBefore + 1);
      // The audit failure was logged under `err` (redacted by the logger), and the drift check still ran.
      expect(
        logs.find((l) => l.message === "m35.patient-census audit failed")?.detail,
      ).toMatchObject({
        organizationId: ORG_A,
      });
      expect(
        logs.find((l) => l.message === "m35.patient-census audit failed")?.detail.err,
      ).toBeInstanceOf(Error);
      expect(logs.some((l) => l.message === "m35.patient-census reconcile drift")).toBe(true);
    } finally {
      await unblock();
    }
  });

  it("a failed audit write on the FAILURE path never hides the original error", async () => {
    const unblock = await blockCensusAudit(ORG_A);
    try {
      const logs: Array<{ message: string; detail: Record<string, unknown> }> = [];
      const failing = {
        ...deps(),
        log: (message: string, detail: Record<string, unknown>) => logs.push({ message, detail }),
        census: {
          activePatientIdsPage: async () => {
            throw new Error("census read failed");
          },
          activePatientCount: async () => 0,
        },
      };
      await expect(runPatientCensusForOrg(failing, ORG_A)).rejects.toThrow("census read failed");
      expect(logs.map((l) => l.message)).toEqual(["m35.patient-census audit failed"]);
    } finally {
      await unblock();
    }
  });

  it("skips an org that never held the add-on", async () => {
    expect(await runPatientCensusForOrg(deps(), ORG_C)).toEqual({ counted: false });
    expect(
      await q("SELECT 1 FROM patient_active_period WHERE organization_id=$1", [ORG_C]),
    ).toHaveLength(0);
    expect(await censusAudit(ORG_C)).toHaveLength(0);
  });

  it("after a cancel, counts one final pass just after the end, then stops (no patients first seen later)", async () => {
    const at = (ms: number) => ({ ...deps(), now: () => new Date(D_ENDED_AT.getTime() + ms) });
    const hour = 3_600_000;
    expect(await runPatientCensusForOrg(at(hour), ORG_D)).toMatchObject({ counted: true, seen: 1 });
    // A patient admitted after the add-on ended is never counted by a later sweep in the same window.
    await addPatient(ORG_D, "D-2", "active");
    expect(await runPatientCensusForOrg(at(7 * hour), ORG_D)).toEqual({ counted: false });
    expect(
      await q("SELECT 1 FROM patient_active_period WHERE organization_id=$1", [ORG_D]),
    ).toHaveLength(1);
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

  it("under a mirrored non-calendar window, a death before the window starts lands on the earlier window", async () => {
    await admin.query(
      `UPDATE subscription SET current_period_start='2026-03-15T00:00:00Z', current_period_end='2026-04-15T00:00:00Z'
        WHERE organization_id=$1`,
      [ORG_C],
    );
    const consumer = buildM35PatientActivePeriodConsumer({ db: app.db, keyProvider });
    await consumer.handle({
      eventType: "m5.patient.deceased",
      organizationId: ORG_C,
      payload: { patientId: patients[ORG_C]?.[0], deceasedDate: "2026-03-10" },
    });
    const rows = await q<{ period_year_month: string }>(
      "SELECT period_year_month FROM patient_active_period WHERE organization_id=$1",
      [ORG_C],
    );
    // [Feb 15, Mar 15) is keyed 2026-02; 2026-03 is the CURRENT window [Mar 15, Apr 15), where the patient was not alive.
    expect(rows).toEqual([{ period_year_month: "2026-02" }]);
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

    // ADR-0053 amendment 2026-11-06: `entitled` / `reason` are the GATE's decision (M23, from the org's clearinghouse choice),
    // read through its seam; the add-on row only informs `status` and the census count. A stub stands in for M23 here:
    // org A chose a live clearinghouse, orgs B and C did not (B holds an ACTIVE add-on and is still refused: no coupling).
    registerSeam("ClaimsBillingEntitlementReader", {
      entitlementForOrg: async (org) =>
        org === ORG_A
          ? { entitled: true }
          : { entitled: false, reason: "clearinghouse_outside" as const },
    });
    const addons = buildDrizzleAddonService(app.db);
    expect(await addons.claimsBillingForOrg(ORG_A)).toMatchObject({
      entitled: true,
      status: "active",
      activePatientCount: 3,
    });
    expect(await addons.claimsBillingForOrg(ORG_B)).toMatchObject({
      entitled: false,
      reason: "clearinghouse_outside",
      status: "active",
    });
    expect(await addons.claimsBillingForOrg(ORG_C)).toMatchObject({
      entitled: false,
      reason: "clearinghouse_outside",
      status: "none",
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

  it("finalizes the previous CALENDAR month (Feb from March, Apr from May), never a duration-shifted window", async () => {
    for (const [ym, pseudo] of [
      ["2026-02", "f".repeat(32)],
      ["2026-04", "e".repeat(32)],
    ] as const) {
      await admin.query(
        `INSERT INTO patient_active_period (organization_id, patient_pseudonym, pseudonym_key_epoch,
           period_year_month, was_active) VALUES ($1,$2,$3,$4,true)`,
        [ORG_B, pseudo, KEY.keyEpoch, ym],
      );
    }
    const at = (iso: string) => ({ db: app.db, now: () => new Date(iso) });
    await aggregateAddonForOrg(at("2026-03-10T12:00:00Z"), ORG_B);
    await aggregateAddonForOrg(at("2026-05-10T12:00:00Z"), ORG_B);
    const rows = await q<{ s: string; e: string; total_quantity: string }>(
      `SELECT to_char(period_start AT TIME ZONE 'UTC','YYYY-MM-DD') s,
              to_char(period_end AT TIME ZONE 'UTC','YYYY-MM-DD') e, total_quantity
         FROM usage_period_aggregate
        WHERE organization_id=$1 AND event_type='billing_addon_patient' ORDER BY period_start`,
      [ORG_B],
    );
    expect(rows).toEqual([
      { s: "2026-02-01", e: "2026-03-01", total_quantity: "1" },
      { s: "2026-04-01", e: "2026-05-01", total_quantity: "1" },
    ]);
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
