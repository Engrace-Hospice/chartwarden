/**
 * ADR-0082 slice S2 - M19's `m36.afterhours_triage.requested` consumer, LIVE Postgres as the NOBYPASSRLS
 * `wardenx_app` role, on the REAL catalog-validating publisher.
 *
 * What a double cannot prove: `triage_call_source_dedupe_uq` is a partial unique index (the redelivery
 * guard), the coalesce grain is a predicate over `state` and `source_outbox_event_id`, the two new enum
 * values exist in the catalog, `on_call_shift_id` is NOT NULL (why `no_coverage` is an outcome and not a
 * throw), the outcome event validates against the real catalog schema, and a patient of another tenant is
 * invisible through the real PatientReader under RLS.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m19:afterhours-requested:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1. Use a PRIVATE container, never the shared cluster.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildOrgProviderEntityLister } from "../src/bootstrap/provider-entity-resolver";
import { createDrizzlePatientReaderStore } from "../src/modules/05-patient/index";
import { createPatientReader } from "../src/modules/05-patient/seams/patient-reader";
import {
  M19_OUTBOX_EVENTS,
  buildAfterHoursRequestedConsumer,
  createDrizzleInboundTriggerPorts,
} from "../src/modules/19-oncall/index";
import { buildDrizzleEscalationRouterReads } from "../src/modules/19-oncall/seams/escalation-router-binding";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111a4710a19";
const ORG_B = "22222222-2222-4222-8222-2222a4710b19";
const NOW = new Date("2026-09-02T03:00:00.000Z");
const SECRET = "SECRET-CLINICAL-TEXT-must-never-be-copied";

type Seed = { pe: string; member: string; patient: string; patient2: string };

describe.skipIf(!DB_URL)("M19 after-hours triage request - LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let consumer: ReturnType<typeof buildAfterHoursRequestedConsumer>;
  const seeded: Record<string, Seed> = {};

  /** The consumer over the given trigger ports (a test may wrap them to interleave a rival delivery). */
  const makeConsumer = (ports: ReturnType<typeof createDrizzleInboundTriggerPorts>) => {
    const txPublisher = buildTxOutboxPublisher(
      buildBootOutboxCatalog([M19_OUTBOX_EVENTS, M36_OUTBOX_EVENTS]),
    );
    return buildAfterHoursRequestedConsumer({
      db: handle.db,
      ports,
      deliveryPorts: ports,
      afterHoursReads: buildDrizzleEscalationRouterReads({
        db: handle.db,
        patientReader: () => createPatientReader(createDrizzlePatientReaderStore(handle.db)),
        siteReader: buildFoundationSiteReader(),
        listProviderEntityIds: buildOrgProviderEntityLister(handle.db),
      }),
      outbox: {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m19" }),
      },
      now: () => NOW,
    });
  };

  const request = (org: string, patientId: string) => ({
    messageId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    patientId,
    occurredAt: NOW.toISOString(),
  });

  const deliver = (
    org: string,
    payload: Record<string, unknown>,
    eventId: string = crypto.randomUUID(),
  ) =>
    consumer.handle({
      id: eventId,
      organizationId: org,
      eventType: "m36.afterhours_triage.requested",
      aggregateKind: "message",
      aggregateId: String(payload.messageId),
      payload,
      attemptCount: 1,
      createdAt: new Date(),
    });

  const calls = async (org: string) =>
    (
      await admin.query(
        `SELECT id, source, caller_kind, inbound_channel, chief_complaint_text, source_outbox_event_id,
                patient_id, on_call_shift_id, state
           FROM triage_call WHERE organization_id = $1 ORDER BY opened_at`,
        [org],
      )
    ).rows;
  const events = async (org: string) =>
    (
      await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE organization_id = $1 ORDER BY created_at, id",
        [org],
      )
    ).rows;
  const outcomes = async (org: string) =>
    (await events(org)).filter((e) => e.event_type === "m19.afterhours_triage.outcome");

  async function seedShift(org: string): Promise<string> {
    const s = seeded[org] as Seed;
    const { rows } = await admin.query(
      `INSERT INTO on_call_shift (organization_id, provider_entity_id, shift_starts_at, shift_ends_at,
         discipline, primary_on_call_membership_id, policy_snapshot, status, opened_at)
       VALUES ($1,$2,$3,$4,'clinical_rn',$5,'{}'::jsonb,'active',$6) RETURNING id`,
      [
        org,
        s.pe,
        new Date(NOW.getTime() - 3_600_000),
        new Date(NOW.getTime() + 3_600_000),
        s.member,
        new Date(NOW.getTime() - 3_600_000),
      ],
    );
    return rows[0].id as string;
  }

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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'a47m19-a','A','A','active'),($2,'a47m19-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `a47m19-${n++}@x.test`,
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
            `CCN-A47-${org.slice(0, 4)}`,
            `A47 ${org.slice(0, 4)}`,
            `NPI-A47-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const mkPatient = async (tag: string) =>
        (
          await admin.query(
            `INSERT INTO patient (organization_id, provider_entity_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
             VALUES ($1,$2,$3,'Af','Hours','1990-01-01','M','active') RETURNING id`,
            [org, pe, `MRN-A47-${org.slice(0, 4)}-${tag}`],
          )
        ).rows[0].id as string;
      seeded[org] = { pe, member, patient: await mkPatient("1"), patient2: await mkPatient("2") };
    }

    const url = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: url });

    consumer = makeConsumer(createDrizzleInboundTriggerPorts(handle.db));
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM triage_escalation");
    await admin.query("DELETE FROM triage_call_state_history");
    await admin.query("DELETE FROM triage_call");
    await admin.query("DELETE FROM on_call_shift");
    await admin.query("DELETE FROM outbox_event");
  });

  it("subscribes to exactly the request event, as m19", () => {
    expect(consumer.eventTypes).toEqual(["m36.afterhours_triage.requested"]);
    expect(consumer.consumerModule).toBe("m19");
  });

  it("opens a patient-attached system_inbound call and answers `opened` in the same transaction", async () => {
    const shiftId = await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    const eventId = crypto.randomUUID();
    await deliver(ORG_A, request(ORG_A, a.patient), eventId);

    const rows = await calls(ORG_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "m36_afterhours_request",
      caller_kind: "system_inbound",
      inbound_channel: "inbound_afterhours_request",
      patient_id: a.patient,
      on_call_shift_id: shiftId,
      source_outbox_event_id: eventId,
      state: "open",
    });
    expect(rows[0].chief_complaint_text).toBe(
      "After-hours urgent message about this patient; review and contact the care team.",
    );
    const answers = await outcomes(ORG_A);
    expect(answers).toHaveLength(1);
    expect(answers[0].payload).toEqual({
      sourceOutboxEventId: eventId,
      triageCallId: rows[0].id,
      outcome: "opened",
    });
    expect((await events(ORG_A)).map((e) => e.event_type).sort()).toEqual([
      "m19.afterhours_triage.outcome",
      "m19.triage_call.opened",
    ]);
  });

  it("a redelivery of the same event writes and publishes nothing more", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    const eventId = crypto.randomUUID();
    const payload = request(ORG_A, a.patient);
    await deliver(ORG_A, payload, eventId);
    const before = await events(ORG_A);
    await deliver(ORG_A, payload, eventId);

    expect(await calls(ORG_A)).toHaveLength(1);
    expect(await events(ORG_A)).toHaveLength(before.length);
  });

  it("a second request for the same patient coalesces onto the open call and answers `coalesced`", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    await deliver(ORG_A, request(ORG_A, a.patient));
    const secondId = crypto.randomUUID();
    await deliver(ORG_A, request(ORG_A, a.patient), secondId);

    const rows = await calls(ORG_A);
    expect(rows).toHaveLength(1);
    const answers = await outcomes(ORG_A);
    expect(answers.map((e) => e.payload.outcome)).toEqual(["opened", "coalesced"]);
    expect(answers[1].payload).toEqual({
      sourceOutboxEventId: secondId,
      triageCallId: rows[0].id,
      outcome: "coalesced",
    });
  });

  it("a redelivery of a COALESCED request publishes nothing more", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    await deliver(ORG_A, request(ORG_A, a.patient));
    const secondId = crypto.randomUUID();
    const payload = request(ORG_A, a.patient);
    await deliver(ORG_A, payload, secondId);
    const before = await events(ORG_A);
    await deliver(ORG_A, payload, secondId);

    expect(await events(ORG_A)).toHaveLength(before.length);
    expect(await calls(ORG_A)).toHaveLength(1);
  });

  it("a redelivery after the coalesce target closed neither opens a call nor contradicts the first outcome", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    await deliver(ORG_A, request(ORG_A, a.patient));
    const secondId = crypto.randomUUID();
    const payload = request(ORG_A, a.patient);
    await deliver(ORG_A, payload, secondId);
    await admin.query("UPDATE triage_call SET state = 'abandoned' WHERE organization_id = $1", [
      ORG_A,
    ]);
    await deliver(ORG_A, payload, secondId);

    expect(await calls(ORG_A)).toHaveLength(1);
    const answers = await outcomes(ORG_A);
    expect(answers.map((e) => e.payload.outcome)).toEqual(["opened", "coalesced"]);
  });

  it("a redelivery of a NO_COVERAGE request emits no second coverage_gap or outcome, even if a shift appeared", async () => {
    const a = seeded[ORG_A] as Seed;
    const eventId = crypto.randomUUID();
    const payload = request(ORG_A, a.patient);
    await deliver(ORG_A, payload, eventId);
    await seedShift(ORG_A);
    await deliver(ORG_A, payload, eventId);

    expect(await calls(ORG_A)).toHaveLength(0);
    expect((await events(ORG_A)).map((e) => e.event_type).sort()).toEqual([
      "m19.afterhours_triage.outcome",
      "m19.oncall_shift.coverage_gap",
    ]);
  });

  it("a HUMAN-opened open call for the same patient does not block, and is not swallowed by, the request", async () => {
    const shiftId = await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    // No unique constraint other than `triage_call_source_dedupe_uq` exists on triage_call (the
    // `triage_call_open_per_pe_uq` named in an old comment was never created): a manual call carries a NULL
    // source_outbox_event_id, so it is neither a conflict nor a coalesce target.
    await admin.query(
      `INSERT INTO triage_call (organization_id, provider_entity_id, on_call_shift_id, patient_id,
         caller_kind, inbound_channel, source, opened_at)
       VALUES ($1,$2,$3,$4,'caregiver','phone','manual',$5)`,
      [ORG_A, a.pe, shiftId, a.patient, new Date(NOW.getTime() - 600_000)],
    );
    await deliver(ORG_A, request(ORG_A, a.patient));

    const rows = await calls(ORG_A);
    expect(rows.map((r) => r.source).sort()).toEqual(["m36_afterhours_request", "manual"]);
    expect((await outcomes(ORG_A)).map((e) => e.payload.outcome)).toEqual(["opened"]);
  });

  it("a different patient is not coalesced", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    await deliver(ORG_A, request(ORG_A, a.patient));
    await deliver(ORG_A, request(ORG_A, a.patient2));
    expect(await calls(ORG_A)).toHaveLength(2);
  });

  it("with no covering shift it opens nothing, publishes the coverage gap, and still answers `no_coverage`", async () => {
    const a = seeded[ORG_A] as Seed;
    const eventId = crypto.randomUUID();
    await deliver(ORG_A, request(ORG_A, a.patient), eventId);

    expect(await calls(ORG_A)).toHaveLength(0);
    const published = await events(ORG_A);
    expect(published.map((e) => e.event_type).sort()).toEqual([
      "m19.afterhours_triage.outcome",
      "m19.oncall_shift.coverage_gap",
    ]);
    expect(
      published.find((e) => e.event_type === "m19.afterhours_triage.outcome")?.payload,
    ).toEqual({
      sourceOutboxEventId: eventId,
      triageCallId: null,
      outcome: "no_coverage",
    });
  });

  it("two CONCURRENT deliveries of one no_coverage event publish exactly one outcome and one gap", async () => {
    const a = seeded[ORG_A] as Seed;
    const eventId = crypto.randomUUID();
    const payload = request(ORG_A, a.patient);
    const settled = await Promise.allSettled([
      deliver(ORG_A, payload, eventId),
      deliver(ORG_A, payload, eventId),
    ]);
    // Interleaving is not forced here (the deterministic test below does that): the loser either skipped on
    // the winner's row (fulfilled) or lost the insert and was rejected. Never two rejections, never two answers.
    expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(settled.filter((s) => s.status === "rejected").length).toBeLessThanOrEqual(1);
    // A retry of a rejected delivery is a skip.
    await deliver(ORG_A, payload, eventId);

    expect(await calls(ORG_A)).toHaveLength(0);
    expect((await events(ORG_A)).map((e) => e.event_type).sort()).toEqual([
      "m19.afterhours_triage.outcome",
      "m19.oncall_shift.coverage_gap",
    ]);
  });

  /** A consumer whose open-call lookup (read AFTER the replay guard) first lets a rival commit its decision. */
  const raceConsumer = (rivalOutcome: "no_coverage" | "coalesced", eventId: string, callId: string | null) => {
    const real = createDrizzleInboundTriggerPorts(handle.db);
    return makeConsumer({
      ...real,
      findOpenMachineCallForPatient: async (...args: Parameters<typeof real.findOpenMachineCallForPatient>) => {
        const found = await real.findOpenMachineCallForPatient(...args);
        await admin.query(
          `INSERT INTO triage_afterhours_decision (organization_id, source_outbox_event_id, triage_call_id, outcome)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [ORG_A, eventId, callId, rivalOutcome],
        );
        return found;
      },
    });
  };
  const deliverVia = (c: typeof consumer, payload: Record<string, unknown>, eventId: string) =>
    c.handle({
      id: eventId,
      organizationId: ORG_A,
      eventType: "m36.afterhours_triage.requested",
      aggregateKind: "message",
      aggregateId: String(payload.messageId),
      payload,
    } as never);

  it("DETERMINISTIC: a rival decision committed after our read makes a no_coverage delivery reject and roll back (no outcome, no gap)", async () => {
    const a = seeded[ORG_A] as Seed;
    const eventId = crypto.randomUUID();
    await expect(
      deliverVia(raceConsumer("no_coverage", eventId, null), request(ORG_A, a.patient), eventId),
    ).rejects.toThrow(/already recorded by a concurrent delivery/);

    expect(await calls(ORG_A)).toHaveLength(0);
    expect(await events(ORG_A)).toHaveLength(0);
  });

  it("DETERMINISTIC: the same for a coalesced delivery - rejected, nothing published, the open call untouched", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    await deliver(ORG_A, request(ORG_A, a.patient));
    const [open] = await calls(ORG_A);
    const before = await events(ORG_A);
    const eventId = crypto.randomUUID();
    await expect(
      deliverVia(raceConsumer("coalesced", eventId, open.id), request(ORG_A, a.patient), eventId),
    ).rejects.toThrow(/already recorded by a concurrent delivery/);

    expect(await calls(ORG_A)).toHaveLength(1);
    expect(await events(ORG_A)).toHaveLength(before.length);
  });

  it("two CONCURRENT deliveries of one opening event open one call and publish one outcome", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    const eventId = crypto.randomUUID();
    const payload = request(ORG_A, a.patient);
    await Promise.allSettled([deliver(ORG_A, payload, eventId), deliver(ORG_A, payload, eventId)]);
    await deliver(ORG_A, payload, eventId);

    expect(await calls(ORG_A)).toHaveLength(1);
    expect(await outcomes(ORG_A)).toHaveLength(1);
  });

  it("a patient with no resolvable provider entity is answered `no_coverage` with no gap event, never silently dropped", async () => {
    const extraPe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-A47-extra','A47 extra','NPI-A47-extra','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    const orphan = (
      await admin.query(
        `INSERT INTO patient (organization_id, provider_entity_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,NULL,'MRN-A47-orphan','Af','Hours','1990-01-01','M','active') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    try {
      await seedShift(ORG_A);
      const eventId = crypto.randomUUID();
      await deliver(ORG_A, request(ORG_A, orphan), eventId);

      expect(await calls(ORG_A)).toHaveLength(0);
      expect((await events(ORG_A)).map((e) => e.event_type)).toEqual([
        "m19.afterhours_triage.outcome",
      ]);
      expect((await outcomes(ORG_A))[0]?.payload).toEqual({
        sourceOutboxEventId: eventId,
        triageCallId: null,
        outcome: "no_coverage",
      });
    } finally {
      await admin.query("DELETE FROM outbox_event");
      await admin.query("DELETE FROM patient WHERE id = $1", [orphan]);
      await admin.query("DELETE FROM provider_entity WHERE id = $1", [extraPe]);
    }
  });

  it("refuses another tenant's patient: nothing opened, nothing published, in either org", async () => {
    await seedShift(ORG_A);
    await seedShift(ORG_B);
    const a = seeded[ORG_A] as Seed;
    const b = seeded[ORG_B] as Seed;

    // Org B's envelope naming org A's patient, and the mirror image.
    await expect(deliver(ORG_B, request(ORG_B, a.patient))).rejects.toMatchObject({
      code: "AFTERHOURS_PATIENT_NOT_IN_ORG",
    });
    await expect(deliver(ORG_A, request(ORG_A, b.patient))).rejects.toMatchObject({
      code: "AFTERHOURS_PATIENT_NOT_IN_ORG",
    });
    // An unknown patient is indistinguishable from a foreign one.
    await expect(deliver(ORG_A, request(ORG_A, crypto.randomUUID()))).rejects.toMatchObject({
      code: "AFTERHOURS_PATIENT_NOT_IN_ORG",
    });

    for (const org of [ORG_A, ORG_B]) {
      expect(await calls(org)).toHaveLength(0);
      expect(await events(org)).toHaveLength(0);
    }
  });

  it("takes the organization from the envelope and never copies message text", async () => {
    await seedShift(ORG_A);
    const a = seeded[ORG_A] as Seed;
    await deliver(ORG_A, {
      ...request(ORG_A, a.patient),
      // A payload that lies about its tenant and carries text: both must be inert.
      organizationId: ORG_B,
      body: SECRET,
      text: SECRET,
      chiefComplaint: SECRET,
    });

    expect(await calls(ORG_A)).toHaveLength(1);
    expect(await calls(ORG_B)).toHaveLength(0);
    const dump = JSON.stringify([
      (await admin.query("SELECT * FROM triage_call")).rows,
      (await admin.query("SELECT * FROM outbox_event")).rows,
      (await admin.query("SELECT * FROM triage_call_state_history")).rows,
    ]);
    expect(dump).not.toContain(SECRET);
  });
});
