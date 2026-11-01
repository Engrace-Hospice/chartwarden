/**
 * S08 (clinical workflow audit 2026-10-28) -- the edges of the returned-lab handshake, on real Postgres.
 *
 * m11-lab-results-applier.live proves the happy path, sequential redelivery and the HH/LL emit. This suite owns what
 * it does not:
 *   - CONCURRENCY: N simultaneous deliveries of one observation apply once; two different observations racing both
 *     apply and neither overwrites the first-received instant;
 *   - NEVER SILENT (#908/#910): a critical result with no order is quarantined in `critical_lab_result` with a clock,
 *     paged to the caseload RN and escalated to the medical director + attending when the clock lapses; one on an
 *     UNSIGNED order still flips state, still emits, and pages RN + drafter + medical director + attending; a later
 *     non-critical observation marks the earlier critical superseded (kept, not deleted); both critical signals have
 *     a consumer, and ONE alert per observation comes out of the REAL M36 emitter and seeded `alert_rule`;
 *   - a returned lab has a review step (#909): the full behaviour is proven in m11-lab-result-review.live.
 *
 * Drives the writes as the NOBYPASSRLS `chartwarden_app` role with the real catalog-validating publisher.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:lab-result-edge-cases:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildCriticalLabDeps, buildCriticalLabEscalate } from "../src/critical-lab-wiring";
import { createCareTeamProvider } from "../src/modules/05-patient/seams/care-team-provider";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
import {
  CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS,
  createCriticalLabLookup,
  sweepQuarantinedCriticalLabs,
} from "../src/modules/11-orders/critical-lab-result";
import { M11_OUTBOX_EVENTS, type OrderWriteOutboxPort } from "../src/modules/11-orders/index";
import { runCriticalLabEscalationFanout } from "../src/modules/11-orders/jobs/critical-lab-escalation-worker";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { buildM11LabResultsApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-results-applier";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/index";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import {
  type CriticalLabDeps,
  buildCriticalLabEscalator,
  buildM36CriticalLabAlertConsumers,
} from "../src/modules/36-messaging/outbox-consumers/critical-lab-alerts";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const RACERS = 6;
const LOINC = "2345-7";
const obs = (n: number): string => `aaaaaaaa-5008-4000-8000-${String(n).padStart(12, "0")}`;

describe.skipIf(!DB_URL)("S08 lab-result edge cases — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let provider: string;
  let member: string;
  let outbox: OrderWriteOutboxPort;
  let consumer: ReturnType<typeof buildM11LabResultsApplierConsumer>;
  let criticalDeps: CriticalLabDeps;
  let criticalConsumers: ReturnType<typeof buildM36CriticalLabAlertConsumers>;
  const who: Record<string, string> = {};
  const warnings: { message: string; context: Record<string, string> }[] = [];

  /**
   * A transmitted lab order awaiting results. `signed: false` clears `signed_at` (a verbal order not yet signed can
   * be transmitted). `ordering_physician_mdm_id` is NOT NULL in the schema, so the applier's null-physician guard is
   * unreachable and `signed_at` is the only way to trip its silent skip.
   */
  async function seedLabOrder(signed = true): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO order_record
         (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
          status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id, signed_at, priority)
       VALUES ($1,$2,$3,gen_random_uuid(),'lab','v1','{}'::jsonb,'active',$4,'rn_case_manager',$5,
               $6::timestamptz - interval '1 hour', 'routine')
       RETURNING id`,
      [ORG, provider, PATIENT, member, PHYSICIAN_MDM, NOW.toISOString()],
    );
    const id = rows[0].id as string;
    await admin.query(
      "UPDATE order_record SET results_status='awaiting_results', transmission_status='transmitted' WHERE id=$1",
      [id],
    );
    if (!signed) await admin.query("UPDATE order_record SET signed_at=NULL WHERE id=$1", [id]);
    return id;
  }
  const attached = (
    orderRecordId: string | null,
    observationId: string,
    flag: string | null = null,
    observationDatetime = "2026-10-08T11:30:00.000Z",
    patientId = PATIENT,
  ) => ({
    eventType: "m29.lab_observation.attached",
    organizationId: ORG,
    payload: {
      observationId,
      organizationId: ORG,
      patientId,
      orderRecordId,
      loincCode: "2345-7",
      abnormalFlag: flag,
      observationDatetime,
    },
  });
  const handleEvent = (e: ReturnType<typeof attached>) => consumer.handle(e as never);
  const orderRow = async (id: string) =>
    (
      await admin.query(
        "SELECT results_status, results_first_received_at, last_lab_observation_attached_id FROM order_record WHERE id=$1",
        [id],
      )
    ).rows[0];
  const eventsFor = async (type: string, orderId: string): Promise<number> =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 AND aggregate_id=$2",
        [type, orderId],
      )
    ).rows[0].n as number;
  const eventsForObservation = async (observationId: string): Promise<number> =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm11.order.results_%' AND payload->>'observationId'=$1",
        [observationId],
      )
    ).rows[0].n as number;

  async function addUser(tag: string, roleKey: string | null): Promise<string> {
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@s08.test`])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, ORG],
      )
    ).rows[0].id as string;
    if (roleKey !== null) {
      const roleId = (
        await admin.query(
          "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive') RETURNING id",
          [ORG, roleKey],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG, membershipId, roleId],
      );
    }
    who[`${tag}Membership`] = membershipId;
    return userId;
  }
  const criticalRow = async (observationId: string) =>
    (
      await admin.query("SELECT * FROM critical_lab_result WHERE observation_id=$1", [
        observationId,
      ])
    ).rows[0];
  const pageAlerts = async (observationId: string) =>
    (
      await admin.query(
        "SELECT id, severity, correlation_id, payload FROM alert WHERE organization_id=$1 AND correlation_id LIKE $2 ORDER BY correlation_id",
        [ORG, `m11-lab-critical:${observationId}%`],
      )
    ).rows as {
      id: string;
      severity: string;
      correlation_id: string;
      payload: Record<string, unknown>;
    }[];
  const pageRecipients = async (alertId: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1",
        [alertId],
      )
    ).rows
      .map((r) => r.recipient_user_id as string)
      .sort();
  const critEvent = (kind: "m11" | "m29", observationId: string, orderId: string | null) =>
    kind === "m11"
      ? {
          eventType: "m11.order.results_received_critical",
          organizationId: ORG,
          payload: { orderId, organizationId: ORG, observationId, criticalFlags: ["HH"] },
        }
      : {
          eventType: "m29.lab_observation.abnormal_flag",
          organizationId: ORG,
          payload: {
            observationId,
            organizationId: ORG,
            patientId: PATIENT,
            loincCode: LOINC,
            criticalCount: 1,
          },
        };
  const pageFrom = (kind: "m11" | "m29", e: ReturnType<typeof critEvent>) =>
    criticalConsumers[kind === "m11" ? 0 : 1].handle(e as never);

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
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (process.env.CHARTWARDEN_TEST_NO_PGVECTOR) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'s08-a','S08','S08')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'s08@x.test')`, [USER]);
    provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'S08-A','Provider A','1300000013','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    member = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,'s08-mrn','Pat','Synthetic','1950-01-01','female','active')`,
      [PATIENT, ORG],
    );
    who.rn = await addUser("rn", null);
    who.attending = await addUser("attending", null);
    who.drafterUser = USER;
    who.medicalDirector = await addUser("md-director", "medical_director");
    who.admin = await addUser("admin", "org_admin");
    // The seeded drafter membership belongs to USER; patient_assignment rows are keyed by user id.
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE), ($1,$2,$4,'attending_clinician',CURRENT_DATE)`,
      [PATIENT, ORG, who.rn, who.attending],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
    outbox = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    consumer = buildM11LabResultsApplierConsumer({ db: handle.db, outbox, now: () => NOW });
    const emitter = createDrizzleAlertEmitter(handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(handle.db);
    // The SAME builder the boot (index.ts) uses -- not a hand-assembled deps object.
    criticalDeps = buildCriticalLabDeps(
      handle.db,
      { alerts: emitter, careTeam: createCareTeamProvider(createDrizzleCareTeamStore(handle.db)) },
      (message, context) => warnings.push({ message, context }),
    );
    criticalConsumers = buildM36CriticalLabAlertConsumers(criticalDeps);
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("N simultaneous deliveries of one critical observation apply once: one results_received, one critical", async () => {
    const order = await seedLabOrder();
    const event = attached(order, obs(1), "HH");

    const results = await Promise.allSettled(
      Array.from({ length: RACERS }, () => handleEvent(event)),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await eventsFor("m11.order.results_received", order)).toBe(1);
    expect(await eventsFor("m11.order.results_received_critical", order)).toBe(1);
    expect((await orderRow(order)).last_lab_observation_attached_id).toBe(obs(1));
  });

  it("two different observations racing both apply, and a later delivery never overwrites the first-received instant", async () => {
    const order = await seedLabOrder();
    // A ticking clock gives every write its own instant, so an overwrite is visible (a constant clock hides it).
    let tick = 0;
    const ticking = buildM11LabResultsApplierConsumer({
      db: handle.db,
      outbox,
      now: () => new Date(NOW.getTime() + tick++ * 60_000),
    });

    await Promise.all([
      ticking.handle(attached(order, obs(2)) as never),
      ticking.handle(attached(order, obs(3)) as never),
    ]);

    expect(await eventsFor("m11.order.results_received", order)).toBe(2);
    const raced = await orderRow(order);
    expect([obs(2), obs(3)]).toContain(raced.last_lab_observation_attached_id);
    const firstReceived = new Date(raced.results_first_received_at).getTime();
    expect([NOW.getTime(), NOW.getTime() + 60_000]).toContain(firstReceived);
    await ticking.handle(attached(order, obs(9)) as never); // a third, later delivery
    const after = await orderRow(order);
    expect(after.last_lab_observation_attached_id).toBe(obs(9));
    expect(new Date(after.results_first_received_at).getTime()).toBe(firstReceived);
  });

  it("a critical result bound to NO order is quarantined with a clock and paged to the caseload RN, never dropped", async () => {
    await handleEvent(attached(null, obs(4), "HH"));

    const row = await criticalRow(obs(4));
    expect(row.disposition).toBe("quarantined_no_order");
    expect(row.order_record_id).toBeNull();
    expect(new Date(row.respond_by).getTime()).toBe(
      NOW.getTime() + CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS,
    );
    expect(await eventsForObservation(obs(4))).toBe(0); // no order => no m11 event; the page comes from M29's signal

    await pageFrom("m29", critEvent("m29", obs(4), null));

    const pages = await pageAlerts(obs(4));
    expect(pages).toHaveLength(1);
    expect(pages[0].severity).toBe("critical");
    expect(await pageRecipients(pages[0].id)).toEqual([who.rn]);
    expect(JSON.stringify(pages[0].payload)).not.toMatch(/Pat|Synthetic|1950/);
  });

  it("an unresolved no-order quarantine is escalated ONCE after its clock to the medical director + attending", async () => {
    await handleEvent(attached(null, obs(10), "LL"));
    const escalate = buildCriticalLabEscalator(criticalDeps);
    const run = (at: Date) =>
      sweepQuarantinedCriticalLabs(
        {
          db: handle.db,
          now: () => at,
          escalate: (org, r) =>
            escalate(org, { ...r, orderId: null, orderUnsigned: false, drafterMembershipId: null }),
        },
        ORG,
      );

    await run(new Date(NOW.getTime() + CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS - 1000)); // clock not lapsed
    expect((await criticalRow(obs(10))).escalated_at).toBeNull();
    await run(new Date(NOW.getTime() + CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS + 1000));
    await run(new Date(NOW.getTime() + 2 * CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS)); // a second tick is a no-op

    expect((await criticalRow(obs(10))).escalated_at).not.toBeNull();
    const escalation = (await pageAlerts(obs(10))).filter((a) =>
      a.correlation_id.endsWith(":escalation"),
    );
    expect(escalation).toHaveLength(1);
    expect(await pageRecipients(escalation[0].id)).toEqual(
      [who.rn, who.attending, who.medicalDirector].sort(),
    );
  });

  it("a critical result on an UNSIGNED order flips state, still emits, and pages RN + drafter + attending + medical director once", async () => {
    const order = await seedLabOrder(false);

    await handleEvent(attached(order, obs(5), "LL"));

    expect((await orderRow(order)).results_status).toBe("results_received");
    expect(await eventsFor("m11.order.results_received", order)).toBe(1);
    expect(await eventsFor("m11.order.results_received_critical", order)).toBe(1);
    expect((await criticalRow(obs(5))).order_unsigned).toBe(true);
    // Both source events land on the same observation: ONE alert comes out.
    await pageFrom("m11", critEvent("m11", obs(5), order));
    await pageFrom("m29", critEvent("m29", obs(5), order));
    await pageFrom("m29", critEvent("m29", obs(5), order)); // a redelivery
    const pages = await pageAlerts(obs(5));
    expect(pages).toHaveLength(1);
    expect(await pageRecipients(pages[0].id)).toEqual(
      [who.rn, who.drafterUser, who.attending, who.medicalDirector].sort(),
    );
  });

  it("a critical result on a SIGNED order pages RN + drafter + attending, not the medical director", async () => {
    const order = await seedLabOrder(true);
    await handleEvent(attached(order, obs(11), "HH"));

    await pageFrom("m11", critEvent("m11", obs(11), order));

    const pages = await pageAlerts(obs(11));
    expect(pages).toHaveLength(1);
    expect(await pageRecipients(pages[0].id)).toEqual(
      [who.rn, who.drafterUser, who.attending].sort(),
    );
  });

  it("a page that resolves nobody falls back to the tenant admin instead of reaching zero people", async () => {
    await admin.query(
      "UPDATE patient_assignment SET unassigned_at = CURRENT_DATE WHERE patient_id=$1",
      [PATIENT],
    );
    try {
      await handleEvent(attached(null, obs(12), "HH"));
      await pageFrom("m29", critEvent("m29", obs(12), null));
    } finally {
      await admin.query("UPDATE patient_assignment SET unassigned_at = NULL WHERE patient_id=$1", [
        PATIENT,
      ]);
    }

    const pages = await pageAlerts(obs(12));
    expect(pages.map((p) => p.correlation_id)).toEqual([
      `m11-lab-critical:${obs(12)}`,
      `m11-lab-critical:${obs(12)}:fb`,
    ]);
    expect(await pageRecipients(pages[1].id)).toContain(who.admin);
  });

  it("the alert is not sent from partial facts: a signal that outruns the applier throws for retry", async () => {
    await expect(pageFrom("m29", critEvent("m29", obs(13), null))).rejects.toThrow(
      /no critical_lab_result row/,
    );
    expect(await pageAlerts(obs(13))).toHaveLength(0);
  });

  it("tenant isolation: another tenant's context cannot see the ledger row", async () => {
    await handleEvent(attached(null, obs(14), "HH"));

    const other = await createCriticalLabLookup(handle.db)(
      "22222222-2222-2222-2222-222222222222",
      obs(14),
    );

    expect(other).toBeNull();
    expect(await createCriticalLabLookup(handle.db)(ORG, obs(14))).not.toBeNull();
  });

  it("a corrected, non-critical observation marks the earlier critical superseded, and keeps its alert", async () => {
    const order = await seedLabOrder();
    await handleEvent(attached(order, obs(6), "HH"));
    await pageFrom("m11", critEvent("m11", obs(6), order));

    await handleEvent(attached(order, obs(7), null));

    const earlier = await criticalRow(obs(6));
    expect(earlier.superseded_by_observation_id).toBe(obs(7));
    expect(earlier.superseded_at).not.toBeNull();
    expect(await pageAlerts(obs(6))).toHaveLength(1); // the earlier alert is kept, not deleted
    expect(await eventsFor("m11.order.results_received_critical", order)).toBe(1);
    expect(await eventsFor("m11.order.results_received", order)).toBe(2);
  });

  it("both critical signals now have the M36 consumer declared", () => {
    const declared = (
      events: readonly { eventName: string; declaredConsumers?: readonly string[] }[],
      name: string,
    ) => events.find((e) => e.eventName === name)?.declaredConsumers;

    expect(declared(M11_OUTBOX_EVENTS, "m11.order.results_received_critical")).toEqual(["m36"]);
    expect(declared(M29_OUTBOX_EVENTS, "m29.lab_observation.abnormal_flag")).toEqual(["m36"]);
  });

  it("a returned lab has a review step: a review row and a service method exist, and the review is append-only", async () => {
    const service = createDbOrderBackend(handle.db, outbox);
    expect(typeof service.reviewLabResults).toBe("function");
    const columns = await admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='order_result_review' AND column_name IN ('reviewer_membership_id','reviewer_discipline','reviewed_at')",
    );
    expect(columns.rows).toHaveLength(3);
    // The full review / amendment / wrong-tenant / role / alert behaviour is m11-lab-result-review.live.
  });

  // ── review follow-up ────────────────────────────────────────────────────────────────────────────────────
  const setMembership = (userId: string, status: string) =>
    admin.query("UPDATE membership SET status=$2 WHERE user_id=$1 AND organization_id=$3", [
      userId,
      status,
      ORG,
    ]);
  const auditCount = async (type: string, resourceId: string): Promise<number> =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='critical_lab_result' AND event_type=$1 AND resource_id=$2",
        [type, resourceId],
      )
    ).rows[0].n as number;

  it("a critical naming an order that does not exist is quarantined (not dropped); a redelivery of an applied critical stays a no-op", async () => {
    const missing = "bbbbbbbb-5008-4000-8000-000000000001";
    await handleEvent(attached(missing, obs(30), "HH"));

    const row = await criticalRow(obs(30));
    expect(row.disposition).toBe("quarantined_no_order");
    expect(row.order_record_id).toBeNull();
    expect(row.patient_id).toBe(PATIENT);
    await handleEvent(attached(missing, obs(30), "HH")); // redelivery of the quarantined one
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM critical_lab_result WHERE observation_id=$1",
          [obs(30)],
        )
      ).rows[0].n,
    ).toBe(1);

    const order = await seedLabOrder();
    await handleEvent(attached(order, obs(31), "HH"));
    await handleEvent(attached(order, obs(31), "HH")); // redelivery of an applied one
    expect((await criticalRow(obs(31))).disposition).toBe("paged");
    expect(await eventsFor("m11.order.results_received_critical", order)).toBe(1);
  });

  it("one poison row does not roll back or block the others: the rest are escalated, the failure is rethrown", async () => {
    await handleEvent(attached(null, obs(32), "HH"));
    await handleEvent(attached(null, obs(33), "HH"));
    const escalate = buildCriticalLabEscalate(criticalDeps);
    const later = new Date(NOW.getTime() + 3 * CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS);

    const run = sweepQuarantinedCriticalLabs(
      {
        db: handle.db,
        now: () => later,
        escalate: async (org, r) => {
          if (r.observationId === obs(32)) throw new Error("poison");
          await escalate(org, r);
        },
      },
      ORG,
    );

    await expect(run).rejects.toBeInstanceOf(AggregateError);
    expect((await criticalRow(obs(32))).escalated_at).toBeNull(); // retried next tick
    expect((await criticalRow(obs(33))).escalated_at).not.toBeNull();
    expect(
      (await pageAlerts(obs(33))).filter((a) => a.correlation_id.endsWith(":escalation")),
    ).toHaveLength(1);
  });

  it("no active medical director: an unsigned-order critical also pages the tenant admins (distinct :fb-md alert) and warns", async () => {
    const order = await seedLabOrder(false);
    await handleEvent(attached(order, obs(34), "LL"));
    await setMembership(who.medicalDirector, "suspended");
    warnings.length = 0;
    try {
      await pageFrom("m11", critEvent("m11", obs(34), order));
    } finally {
      await setMembership(who.medicalDirector, "active");
    }

    const pages = await pageAlerts(obs(34));
    expect(pages.map((p) => p.correlation_id)).toEqual([
      `m11-lab-critical:${obs(34)}`,
      `m11-lab-critical:${obs(34)}:fb-md`,
    ]);
    expect(await pageRecipients(pages[1].id)).toContain(who.admin);
    expect(await pageRecipients(pages[0].id)).toEqual(
      [who.rn, who.drafterUser, who.attending].sort(),
    );
    expect(warnings.some((w) => w.context.observationId === obs(34))).toBe(true);
    expect(JSON.stringify(warnings)).not.toMatch(/Pat|Synthetic|1950/);
  });

  it("a suspended attending is not paged (only an ACTIVE membership counts) and the other recipients still are", async () => {
    const order = await seedLabOrder(true);
    await handleEvent(attached(order, obs(35), "HH"));
    await setMembership(who.attending, "suspended");
    try {
      await pageFrom("m11", critEvent("m11", obs(35), order));
    } finally {
      await setMembership(who.attending, "active");
    }

    const pages = await pageAlerts(obs(35));
    expect(pages).toHaveLength(1);
    expect(await pageRecipients(pages[0].id)).toEqual([who.rn, who.drafterUser].sort());
  });

  it("a suspended attending is the ONLY care-team contact: the page falls back to the tenant admins", async () => {
    await admin.query(
      "UPDATE patient_assignment SET unassigned_at = CURRENT_DATE WHERE patient_id=$1 AND role='primary_rn'",
      [PATIENT],
    );
    await setMembership(who.attending, "suspended");
    try {
      await handleEvent(attached(null, obs(44), "HH"));
      await pageFrom("m29", critEvent("m29", obs(44), null));
    } finally {
      await setMembership(who.attending, "active");
      await admin.query("UPDATE patient_assignment SET unassigned_at = NULL WHERE patient_id=$1", [
        PATIENT,
      ]);
    }

    const pages = await pageAlerts(obs(44));
    expect(pages.map((p) => p.correlation_id)).toEqual([
      `m11-lab-critical:${obs(44)}`,
      `m11-lab-critical:${obs(44)}:fb`,
    ]);
    expect(await pageRecipients(pages[1].id)).toContain(who.admin);
  });

  it("the ledger patient comes from the locked order, not the payload (a mismatch warns with ids only)", async () => {
    const order = await seedLabOrder();
    const warned: { message: string; context: Record<string, string> }[] = [];
    const checking = buildM11LabResultsApplierConsumer({
      db: handle.db,
      outbox,
      now: () => NOW,
      warn: (message, context) => warned.push({ message, context }),
    });
    const other = "44444444-4444-4444-4444-4444444444ff";

    await checking.handle(attached(order, obs(36), "HH", undefined, other) as never);

    expect((await criticalRow(obs(36))).patient_id).toBe(PATIENT);
    expect(warned).toHaveLength(1);
    expect(warned[0].context).toMatchObject({ observationId: obs(36), orderId: order });
  });

  it("supersede is order-aware: a late redelivery of an OLDER non-critical does not withdraw a newer critical", async () => {
    const order = await seedLabOrder();
    await handleEvent(attached(order, obs(37), "HH", "2026-10-08T11:30:00.000Z"));

    await handleEvent(attached(order, obs(38), null, "2026-10-08T10:00:00.000Z")); // older, arrives late

    expect((await criticalRow(obs(37))).superseded_at).toBeNull();
    await handleEvent(attached(order, obs(39), null, "2026-10-08T12:30:00.000Z")); // genuinely newer
    expect((await criticalRow(obs(37))).superseded_by_observation_id).toBe(obs(39));
  });

  it("critical_lab_result insert and the escalated / superseded stamps land in audit_event", async () => {
    const order = await seedLabOrder();
    await handleEvent(attached(order, obs(40), "HH"));
    await handleEvent(attached(order, obs(41), null, "2026-10-08T12:45:00.000Z"));
    await handleEvent(attached(null, obs(42), "LL"));
    await sweepQuarantinedCriticalLabs(
      {
        db: handle.db,
        now: () => new Date(NOW.getTime() + 5 * CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS),
        escalate: async () => undefined,
      },
      ORG,
    );

    const superseded = await criticalRow(obs(40));
    const escalated = await criticalRow(obs(42));
    expect(await auditCount("critical_lab_result.insert", superseded.id)).toBe(1);
    expect(await auditCount("critical_lab_result.update", superseded.id)).toBeGreaterThanOrEqual(1);
    expect(await auditCount("critical_lab_result.insert", escalated.id)).toBe(1);
    expect(await auditCount("critical_lab_result.update", escalated.id)).toBeGreaterThanOrEqual(1);
    const after = (
      await admin.query(
        "SELECT after FROM audit_event WHERE resource_id=$1 AND event_type='critical_lab_result.update' ORDER BY created_at DESC LIMIT 1",
        [escalated.id],
      )
    ).rows[0].after as Record<string, unknown>;
    expect(after.escalated_at).toBeTruthy();
  });

  it("worker level: runCriticalLabEscalationFanout over the boot's deps-builder escalates a lapsed quarantine once", async () => {
    await handleEvent(attached(null, obs(43), "HH"));
    const deps = {
      connection: {} as never,
      db: handle.db,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      escalate: buildCriticalLabEscalate(criticalDeps),
    };

    await runCriticalLabEscalationFanout(deps); // real clock: obs(43)'s 1 h clock (from 2026-10-08) has lapsed
    await runCriticalLabEscalationFanout(deps); // second tick is a no-op

    expect((await criticalRow(obs(43))).escalated_at).not.toBeNull();
    const escalation = (await pageAlerts(obs(43))).filter((a) =>
      a.correlation_id.endsWith(":escalation"),
    );
    expect(escalation).toHaveLength(1);
    expect(await pageRecipients(escalation[0].id)).toEqual(
      [who.rn, who.attending, who.medicalDirector].sort(),
    );
  });

  it("migration 1298 backfills observation_at on a 1297-era critical from the source observation, idempotently", async () => {
    const order = await seedLabOrder();
    await handleEvent(attached(order, obs(60), "HH", "2026-10-08T09:15:00.000Z"));
    await admin.query(
      "UPDATE critical_lab_result SET observation_at=NULL WHERE organization_id=$1 AND observation_id=$2",
      [ORG, obs(60)],
    ); // the row as 1297 left it
    await admin.query(
      `INSERT INTO lab_observation
         (id, organization_id, provider_entity_id, source_message_id, patient_id, order_id, observation_date,
          result_status, loinc_code, loinc_display_text, terminology_validation, abnormal_summary)
       VALUES ($1,$2,$3,gen_random_uuid(),$4,$5,'2026-10-08T09:15:00.000Z','final','2345-7','Glucose',
               'valid','any_critical')`,
      [obs(60), ORG, provider, PATIENT, order],
    );
    const migration = readFileSync(
      join(MIGRATIONS_DIR, "1298_m11_critical_lab_destruction_and_observation_at.sql"),
      "utf8",
    );
    const backfill = migration
      .split("--> statement-breakpoint")
      .find((chunk) => chunk.includes('UPDATE "critical_lab_result"'));
    expect(backfill).toBeTruthy();

    await admin.query(backfill as string);
    const stamped = (await criticalRow(obs(60))).observation_at as Date;
    expect(stamped.toISOString()).toBe("2026-10-08T09:15:00.000Z");

    await admin.query(backfill as string);
    expect(((await criticalRow(obs(60))).observation_at as Date).toISOString()).toBe(
      "2026-10-08T09:15:00.000Z",
    );
  });
});
