/**
 * F-043 (#103) — M19's D10 inbound triggers are bound, and a proactive triage call can finally be opened.
 *
 * THE FINDING. `consumers/m17-no-show.ts` and `consumers/m18-late-checkout.ts` are complete deciders over
 * the shared `consumers/inbound-trigger.ts` core, and `consumers/trigger-context.ts` resolves their facts
 * through M17's seam. No factory anywhere yielded an `OutboxConsumerBinding` for either, so their only
 * caller was `oncall-consumers.test.ts` and the relay deferred both triggers forever.
 *
 * WHAT THAT MEANT. `triage_call.source` has six enum values and the module's two live insert paths
 * hardcode `manual` and `paper_origin` — so `no_show`, `late_checkout`, `m36_delivery_failure` and
 * `geofence_anomaly` were unreachable, and `source_outbox_event_id`, the column D10's redelivery guard
 * `triage_call_source_dedupe_uq` is built on, had never been written by anything. NO PROACTIVE TRIAGE CALL
 * HAD EVER BEEN OPENED. A clinician who never arrived at a dying patient's home, and one who never checked
 * out of it, each raised an event the relay re-claimed every thirty minutes and delivered to nobody.
 *
 * It also gives `m19.oncall_shift.coverage_gap` its first producer — `events-by-m19.ts` says so in its own
 * header ("never actually published anywhere in this codebase yet").
 *
 * WHY LIVE. Every claim is about Postgres or about RLS. The redelivery guard is a partial unique index;
 * the coalesce grain is a predicate over `state` and `source_outbox_event_id`; `on_call_shift_id` is NOT
 * NULL, which is the whole reason `no_coverage` exists as an outcome rather than a throw; and
 * `readTriggerVisit` reaches M17's seam, whose store pins the tenant from the ambient scope the binding
 * establishes — a double proves none of it.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m19:inbound-triggers:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSchedulingSeams } from "../src/modules/17-scheduling/index";
import { createDrizzleSchedulingSeamStore } from "../src/modules/17-scheduling/seams/drizzle-store";
import {
  M19_OUTBOX_EVENTS,
  buildOncallTriggerConsumers,
  createDrizzleInboundTriggerPorts,
} from "../src/modules/19-oncall/index";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f0430a19";
const ORG_B = "22222222-2222-4222-8222-2222f0430b19";
const PATIENT = "44444444-4444-4444-8444-4444f0430419";
const PATIENT_2 = "44444444-4444-4444-8444-4444f0430420";
const ADMISSION = "55555555-5555-4555-8555-5555f0430519";

/** The visit window, and the trigger instant an hour into it. */
const START = new Date("2026-09-02T18:00:00.000Z");
const END = new Date("2026-09-02T19:00:00.000Z");
const TRIGGER_AT = new Date("2026-09-02T19:30:00.000Z");

type Seed = { pe: string; location: string; member: string };

describe.skipIf(!DB_URL)("F-043 M19 D10 inbound triggers — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let consumers: readonly ReturnType<typeof buildOncallTriggerConsumers>[number][];
  const seeded: Record<string, Seed> = {};

  const consumerFor = (eventType: string) => {
    const found = consumers.find((c) => c.eventTypes.includes(eventType));
    if (!found) throw new Error(`no M19 binding for '${eventType}'`);
    return found;
  };

  const deliver = (
    eventType: string,
    organizationId: string,
    payload: Record<string, unknown>,
    eventId = crypto.randomUUID(),
  ) =>
    consumerFor(eventType).handle({
      id: eventId,
      organizationId,
      eventType,
      aggregateKind: "visit",
      aggregateId: String(payload.visitId ?? ""),
      payload,
      attemptCount: 1,
      createdAt: new Date(),
    });

  async function callsFor(org: string) {
    const { rows } = await admin.query(
      `SELECT id, source, state, caller_kind, inbound_channel, chief_complaint_text,
              source_outbox_event_id, patient_id, on_call_shift_id, first_response_at
         FROM triage_call WHERE organization_id = $1 ORDER BY opened_at`,
      [org],
    );
    return rows;
  }

  async function applyMigrations() {
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
  }

  async function seedVisit(org: string, patientId = PATIENT): Promise<string> {
    const s = seeded[org] as Seed;
    const { rows } = await admin.query(
      `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
         assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
         scheduled_started_at, scheduled_ended_at, service_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',$7,$8,'2026-09-02','proposed')
       RETURNING id`,
      [org, s.pe, s.location, patientId, ADMISSION, s.member, START, END],
    );
    return rows[0].id as string;
  }

  /** An RN shift covering the trigger instant. `status` defaults to `scheduled`. */
  async function seedShift(org: string, status = "active"): Promise<string> {
    const s = seeded[org] as Seed;
    const { rows } = await admin.query(
      `INSERT INTO on_call_shift (organization_id, provider_entity_id, shift_starts_at, shift_ends_at,
         discipline, primary_on_call_membership_id, policy_snapshot, status, opened_at)
       VALUES ($1,$2,$3,$4,'clinical_rn',$5,'{}'::jsonb,$6,$7) RETURNING id`,
      [
        org,
        s.pe,
        new Date(TRIGGER_AT.getTime() - 3_600_000),
        new Date(TRIGGER_AT.getTime() + 3_600_000),
        s.member,
        status,
        status === "active" ? new Date(TRIGGER_AT.getTime() - 3_600_000) : null,
      ],
    );
    return rows[0].id as string;
  }

  const noShowPayload = (visitId: string, org: string) => ({
    visitId,
    patientId: PATIENT,
    clinicianMembershipId: (seeded[org] as Seed).member,
    scheduledStartedAt: START.toISOString(),
    reason: "clinician reported vehicle breakdown",
  });

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
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f043m19-a','A','A','active'),($2,'f043m19-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `f043m19-${n++}@x.test`,
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
            `CCN-M19T-${org.slice(0, 4)}`,
            `M19T ${org.slice(0, 4)}`,
            `NPI-M19T-${org.slice(0, 4)}`,
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
      seeded[org] = { pe, location, member };
    }

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // The REAL M17 seam over the same NOBYPASSRLS pool: `readTriggerVisit` goes through it and it pins
    // the tenant from the ambient scope each binding establishes.
    registerSchedulingSeams({ store: createDrizzleSchedulingSeamStore(handle.db) });

    const txPublisher = buildTxOutboxPublisher(
      buildBootOutboxCatalog([M19_OUTBOX_EVENTS, M36_OUTBOX_EVENTS]),
    );
    const triggerPorts = createDrizzleInboundTriggerPorts(handle.db);
    consumers = buildOncallTriggerConsumers({
      db: handle.db,
      ports: triggerPorts,
      deliveryPorts: triggerPorts,
      outbox: {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m19" }),
      },
      now: () => TRIGGER_AT,
    });
  }, 180_000);

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

  it("binds both §4.8 D10 triggers plus the M36 delivery-failure trigger, and each names m19", () => {
    expect(consumers.flatMap((c) => c.eventTypes).sort()).toEqual([
      "m17.visit.no_show_detected",
      "m18.evv.late_check_out_detected",
      "m36.notification.delivery_failed",
    ]);
    for (const c of consumers) expect(c.consumerModule).toBe("m19");
  });

  it("a no-show opens a machine welfare call — the FIRST non-manual source this table has held", async () => {
    const shiftId = await seedShift(ORG_A);
    const visitId = await seedVisit(ORG_A);
    const eventId = crypto.randomUUID();
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(visitId, ORG_A), eventId);

    const calls = await callsFor(ORG_A);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("no_show");
    expect(calls[0].caller_kind).toBe("system_inbound");
    expect(calls[0].inbound_channel).toBe("inbound_visit_failure");
    expect(calls[0].on_call_shift_id).toBe(shiftId);
    expect(calls[0].patient_id).toBe(PATIENT);
    expect(calls[0].source_outbox_event_id).toBe(eventId);
    // §7.6's frozen platform string, NOT M17's `reason` free text — which would put a second unscrubbed
    // copy of another module's prose in a §3.6-denylisted column and tell the nurse the scheduler's
    // problem instead of the patient's.
    expect(calls[0].chief_complaint_text).toBe("Visit missed; check on patient.");
    // `machineOpened: true` sets no `first_response_at`: nobody has responded yet.
    expect(calls[0].first_response_at).toBeNull();
  });

  it("emits m19.triage_call.opened for the machine-opened call", async () => {
    await seedShift(ORG_A);
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(visitId, ORG_A));
    const { rows } = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE organization_id=$1",
      [ORG_A],
    );
    expect(rows.map((r) => r.event_type)).toEqual(["m19.triage_call.opened"]);
    expect(rows[0].payload.source).toBe("no_show");
    expect(rows[0].payload.paperOrigin).toBe(false);
  });

  it("writes the §2.4 state-history row with systemActor and no membership", async () => {
    await seedShift(ORG_A);
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(visitId, ORG_A));
    const { rows } = await admin.query(
      "SELECT from_state, to_state, system_actor, actor_membership_id FROM triage_call_state_history WHERE organization_id=$1",
      [ORG_A],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].to_state).toBe("open");
    expect(rows[0].system_actor).toBe(true);
    expect(rows[0].actor_membership_id).toBeNull();
  });

  it("a redelivery of the same event writes nothing — D10's `triage_call_source_dedupe_uq`", async () => {
    await seedShift(ORG_A);
    const visitId = await seedVisit(ORG_A);
    const eventId = crypto.randomUUID();
    const payload = noShowPayload(visitId, ORG_A);
    await deliver("m17.visit.no_show_detected", ORG_A, payload, eventId);
    await admin.query("DELETE FROM outbox_event");
    await deliver("m17.visit.no_show_detected", ORG_A, payload, eventId);

    expect(await callsFor(ORG_A)).toHaveLength(1);
    // No second page, either: a redelivery must never re-emit.
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM outbox_event");
    expect(rows[0].n).toBe(0);
  });

  it("a DIFFERENT trigger about the same patient coalesces rather than paging twice", async () => {
    await seedShift(ORG_A);
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(visitId, ORG_A));
    // M18 noticed the same night from the other side. Two distinct event ids, one patient.
    await deliver("m18.evv.late_check_out_detected", ORG_A, {
      visitId,
      missingResolutionId: crypto.randomUUID(),
      hoursPastGrace: 2,
      hasCheckIn: true,
    });
    expect(await callsFor(ORG_A)).toHaveLength(1);
  });

  it("a second patient's trigger is NOT coalesced — the grain is the patient, not the org", async () => {
    await seedShift(ORG_A);
    const first = await seedVisit(ORG_A);
    const second = await seedVisit(ORG_A, PATIENT_2);
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(first, ORG_A));
    await deliver("m17.visit.no_show_detected", ORG_A, {
      ...noShowPayload(second, ORG_A),
      patientId: PATIENT_2,
    });
    const calls = await callsFor(ORG_A);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.patient_id))).toEqual(new Set([PATIENT, PATIENT_2]));
  });

  it("a MANUAL call about the same patient does not swallow the machine's welfare check", async () => {
    const shiftId = await seedShift(ORG_A);
    const s = seeded[ORG_A] as Seed;
    // A caregiver rang in an hour ago. That nurse does not know a clinician has since failed to arrive.
    await admin.query(
      `INSERT INTO triage_call (organization_id, provider_entity_id, on_call_shift_id, patient_id,
         caller_kind, inbound_channel, source, opened_at)
       VALUES ($1,$2,$3,$4,'caregiver','phone','manual',$5)`,
      [ORG_A, s.pe, shiftId, PATIENT, new Date(TRIGGER_AT.getTime() - 3_600_000)],
    );
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(visitId, ORG_A));
    const calls = await callsFor(ORG_A);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.source).sort()).toEqual(["manual", "no_show"]);
  });

  it("no covering shift emits the coverage gap INSTEAD of a call — its first producer ever", async () => {
    // §7.6's own scenario: a 14:00 visit whose no-show is detected at 15:00, at an agency that only
    // staffs nights. `on_call_shift_id` is NOT NULL, so the call cannot be written; throwing would park a
    // patient welfare check in a DLQ where nobody clinical will see it.
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(visitId, ORG_A));

    expect(await callsFor(ORG_A)).toHaveLength(0);
    const { rows } = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE organization_id=$1",
      [ORG_A],
    );
    expect(rows.map((r) => r.event_type)).toEqual(["m19.oncall_shift.coverage_gap"]);
    expect(rows[0].payload.discipline).toBe("clinical_rn");
    expect(rows[0].payload.providerEntityId).toBe((seeded[ORG_A] as Seed).pe);
    // A zero-length gap would render as "no coverage, for no time" — with nothing scheduled the window
    // runs to the end of §4.8's 24-hour lookahead.
    expect(Date.parse(rows[0].payload.gapEndsAt)).toBeGreaterThan(
      Date.parse(rows[0].payload.gapStartsAt),
    );
  });

  it("a late check-out opens its own welfare call under the right source and channel", async () => {
    await seedShift(ORG_A);
    const visitId = await seedVisit(ORG_A);
    await deliver("m18.evv.late_check_out_detected", ORG_A, {
      visitId,
      missingResolutionId: crypto.randomUUID(),
      hoursPastGrace: 3,
      hasCheckIn: true,
    });
    const calls = await callsFor(ORG_A);
    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe("late_checkout");
    expect(calls[0].inbound_channel).toBe("inbound_evv_anomaly");
  });

  it("org A's relay cannot open a call against org B's visit — RLS answers 'no such visit'", async () => {
    await seedShift(ORG_A);
    const visitB = await seedVisit(ORG_B);
    // The payload names org B's visit; the outbox row is org A's, so the seam read runs in org A's scope
    // and resolves nothing. `TRIGGER_VISIT_UNRESOLVED` dead-letters rather than writing a guessed anchor.
    await expect(
      deliver("m17.visit.no_show_detected", ORG_A, {
        ...noShowPayload(visitB, ORG_A),
      }),
    ).rejects.toThrow(/TRIGGER_VISIT_UNRESOLVED|resolved no visit/);
    expect(await callsFor(ORG_A)).toHaveLength(0);
    expect(await callsFor(ORG_B)).toHaveLength(0);
  });

  it("each org's trigger writes its own tenant's call only", async () => {
    await seedShift(ORG_A);
    await seedShift(ORG_B);
    const visitA = await seedVisit(ORG_A);
    const visitB = await seedVisit(ORG_B);
    await deliver("m17.visit.no_show_detected", ORG_A, noShowPayload(visitA, ORG_A));
    await deliver("m17.visit.no_show_detected", ORG_B, noShowPayload(visitB, ORG_B));
    expect(await callsFor(ORG_A)).toHaveLength(1);
    expect(await callsFor(ORG_B)).toHaveLength(1);
  });

  // ── #205 M36 follow-up — the §4.8 delivery-failure trigger (no producer exists yet; see
  // events-by-m36.ts's header) ───────────────────────────────────────────────────────────────────────
  describe("§4.8 M36 delivery-failure trigger", () => {
    async function seedOpenCall(org: string, shiftId: string): Promise<string> {
      const s = seeded[org] as Seed;
      const { rows } = await admin.query(
        `INSERT INTO triage_call
           (organization_id, provider_entity_id, on_call_shift_id, caller_kind, inbound_channel, source,
            chief_complaint_text, opened_at, state)
         VALUES ($1,$2,$3,'system_inbound','inbound_alert_failure','m36_delivery_failure','test call',$4,'open')
         RETURNING id`,
        [org, s.pe, shiftId, TRIGGER_AT],
      );
      return rows[0].id as string;
    }

    const deliveryFailedPayload = (input: {
      recipientKind: string;
      providerEntityId: string | null;
      alertEventType: string | null;
      sourceAggregateId: string | null;
    }) => ({
      notificationId: crypto.randomUUID(),
      organizationId: ORG_A,
      channel: "sms",
      failureReason: "vendor_timeout",
      failedAt: TRIGGER_AT.toISOString(),
      recipientKind: input.recipientKind,
      recipientMembershipId: null,
      providerEntityId: input.providerEntityId,
      alertEventType: input.alertEventType,
      sourceAggregateId: input.sourceAggregateId,
    });

    it("ignores a non-on-call recipient", async () => {
      await seedShift(ORG_A);
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "role_set",
          providerEntityId: (seeded[ORG_A] as Seed).pe,
          alertEventType: null,
          sourceAggregateId: null,
        }),
      );
      expect(await callsFor(ORG_A)).toHaveLength(0);
      const { rows } = await admin.query(
        "SELECT id FROM triage_escalation WHERE organization_id=$1",
        [ORG_A],
      );
      expect(rows).toHaveLength(0);
    });

    it("escalates an already-open call one rung at sla_breach, to the covering shift's primary", async () => {
      const shiftId = await seedShift(ORG_A);
      const callId = await seedOpenCall(ORG_A, shiftId);
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          providerEntityId: (seeded[ORG_A] as Seed).pe,
          alertEventType: "m19.triage.case_opened",
          sourceAggregateId: callId,
        }),
      );
      const { rows } = await admin.query(
        "SELECT tier, trigger_kind, trigger_detail, escalated_to_membership_id FROM triage_escalation WHERE triage_call_id=$1",
        [callId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tier: "tier_1_rn_supervisor",
        trigger_kind: "sla_breach",
        trigger_detail: "m36.notification.delivery_failed",
        escalated_to_membership_id: (seeded[ORG_A] as Seed).member,
      });
      // No new triage_call was opened — the existing one was escalated, not duplicated.
      expect(await callsFor(ORG_A)).toHaveLength(1);
    });

    it("REPORTED, NOT FIXED: a redelivery double-escalates (the decider's §2.6 guard covers new calls, not escalate_existing)", async () => {
      const shiftId = await seedShift(ORG_A);
      const callId = await seedOpenCall(ORG_A, shiftId);
      const eventId = crypto.randomUUID();
      const payload = deliveryFailedPayload({
        recipientKind: "on_call",
        providerEntityId: (seeded[ORG_A] as Seed).pe,
        alertEventType: "m19.triage.case_opened",
        sourceAggregateId: callId,
      });
      await deliver("m36.notification.delivery_failed", ORG_A, payload, eventId);
      await deliver("m36.notification.delivery_failed", ORG_A, payload, eventId);
      // `findCallBySourceEvent` (the decider's redelivery guard) matches on `triage_call
      // .source_outbox_event_id`, which `escalate_existing` never writes — no NEW call is opened, so
      // there is nothing for the guard to find. A relay redelivery of the SAME outbox row (retried after
      // a timeout, a replica restart) therefore escalates a second time. Out of scope to fix here (the
      // decider's own logic, not this pass's wiring), and worth flagging: this pins the finding rather
      // than hiding it behind a loose assertion.
      const { rows } = await admin.query(
        "SELECT id FROM triage_escalation WHERE triage_call_id=$1",
        [callId],
      );
      expect(rows).toHaveLength(2);
    });

    it("opens a patient-less operational call when no call is named, anchored to the covering shift", async () => {
      const shiftId = await seedShift(ORG_A);
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          providerEntityId: (seeded[ORG_A] as Seed).pe,
          alertEventType: null,
          sourceAggregateId: null,
        }),
      );
      const calls = await callsFor(ORG_A);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        source: "m36_delivery_failure",
        inbound_channel: "inbound_alert_failure",
        caller_kind: "system_inbound",
        patient_id: null,
        on_call_shift_id: shiftId,
      });
    });

    it("no coverage → publishes the coverage gap instead of a patient-less call", async () => {
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          providerEntityId: (seeded[ORG_A] as Seed).pe,
          alertEventType: null,
          sourceAggregateId: null,
        }),
      );
      expect(await callsFor(ORG_A)).toHaveLength(0);
      const { rows } = await admin.query(
        "SELECT event_type FROM outbox_event WHERE organization_id=$1",
        [ORG_A],
      );
      expect(rows.map((r) => r.event_type)).toEqual(["m19.oncall_shift.coverage_gap"]);
    });

    it("an aggregate id from a NON-m19 alert is never trusted as a triage_call id", async () => {
      const shiftId = await seedShift(ORG_A);
      const callId = await seedOpenCall(ORG_A, shiftId);
      // Named as if it were the open call, but `alertEventType` says the failed page was M20's — the
      // decider must not escalate a call it was never told about.
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          providerEntityId: (seeded[ORG_A] as Seed).pe,
          alertEventType: "m20.safety.sos_alert_raised",
          sourceAggregateId: callId,
        }),
      );
      const { rows } = await admin.query(
        "SELECT id FROM triage_escalation WHERE triage_call_id=$1",
        [callId],
      );
      expect(rows).toHaveLength(0);
      // Falls through to the operational-call path instead of trusting the aggregate id (no coverage
      // gap here: a shift IS seeded) — a SECOND call, beside the one `seedOpenCall` already wrote.
      expect(await callsFor(ORG_A)).toHaveLength(2);
    });
  });
});
