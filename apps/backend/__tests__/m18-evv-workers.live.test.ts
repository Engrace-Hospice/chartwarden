/**
 * GAP-056 — the M18 §4.8 workers, proven against real Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * Covers: the late-check sweep (opens one `missing_checkout` per late visit, idempotent, never touches a visit
 * that checked out or is still inside grace), the aggregator-submission prep consumer (a REAL `check_out_recorded`
 * payload from `recordCapture` → one `queued` row; redelivery is a no-op; open-model/no-state is a no-op), the
 * submitter (async accept → `submitted`; sync reject → `rejected`; transport failures back off then land in
 * `timeout`; pre-call failure is rethrown and consumes no attempt), the poller (`submitted → accepted`, and the SLA
 * deadline → `timeout`), the D9 spoof detector (flags via migration 0351's one permitted `gps_quality` transition and
 * the append-only trigger still refuses every other column), and cross-tenant isolation on every worker.
 *
 * The aggregator is EXTERNAL: every adapter here is an in-memory fake behind the `EvvAggregatorAdapter` seam — no
 * network, and nothing here claims a live aggregator call.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m18:workers:live
 * (`evv_event` is RANGE-partitioned → a throwaway superuser DB needs `max_locks_per_transaction` raised.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import {
  type AggregatorPollResult,
  type AggregatorSubmitResult,
  type EvvAggregatorAdapter,
  StateAggregatorRegistry,
  createFixtureCredentialStore,
} from "@wardenx/evv-aggregators";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type EvvAggregatorDeps,
  type EvvWriteOutboxPort,
  M18_OUTBOX_EVENTS,
  buildM18SpoofDetectorConsumer,
  buildM18SubmissionPrepConsumer,
  buildM18VisitPublishedConsumer,
  createDbEvvBackend,
  runAggregatorPollerForOrg,
  runAggregatorSubmitterForOrg,
  runLateCheckSweepForOrg,
  systemCapture,
} from "../src/modules/18-evv/index";
import { M18_POLL_DEADLINE_MS, M18_SUBMIT_MAX_ATTEMPTS } from "../src/modules/18-evv/jobs/queues";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { createTestEvvCoordsCipher } from "./_m18-coords-test-cipher";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PORTLAND = { lat: 45.523, lng: -122.6789 };
const SEATTLE = { lat: 47.6062, lng: -122.3321 };
/** GAP-133 — the §D10 coordinate envelope (production code) over an in-memory per-tenant DEK ring. */
const coordsCipher = createTestEvvCoordsCipher();
const HOUR = 3_600_000;

type Seed = { pe: string; location: string; member: string; device: string };

/** A scripted in-memory aggregator: the transport seam's test fake (never a live call). */
class FakeAdapter implements EvvAggregatorAdapter {
  readonly vendor = "fake";
  readonly states = ["OR"];
  submitCalls = 0;
  pollCalls = 0;
  submitResult: AggregatorSubmitResult = {
    result: "pending_async",
    transactionId: "fake-tx-1",
    nextPollAt: new Date(0).toISOString(),
  };
  pollResult: AggregatorPollResult = { result: "accepted", acceptedAt: new Date().toISOString() };
  async buildSubmissionPayload(args: { checkInEventId: string; checkOutEventId: string }) {
    return { body: { pair: [args.checkInEventId, args.checkOutEventId] }, idempotencyKey: "idem" };
  }
  async submit() {
    this.submitCalls += 1;
    return this.submitResult;
  }
  async poll() {
    this.pollCalls += 1;
    return this.pollResult;
  }
  async healthy() {
    return true;
  }
}

describe.skipIf(!DB_URL)("M18 §4.8 workers — LIVE Postgres (GAP-056)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let outbox: EvvWriteOutboxPort;
  let svc: ReturnType<typeof createDbEvvBackend>;
  let adapter: FakeAdapter;
  let aggregator: EvvAggregatorDeps;
  let patientIdentifierAvailable = true;
  const seeded: Record<string, Seed> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
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
  async function events(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  /** Register a visit (through the REAL M17-publication consumer) with an explicit window. */
  async function registerVisit(org: string, startedAt: Date, endedAt: Date): Promise<string> {
    const s = seeded[org];
    const visitId = randomUUID();
    await buildM18VisitPublishedConsumer({ db: handle.db }).handle({
      id: randomUUID(),
      organizationId: org,
      payload: {
        organizationId: org,
        visitId,
        providerEntityId: s.pe,
        locationId: s.location,
        patientId: PATIENT,
        admissionId: ADMISSION,
        assignedMembershipId: s.member,
        assignedDiscipline: "rn",
        visitPurpose: "routine_visit",
        patientAddressId: null,
        externalFacilityId: null,
        scheduledStartedAt: startedAt.toISOString(),
        scheduledEndedAt: endedAt.toISOString(),
      },
    });
    return visitId;
  }
  /** A raw `evv_event` row (admin) — full control of coords/accuracy/time for the spoof + sweep fixtures. */
  async function rawEvent(
    org: string,
    visitId: string,
    kind: "check_in" | "check_out",
    at: Date,
    coords = PORTLAND,
    accuracyM = 9,
  ): Promise<string> {
    const s = seeded[org];
    // GAP-133 — the coordinate is SEALED exactly as the capture seals it, so the spoof detector opens it.
    const sealed = await coordsCipher.seal(org, coords);
    return (
      await admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
           service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
           captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
           device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,$6,'routine_visit',$7,'rn',$8,$9,$9,$10,$13,$11,'acceptable',$12) RETURNING id`,
        [
          org,
          s.pe,
          s.location,
          visitId,
          PATIENT,
          kind,
          s.member,
          s.device,
          at,
          sealed.cipher,
          accuracyM,
          "66666666-6666-6666-6666-666666666666",
          sealed.dekVersion,
        ],
      )
    ).rows[0].id as string;
  }
  const checkOutPayload = (visitId: string, ci: string | null, co: string) => ({
    eventId: co,
    visitId,
    pairedCheckInEventId: ci,
  });
  async function submissionOf(visitId: string) {
    return (
      await admin.query("SELECT * FROM evv_aggregator_submission WHERE visit_id=$1", [visitId])
    ).rows[0];
  }
  const workerDeps = (now?: Date) => ({
    db: handle.db,
    outbox,
    aggregator,
    now: now ? () => now : undefined,
  });
  const prepConsumer = () => buildM18SubmissionPrepConsumer({ db: handle.db, aggregator });
  /** Seed a visit with a paired check-in/out and prep it to a `queued` submission. */
  async function queuedSubmission(org: string): Promise<{ visitId: string; id: string }> {
    const end = new Date(Date.now() - HOUR);
    const visitId = await registerVisit(org, new Date(end.getTime() - HOUR), end);
    const ci = await rawEvent(org, visitId, "check_in", new Date(end.getTime() - HOUR));
    const co = await rawEvent(org, visitId, "check_out", end);
    await prepConsumer().handle({
      organizationId: org,
      payload: checkOutPayload(visitId, ci, co),
    });
    return { visitId, id: (await submissionOf(visitId)).id as string };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m18wk-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-M18K-${org.slice(0, 4)}`,
            `M18K ${org.slice(0, 4)}`,
            `NPI-M18K-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const device = (
        await admin.query(
          `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
             m2_device_attestation_id, status, approved_at)
           VALUES ($1,$2,'ios',$3,$4,'approved', now()) RETURNING id`,
          [org, member, `fp-M18K-${n}`, "66666666-6666-6666-6666-666666666666"],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO evv_geofence_policy (organization_id, scope, radius_m, max_accuracy_m, effective_from, set_by_membership_id)
         VALUES ($1,'tenant',150,50, now()::date, $2)`,
        [org, member],
      );
      seeded[org] = { pe, location, member, device };
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M18_OUTBOX_EVENTS]));
    outbox = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m18" }),
    };
    svc = createDbEvvBackend(handle.db, outbox, {
      addressCoordinate: async () => PORTLAND,
      coordsCipher,
    });
    adapter = new FakeAdapter();
    aggregator = {
      registry: new StateAggregatorRegistry(
        [
          { stateCode: "OR", aggregatorVendor: "fake", operatingModel: "closed_single_vendor" },
          { stateCode: "WA", aggregatorVendor: "open_model", operatingModel: "open_no_aggregator" },
        ],
        { defaultAdapters: [adapter] },
      ),
      credentials: createFixtureCredentialStore(),
      facts: {
        stateCodeForProviderEntity: async () => "OR",
        patientStateIdentifier: async () => (patientIdentifierAvailable ? "MCD-123" : null),
        clinicianNpi: async () => null,
      },
    };
  }, 240_000);

  // Each tick drains EVERY due row in the org, so a row left by one test would be driven by the next — isolate.
  beforeEach(async () => {
    await admin.query("DELETE FROM evv_aggregator_submission");
    adapter.submitResult = {
      result: "pending_async",
      transactionId: "fake-tx-1",
      nextPollAt: new Date(0).toISOString(),
    };
    adapter.pollResult = { result: "accepted", acceptedAt: new Date().toISOString() };
    patientIdentifierAvailable = true;
  });

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── late-check sweep ───────────────────────────────────────────────────────────────────────────────────
  it("late-check sweep opens one missing_checkout for a checked-in/never-out visit past grace, idempotently", async () => {
    const now = new Date();
    const lateVisit = await registerVisit(
      ORG_A,
      new Date(now.getTime() - 10 * HOUR),
      new Date(now.getTime() - 9 * HOUR),
    );
    await rawEvent(ORG_A, lateVisit, "check_in", new Date(now.getTime() - 10 * HOUR));
    const doneVisit = await registerVisit(
      ORG_A,
      new Date(now.getTime() - 10 * HOUR),
      new Date(now.getTime() - 9 * HOUR),
    );
    await rawEvent(ORG_A, doneVisit, "check_in", new Date(now.getTime() - 10 * HOUR));
    await rawEvent(ORG_A, doneVisit, "check_out", new Date(now.getTime() - 9 * HOUR));
    const withinGrace = await registerVisit(
      ORG_A,
      new Date(now.getTime() - 2 * HOUR),
      new Date(now.getTime() - HOUR),
    );
    await rawEvent(ORG_A, withinGrace, "check_in", new Date(now.getTime() - 2 * HOUR));
    const neverCheckedIn = await registerVisit(
      ORG_A,
      new Date(now.getTime() - 10 * HOUR),
      new Date(now.getTime() - 9 * HOUR),
    );

    const first = await runLateCheckSweepForOrg({ db: handle.db, outbox }, ORG_A);
    expect(first.opened).toBe(1);
    const rows = (
      await admin.query(
        "SELECT id, visit_id, status, detected_by_source FROM evv_missing_resolution WHERE organization_id=$1 AND visit_id = ANY($2)",
        [ORG_A, [lateVisit, doneVisit, withinGrace, neverCheckedIn]],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      visit_id: lateVisit,
      status: "open",
      detected_by_source: "cron_late_check_sweep",
    });
    expect(await events(rows[0].id)).toContain("m18.evv.late_check_out_detected");

    const second = await runLateCheckSweepForOrg({ db: handle.db, outbox }, ORG_A);
    expect(second.opened).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM evv_missing_resolution WHERE visit_id=$1",
          [lateVisit],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("late-check sweep is tenant-scoped: ORG_B's tick never sees or creates ORG_A's rows", async () => {
    const before = (
      await admin.query(
        "SELECT count(*)::int AS n FROM evv_missing_resolution WHERE organization_id=$1",
        [ORG_A],
      )
    ).rows[0].n;
    const result = await runLateCheckSweepForOrg({ db: handle.db, outbox }, ORG_B);
    expect(result).toEqual({ candidates: 0, opened: 0 });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM evv_missing_resolution WHERE organization_id=$1",
          [ORG_A],
        )
      ).rows[0].n,
    ).toBe(before);
    // And the RLS wall itself, as the app role: ORG_B's context cannot read ORG_A's resolutions.
    const seen = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: "" },
      async (tx) =>
        (tx as unknown as { execute(q: unknown): Promise<unknown> }).execute(
          (await import("drizzle-orm"))
            .sql`SELECT count(*)::int AS n FROM evv_missing_resolution WHERE organization_id = ${ORG_A}`,
        ),
    );
    expect((seen as { rows: { n: number }[] }).rows[0].n).toBe(0);
  });

  // ── submission prep ────────────────────────────────────────────────────────────────────────────────────
  it("prep consumes a REAL check_out_recorded payload from recordCapture and queues exactly one submission", async () => {
    const s = seeded[ORG_A];
    const started = new Date();
    const visitId = await registerVisit(ORG_A, started, new Date(started.getTime() + HOUR));
    await svc.recordCapture(
      ORG_A,
      s.member,
      "check_in",
      { visitId, coords: PORTLAND, accuracyM: 5, capturedAt: new Date().toISOString() },
      systemCapture("live-suite fixture"),
    );
    const co = await svc.recordCapture(
      ORG_A,
      s.member,
      "check_out",
      {
        visitId,
        coords: PORTLAND,
        accuracyM: 7,
        capturedAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
      systemCapture("live-suite fixture"),
    );
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m18.evv.check_out_recorded' AND aggregate_id=$1",
      [co.eventId],
    );
    expect(rows).toHaveLength(1);
    const consumer = prepConsumer();
    await consumer.handle({ organizationId: ORG_A, payload: rows[0].payload });
    const sub = await submissionOf(visitId);
    expect(sub).toMatchObject({ status: "queued", state_code: "OR", aggregator_vendor: "fake" });
    expect(sub.check_out_event_id).toBe(co.eventId);
    expect(sub.event_pair_hash).toMatch(/^[0-9a-f]{64}$/);

    await consumer.handle({ organizationId: ORG_A, payload: rows[0].payload }); // redelivery
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM evv_aggregator_submission WHERE visit_id=$1",
          [visitId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("prep is a no-op without a pair, and for an open-model-no-aggregator state", async () => {
    const end = new Date(Date.now() - HOUR);
    const visitId = await registerVisit(ORG_A, new Date(end.getTime() - HOUR), end);
    const co = await rawEvent(ORG_A, visitId, "check_out", end);
    await prepConsumer().handle({
      organizationId: ORG_A,
      payload: checkOutPayload(visitId, null, co),
    });
    expect(await submissionOf(visitId)).toBeUndefined();

    const waAggregator: EvvAggregatorDeps = {
      ...aggregator,
      facts: { ...aggregator.facts, stateCodeForProviderEntity: async () => "WA" },
    };
    const ci = await rawEvent(ORG_A, visitId, "check_in", new Date(end.getTime() - HOUR));
    await buildM18SubmissionPrepConsumer({ db: handle.db, aggregator: waAggregator }).handle({
      organizationId: ORG_A,
      payload: checkOutPayload(visitId, ci, co),
    });
    expect(await submissionOf(visitId)).toBeUndefined();
  });

  it("a corrected event pair re-points a queued row, and requeues a rejected one (D7 alternative c)", async () => {
    const { visitId, id } = await queuedSubmission(ORG_A);
    const before = await submissionOf(visitId);
    const ci2 = randomUUID(); // a corrected check-in (prep never dereferences the event row)
    await admin.query(
      "UPDATE evv_aggregator_submission SET status='rejected', attempt_count=2 WHERE id=$1",
      [id],
    );
    await prepConsumer().handle({
      organizationId: ORG_A,
      payload: checkOutPayload(visitId, ci2, before.check_out_event_id),
    });
    const after = await submissionOf(visitId);
    expect(after.status).toBe("queued");
    expect(after.check_in_event_id).toBe(ci2);
    expect(after.event_pair_hash).not.toBe(before.event_pair_hash);
    expect(after.attempt_count).toBe(0);
  });

  // ── submitter ──────────────────────────────────────────────────────────────────────────────────────────
  it("submitter: async vendor → submitted (+aggregator_submitted); poller → accepted (+aggregator_accepted)", async () => {
    const { visitId, id } = await queuedSubmission(ORG_A);
    adapter.submitResult = {
      result: "pending_async",
      transactionId: "fake-tx-async",
      nextPollAt: new Date(0).toISOString(),
    };
    adapter.pollResult = { result: "accepted", acceptedAt: new Date().toISOString() };
    await runAggregatorSubmitterForOrg(workerDeps(), ORG_A);
    let sub = await submissionOf(visitId);
    expect(sub).toMatchObject({
      status: "submitted",
      aggregator_transaction_id: "fake-tx-async",
      attempt_count: 1,
    });
    expect(sub.submitted_at).not.toBeNull();
    expect(await events(id)).toContain("m18.evv.aggregator_submitted");

    await runAggregatorPollerForOrg(workerDeps(new Date(Date.now() + 60_000)), ORG_A);
    sub = await submissionOf(visitId);
    expect(sub.status).toBe("accepted");
    expect(await events(id)).toContain("m18.evv.aggregator_accepted");
  });

  it("submitter: a vendor rejection lands in rejected with the code + reason and emits aggregator_rejected", async () => {
    const { visitId, id } = await queuedSubmission(ORG_A);
    adapter.submitResult = {
      result: "rejected",
      rejectionCode: "E-17",
      rejectionReason: "member not eligible",
      transactionId: null,
    };
    await runAggregatorSubmitterForOrg(workerDeps(), ORG_A);
    const sub = await submissionOf(visitId);
    expect(sub).toMatchObject({ status: "rejected", aggregator_rejection_code: "E-17" });
    expect(sub.aggregator_rejection_reason).toBe("member not eligible");
    expect(await events(id)).toContain("m18.evv.aggregator_rejected");
  });

  it("submitter: transport failures back off, then the budget lands the row in timeout (+aggregator_timeout)", async () => {
    const { visitId, id } = await queuedSubmission(ORG_A);
    adapter.submitResult = { result: "transport_failure", nextRetryAt: new Date(0).toISOString() };
    let clock = Date.now();
    for (let attempt = 1; attempt <= M18_SUBMIT_MAX_ATTEMPTS; attempt++) {
      const callsBefore = adapter.submitCalls;
      await runAggregatorSubmitterForOrg(workerDeps(new Date(clock)), ORG_A);
      const sub = await submissionOf(visitId);
      expect(adapter.submitCalls).toBe(callsBefore + 1);
      expect(sub.attempt_count).toBe(attempt);
      if (attempt < M18_SUBMIT_MAX_ATTEMPTS) {
        expect(sub.status).toBe("queued");
        expect(new Date(sub.next_retry_at).getTime()).toBeGreaterThan(clock);
        // A tick BEFORE the backoff elapses must not call the vendor again.
        const calls = adapter.submitCalls;
        await runAggregatorSubmitterForOrg(workerDeps(new Date(clock)), ORG_A);
        expect(adapter.submitCalls).toBe(calls);
        clock = new Date(sub.next_retry_at).getTime() + 1_000;
      }
    }
    expect((await submissionOf(visitId)).status).toBe("timeout");
    expect(await events(id)).toContain("m18.evv.aggregator_timeout");
  });

  it("submitter: a pre-call failure (patient identifier unavailable) is rethrown, consumes no attempt, and backs off", async () => {
    const { visitId } = await queuedSubmission(ORG_A);
    patientIdentifierAvailable = false;
    const callsBefore = adapter.submitCalls;
    await expect(runAggregatorSubmitterForOrg(workerDeps(), ORG_A)).rejects.toThrow(/failed/);
    patientIdentifierAvailable = true;
    const sub = await submissionOf(visitId);
    expect(adapter.submitCalls).toBe(callsBefore);
    expect(sub).toMatchObject({ status: "queued", attempt_count: 0 });
    expect(sub.next_retry_at).not.toBeNull();
  });

  it("submitter: a stale `submitting` row (crashed worker) is re-queued by the next tick", async () => {
    const { visitId, id } = await queuedSubmission(ORG_A);
    await admin.query(
      "UPDATE evv_aggregator_submission SET status='submitting', attempt_count=1, last_attempt_at = now() - interval '1 hour', next_retry_at = now() + interval '1 day' WHERE id=$1",
      [id],
    );
    await runAggregatorSubmitterForOrg(workerDeps(), ORG_A);
    expect((await submissionOf(visitId)).status).toBe("queued"); // re-queued; its backoff window is still in the future
  });

  it("poller: a submitted row past the vendor SLA window times out without calling the vendor", async () => {
    const { visitId, id } = await queuedSubmission(ORG_A);
    await admin.query(
      "UPDATE evv_aggregator_submission SET status='submitted', aggregator_transaction_id='old-tx', submitted_at=$2 WHERE id=$1",
      [id, new Date(Date.now() - M18_POLL_DEADLINE_MS - HOUR)],
    );
    const pollsBefore = adapter.pollCalls;
    await runAggregatorPollerForOrg(workerDeps(), ORG_A);
    expect(adapter.pollCalls).toBe(pollsBefore);
    expect((await submissionOf(visitId)).status).toBe("timeout");
    expect(await events(id)).toContain("m18.evv.aggregator_timeout");
  });

  it("submitter + poller are tenant-scoped: ORG_B's ticks never touch ORG_A's rows or call the vendor for them", async () => {
    const { visitId } = await queuedSubmission(ORG_A);
    const callsBefore = adapter.submitCalls;
    const pollsBefore = adapter.pollCalls;
    await runAggregatorSubmitterForOrg(workerDeps(), ORG_B);
    await runAggregatorPollerForOrg(workerDeps(), ORG_B);
    expect(adapter.submitCalls).toBe(callsBefore);
    expect(adapter.pollCalls).toBe(pollsBefore);
    expect((await submissionOf(visitId)).status).toBe("queued");
  });

  it("prep refuses a visit that has no registration in the ENVELOPE's org (a cross-tenant redelivery cannot queue)", async () => {
    const end = new Date(Date.now() - HOUR);
    const visitId = await registerVisit(ORG_A, new Date(end.getTime() - HOUR), end);
    const ci = await rawEvent(ORG_A, visitId, "check_in", new Date(end.getTime() - HOUR));
    const co = await rawEvent(ORG_A, visitId, "check_out", end);
    await expect(
      prepConsumer().handle({ organizationId: ORG_B, payload: checkOutPayload(visitId, ci, co) }),
    ).rejects.toThrow(/no EVV registration/);
    expect(await submissionOf(visitId)).toBeUndefined();
  });

  // ── GPS-spoof detector ─────────────────────────────────────────────────────────────────────────────────
  it("spoof detector flags an impossible jump (advisory), emits gps_spoof_suspected, and leaves a clean event alone", async () => {
    const s = seeded[ORG_A];
    const base = new Date(Date.now() - 6 * HOUR);
    const v1 = await registerVisit(ORG_A, base, new Date(base.getTime() + HOUR));
    const v2 = await registerVisit(ORG_A, base, new Date(base.getTime() + HOUR));
    const first = await rawEvent(ORG_A, v1, "check_in", base, PORTLAND, 9);
    const jump = await rawEvent(
      ORG_A,
      v2,
      "check_in",
      new Date(base.getTime() + 3 * 60_000),
      SEATTLE,
      12,
    );
    const detector = buildM18SpoofDetectorConsumer({ db: handle.db, outbox, coordsCipher });

    await detector.handle({
      organizationId: ORG_A,
      payload: { eventId: first, visitId: v1, postingMembershipId: s.member },
    });
    expect(
      (await admin.query("SELECT gps_quality FROM evv_event WHERE id=$1", [first])).rows[0]
        .gps_quality,
    ).toBe("acceptable");

    await detector.handle({
      organizationId: ORG_A,
      payload: { eventId: jump, visitId: v2, postingMembershipId: s.member },
    });
    expect(
      (await admin.query("SELECT gps_quality FROM evv_event WHERE id=$1", [jump])).rows[0]
        .gps_quality,
    ).toBe("suspected_spoof");
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m18.evv.gps_spoof_suspected' AND aggregate_id=$1",
      [jump],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.detectionSignals).toEqual(["implausible_speed"]);

    // Redelivery is a no-op (already flagged) — no second event.
    await detector.handle({
      organizationId: ORG_A,
      payload: { eventId: jump, visitId: v2, postingMembershipId: s.member },
    });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m18.evv.gps_spoof_suspected' AND aggregate_id=$1",
          [jump],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("migration 0351 permits ONLY the gps_quality → suspected_spoof transition; every other column stays immutable", async () => {
    const base = new Date(Date.now() - 5 * HOUR);
    const v = await registerVisit(ORG_A, base, new Date(base.getTime() + HOUR));
    const id = await rawEvent(ORG_A, v, "check_in", base);
    await expect(
      admin.query("UPDATE evv_event SET accuracy_m = 1 WHERE id=$1", [id]),
    ).rejects.toThrow(/IMMUTABLE_COLUMN/);
    await expect(
      admin.query("UPDATE evv_event SET gps_quality = 'high' WHERE id=$1", [id]),
    ).rejects.toThrow(/IMMUTABLE_COLUMN/);
    await expect(
      admin.query(
        "UPDATE evv_event SET gps_quality = 'suspected_spoof', accuracy_m = 1 WHERE id=$1",
        [id],
      ),
    ).rejects.toThrow(/IMMUTABLE_COLUMN/);
    await admin.query("UPDATE evv_event SET gps_quality = 'suspected_spoof' WHERE id=$1", [id]);
    await expect(admin.query("DELETE FROM evv_event WHERE id=$1", [id])).rejects.toThrow(
      /NO_DELETE/,
    );
  });

  it("spoof detector is tenant-scoped: another org's envelope cannot see or flag ORG_A's event", async () => {
    const base = new Date(Date.now() - 4 * HOUR);
    const v = await registerVisit(ORG_A, base, new Date(base.getTime() + HOUR));
    const prior = await rawEvent(ORG_A, v, "check_in", base, PORTLAND, 9);
    const v2 = await registerVisit(ORG_A, base, new Date(base.getTime() + HOUR));
    const jump = await rawEvent(
      ORG_A,
      v2,
      "check_in",
      new Date(base.getTime() + 60_000),
      SEATTLE,
      12,
    );
    const detector = buildM18SpoofDetectorConsumer({ db: handle.db, outbox, coordsCipher });
    await detector.handle({ organizationId: ORG_B, payload: { eventId: jump } }); // wrong tenant: event_not_found
    expect(
      (await admin.query("SELECT gps_quality FROM evv_event WHERE id=$1", [jump])).rows[0]
        .gps_quality,
    ).toBe("acceptable");
    expect(prior).toBeTruthy();
  });
});
