/**
 * S12 (clinical workflow audit 2026-10-28) -- downtime, recovery, replay and idempotent restoration of
 * clinical state, proven on real Postgres through the REAL catalog-validating publisher and the REAL
 * outbox dispatcher (`createOutboxDispatcher`), driving DB writes as the NOBYPASSRLS `chartwarden_app` role.
 *
 *   1. a consumer that always throws is retried with exponential backoff and ends `failed` (dead letter),
 *      visibly: `last_error`, the `onDeadLetter` hook, a log line -- never silently dropped, never purged;
 *   2. a flaky consumer that recovers is delivered once; in a two-consumer fan-out the consumer that already
 *      succeeded is NOT re-run when the other one is retried (receipt dedup);
 *   3. a worker killed mid-batch (claimed rows left `dispatching`) is replaced by a second worker which
 *      reclaims them after the visibility timeout: nothing lost, nothing delivered twice by the new worker;
 *   4. a relay tick during a DB outage rejects loudly, leaves the row pending, and the next tick after
 *      recovery delivers it (also after the live backends were killed);
 *   5. redelivering `m6.admission.discharged` -- by tick, and by a crash between handle and receipt -- yields
 *      exactly ONE dose cancellation and ONE `m13.scheduled_dose.cancelled` event (M13 discharge cascade);
 *   6. an offline-replayed eMAR administration with the same (deviceId, localId) key is a no-op.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:s12:replay-recovery:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import {
  type OutboxConsumerBinding,
  createOutboxDispatcher,
} from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { createDbEmarBackend } from "../src/modules/13-emar/emar-route-service-db";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { buildM13AdmissionDischargedCascadeConsumer } from "../src/modules/13-emar/outbox-consumers/m6-admission-discharged-cascade";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const DEVICE = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";

/** A real catalog event with exactly one declared consumer (m36), so a single bound binding makes it deliverable. */
const PROBE_EVENT = "m13.prn_reassessment.overdue";
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 5_000;
const VISIBILITY_MS = 5 * 60_000;
const DEFERRED_RETRY_MS = 30 * 60_000;
const T0 = Date.parse("2030-01-01T00:00:00Z");

describe.skipIf(!DB_URL)("S12 downtime / replay / recovery — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let membershipId: string;
  let now = T0;
  const catalog = buildBootOutboxCatalog([M6_OUTBOX_EVENTS, M13_OUTBOX_EVENTS]);
  const publisher = buildTxOutboxPublisher(catalog);
  const orgs: ActiveOrgEnumerator = { listActiveOrgs: async () => [{ organizationId: ORG }] };
  const logs: string[] = [];
  const deadLetters: Array<{ eventId: string; attemptCount: number; error: string }> = [];

  const publishVia = (
    db: typeof handle.db,
    eventName: string,
    aggregateId: string,
    payload: object,
    callerModule = "m13",
  ) =>
    withOrgContext(db, { organizationId: ORG, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName,
        payload,
        organizationId: ORG,
        aggregateKind: "probe",
        aggregateId,
        callerModule,
      }),
    );
  const probePayload = () => ({
    prnAdministrationId: randomUUID(),
    patientId: PATIENT,
    medicationOrderId: randomUUID(),
    recommendedReassessmentScale: randomUUID(),
    reassessmentDueAt: new Date(T0).toISOString(),
  });
  const publishProbe = async (db = handle.db): Promise<string> => {
    const aggregateId = randomUUID();
    await publishVia(db, PROBE_EVENT, aggregateId, probePayload());
    const { rows } = await admin.query(
      "SELECT id FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [aggregateId, PROBE_EVENT],
    );
    return rows[0].id as string;
  };
  const row = async (id: string) =>
    (
      await admin.query(
        "SELECT status, attempt_count, last_error, next_attempt_at, dispatched_at FROM outbox_event WHERE id=$1",
        [id],
      )
    ).rows[0];
  const receipts = async (id: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT consumer_name FROM outbox_consumer_receipt WHERE event_id=$1 ORDER BY 1",
        [id],
      )
    ).rows.map((r) => r.consumer_name as string);
  const probeConsumer = (
    consumerName: string,
    handleFn: OutboxConsumerBinding["handle"],
  ): OutboxConsumerBinding => ({
    consumerName,
    consumerModule: "m36",
    eventTypes: [PROBE_EVENT],
    handle: handleFn,
  });
  const dispatcherFor = (
    consumers: readonly OutboxConsumerBinding[],
    db = handle.db,
    batchSize = 25,
  ) =>
    createOutboxDispatcher({
      db,
      orgs,
      consumers,
      eventCatalog: catalog,
      options: {
        clock: () => now,
        maxAttempts: MAX_ATTEMPTS,
        backoffBaseMs: BACKOFF_BASE_MS,
        visibilityTimeoutMs: VISIBILITY_MS,
        deferredRetryMs: DEFERRED_RETRY_MS,
        batchSize,
        log: (m) => void logs.push(m),
        onDeadLetter: (e) => void deadLetters.push(e),
      },
    });
  /** Park every unrelated pending row so one scenario's ticks never touch another's rows. */
  const quiesce = () =>
    admin.query(
      "UPDATE outbox_event SET status='dispatched', dispatched_at=now() WHERE status IN ('pending','dispatching')",
    );

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-s12','S12','S12')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'s12@x.test')`, [USER]);
    membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1,$2,'mrn-s12','Pat','Alpha','1950-01-01','female','active')`,
      [PATIENT, ORG],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("a consumer that always throws is retried with exponential backoff, then dead-lettered visibly and never purged", async () => {
    await quiesce();
    let calls = 0;
    const d = dispatcherFor([
      probeConsumer("s12.always-throws", async () => {
        calls += 1;
        throw new Error("downstream unavailable");
      }),
    ]);
    const id = await publishProbe();

    const t1 = await d.tick();
    expect(t1).toMatchObject({ delivered: 0, retried: 1, deadLettered: 0 });
    let r = await row(id);
    expect(r).toMatchObject({ status: "pending", attempt_count: 1 });
    expect(r.last_error).toContain("downstream unavailable");
    expect(new Date(r.next_attempt_at).getTime()).toBe(now + BACKOFF_BASE_MS);

    // Not due yet: a tick inside the backoff window must not call the consumer again.
    expect((await d.tick()).retried).toBe(0);
    expect(calls).toBe(1);

    now += BACKOFF_BASE_MS;
    expect((await d.tick()).retried).toBe(1);
    r = await row(id);
    expect(r.attempt_count).toBe(2);
    expect(new Date(r.next_attempt_at).getTime()).toBe(now + BACKOFF_BASE_MS * 2); // doubled

    now += BACKOFF_BASE_MS * 2;
    const t3 = await d.tick();
    expect(t3).toMatchObject({ retried: 0, deadLettered: 1, delivered: 0 });
    r = await row(id);
    expect(r).toMatchObject({ status: "failed", attempt_count: MAX_ATTEMPTS, dispatched_at: null });
    expect(r.last_error).toContain("downstream unavailable");
    expect(calls).toBe(MAX_ATTEMPTS);
    expect(await receipts(id)).toEqual([]);
    // Visible: hook + log line.
    expect(deadLetters.filter((e) => e.eventId === id)).toEqual([
      expect.objectContaining({
        attemptCount: MAX_ATTEMPTS,
        error: expect.stringContaining("downstream"),
      }),
    ]);
    expect(logs.some((l) => l.includes(id) && l.includes("dead-lettered"))).toBe(true);

    // Terminal: later ticks (even a year on, past the 14-day retention) neither retry nor purge it.
    now += 365 * 24 * 3_600_000;
    expect(await d.tick()).toMatchObject({ delivered: 0, retried: 0, deadLettered: 0, purged: 0 });
    expect(calls).toBe(MAX_ATTEMPTS);
    expect((await row(id)).status).toBe("failed");
  });

  it("a flaky consumer that recovers delivers once; in a fan-out the already-succeeded consumer is not re-run", async () => {
    await quiesce();
    now = T0;
    let aCalls = 0;
    let bCalls = 0;
    let bFailuresLeft = 1;
    const d = dispatcherFor([
      probeConsumer("s12.fanout-a", async () => {
        aCalls += 1;
      }),
      probeConsumer("s12.fanout-b", async () => {
        bCalls += 1;
        if (bFailuresLeft-- > 0) throw new Error("b: transient");
      }),
    ]);
    const id = await publishProbe();

    expect(await d.tick()).toMatchObject({ retried: 1, delivered: 0 });
    expect(await receipts(id)).toEqual(["s12.fanout-a"]); // partial fan-out is durable
    now += BACKOFF_BASE_MS;
    expect(await d.tick()).toMatchObject({ retried: 0, delivered: 1 });
    expect(await receipts(id)).toEqual(["s12.fanout-a", "s12.fanout-b"]);
    expect({ aCalls, bCalls }).toEqual({ aCalls: 1, bCalls: 2 });
    expect((await row(id)).status).toBe("dispatched");

    // Replaying the finished tick set is a no-op.
    now += 10 * BACKOFF_BASE_MS;
    expect(await d.tick()).toMatchObject({ delivered: 0, retried: 0 });
    expect({ aCalls, bCalls }).toEqual({ aCalls: 1, bCalls: 2 });
  });

  it("a worker killed mid-batch is replaced: nothing lost, nothing re-delivered by the new worker", async () => {
    await quiesce();
    now = T0;
    const seen = new Map<string, number>();
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) ids.push(await publishProbe());
    const idOf = (e: { payload: unknown }) => (e as { id?: string }).id as string;
    // Worker 1 handles events 1 and 2, then "dies" inside event 3's handler (never settles).
    const worker1 = dispatcherFor([
      probeConsumer("s12.killable", async (e) => {
        seen.set(`${idOf(e)}@w1`, (seen.get(`${idOf(e)}@w1`) ?? 0) + 1);
        if (idOf(e) === ids[2]) await new Promise<never>(() => {});
      }),
    ]);
    void worker1.tick(); // abandoned: the process is gone
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await receipts(ids[1])).length === 0)
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));

    expect((await row(ids[0])).status).toBe("dispatched");
    expect((await row(ids[1])).status).toBe("dispatched");
    for (const i of [2, 3, 4]) expect((await row(ids[i])).status).toBe("dispatching"); // stranded claims

    // Inside the visibility window a second worker must NOT steal them (it would double-run live work).
    const worker2 = dispatcherFor([
      probeConsumer("s12.killable", async (e) => {
        seen.set(`${idOf(e)}@w2`, (seen.get(`${idOf(e)}@w2`) ?? 0) + 1);
      }),
    ]);
    now += VISIBILITY_MS - 1_000;
    expect(await worker2.tick()).toMatchObject({ reclaimed: 0, delivered: 0 });

    now += 2_000;
    const t = await worker2.tick();
    expect(t).toMatchObject({ reclaimed: 3, delivered: 3 });
    for (const id of ids) {
      expect((await row(id)).status).toBe("dispatched");
      expect(await receipts(id)).toEqual(["s12.killable"]); // none lost, one receipt each
    }
    for (const i of [0, 1]) {
      expect(seen.get(`${ids[i]}@w1`)).toBe(1);
      expect(seen.get(`${ids[i]}@w2`)).toBeUndefined(); // already receipted -> never re-run
    }
    // The event in flight at the kill is at-least-once (it ran on worker 1 and again on worker 2); the
    // two never-started ones ran only on worker 2.
    expect(seen.get(`${ids[2]}@w1`)).toBe(1);
    expect(seen.get(`${ids[2]}@w2`)).toBe(1);
    for (const i of [3, 4]) expect(seen.get(`${ids[i]}@w1`)).toBeUndefined();
    for (const i of [3, 4]) expect(seen.get(`${ids[i]}@w2`)).toBe(1);
  });

  it("a relay tick during a DB outage rejects loudly, leaves the row pending, and recovers on the next tick", async () => {
    await quiesce();
    now = T0;
    const id = await publishProbe();
    let calls = 0;
    const consumers = [
      probeConsumer("s12.outage", async () => {
        calls += 1;
      }),
    ];

    // (a) The DB is unreachable (nothing listening) when the relay ticks: the tick must fail, not swallow.
    const down = createDbClient({
      connectionString: appRoleUrl(DB_URL as string).replace(/:\d+\//, ":1/"),
      max: 2,
    });
    down.pool.on("error", () => {});
    await expect(dispatcherFor(consumers, down.db).tick()).rejects.toThrow();
    await down.close();
    const cold = createDbClient({ connectionString: appRoleUrl(DB_URL as string), max: 2 });
    expect(calls).toBe(0);
    expect(await row(id)).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(await dispatcherFor(consumers, cold.db).tick()).toMatchObject({ delivered: 1 });
    expect(calls).toBe(1);
    await cold.close();

    // (b) Backends killed under a warm pool (failover / network blip): first tick may fail, the relay
    // converges on its own once the DB is back, and the event is delivered exactly once.
    const id2 = await publishProbe();
    const warm = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
      max: 2,
      pool: { application_name: "s12-warm" },
    });
    warm.pool.on("error", () => {}); // pg emits 'error' for idle clients whose backend was terminated
    await warm.pool.query("SELECT 1");
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='s12-warm' AND pid <> pg_backend_pid()",
    );
    await new Promise((r) => setTimeout(r, 500)); // let the pool notice the dead idle sockets
    const d = dispatcherFor(consumers, warm.db);
    let delivered = 0;
    for (let i = 0; i < 3 && delivered === 0; i++)
      delivered = await d.tick().then(
        (s) => s.delivered,
        () => 0,
      );
    expect(delivered).toBe(1);
    expect((await row(id2)).status).toBe("dispatched");
    expect(calls).toBe(2);
    await warm.close();
  });

  describe("idempotent restoration of clinical state", () => {
    const DOSE = "dddddddd-0000-4000-8000-000000000001";
    const KIT = "eeeeeeee-0000-4000-8000-000000000001";
    let providerId: string;
    let locationId: string;
    let cascadeCancelled = 0;

    const cancelEvents = async (): Promise<number> =>
      (
        await admin.query(
          "SELECT count(*)::int n FROM outbox_event WHERE event_type='m13.scheduled_dose.cancelled' AND aggregate_id=$1",
          [DOSE],
        )
      ).rows[0].n as number;

    it("redelivering m6.admission.discharged (tick replay and crash-before-receipt) cancels the dose and publishes once", async () => {
      await quiesce();
      now = T0;
      providerId = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'S12-A','S12 Provider','1300000099','enc','12-31') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      locationId = (
        await admin.query(
          `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,'S12 Location','1 Test St','Testville','OR','97201','America/Los_Angeles') RETURNING id`,
          [providerId],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO scheduled_dose
           (id, organization_id, provider_entity_id, location_id, patient_id, admission_id,
            medication_order_id, due_at, grace_window_minutes, expected_dose_amount, expected_dose_unit,
            expected_route, status, materialization_sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'2099-01-01T08:00:00Z',30,10,'mg','oral','pending',1)`,
        [DOSE, ORG, providerId, locationId, PATIENT, ADMISSION, randomUUID()],
      );
      await admin.query(
        `INSERT INTO comfort_kit_deployment
           (id, organization_id, provider_entity_id, location_id, patient_id, admission_id, deployed_at, disposal_status)
         VALUES ($1,$2,$3,$4,$5,$6,now(),'deployed')`,
        [KIT, ORG, providerId, locationId, PATIENT, ADMISSION],
      );

      const consumer = buildM13AdmissionDischargedCascadeConsumer({
        db: handle.db,
        outbox: {
          publish: (tx, e) =>
            publisher.publish(tx as never, { ...e, callerModule: "m13" } as never),
        },
        resolveAdmission: async () => ({ patientId: PATIENT as never }),
      });
      const counting: OutboxConsumerBinding = {
        ...consumer,
        async handle(e) {
          cascadeCancelled += 1;
          await consumer.handle(e);
        },
      };
      const d = dispatcherFor([counting]);
      await publishVia(
        handle.db,
        "m6.admission.discharged",
        ADMISSION,
        {
          admissionId: ADMISSION,
          reason: "revocation",
          dischargeDate: new Date(T0).toISOString(),
        },
        "m6",
      );
      const { rows } = await admin.query(
        "SELECT id FROM outbox_event WHERE event_type='m6.admission.discharged' AND aggregate_id=$1",
        [ADMISSION],
      );
      const eventId = rows[0].id as string;
      const state = async () =>
        (
          await admin.query(
            "SELECT d.status, d.cancelled_at, k.disposal_status FROM scheduled_dose d, comfort_kit_deployment k WHERE d.id=$1 AND k.id=$2",
            [DOSE, KIT],
          )
        ).rows[0];

      await d.tick();
      const first = await state();
      expect(first).toMatchObject({ status: "cancelled", disposal_status: "return_required" });
      expect(await cancelEvents()).toBe(1);
      expect(cascadeCancelled).toBe(1);
      const returnEvents = async () =>
        (
          await admin.query(
            "SELECT count(*)::int n FROM outbox_event WHERE event_type='m13.comfort_kit.return_required' AND aggregate_id=$1",
            [KIT],
          )
        ).rows[0].n as number;
      expect(await returnEvents()).toBe(1);

      // (a) The event is deferred (other declared consumers are not bound in this harness) and comes due
      // again: the receipt stops a second invocation.
      now += DEFERRED_RETRY_MS + 1_000;
      await d.tick();
      expect(cascadeCancelled).toBe(1);

      // (b) Crash between handle() and the receipt insert: the consumer genuinely runs again.
      await admin.query("DELETE FROM outbox_consumer_receipt WHERE event_id=$1", [eventId]);
      now += DEFERRED_RETRY_MS + 1_000;
      await d.tick();
      expect(cascadeCancelled).toBe(2);
      const again = await state();
      expect(again.status).toBe("cancelled");
      expect(new Date(again.cancelled_at).getTime()).toBe(new Date(first.cancelled_at).getTime());
      expect(await cancelEvents()).toBe(1); // exactly one clinical side effect
      expect(await returnEvents()).toBe(1);
    });
  });

  describe("eMAR offline replay", () => {
    it("replaying the same (deviceId, localId) administration is a no-op: one record, one event", async () => {
      const medicationOrderId = randomUUID();
      const emarOutbox = {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m13" } as never),
      };
      const orders = {
        async administrationIdentity({ medicationOrderId: id }: { medicationOrderId: string }) {
          if (id !== medicationOrderId) return null;
          return {
            patientId: PATIENT,
            admissionId: ADMISSION,
            drugName: "Acetaminophen",
            route: "oral",
            ivContinuousPolicy: null,
            allowAdministration: true,
            blockedReasons: [],
            medClass: "standard",
            isControlledSubstance: false,
            isSudTreatment: false,
            doseAmount: 500,
            doseUnit: "mg",
            rxnormRxcui: "rx-apap",
            ndc: "ndc-apap",
            prnMinimumIntervalMinutes: null,
          };
        },
        async activeMedicationOrderIds() {
          return [];
        },
      };
      const svc = createDbEmarBackend(
        handle.db,
        emarOutbox as never,
        undefined,
        () => orders as never,
      );
      const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
      const syncRow = {
        medicationOrderId,
        medClass: "standard",
        mode: "single_dose",
        administeredAt: at,
        route: "oral",
        doseAmount: 500,
        doseUnit: "mg",
        lateEntryReason: "Offline capture synced after the shift; dose given at the bedside.",
        offlineCapture: { deviceId: DEVICE, localId: randomUUID(), capturedAt: at },
      };

      const first = await svc.offlineSync(ORG_ARG, membershipId, [syncRow] as never);
      expect(first.synced).toBe(1);
      // The device never saw the ack and replays the whole queue (twice, in different batch shapes).
      const second = await svc.offlineSync(ORG_ARG, membershipId, [syncRow] as never);
      const third = await svc.offlineSync(ORG_ARG, membershipId, [syncRow, syncRow] as never);
      expect(second.results[0]?.id).toBe(first.results[0]?.id);
      expect(third.results.map((r) => r.id)).toEqual([first.results[0]?.id, first.results[0]?.id]);

      const { rows } = await admin.query(
        "SELECT id FROM administration_record WHERE medication_order_id=$1",
        [medicationOrderId],
      );
      expect(rows).toHaveLength(1);
      const events = await admin.query(
        "SELECT count(*)::int n FROM outbox_event WHERE event_type='m13.administration.recorded' AND aggregate_id=$1",
        [rows[0].id],
      );
      expect(events.rows[0].n).toBe(1);

      // A different localId from the same device is a different dose and is recorded.
      await svc.offlineSync(ORG_ARG, membershipId, [
        { ...syncRow, offlineCapture: { ...syncRow.offlineCapture, localId: randomUUID() } },
      ] as never);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int n FROM administration_record WHERE medication_order_id=$1",
            [medicationOrderId],
          )
        ).rows[0].n,
      ).toBe(2);

      // A key that names a DIFFERENT order is a reused localId, not a replay: refused with a bare conflict, the
      // stored record is never echoed back, and nothing new is written (review H1).
      await expect(
        svc.offlineSync(ORG_ARG, membershipId, [
          { ...syncRow, medicationOrderId: randomUUID() },
        ] as never),
      ).rejects.toMatchObject({ name: "ConflictError" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int n FROM administration_record WHERE medication_order_id=$1",
            [medicationOrderId],
          )
        ).rows[0].n,
      ).toBe(2);
    });
  });
});

const ORG_ARG = ORG;
