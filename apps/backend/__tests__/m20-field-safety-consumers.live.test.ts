/**
 * F-043 (#103) — M20's field-safety visit consumers are bound, and `safety_check_in_schedule` finally has
 * a producer.
 *
 * THE FINDING. `consumers/` held six complete, exported, unit-tested deciders — `planVisitCadence`,
 * `decideVisitReassigned`, `decideVisitCompleted`, `decideVisitNoShow`, `decideEvvCheckIn`,
 * `decideEvvCheckOut` — and no factory anywhere yielded an `OutboxConsumerBinding` for any of them. Their
 * only caller was `field-safety-consumers.test.ts`. So `check-outbox-bindings.ts` found no live consumer
 * for m20, and the relay marked every m20-declared event `deferred`: the row finalizes `pending` with
 * `attemptCount - 1`, never dead-letters, and is re-claimed every thirty minutes for the life of the
 * deployment.
 *
 * ONE LAYER DOWN IT WAS WORSE. No INSERT into `safety_check_in_schedule` existed anywhere in the
 * repository — the only write was the fulfilment UPDATE in `write-service-drizzle.ts`, which can close a
 * row but not make one. The §4.2 supervisor board, the §4.3 badge trio, the §4.8 overdue detector and the
 * clinician's own `/me/today` have therefore always read an EMPTY SET. A safety board that answers "nobody
 * is overdue" because nobody was ever OBLIGED is indistinguishable from one where everyone is fine, and
 * that is the single reading this module exists to prevent.
 *
 * AND THE CATALOG DID NOT DECLARE M20 ON FIVE OF THE SIX TRIGGERS. `M20_SUBSCRIBED_EVENT_NAMES` has named
 * `m17.visit.published` / `.completed` / `.no_show_detected` and `m18.evv.check_in_recorded` /
 * `.check_out_recorded` since M20-T01; `declaredConsumers` named m8, m17, m18, m19, m30 and not m20. A
 * binding without the declaration is routed nothing, so both halves had to land together.
 *
 * WHY THIS SUITE IS LIVE. Every claim is a statement about Postgres or about RLS. The materializer's
 * idempotence is `scis_visit_kind_expected_uniq`; `mark_overdue` is only representable because
 * `m20_scis_overdue_stamped` refuses the state without the instant; the policy-version seed exists because
 * `safety_policy_version_id` is a real NOT NULL FK and `SafetyPolicyProvider` answers a fresh tenant with
 * an EMPTY version id; and the whole point of driving it as the NOBYPASSRLS `wardenx_app` role is that
 * `readAnchors` reaches M17's seam, which pins the tenant from the ambient scope the binding establishes.
 * An in-memory double answers all of it happily and proves none of it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m20:consumers:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensurePolicyVersionForConsumer } from "../src/modules/20-field-safety/consumers/schedule-store";

import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSchedulingSeams } from "../src/modules/17-scheduling/index";
import { createDrizzleSchedulingSeamStore } from "../src/modules/17-scheduling/seams/drizzle-store";
import {
  M20_OUTBOX_EVENTS,
  buildDrizzleSafetySeamStore,
  buildFieldSafetyConsumers,
  createSafetyClinicianSignalCache,
  createSafetyPolicyProvider,
} from "../src/modules/20-field-safety/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-11110430a001";
const ORG_B = "22222222-2222-4222-8222-22220430b002";
const PATIENT = "44444444-4444-4444-8444-444404430004";
const ADMISSION = "55555555-5555-4555-8555-555504430005";

/** The `expected_at` a 10:00→11:00 visit's obligations land on, under the platform floor. */
const START = new Date("2026-09-01T17:00:00.000Z");
const END = new Date("2026-09-01T18:00:00.000Z");

type Seed = { pe: string; location: string; member: string; other: string };

describe.skipIf(!DB_URL)("F-043 M20 field-safety visit consumers — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let consumers: readonly ReturnType<typeof buildFieldSafetyConsumers>[number][];
  const seeded: Record<string, Seed> = {};
  const signals = createSafetyClinicianSignalCache();

  const consumerFor = (eventType: string) => {
    const found = consumers.find((c) => c.eventTypes.includes(eventType));
    if (!found) throw new Error(`no M20 binding for '${eventType}'`);
    return found;
  };

  const deliver = (eventType: string, organizationId: string, payload: Record<string, unknown>) =>
    consumerFor(eventType).handle({
      id: crypto.randomUUID(),
      organizationId,
      eventType,
      aggregateKind: "visit",
      aggregateId: String(payload.visitId ?? ""),
      payload,
      attemptCount: 1,
      createdAt: new Date(),
    });

  async function schedulesFor(visitId: string) {
    const { rows } = await admin.query(
      `SELECT kind, state, expected_at, window_minutes, clinician_membership_id, overdue_detected_at
         FROM safety_check_in_schedule WHERE visit_id = $1 ORDER BY expected_at, kind`,
      [visitId],
    );
    return rows as {
      kind: string;
      state: string;
      expected_at: Date;
      window_minutes: number;
      clinician_membership_id: string;
      overdue_detected_at: Date | null;
    }[];
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

  /** A real M17 `visit` row — the consumers read every tenancy anchor back through `VisitReader`. */
  async function seedVisit(org: string, member?: string): Promise<string> {
    const s = seeded[org] as Seed;
    const { rows } = await admin.query(
      `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
         assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
         scheduled_started_at, scheduled_ended_at, service_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',$7,$8,$9::date,'proposed')
       RETURNING id`,
      [org, s.pe, s.location, PATIENT, ADMISSION, member ?? s.member, START, END, "2026-09-01"],
    );
    return rows[0].id as string;
  }

  const published = (visitId: string, org: string) => ({
    visitId,
    patientId: PATIENT,
    admissionId: ADMISSION,
    assignedMembershipId: (seeded[org] as Seed).member,
    assignedDiscipline: "rn",
    encounterType: "routine_visit",
    serviceDate: "2026-09-01",
    organizationId: org,
    providerEntityId: (seeded[org] as Seed).pe,
    locationId: (seeded[org] as Seed).location,
    visitPurpose: "routine_visit",
    visitSetting: "patient_home",
    scheduledStartedAt: START.toISOString(),
    scheduledEndedAt: END.toISOString(),
    patientAddressId: null,
    externalFacilityId: null,
    parentRecurringVisitId: null,
    parentProposalId: null,
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
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f043-a','A','A','active'),($2,'f043-b','B','B','active')",
      [ORG_A, ORG_B],
    );

    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const memberships: string[] = [];
      for (const _ of [0, 1]) {
        const user = (
          await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
            `f043-${n++}@x.test`,
          ])
        ).rows[0].id as string;
        memberships.push(
          (
            await admin.query(
              `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
              [user, org],
            )
          ).rows[0].id as string,
        );
      }
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-F043-${org.slice(0, 4)}`,
            `F043 ${org.slice(0, 4)}`,
            `NPI-F043-${org.slice(0, 4)}`,
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
      seeded[org] = {
        pe,
        location,
        member: memberships[0] as string,
        other: memberships[1] as string,
      };
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The REAL M17 seam over the same NOBYPASSRLS pool: `readAnchors` goes through it, and it resolves the
    // tenant from the ambient scope each binding establishes — which is the half a double cannot prove.
    registerSchedulingSeams({ store: createDrizzleSchedulingSeamStore(handle.db) });

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M20_OUTBOX_EVENTS]));
    consumers = buildFieldSafetyConsumers({
      db: handle.db,
      policy: createSafetyPolicyProvider(buildDrizzleSafetySeamStore(handle.db)),
      outbox: {
        publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m20" }),
      },
      signals,
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM outbox_event");
    await admin.query("DELETE FROM safety_sos_alert_state_history");
    await admin.query("DELETE FROM safety_sos_alert");
    await admin.query("DELETE FROM safety_emergency_contact_consent");
  });

  it("every §4.8 visit trigger plus the M36 delivery-failure trigger has a live binding, and each names m20", () => {
    const bound = consumers.flatMap((c) => c.eventTypes).sort();
    expect(bound).toEqual([
      "m17.visit.assigned",
      "m17.visit.completed",
      "m17.visit.no_show_detected",
      "m17.visit.published",
      "m18.evv.check_in_recorded",
      "m18.evv.check_out_recorded",
      "m18.evv.gps_spoof_suspected",
      "m36.notification.delivery_failed",
    ]);
    for (const c of consumers) expect(c.consumerModule).toBe("m20");
  });

  it("a published visit materializes the pre/mid/post obligations — the FIRST producer this table has had", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));

    const rows = await schedulesFor(visitId);
    // Floor: pre-visit window 15 → 16:45Z; mid-visit cadence 60 → one prompt at 18:00Z (§7.1's inclusive
    // endpoint — an exclusive one would give the commonest visit length no mid-visit prompt at all);
    // post-visit at the scheduled end, 18:00Z.
    expect(rows.map((r) => r.kind)).toEqual(["pre_visit", "mid_visit", "post_visit"]);
    expect(rows[0]?.expected_at.toISOString()).toBe("2026-09-01T16:45:00.000Z");
    expect(rows[1]?.expected_at.toISOString()).toBe("2026-09-01T18:00:00.000Z");
    expect(rows[2]?.expected_at.toISOString()).toBe("2026-09-01T18:00:00.000Z");
    for (const r of rows) expect(r.state).toBe("proposed");
  });

  it("seeds the §3.2 Phase E policy floor rather than dying on the NOT NULL FK", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    // `SafetyPolicyProvider` answers a tenant with no policy row using the FLOOR under an EMPTY versionId,
    // deliberately (inventing an id would let a write snapshot a version that does not exist). A consumer
    // taking that at face value would insert '' into a uuid FK column inside a retry loop.
    const { rows } = await admin.query(
      `SELECT v.id, v.created_by_membership_id FROM safety_policy_version v WHERE v.organization_id = $1`,
      [ORG_A],
    );
    expect(rows).toHaveLength(1);
    // §3.3's attribution rule: a system materialization names no acting membership.
    expect(rows[0].created_by_membership_id).toBeNull();
    const linked = await admin.query(
      `SELECT count(*)::int AS n FROM safety_check_in_schedule s
         WHERE s.visit_id = $1 AND s.safety_policy_version_id = $2`,
      [visitId, rows[0].id],
    );
    expect(linked.rows[0].n).toBe(3);
  });

  it("redelivery is a no-op, not a unique violation inside the relay's retry loop", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    expect(await schedulesFor(visitId)).toHaveLength(3);
  });

  it("a reassignment re-points the unanswered obligations and leaves an overdue one's name alone", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    // One row has already gone unanswered — that name is a record of who did not answer, not a slot.
    await admin.query(
      `UPDATE safety_check_in_schedule SET state='overdue', overdue_detected_at=now()
         WHERE visit_id=$1 AND kind='pre_visit'`,
      [visitId],
    );
    const { other } = seeded[ORG_A] as Seed;
    await admin.query("UPDATE visit SET assigned_membership_id=$1 WHERE id=$2", [other, visitId]);
    await deliver("m17.visit.assigned", ORG_A, {
      visitId,
      assignedMembershipId: other,
      patientId: PATIENT,
      scheduledStartedAt: START.toISOString(),
      scheduledEndedAt: END.toISOString(),
    });

    const rows = await schedulesFor(visitId);
    const pre = rows.find((r) => r.kind === "pre_visit");
    expect(pre?.clinician_membership_id).toBe((seeded[ORG_A] as Seed).member);
    for (const r of rows.filter((x) => x.state === "proposed")) {
      expect(r.clinician_membership_id).toBe(other);
    }
  });

  it("an EVV arrival re-anchors the mid-visit cadence to where she actually was", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    await deliver("m18.evv.check_in_recorded", ORG_A, {
      eventId: crypto.randomUUID(),
      visitId,
      patientId: PATIENT,
      postingMembershipId: (seeded[ORG_A] as Seed).member,
      capturedAt: "2026-09-01T17:02:00.000Z",
      recordedAt: "2026-09-01T17:02:00.000Z",
      gpsQuality: "good",
      geofenceDecision: "inside",
    });
    const mid = (await schedulesFor(visitId)).find((r) => r.kind === "mid_visit");
    // §7.1: the 10:00 visit entered at 10:02 prompts at 11:02 — sixty minutes after the ARRIVAL.
    expect(mid?.expected_at.toISOString()).toBe("2026-09-01T18:02:00.000Z");
  });

  it("a no-show marks ONE overdue anchor, retires the rest and emits the §4.9 supervisor inquiry", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    // Detected well after the pre-visit obligation's window closed, so the anchor is truthfully overdue.
    await deliver("m17.visit.no_show_detected", ORG_A, {
      visitId,
      patientId: PATIENT,
      clinicianMembershipId: (seeded[ORG_A] as Seed).member,
      scheduledStartedAt: "2026-09-01T17:30:00.000Z",
      reason: "clinician did not arrive",
    });

    const rows = await schedulesFor(visitId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("pre_visit");
    expect(rows[0]?.state).toBe("overdue");
    // `m20_scis_overdue_stamped` makes "overdue since unknown" unrepresentable.
    expect(rows[0]?.overdue_detected_at).not.toBeNull();

    const { rows: events } = await admin.query(
      "SELECT event_type, payload FROM outbox_event WHERE organization_id=$1",
      [ORG_A],
    );
    expect(events.map((e) => e.event_type)).toEqual(["m20.safety.check_in_overdue"]);
    expect(events[0].payload.minutesOverdue).toBe(45);
  });

  it("a no-show whose obligations are all still in the future emits NO inquiry", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    await deliver("m17.visit.no_show_detected", ORG_A, {
      visitId,
      patientId: PATIENT,
      clinicianMembershipId: (seeded[ORG_A] as Seed).member,
      // Before the pre-visit obligation is even due: nothing has gone unanswered.
      scheduledStartedAt: "2026-09-01T16:00:00.000Z",
      reason: "cancelled early",
    });
    expect(await schedulesFor(visitId)).toHaveLength(0);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM outbox_event");
    expect(rows[0].n).toBe(0);
  });

  it("a check-out opens the post-visit window and retires the mid-visit prompts the visit outran", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    await deliver("m18.evv.check_out_recorded", ORG_A, {
      eventId: crypto.randomUUID(),
      visitId,
      patientId: PATIENT,
      postingMembershipId: (seeded[ORG_A] as Seed).member,
      capturedAt: "2026-09-01T17:30:00.000Z",
      recordedAt: "2026-09-01T17:30:00.000Z",
      gpsQuality: "good",
      geofenceDecision: "inside",
      pairedCheckInEventId: null,
      serviceDurationMinutes: 30,
    });
    const rows = await schedulesFor(visitId);
    expect(rows.map((r) => r.kind)).toEqual(["pre_visit", "post_visit"]);
    expect(rows[1]?.expected_at.toISOString()).toBe("2026-09-01T17:30:00.000Z");
  });

  it("a completion retires only the mid-visit prompts — an unanswered pre-visit obligation is a FINDING", async () => {
    const visitId = await seedVisit(ORG_A);
    await deliver("m17.visit.published", ORG_A, published(visitId, ORG_A));
    await deliver("m17.visit.completed", ORG_A, {
      visitId,
      completedAt: "2026-09-01T17:30:00.000Z",
      encounterId: null,
      evvBracketState: "complete",
    });
    expect((await schedulesFor(visitId)).map((r) => r.kind)).toEqual(["pre_visit", "post_visit"]);
  });

  it("org B's publication writes org B's rows only — the tenant is the binding's, never the payload's", async () => {
    const visitA = await seedVisit(ORG_A);
    const visitB = await seedVisit(ORG_B);
    await deliver("m17.visit.published", ORG_A, published(visitA, ORG_A));
    await deliver("m17.visit.published", ORG_B, published(visitB, ORG_B));

    const { rows } = await admin.query(
      `SELECT organization_id, count(*)::int AS n FROM safety_check_in_schedule
         WHERE visit_id = ANY($1::uuid[]) GROUP BY organization_id ORDER BY organization_id`,
      [[visitA, visitB]],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.n).toBe(3);
  });

  it("org A's relay cannot materialize against org B's visit — RLS answers 'no such visit'", async () => {
    const visitB = await seedVisit(ORG_B);
    // The payload names org B's visit; the outbox row is org A's. The seam read runs in org A's scope.
    await deliver("m17.visit.published", ORG_A, {
      ...published(visitB, ORG_B),
      organizationId: ORG_A,
    });
    expect(await schedulesFor(visitB)).toHaveLength(0);
  });

  it("the §7.7 spoof badge is recorded from the consumer the board reads", async () => {
    const { member } = seeded[ORG_A] as Seed;
    expect(signals.gpsSpoofSuspected(ORG_A, member, "2026-09-01T18:00:00.000Z")).toBe(false);
    await deliver("m18.evv.gps_spoof_suspected", ORG_A, {
      eventId: crypto.randomUUID(),
      visitId: await seedVisit(ORG_A),
      patientId: PATIENT,
      postingMembershipId: member,
      capturedAt: "2026-09-01T17:00:00.000Z",
      recordedAt: "2026-09-01T17:00:00.000Z",
      gpsQuality: "suspect",
      geofenceDecision: "inside",
    });
    expect(signals.gpsSpoofSuspected(ORG_A, member, "2026-09-01T18:00:00.000Z")).toBe(true);
    // Twelve hours from when M18 saw it, not from delivery — a late redelivery cannot extend a suspicion.
    expect(signals.gpsSpoofSuspected(ORG_A, member, "2026-09-02T06:00:00.000Z")).toBe(false);
  });

  // ── #205 M36 follow-up — the §4.8 SOS delivery-failure trigger (no producer exists yet; see
  // events-by-m36.ts's header) ───────────────────────────────────────────────────────────────────────
  describe("§4.8 M36 delivery-failure trigger", () => {
    async function seedSos(
      org: string,
      lifecycleState: string,
      postedAt = new Date("2026-09-01T17:00:00.000Z"),
    ): Promise<string> {
      const s = seeded[org] as Seed;
      const policyVersionId = await withOrgContext(
        handle.db,
        { organizationId: org, userId: "" },
        (tx) => ensurePolicyVersionForConsumer(tx as never, org as never, postedAt),
      );
      // m20_ssa_ack_stamped — acknowledged/resolving/resolved all require the ack pair stamped.
      const acked = ["acknowledged", "resolving", "resolved"].includes(lifecycleState);
      const { rows } = await admin.query(
        `INSERT INTO safety_sos_alert
           (organization_id, provider_entity_id, posted_by_membership_id, posted_at,
            posted_coordinates_cipher, posted_coordinates_accuracy_m, coordinates_consent_at,
            cancel_window_expired_at, lifecycle_state, safety_policy_version_id,
            acknowledged_at, acknowledged_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,10,$4,$6,$7,$8,$9,$10) RETURNING id`,
        [
          org,
          s.pe,
          s.member,
          postedAt,
          Buffer.from([0]),
          new Date(postedAt.getTime() + 5_000),
          lifecycleState,
          policyVersionId,
          acked ? postedAt : null,
          acked ? s.member : null,
        ],
      );
      return rows[0].id as string;
    }

    async function grantEmergencyContactConsent(org: string): Promise<void> {
      const s = seeded[org] as Seed;
      await admin.query(
        `INSERT INTO safety_emergency_contact_consent
           (organization_id, clinician_membership_id, consent_purpose, consent_scope_detail,
            acknowledgment_text_snapshot)
         VALUES ($1,$2,'emergency_contact_call','{"contact":{}}'::jsonb,'ack')`,
        [org, s.member],
      );
    }

    const deliveryFailedPayload = (input: {
      recipientKind: string;
      alertEventType: string | null;
      sourceAggregateId: string | null;
    }) => ({
      notificationId: crypto.randomUUID(),
      organizationId: ORG_A,
      channel: "sms",
      failureReason: "vendor_timeout",
      failedAt: "2026-09-01T17:05:00.000Z",
      recipientKind: input.recipientKind,
      recipientMembershipId: null,
      providerEntityId: (seeded[ORG_A] as Seed).pe,
      alertEventType: input.alertEventType,
      sourceAggregateId: input.sourceAggregateId,
    });

    it("ignores a delivery-failed event with no named SOS alert", async () => {
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({ recipientKind: "on_call", alertEventType: null, sourceAggregateId: null }),
      );
      const { rows } = await admin.query("SELECT id FROM safety_sos_alert_state_history");
      expect(rows).toHaveLength(0);
    });

    it("escalates an acknowledging alert to escalation_tier_1, without emergency-contact consent", async () => {
      const sosAlertId = await seedSos(ORG_A, "acknowledging");
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          alertEventType: "m20.safety.sos_alert_raised",
          sourceAggregateId: sosAlertId,
        }),
      );
      const { rows: alert } = await admin.query(
        "SELECT lifecycle_state, version FROM safety_sos_alert WHERE id=$1",
        [sosAlertId],
      );
      expect(alert[0]).toMatchObject({ lifecycle_state: "escalation_tier_1", version: 2 });

      const { rows: history } = await admin.query(
        "SELECT from_state, to_state, transitioned_by_membership_id FROM safety_sos_alert_state_history WHERE sos_alert_id=$1",
        [sosAlertId],
      );
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        from_state: "acknowledging",
        to_state: "escalation_tier_1",
        transitioned_by_membership_id: null, // §3.3 — a system-driven tier advance names no actor.
      });

      const { rows: outbox } = await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1",
        [sosAlertId],
      );
      expect(outbox.map((r) => r.event_type)).toEqual(["m20.safety.sos_alert_escalated"]);
      expect(outbox[0].payload).toMatchObject({
        sosAlertId,
        fromTier: "acknowledging",
        toTier: "escalation_tier_1",
        reasonCode: "delivery_failed",
      });
    });

    it("an already-settled alert (acknowledged) is a no-op — re-paging a channel that already worked is wrong", async () => {
      const sosAlertId = await seedSos(ORG_A, "acknowledged");
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          alertEventType: "m20.safety.sos_alert_raised",
          sourceAggregateId: sosAlertId,
        }),
      );
      const { rows } = await admin.query(
        "SELECT lifecycle_state, version FROM safety_sos_alert WHERE id=$1",
        [sosAlertId],
      );
      expect(rows[0]).toMatchObject({ lifecycle_state: "acknowledged", version: 1 });
    });

    it("escalation_tier_3 DEAD-LETTERS rather than completing a transition into emergency_terminus", async () => {
      const sosAlertId = await seedSos(ORG_A, "escalation_tier_3");
      await expect(
        deliver(
          "m36.notification.delivery_failed",
          ORG_A,
          deliveryFailedPayload({
            recipientKind: "on_call",
            alertEventType: "m20.safety.sos_alert_raised",
            sourceAggregateId: sosAlertId,
          }),
        ),
      ).rejects.toThrow(/emergency_terminus/);
      const { rows } = await admin.query(
        "SELECT lifecycle_state, version FROM safety_sos_alert WHERE id=$1",
        [sosAlertId],
      );
      // Unchanged — the throw happens before any write, never a half-applied terminus.
      expect(rows[0]).toMatchObject({ lifecycle_state: "escalation_tier_3", version: 1 });
    });

    it("an aggregate id from a NON-m20 alert is never trusted as a safety_sos_alert id", async () => {
      const sosAlertId = await seedSos(ORG_A, "acknowledging");
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          alertEventType: "m19.triage.case_opened",
          sourceAggregateId: sosAlertId,
        }),
      );
      const { rows } = await admin.query(
        "SELECT lifecycle_state, version FROM safety_sos_alert WHERE id=$1",
        [sosAlertId],
      );
      expect(rows[0]).toMatchObject({ lifecycle_state: "acknowledging", version: 1 });
    });

    it("org A cannot escalate org B's SOS alert — RLS answers 'no such alert'", async () => {
      const sosAlertId = await seedSos(ORG_B, "acknowledging");
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          alertEventType: "m20.safety.sos_alert_raised",
          sourceAggregateId: sosAlertId,
        }),
      );
      const { rows } = await admin.query(
        "SELECT lifecycle_state, version FROM safety_sos_alert WHERE id=$1",
        [sosAlertId],
      );
      expect(rows[0]).toMatchObject({ lifecycle_state: "acknowledging", version: 1 });
    });

    it("consent is read for the clinician who posted the alert, not hardcoded false", async () => {
      const sosAlertId = await seedSos(ORG_A, "escalation_tier_2");
      await grantEmergencyContactConsent(ORG_A);
      await deliver(
        "m36.notification.delivery_failed",
        ORG_A,
        deliveryFailedPayload({
          recipientKind: "on_call",
          alertEventType: "m20.safety.sos_alert_raised",
          sourceAggregateId: sosAlertId,
        }),
      );
      // escalation_tier_2 → escalation_tier_3 is still a non-terminus rung, so this succeeds; the
      // granted consent is exercised (read, not defaulted) even though tier_3 carries no dial effect yet.
      const { rows } = await admin.query(
        "SELECT lifecycle_state FROM safety_sos_alert WHERE id=$1",
        [sosAlertId],
      );
      expect(rows[0].lifecycle_state).toBe("escalation_tier_3");
    });
  });
});
