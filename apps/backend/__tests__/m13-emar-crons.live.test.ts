/**
 * GAP-038 / GAP-039 / GAP-040 — LIVE Postgres proof of M13's §4.8 crons: `extend-schedule`,
 * `missed-dose-sweep`, `reconciliation-due-warning`, `kit-return-overdue`, `prn-reassessment-overdue`,
 * `purge-offline-queue` (GAP-038 follow-up).
 *
 * THE FINDINGS. Scheduled doses were materialized once for 7 days and never extended (038); nothing wrote
 * `missed_dose`, so M30's `missed_dose_rate` was a real denominator over a numerator that could never move
 * (039); and no module produced a PRN reassessment-overdue signal (040). The deadline crons the M13 spec
 * lists beside them did not exist either.
 *
 * WHY LIVE. The proof is a statement about Postgres: the `FOR UPDATE SKIP LOCKED` claim, the
 * `sched_dose_order_due_uk` / `missed_dose_scheduled_dose_uk` unique indexes that make a re-tick a no-op, the
 * `NOT EXISTS` over the PARTITIONED `administration_record`, and the cross-tenant wall — all on the real
 * NOBYPASSRLS `wardenx_app` role. Events go through the REAL catalog-validating outbox publisher (an
 * undeclared event or a payload that fails its TypeBox schema throws), not `NOOP_OUTBOX`.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m13:emar-crons:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { medicationOrderScheduleContextForOrg } from "../src/modules/12-dosespot/seams/drizzle-store";
import {
  M13_OUTBOX_EVENTS,
  MISSED_DOSE_SWEEP_LOOKBACK_HOURS,
  buildM13CronRunners,
  createDrizzleEmarSeamStore,
} from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "13111111-1111-4111-8111-1111a0380001";
const ORG_B = "13222222-2222-4222-8222-2222b0380002";
const PATIENT_A = "13aaaaaa-1111-4111-8111-0000000000a1";
const PATIENT_A2 = "13aaaaaa-1111-4111-8111-0000000000a2";
const PATIENT_B = "13bbbbbb-1111-4111-8111-0000000000b1";
const ADMISSION_A = "13aaaaaa-0000-4000-8000-0000000000a1";
const ADMISSION_B = "13bbbbbb-0000-4000-8000-0000000000b1";
const PHYSICIAN_MDM_ID = "99999999-0000-4000-8000-000000000013";

/** Thursday 2026-09-10 08:00 America/Los_Angeles (PDT, UTC-7). */
const NOW = new Date("2026-09-10T15:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

type Site = { provider: string; location: string; member: string };

describe.skipIf(!DB_URL)("GAP-038/039/040 — M13 eMAR crons — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const site: Record<string, Site> = {};
  let clock = NOW;
  let orgs: { organizationId: string }[] = [{ organizationId: ORG_A }, { organizationId: ORG_B }];
  /** Patients whose PRN reassessment was "captured" (stands in for M9's ScaleSeriesProvider). */
  let reassessedPatients = new Set<string>();
  let runners: ReturnType<typeof buildM13CronRunners>;

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedOrder(o: {
    id: string;
    org: string;
    patient: string;
    admission: string;
    status: string;
    activatedAt: string;
    controlled?: boolean;
    frequencyCode?: string;
  }) {
    await admin.query(
      `INSERT INTO medication_order
         (id, organization_id, patient_id, admission_id, med_class, is_controlled_substance,
          drug_name, strength, dose_form, route, data, prescriber_membership_id,
          prescribing_physician_mdm_id, status, activated_at, dea_schedule)
       VALUES ($1,$2,$3,$4,$5,$6,'Test Drug','5 mg','tablet','oral',$7,$8,$9,$10,$11,$12)`,
      [
        o.id,
        o.org,
        o.patient,
        o.admission,
        o.controlled ? "controlled_substance" : "standard",
        o.controlled ?? false,
        JSON.stringify({
          sigStructured: {
            doseQuantity: 1,
            doseUnit: "tab",
            route: "oral",
            frequencyCode: o.frequencyCode ?? "bid",
            asNeeded: false,
          },
        }),
        site[o.org]?.member,
        PHYSICIAN_MDM_ID,
        o.status,
        o.activatedAt,
        o.controlled ? "II" : null, // CHECK: is_controlled_substance <=> dea_schedule IS NOT NULL
      ],
    );
  }

  async function seedDose(d: {
    org: string;
    patient: string;
    admission: string;
    order: string;
    dueAt: string;
    status?: string;
    grace?: number;
    seq?: number;
    cancellationReason?: string;
  }): Promise<string> {
    const s = site[d.org] as Site;
    const { rows } = await admin.query(
      `INSERT INTO scheduled_dose
         (organization_id, provider_entity_id, location_id, patient_id, admission_id, medication_order_id,
          due_at, grace_window_minutes, expected_dose_amount, expected_dose_unit, expected_route,
          status, cancellation_reason, materialization_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'tab','oral',$9,$10,$11) RETURNING id`,
      [
        d.org,
        s.provider,
        s.location,
        d.patient,
        d.admission,
        d.order,
        d.dueAt,
        d.grace ?? 60,
        d.status ?? "pending",
        d.cancellationReason ?? null,
        d.seq ?? 1,
      ],
    );
    return rows[0].id as string;
  }

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await admin.query(sql, params);
    return Object.values(rows[0] ?? {})[0] as T;
  }

  const events = async (org: string, type: string) =>
    (
      await admin.query(
        "SELECT aggregate_id, payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at",
        [org, type],
      )
    ).rows as { aggregate_id: string; payload: Record<string, unknown> }[];

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
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'m13c-a','A','A','active'),($2,'m13c-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m13c-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const provider = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-M13C-${org.slice(0, 4)}`,
            `M13C ${org.slice(0, 4)}`,
            `NPI-M13C-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [provider],
        )
      ).rows[0].id as string;
      site[org] = { provider, location, member };
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M13_OUTBOX_EVENTS]));
    runners = buildM13CronRunners({
      connection: { host: "unused", port: 0 }, // never used — the suite drives the runners, not BullMQ
      db: handle.db,
      outbox: {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m13" }),
      },
      activeOrgs: { listActiveOrgs: async () => orgs },
      orderContext: (organizationId, orderId) =>
        medicationOrderScheduleContextForOrg(handle.db, organizationId, orderId),
      locationTimezone: (organizationId, locationId) =>
        withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
          buildFoundationSiteReader().locationTimezone(tx as unknown as DbClient, locationId),
        ),
      reassessmentCaptured: async (_org, patientId) => reassessedPatients.has(patientId),
      now: () => clock,
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    for (const t of [
      "outbox_event",
      "administration_offline_queue",
      "missed_dose",
      "prn_administration",
      "administration_record",
      "scheduled_dose",
      "comfort_kit_deployment",
      "medication_reconciliation_worksheet",
      "medication_order",
    ]) {
      await admin.query(`DELETE FROM ${t}`);
    }
    clock = NOW;
    orgs = [{ organizationId: ORG_A }, { organizationId: ORG_B }];
    reassessedPatients = new Set();
  });

  describe("GAP-038 extend-schedule", () => {
    it("gives an order activated 8 days ago today's doses, never backfills the past, and is idempotent", async () => {
      const order = "13dddddd-0000-4000-8000-000000000001";
      await seedOrder({
        id: order,
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        status: "active",
        activatedAt: iso(NOW.getTime() - 8 * DAY_MS),
      });
      // The activation pass's 7-day window, now exhausted (every row is in the past).
      for (let d = 8; d >= 2; d -= 1) {
        await seedDose({
          org: ORG_A,
          patient: PATIENT_A,
          admission: ADMISSION_A,
          order,
          dueAt: iso(NOW.getTime() - d * DAY_MS),
          status: "administered",
        });
      }
      const before = await scalar<number>(
        "SELECT count(*)::int FROM scheduled_dose WHERE medication_order_id=$1",
        [order],
      );

      await runners.extendSchedule();

      const rows = (
        await admin.query(
          "SELECT due_at, materialization_sequence AS seq FROM scheduled_dose WHERE medication_order_id=$1 AND due_at > $2 ORDER BY due_at",
          [order, NOW],
        )
      ).rows as { due_at: Date; seq: number }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.due_at.getTime() > NOW.getTime())).toBe(true);
      expect(rows.every((r) => r.seq === 2)).toBe(true);
      // "Today's doses": the 20:00 PDT slot of 2026-09-10 (= 03:00Z on the 11th) is there.
      expect(rows.some((r) => r.due_at.toISOString().startsWith("2026-09-11T03:00"))).toBe(true);
      // Nothing was materialized into the past (it would be swept as missed on the next tick).
      expect(
        await scalar<number>(
          "SELECT count(*)::int FROM scheduled_dose WHERE medication_order_id=$1 AND due_at <= $2 AND materialization_sequence = 2",
          [order, NOW],
        ),
      ).toBe(0);
      const events1 = await events(ORG_A, "m13.scheduled_dose.materialized");
      expect(events1).toHaveLength(1);
      expect(events1[0]?.payload.medicationOrderId).toBe(order);

      // Re-tick the same instant: the unique index absorbs the whole window — no rows, no event.
      const afterFirst = await scalar<number>(
        "SELECT count(*)::int FROM scheduled_dose WHERE medication_order_id=$1",
        [order],
      );
      expect(afterFirst).toBe(before + rows.length);
      await runners.extendSchedule();
      expect(
        await scalar<number>(
          "SELECT count(*)::int FROM scheduled_dose WHERE medication_order_id=$1",
          [order],
        ),
      ).toBe(afterFirst);
      expect(await events(ORG_A, "m13.scheduled_dose.materialized")).toHaveLength(1);
    });

    it("never extends a discontinued order or one the cascade already cut off, and stays inside its tenant", async () => {
      const discontinued = "13dddddd-0000-4000-8000-000000000002";
      const cascaded = "13dddddd-0000-4000-8000-000000000003";
      const orgBOrder = "13dddddd-0000-4000-8000-000000000004";
      await seedOrder({
        id: discontinued,
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        status: "discontinued",
        activatedAt: iso(NOW.getTime() - 8 * DAY_MS),
      });
      await seedOrder({
        id: cascaded,
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        status: "active",
        activatedAt: iso(NOW.getTime() - 8 * DAY_MS),
      });
      await seedOrder({
        id: orgBOrder,
        org: ORG_B,
        patient: PATIENT_B,
        admission: ADMISSION_B,
        status: "active",
        activatedAt: iso(NOW.getTime() - 8 * DAY_MS),
      });
      for (const order of [discontinued, cascaded]) {
        await seedDose({
          org: ORG_A,
          patient: PATIENT_A,
          admission: ADMISSION_A,
          order,
          dueAt: iso(NOW.getTime() - DAY_MS),
          status: "administered",
        });
      }
      await seedDose({
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        order: cascaded,
        dueAt: iso(NOW.getTime() + DAY_MS),
        status: "cancelled",
        cancellationReason: "admission_discharged",
      });
      await seedDose({
        org: ORG_B,
        patient: PATIENT_B,
        admission: ADMISSION_B,
        order: orgBOrder,
        dueAt: iso(NOW.getTime() - DAY_MS),
        status: "administered",
      });

      orgs = [{ organizationId: ORG_A }]; // org B is NOT in this tick's fan-out
      await runners.extendSchedule();

      for (const order of [discontinued, cascaded]) {
        expect(
          await scalar<number>(
            "SELECT count(*)::int FROM scheduled_dose WHERE medication_order_id=$1 AND status='pending'",
            [order],
          ),
        ).toBe(0);
      }
      expect(
        await scalar<number>(
          "SELECT count(*)::int FROM scheduled_dose WHERE medication_order_id=$1 AND status='pending'",
          [orgBOrder],
        ),
      ).toBe(0);
    });
  });

  describe("GAP-039 missed-dose-sweep", () => {
    it("writes exactly one missed_dose + one event per lapsed dose, stays idempotent, and moves M30's numerator", async () => {
      const std = "13dddddd-0000-4000-8000-000000000011";
      const ctl = "13dddddd-0000-4000-8000-000000000012";
      await seedOrder({
        id: std,
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        status: "active",
        activatedAt: iso(NOW.getTime() - DAY_MS),
      });
      await seedOrder({
        id: ctl,
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        status: "active",
        activatedAt: iso(NOW.getTime() - DAY_MS),
        controlled: true,
      });
      const base = { org: ORG_A, patient: PATIENT_A, admission: ADMISSION_A };
      const lapsed = await seedDose({
        ...base,
        order: std,
        dueAt: iso(NOW.getTime() - 2 * HOUR_MS),
        grace: 60,
      });
      const lapsedControlled = await seedDose({
        ...base,
        order: ctl,
        dueAt: iso(NOW.getTime() - 2 * HOUR_MS),
        grace: 30,
      });
      const insideGrace = await seedDose({
        ...base,
        order: std,
        dueAt: iso(NOW.getTime() - 15 * 60_000),
        grace: 60,
      });
      const alreadyGiven = await seedDose({
        ...base,
        order: std,
        dueAt: iso(NOW.getTime() - 3 * HOUR_MS),
        status: "administered",
      });
      const hasRecord = await seedDose({
        ...base,
        order: std,
        dueAt: iso(NOW.getTime() - 4 * HOUR_MS),
      });
      await admin.query(
        `INSERT INTO administration_record (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, medication_order_id, scheduled_dose_id, mode, data, drug_name_snapshot,
           route_snapshot, administered_at, actor_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'single_dose','{}'::jsonb,'Test Drug','oral',$8,'clinician')`,
        [
          ORG_A,
          site[ORG_A]?.provider,
          site[ORG_A]?.location,
          PATIENT_A,
          ADMISSION_A,
          std,
          hasRecord,
          NOW,
        ],
      );
      const beyondLookback = await seedDose({
        ...base,
        order: std,
        dueAt: iso(NOW.getTime() - (MISSED_DOSE_SWEEP_LOOKBACK_HOURS + 1) * HOUR_MS),
      });
      const orgBDose = await seedDose({
        org: ORG_B,
        patient: PATIENT_B,
        admission: ADMISSION_B,
        order: "13dddddd-0000-4000-8000-0000000000bb",
        dueAt: iso(NOW.getTime() - 5 * HOUR_MS),
      });
      orgs = [{ organizationId: ORG_A }];

      await runners.missedDoseSweep();

      const status = async (id: string) =>
        scalar<string>("SELECT status FROM scheduled_dose WHERE id=$1", [id]);
      expect(await status(lapsed)).toBe("missed");
      expect(await status(lapsedControlled)).toBe("missed");
      expect(await status(insideGrace)).toBe("pending");
      expect(await status(alreadyGiven)).toBe("administered");
      expect(await status(beyondLookback)).toBe("pending"); // older than the look-back: left for an explicit backfill
      expect(await status(hasRecord)).toBe("pending"); // a live administration names it — never "missed"
      expect(await status(orgBDose)).toBe("pending"); // other tenant, not in this fan-out

      const missed = (
        await admin.query(
          "SELECT scheduled_dose_id, missed_kind, is_controlled_substance FROM missed_dose WHERE organization_id=$1",
          [ORG_A],
        )
      ).rows as {
        scheduled_dose_id: string;
        missed_kind: string;
        is_controlled_substance: boolean;
      }[];
      expect(missed).toHaveLength(2);
      expect(missed.every((m) => m.missed_kind === "detected_by_sweep")).toBe(true);
      expect(
        missed.find((m) => m.scheduled_dose_id === lapsedControlled)?.is_controlled_substance,
      ).toBe(true);
      expect(missed.find((m) => m.scheduled_dose_id === lapsed)?.is_controlled_substance).toBe(
        false,
      );
      expect(
        await scalar<number>(
          "SELECT count(*)::int FROM scheduled_dose sd JOIN missed_dose md ON md.id = sd.missed_dose_id AND md.scheduled_dose_id = sd.id WHERE sd.organization_id=$1",
          [ORG_A],
        ),
      ).toBe(2);
      const emitted = await events(ORG_A, "m13.scheduled_dose.missed");
      expect(emitted).toHaveLength(2);
      expect(emitted.find((e) => e.aggregate_id === lapsedControlled)?.payload.isControlled).toBe(
        true,
      );

      // Idempotent across ticks: nothing new, no second event.
      await runners.missedDoseSweep();
      expect(
        await scalar<number>("SELECT count(*)::int FROM missed_dose WHERE organization_id=$1", [
          ORG_A,
        ]),
      ).toBe(2);
      expect(await events(ORG_A, "m13.scheduled_dose.missed")).toHaveLength(2);

      // The seam M30 reads: numerator is no longer structurally zero (2 missed of 5 doses due in the window).
      const counts = await createDrizzleEmarSeamStore(handle.db).missedDoseCountsForOrg(ORG_A, {
        from: iso(NOW.getTime() - DAY_MS),
        to: iso(NOW.getTime()),
      });
      expect(counts).toEqual({ numerator: 2, denominator: 5 });

      // The grace boundary: the in-grace dose lapses once the clock passes due + 60min.
      clock = new Date(NOW.getTime() + HOUR_MS);
      await runners.missedDoseSweep();
      expect(await status(insideGrace)).toBe("missed");
      expect(
        await scalar<number>("SELECT count(*)::int FROM missed_dose WHERE organization_id=$1", [
          ORG_A,
        ]),
      ).toBe(3);
    });

    it("keeps the missed_dose trail when a late administration later flips the dose to administered", async () => {
      const order = "13dddddd-0000-4000-8000-000000000013";
      await seedOrder({
        id: order,
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        status: "active",
        activatedAt: iso(NOW.getTime() - DAY_MS),
      });
      const dose = await seedDose({
        org: ORG_A,
        patient: PATIENT_A,
        admission: ADMISSION_A,
        order,
        dueAt: iso(NOW.getTime() - 3 * HOUR_MS),
      });
      orgs = [{ organizationId: ORG_A }];
      await runners.missedDoseSweep();
      // What `recordAdministration` does for a dose named by `scheduledDoseId` (emar-route-service-db.ts).
      await admin.query(
        "UPDATE scheduled_dose SET status='administered', administered_at=$2 WHERE id=$1",
        [dose, NOW],
      );

      await runners.missedDoseSweep();

      expect(
        await scalar<number>("SELECT count(*)::int FROM missed_dose WHERE scheduled_dose_id=$1", [
          dose,
        ]),
      ).toBe(1);
      expect(await scalar<string>("SELECT status FROM scheduled_dose WHERE id=$1", [dose])).toBe(
        "administered",
      );
      expect(await events(ORG_A, "m13.scheduled_dose.missed")).toHaveLength(1);
    });
  });

  describe("GAP-038 reconciliation-due-warning + kit-return-overdue, GAP-040 prn-reassessment-overdue", () => {
    async function seedWorksheet(due: Date): Promise<string> {
      const s = site[ORG_A] as Site;
      return scalar<string>(
        `INSERT INTO medication_reconciliation_worksheet (organization_id, provider_entity_id, location_id,
           patient_id, admission_id, trigger_kind, trigger_outbox_event_id, triggered_at, due_at, status)
         VALUES ($1,$2,$3,$4,$5,'admission', gen_random_uuid(), $6, $7, 'pending') RETURNING id`,
        [
          ORG_A,
          s.provider,
          s.location,
          PATIENT_A,
          ADMISSION_A,
          new Date(due.getTime() - 5 * DAY_MS),
          due,
        ],
      );
    }

    it("announces each reconciliation deadline exactly once and never re-alerts on the next tick", async () => {
      const overdue = await seedWorksheet(new Date("2026-09-10T14:30:00.000Z"));
      const warn = await seedWorksheet(new Date("2026-09-11T14:20:00.000Z")); // inside the 24h lead
      await seedWorksheet(new Date("2026-09-13T14:20:00.000Z")); // neither
      orgs = [{ organizationId: ORG_A }];

      await runners.reconciliationDueWarning();

      const overdueEvents = await events(ORG_A, "m13.reconciliation.overdue");
      const warnEvents = await events(ORG_A, "m13.reconciliation.due_at_warning");
      expect(overdueEvents.map((e) => e.aggregate_id)).toEqual([overdue]);
      expect(warnEvents.map((e) => e.aggregate_id)).toEqual([warn]);
      expect(overdueEvents[0]?.payload).toMatchObject({
        patientId: PATIENT_A,
        triggerKind: "admission",
      });
      expect(warnEvents[0]?.payload).toMatchObject({ hoursRemaining: 24 });

      clock = new Date(NOW.getTime() + HOUR_MS);
      await runners.reconciliationDueWarning();
      expect(await events(ORG_A, "m13.reconciliation.overdue")).toHaveLength(1);
      expect(await events(ORG_A, "m13.reconciliation.due_at_warning")).toHaveLength(1);
    });

    it("catches up a deadline missed by down ticks exactly once, then ignores it; stale (>48h) deadlines stay silent", async () => {
      const missed = await seedWorksheet(new Date("2026-09-10T09:10:00.000Z")); // 6h before NOW, no tick ran
      await seedWorksheet(new Date("2026-09-07T09:10:00.000Z")); // 3 days old: outside the lookback
      orgs = [{ organizationId: ORG_A }];

      await runners.reconciliationDueWarning();
      await runners.reconciliationDueWarning(); // overlapping / repeated tick

      const overdueEvents = await events(ORG_A, "m13.reconciliation.overdue");
      expect(overdueEvents.map((e) => e.aggregate_id)).toEqual([missed]);
      expect(
        await scalar<Date | null>(
          "SELECT deadline_overdue_warned_at FROM medication_reconciliation_worksheet WHERE id=$1",
          [missed],
        ),
      ).not.toBeNull();
    });

    it("isolates tenants (org B's overdue worksheet is untouched by an org A run)", async () => {
      const s = site[ORG_B] as Site;
      const bId = await scalar<string>(
        `INSERT INTO medication_reconciliation_worksheet (organization_id, provider_entity_id, location_id,
           patient_id, admission_id, trigger_kind, trigger_outbox_event_id, triggered_at, due_at, status)
         VALUES ($1,$2,$3,$4,$5,'admission', gen_random_uuid(), $6, $7, 'pending') RETURNING id`,
        [
          ORG_B,
          s.provider,
          s.location,
          PATIENT_B,
          ADMISSION_B,
          new Date("2026-09-05T10:00:00.000Z"),
          new Date("2026-09-10T10:00:00.000Z"),
        ],
      );
      await seedWorksheet(new Date("2026-09-10T11:00:00.000Z"));
      orgs = [{ organizationId: ORG_A }];

      await runners.reconciliationDueWarning();

      expect(await events(ORG_B, "m13.reconciliation.overdue")).toHaveLength(0);
      expect(
        await scalar<Date | null>(
          "SELECT deadline_overdue_warned_at FROM medication_reconciliation_worksheet WHERE id=$1",
          [bId],
        ),
      ).toBeNull();

      orgs = [{ organizationId: ORG_B }];
      await runners.reconciliationDueWarning();
      expect(
        (await events(ORG_B, "m13.reconciliation.overdue")).map((e) => e.aggregate_id),
      ).toEqual([bId]);
      expect(await events(ORG_A, "m13.reconciliation.overdue")).toHaveLength(1);
    });

    it("flags comfort kits unreturned 30 days after return_required_at, with the day count", async () => {
      const s = site[ORG_A] as Site;
      const seed = async (daysAgo: number, status = "return_required") =>
        scalar<string>(
          `INSERT INTO comfort_kit_deployment (organization_id, provider_entity_id, location_id, patient_id,
             admission_id, deployed_at, disposal_status, return_required_at)
           VALUES ($1,$2,$3,$4,$5, $6, $7, $8) RETURNING id`,
          [
            ORG_A,
            s.provider,
            s.location,
            PATIENT_A,
            ADMISSION_A,
            new Date(NOW.getTime() - 60 * DAY_MS),
            status,
            new Date(NOW.getTime() - daysAgo * DAY_MS),
          ],
        );
      const overdue = await seed(35);
      await seed(10); // inside the window
      await seed(40, "returned"); // already back
      orgs = [{ organizationId: ORG_A }];

      await runners.kitReturnOverdue();

      const emitted = await events(ORG_A, "m13.comfort_kit.return_overdue");
      expect(emitted.map((e) => e.aggregate_id)).toEqual([overdue]);
      expect(emitted[0]?.payload).toMatchObject({
        deploymentId: overdue,
        patientId: PATIENT_A,
        daysOverdue: 35,
      });
    });

    it("emits m13.prn_reassessment.overdue only for PRN doses whose reassessment was not captured", async () => {
      const s = site[ORG_A] as Site;
      const seedPrn = async (patient: string, due: Date) =>
        scalar<string>(
          `INSERT INTO prn_administration (organization_id, provider_entity_id, location_id,
             administration_record_id, patient_id, admission_id, medication_order_id, triggering_prn_reason,
             requested_by_kind, reassessment_window_minutes, reassessment_due_at, recommended_reassessment_scale)
           VALUES ($1,$2,$3,gen_random_uuid(),$4,$5,gen_random_uuid(),'pain','clinician_observed',60,$6,'painad')
           RETURNING id`,
          [ORG_A, s.provider, s.location, patient, ADMISSION_A, due],
        );
      const missedReassessment = await seedPrn(PATIENT_A, new Date("2026-09-10T14:50:00.000Z")); // (14:45, 15:00]
      await seedPrn(PATIENT_A2, new Date("2026-09-10T14:55:00.000Z")); // captured
      await seedPrn(PATIENT_A, new Date("2026-09-10T16:30:00.000Z")); // not due yet
      reassessedPatients = new Set([PATIENT_A2]);
      orgs = [{ organizationId: ORG_A }];

      await runners.prnReassessmentOverdue();

      const emitted = await events(ORG_A, "m13.prn_reassessment.overdue");
      expect(emitted.map((e) => e.aggregate_id)).toEqual([missedReassessment]);
      expect(emitted[0]?.payload).toMatchObject({
        patientId: PATIENT_A,
        recommendedReassessmentScale: "painad",
      });
    });

    it("catches up a missed PRN reassessment tick once, stamps captured rows, and never re-alerts", async () => {
      const s = site[ORG_A] as Site;
      const seedPrn = async (org: string, site_: Site, patient: string, due: Date) =>
        scalar<string>(
          `INSERT INTO prn_administration (organization_id, provider_entity_id, location_id,
             administration_record_id, patient_id, admission_id, medication_order_id, triggering_prn_reason,
             requested_by_kind, reassessment_window_minutes, reassessment_due_at, recommended_reassessment_scale)
           VALUES ($1,$2,$3,gen_random_uuid(),$4,$5,gen_random_uuid(),'pain','clinician_observed',60,$6,'painad')
           RETURNING id`,
          [org, site_.provider, site_.location, patient, ADMISSION_A, due],
        );
      const missed = await seedPrn(ORG_A, s, PATIENT_A, new Date("2026-09-10T10:20:00.000Z")); // 4h40m ago
      const captured = await seedPrn(ORG_A, s, PATIENT_A2, new Date("2026-09-10T10:25:00.000Z"));
      await seedPrn(ORG_A, s, PATIENT_A, new Date("2026-09-07T10:20:00.000Z")); // stale: outside lookback
      const otherOrg = await seedPrn(
        ORG_B,
        site[ORG_B] as Site,
        PATIENT_B,
        new Date("2026-09-10T10:20:00.000Z"),
      );
      reassessedPatients = new Set([PATIENT_A2]);
      orgs = [{ organizationId: ORG_A }];

      await runners.prnReassessmentOverdue();
      await runners.prnReassessmentOverdue();
      clock = new Date(NOW.getTime() + 15 * 60_000);
      await runners.prnReassessmentOverdue();

      expect(
        (await events(ORG_A, "m13.prn_reassessment.overdue")).map((e) => e.aggregate_id),
      ).toEqual([missed]);
      expect(await events(ORG_B, "m13.prn_reassessment.overdue")).toHaveLength(0);
      const stamped = async (id: string) =>
        scalar<Date | null>(
          "SELECT reassessment_overdue_warned_at FROM prn_administration WHERE id=$1",
          [id],
        );
      expect(await stamped(captured)).not.toBeNull(); // resolved, not re-evaluated every tick
      expect(await stamped(otherOrg)).toBeNull(); // cross-tenant untouched

      reassessedPatients = new Set();
      orgs = [{ organizationId: ORG_B }];
      await runners.prnReassessmentOverdue();
      expect(
        (await events(ORG_B, "m13.prn_reassessment.overdue")).map((e) => e.aggregate_id),
      ).toEqual([otherOrg]);
    });
  });

  describe("GAP-038 purge-offline-queue", () => {
    const DAY_30 = 30 * DAY_MS;
    async function seedQueueRow(
      org: string,
      status: "pending" | "synced" | "rejected",
      receivedAt: Date,
    ): Promise<string> {
      return scalar<string>(
        `INSERT INTO administration_offline_queue
           (organization_id, device_id, local_id, received_at, sync_status, payload_envelope_digest)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, $3, 'digest') RETURNING id`,
        [org, receivedAt, status],
      );
    }
    const queueIds = async (org: string) =>
      (
        await admin.query(
          "SELECT id FROM administration_offline_queue WHERE organization_id=$1 ORDER BY id",
          [org],
        )
      ).rows.map((r) => r.id as string);

    it("purges only synced rows older than 30 days and NEVER a pending or rejected one at any age", async () => {
      const ancient = new Date(NOW.getTime() - 400 * DAY_MS);
      const oldSynced = await seedQueueRow(
        ORG_A,
        "synced",
        new Date(NOW.getTime() - DAY_30 - HOUR_MS),
      );
      const freshSynced = await seedQueueRow(
        ORG_A,
        "synced",
        new Date(NOW.getTime() - DAY_30 + HOUR_MS),
      );
      const ancientPending = await seedQueueRow(ORG_A, "pending", ancient);
      const ancientRejected = await seedQueueRow(ORG_A, "rejected", ancient);
      orgs = [{ organizationId: ORG_A }];

      await runners.purgeOfflineQueue();

      const left = await queueIds(ORG_A);
      expect(left).not.toContain(oldSynced);
      expect(left).toEqual(expect.arrayContaining([freshSynced, ancientPending, ancientRejected]));
      expect(left).toHaveLength(3);
      // The purge leaves its audit trail through the 0041 write-audit trigger (one DELETE event per row).
      const audited = await scalar<string>(
        "SELECT count(*) FROM audit_event WHERE event_type='administration_offline_queue.delete' AND resource_id=$1",
        [oldSynced],
      );
      expect(Number(audited)).toBe(1);
    });

    it("is idempotent and never crosses the tenant wall", async () => {
      const old = new Date(NOW.getTime() - 60 * DAY_MS);
      const a = await seedQueueRow(ORG_A, "synced", old);
      const b = await seedQueueRow(ORG_B, "synced", old);

      orgs = [{ organizationId: ORG_A }]; // only A is enumerated
      await runners.purgeOfflineQueue();
      expect(await queueIds(ORG_A)).toEqual([]);
      expect(await queueIds(ORG_B)).toEqual([b]);

      await runners.purgeOfflineQueue(); // re-tick: nothing left to do, no throw
      expect(await queueIds(ORG_B)).toEqual([b]);
      expect(a).not.toBe(b);

      orgs = [{ organizationId: ORG_A }, { organizationId: ORG_B }];
      await runners.purgeOfflineQueue();
      expect(await queueIds(ORG_B)).toEqual([]);
    });

    it("drains a backlog larger than one batch across batches in a single tick", async () => {
      const old = new Date(NOW.getTime() - 90 * DAY_MS);
      await admin.query(
        `INSERT INTO administration_offline_queue
           (organization_id, device_id, local_id, received_at, sync_status, payload_envelope_digest)
         SELECT $1, gen_random_uuid(), gen_random_uuid(), $2, 'synced', 'digest' FROM generate_series(1, 1100)`,
        [ORG_A, old],
      );
      orgs = [{ organizationId: ORG_A }];

      await runners.purgeOfflineQueue();

      expect(await queueIds(ORG_A)).toEqual([]);
    });
  });
});
