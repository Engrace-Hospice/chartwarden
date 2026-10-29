/**
 * S06 (clinical workflow audit 2026-10-28) -- PRN administration under concurrency, proven on real Postgres.
 *
 * `planPrn` serialises PRN doses of one order with `pg_advisory_xact_lock`; nothing in the schema backs the
 * interval up (`prn_administration` has only a 1:1 unique on the administration row). The sequential case lives
 * in m13-emar-write.live.test.ts (GAP-021/022); this suite proves what that one cannot:
 *   - N simultaneous doses of one order inside the minimum interval -> exactly ONE commits;
 *   - the lock is per ORDER, so two orders of one patient do not block each other;
 *   - a failure after the interval check leaves no administration, PRN or outbox row behind;
 *   - concurrent supervisor overrides are each recorded and attributed.
 * Drives the writes as the NOBYPASSRLS `chartwarden_app` role and binds the REAL catalog-validating publisher.
 * The order port is a stub: it supplies the 240 min minimum interval directly, so M12's own PRN-interval path is
 * NOT exercised here (that is order-to-administration's job); this suite is about the M13 lock and rollback.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m13:prn-concurrency:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type EmarMedicationOrderPort,
  type EmarWriteOutboxPort,
  createDbEmarBackend,
} from "../src/modules/13-emar/emar-route-service-db";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
/** Parallel requests per race; below the pool size (10) so every one gets its own backend. */
const RACERS = 8;
const MIN_INTERVAL_MINUTES = 240;
const OVERRIDE_REASON =
  "Supervisor override: breakthrough pain unrelieved, physician reached and agreed by phone.";
const PRN = { triggeringPrnReason: "breakthrough pain", requestedByKind: "clinician_observed" };

describe.skipIf(!DB_URL)("S06 PRN concurrency — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbEmarBackend>;
  let membershipId: string;
  /** Orders the stub resolves; each test mints its own so no test sees another's doses. */
  const prnOrders = new Set<string>();
  /** When set, the outbox throws for this event type, after the interval check and both inserts have run. */
  let failEvent: string | null = null;

  const newOrder = (): string => {
    const id = crypto.randomUUID();
    prnOrders.add(id);
    return id;
  };
  const dose = (medicationOrderId: string, administeredAt: string, over: object = {}) =>
    svc.recordAdministration(ORG, membershipId, {
      medicationOrderId,
      medClass: "standard",
      mode: "single_dose",
      administeredAt,
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
      prn: PRN,
      ...over,
    } as never);
  const count = async (table: string, medicationOrderId: string): Promise<number> =>
    (
      await admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE medication_order_id=$1`, [
        medicationOrderId,
      ])
    ).rows[0].n as number;
  /** All M13 outbox rows. Counted directly: a join through administration_record is 0 after a rollback anyway. */
  const m13OutboxCount = async (): Promise<number> =>
    (await admin.query("SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm13.%'"))
      .rows[0].n as number;
  /** Resolves to `PENDING` if `p` has not settled within `ms` (proves a call is blocked, not just slow). */
  const PENDING = Symbol("pending");
  const stillPending = async (p: Promise<unknown>, ms = 400): Promise<boolean> =>
    (await Promise.race([
      p.then(
        () => null,
        () => null,
      ),
      new Promise((r) => setTimeout(() => r(PENDING), ms)),
    ])) === PENDING;
  const codes = (results: PromiseSettledResult<unknown>[]): unknown[] =>
    results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason as { code?: unknown }).code);
  const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'s06@x.test')`, [USER]);
    membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1,$2,'mrn-s06','Pat','Alpha','1950-01-01','female','active')`,
      [PATIENT, ORG],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M13_OUTBOX_EVENTS]));
    const outbox: EmarWriteOutboxPort = {
      publish: (tx, e) => {
        if (failEvent !== null && e.eventName === failEvent)
          throw new Error(`injected outbox failure for ${failEvent}`);
        return txPublisher.publish(tx as never, { ...e, callerModule: "m13" });
      },
    };
    const orders: EmarMedicationOrderPort = {
      async administrationIdentity({ medicationOrderId }) {
        if (!prnOrders.has(medicationOrderId)) return null;
        return {
          patientId: PATIENT,
          admissionId: ADMISSION,
          drugName: "Morphine Sulfate Oral Solution",
          route: "oral",
          ivContinuousPolicy: null,
          allowAdministration: true,
          blockedReasons: [],
          medClass: "standard",
          isControlledSubstance: false,
          isSudTreatment: false,
          doseAmount: 5,
          doseUnit: "mg",
          rxnormRxcui: "rx-morphine",
          ndc: "ndc-morphine",
          prnMinimumIntervalMinutes: MIN_INTERVAL_MINUTES,
        };
      },
      async activeMedicationOrderIds() {
        return [];
      },
    };
    svc = createDbEmarBackend(handle.db, outbox, undefined, () => orders);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("simultaneous doses at the same instant: exactly one commits, the rest are refused PRN_INTERVAL_VIOLATION", async () => {
    const order = newOrder();
    const at = hoursAgo(1);
    const results = await Promise.allSettled(Array.from({ length: RACERS }, () => dose(order, at)));

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(RACERS - 1);
    expect(codes(results)).toEqual(Array(RACERS - 1).fill("PRN_INTERVAL_VIOLATION"));
    expect(await count("administration_record", order)).toBe(1);
    expect(await count("prn_administration", order)).toBe(1);
  });

  it("simultaneous doses at different instants inside the interval: still exactly one", async () => {
    const order = newOrder();
    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, (_, i) =>
        dose(order, new Date(Date.now() - (i + 1) * 60_000).toISOString()),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(codes(results)).toEqual(Array(RACERS - 1).fill("PRN_INTERVAL_VIOLATION"));
    expect(await count("administration_record", order)).toBe(1);
    expect(await count("prn_administration", order)).toBe(1);
  });

  it("the lock is per order: a dose of order A waits on A's advisory lock while order B's dose commits", async () => {
    const [orderA, orderB] = [newOrder(), newOrder()];
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`prn:${orderA}`]);

      const doseA = dose(orderA, hoursAgo(1));
      const doseB = await dose(orderB, hoursAgo(1));

      expect(doseB.status).toBe("committed");
      expect(await stillPending(doseA)).toBe(true);
      expect(await count("administration_record", orderA)).toBe(0);
      await holder.query("COMMIT");
      expect((await doseA).status).toBe("committed");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("a race after a committed dose: every contender is refused and the table does not grow", async () => {
    const order = newOrder();
    await dose(order, hoursAgo(2));

    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, () => dose(order, hoursAgo(1))),
    );

    expect(codes(results)).toEqual(Array(RACERS).fill("PRN_INTERVAL_VIOLATION"));
    expect(await count("administration_record", order)).toBe(1);
    expect(await count("prn_administration", order)).toBe(1);
  });

  it("past the minimum interval a second dose records (the gate is not stuck shut)", async () => {
    const order = newOrder();
    await dose(order, hoursAgo(6));

    const later = await dose(order, hoursAgo(1));

    expect(later.status).toBe("committed");
    expect(await count("prn_administration", order)).toBe(2);
  });

  it("a failure after the interval check leaves no administration, PRN or outbox row, and frees the lock", async () => {
    const order = newOrder();
    const outboxBefore = await m13OutboxCount();
    failEvent = "m13.prn_administration_recorded";
    try {
      await expect(dose(order, hoursAgo(1))).rejects.toThrow(/injected outbox failure/);
    } finally {
      failEvent = null;
    }

    expect(await count("administration_record", order)).toBe(0);
    expect(await count("prn_administration", order)).toBe(0);
    expect(await m13OutboxCount()).toBe(outboxBefore);
    // The rolled-back dose must not count as a "last dose": a retry at the same instant records.
    const retry = await dose(order, hoursAgo(1));
    expect(retry.status).toBe("committed");
  });

  it("concurrent supervisor overrides are each recorded, attributed and carry the reason", async () => {
    const order = newOrder();
    await dose(order, hoursAgo(2));
    const override = { hasPermission: true, reason: OVERRIDE_REASON };

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, (_, i) =>
        dose(order, new Date(Date.now() - (i + 1) * 30_000).toISOString(), {
          prn: { ...PRN, intervalOverride: override },
        }),
      ),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const { rows } = await admin.query(
      `SELECT prn_interval_override_reason AS reason, prn_interval_override_by AS by
         FROM prn_administration WHERE medication_order_id=$1 AND prn_interval_override`,
      [order],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.reason).toBe(OVERRIDE_REASON);
      expect(r.by).toBe(membershipId);
    }
  });

  it("an override without the permission is refused even while racing a permitted one", async () => {
    const order = newOrder();
    await dose(order, hoursAgo(2));

    const [denied, allowed] = await Promise.allSettled([
      dose(order, hoursAgo(1), {
        prn: { ...PRN, intervalOverride: { hasPermission: false, reason: OVERRIDE_REASON } },
      }),
      dose(order, new Date(Date.now() - 30_000).toISOString(), {
        prn: { ...PRN, intervalOverride: { hasPermission: true, reason: OVERRIDE_REASON } },
      }),
    ]);

    expect((denied as PromiseRejectedResult).reason).toMatchObject({
      code: "PRN_INTERVAL_OVERRIDE_NOT_PERMITTED",
    });
    expect(allowed.status).toBe("fulfilled");
    expect(await count("prn_administration", order)).toBe(2);
  });
});
