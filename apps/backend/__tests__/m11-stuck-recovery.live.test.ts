/**
 * F-201 (#248) — STUCK LAB ORDERS stop waiting on a human to notice, proven end to end over real Postgres.
 *
 * Two kinds of stuck, with opposite answers (see `orm-request/stuck-recovery.ts`):
 *
 *  1. REFUSED BEFORE ANY OUTBOUND ROW EXISTED (`dispatch_refused:*` from M29's worker, `orm_refused:*` from the producer).
 *     Nothing was ever sent, so re-emitting cannot duplicate — the sweep re-runs F-182's resend automatically once the
 *     cause (a lapsed BAA, a missing feed, an incomplete identity) is fixed. BOUNDED: attempts, a backoff, and a window,
 *     and it never re-alerts the ordering provider while the cause is still there.
 *  2. FAILED AFTER A MESSAGE WAS BUILT (`dlq_exhausted`, `application_reject`, `recovery_blocked:*`). The lab MAY have it,
 *     so it is NEVER retried automatically; it gets a WORKLIST and an AGING ESCALATION (warn, then critical).
 *
 * Everything runs as the NOBYPASSRLS `chartwarden_app` role through the real catalog-validating publisher, M29's real T08
 * worker (a STUB `MllpTransport`), F-177's real applier, and the REAL M36 alert emitter over the REAL platform-default
 * rule seed — so "one page per stage" is proven by the `alert` table's unique correlation id, not asserted on a stub.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:stuck-recovery:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { ConflictError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { hl7OrmDemographicsInTx } from "../src/modules/05-patient/seams/hl7-orm-demographics";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { buildM11OrmRequestedPorts } from "../src/modules/11-orders/orm-request/ports";
import {
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_WINDOW_MS,
} from "../src/modules/11-orders/orm-request/stuck-recovery";
import { buildM11LabTransmissionApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-transmission-applier";
import { SYSTEM_ORDER_ACTOR } from "../src/modules/11-orders/routes/service";
import { createStuckTransmissionRecovery } from "../src/modules/11-orders/stuck-transmission-recovery";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/events-by-m29";
import { parseMshEnvelope } from "../src/modules/29-external-interfaces/listener/mllp-framing";
import type { OutboundTenantKeyProvider } from "../src/modules/29-external-interfaces/outbound/dispatch-crypto";
import { buildM29OutboundDispatchConsumer } from "../src/modules/29-external-interfaces/outbound/dispatch-worker";
import { buildDrizzleOutboundFeedResolver } from "../src/modules/29-external-interfaces/outbound/feed-resolver";
import type {
  MllpTransport,
  MllpTransportSendInput,
} from "../src/modules/29-external-interfaces/outbound/mllp-transport";
import { ormOutboundEvidenceForOrder } from "../src/modules/29-external-interfaces/outbound/order-dispatch-dedupe";
import {
  ormOutboundFeedsForOrders,
  outboundBaaCleared,
} from "../src/modules/29-external-interfaces/outbound/stuck-order-support";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { createDbMdmStore, registerMdmSeams } from "../src/modules/40-mdm/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER_B = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PH_ACTIVE = "a0000000-0000-0000-0000-000000000001";
const FAC_ACTIVE = "b0000000-0000-0000-0000-000000000001";

const HOUR = 3_600_000;
const TEST_DEK = Buffer.alloc(32, 7);
const keys: OutboundTenantKeyProvider = {
  async dekForOrg() {
    return { version: "v1", key: TEST_DEK };
  },
  async dekForOrgVersion(_orgId, version) {
    return { version, key: TEST_DEK };
  },
};
const LOINC = [{ system: "http://loinc.org", code: "2345-7", display: "Glucose" }];
const LAB_DATA = { testCodes: LOINC, fastingRequired: false, routingLabId: FAC_ACTIVE };

describe.skipIf(!DB_URL)("F-201 — stuck lab-order recovery, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let recovery: ReturnType<typeof createStuckTransmissionRecovery>;
  let recoveryB: ReturnType<typeof createStuckTransmissionRecovery>;
  let member: string;
  let memberB: string;
  let feedA = "";
  let wires: string[] = [];
  let mode: "ack" | "refuse" = "ack";
  let baaActive = true;
  const user: Record<string, string> = {};

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  async function addMember(
    orgId: string,
    tag: string,
    roleKey: string,
    category: string,
  ): Promise<string> {
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,$3) RETURNING id",
        [orgId, roleKey, category],
      )
    ).rows[0].id as string;
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@f191.test`])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, orgId],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [orgId, membershipId, roleId],
    );
    return userId;
  }

  const transport: MllpTransport = {
    async send(input: MllpTransportSendInput) {
      if (mode === "refuse")
        return { kind: "destination_refused" as const, errorClass: "loopback_refused" as never };
      wires.push(input.wireMessage);
      const env = parseMshEnvelope(input.wireMessage);
      const msh = [
        "MSH",
        "^~\\&",
        env.receivingApplication,
        env.receivingFacility,
        env.sendingApplication,
        env.sendingFacility,
        "20260101000000",
        "",
        "ACK",
        `${env.messageControlId}-ack`,
        "P",
        "2.5.1",
      ].join("|");
      return {
        kind: "ack" as const,
        rawAckPayload: [msh, ["MSA", "AA", env.messageControlId, ""].join("|")].join("\r"),
      };
    },
  };

  async function seedFeed(organizationId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, host, port, protocol, channel_cert_pin,
          status, proposed_by_membership_id, rate_limit_msg_per_sec, lab_destination_facility_id,
          msh_sending_application, msh_sending_facility, msh_receiving_application, msh_receiving_facility)
       VALUES ($1,$2,'orm_outbound','Reference Lab','127.0.0.1',2575,'mllp_plain',NULL,'active',$3,1000,$4,
               'CHARTWARDEN','HOSPICE-A','REFLAB','REFLAB-FAC')`,
      [id, organizationId, randomUUID(), FAC_ACTIVE],
    );
    return id;
  }
  async function seedPatient(id: string, organizationId: string, mrn: string): Promise<void> {
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
       VALUES ($1,$2,$3,'Jane','Doe','1950-04-05','F')`,
      [id, organizationId, mrn],
    );
  }
  async function signedLab(org = ORG_A, who = member): Promise<string> {
    const patientId = randomUUID();
    await seedPatient(patientId, org, `MRN-${patientId.slice(0, 6)}`);
    const draft = await svc.createDraft(
      org,
      who,
      {
        patientId,
        admissionId: ADMISSION,
        kind: "lab" as never,
        drafterDiscipline: "rn_case_manager",
        data: LAB_DATA,
        orderingPhysicianMdmId: PH_ACTIVE,
      },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.requestSignature(
      org,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.signOrder(
      org,
      who,
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    return draft.id;
  }
  async function settle() {
    for (let i = 0; i < 5; i++) await dispatcher.tick();
  }
  async function orderRow(id: string) {
    const { rows } = await admin.query(
      `SELECT status, transmission_status, transmission_failure_reason, transmission_attempt_id,
              transmission_auto_retry_count AS retries, transmission_auto_retry_at AS retry_at,
              transmission_auto_retry_exhausted_at AS exhausted_at, updated_at, patient_id
         FROM order_record WHERE id=$1`,
      [id],
    );
    return rows[0];
  }
  async function count(aggregateId: string, eventType: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [aggregateId, eventType],
    );
    return rows[0].n as number;
  }
  async function outboundRows(orderId: string) {
    const { rows } = await admin.query(
      "SELECT status, feed_id FROM hl7_message_outbound WHERE organization_id=$1 AND source_aggregate_id=$2 ORDER BY queued_at, id",
      [ORG_A, orderId],
    );
    return rows as { status: string; feed_id: string }[];
  }
  /** Superuser edit that bypasses the state-transition triggers — for arranging a state, never for the code under test. */
  async function arrange(sqlText: string, params: unknown[]) {
    await admin.query("SET session_replication_role = replica");
    try {
      await admin.query(sqlText, params);
    } finally {
      await admin.query("SET session_replication_role = DEFAULT");
    }
  }
  const backdate = (id: string, hours: number) =>
    arrange("UPDATE order_record SET updated_at = now() - ($2 || ' hours')::interval WHERE id=$1", [
      id,
      String(hours),
    ]);
  const alertsOf = async (org: string, eventType: string) =>
    (
      await admin.query(
        "SELECT id, severity, correlation_id FROM alert WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at",
        [org, eventType],
      )
    ).rows as { id: string; severity: string; correlation_id: string }[];
  const recipientsOf = async (alertId: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1",
        [alertId],
      )
    ).rows
      .map((r) => r.recipient_user_id as string)
      .sort();

  /** An order the real worker refused to persist because the BAA had lapsed → `failed` / `dispatch_refused:baa_inactive`. */
  async function baaLapsedOrder(): Promise<string> {
    baaActive = false;
    const id = await signedLab();
    await settle();
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    expect(await outboundRows(id)).toHaveLength(0); // nothing was ever sent
    return id;
  }
  /** A second order refused for the same lapse (the BAA is already lapsed when it is signed). */
  async function signedLabAfterLapse(): Promise<string> {
    const id = await signedLab();
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    return id;
  }
  /** An order that went out, was permanently refused, and the real applier marked `failed` / `dlq_exhausted`. */
  async function heldOrder(): Promise<string> {
    mode = "refuse";
    const id = await signedLab();
    await settle();
    mode = "ack";
    const row = await orderRow(id);
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq"]);
    return id;
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
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f191@x.test'),($2,'f191b@x.test')`,
      [USER, USER_B],
    );
    member = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    memberB = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER_B, ORG_B],
      )
    ).rows[0].id as string;
    user.orgAdmin = await addMember(ORG_A, "a-admin", "org_admin", "admin_executive");
    user.clinicalLead = await addMember(ORG_A, "a-lead", "clinical_lead", "clinical_leadership");
    user.bystander = await addMember(ORG_A, "a-biller", "biller", "billing_finance");
    user.otherTenantAdmin = await addMember(ORG_B, "b-admin", "org_admin", "admin_executive");

    // The REAL NOBYPASSRLS role — asserted, never assumed.
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, status) VALUES ('${PH_ACTIVE}', '1234567893', 'Sam', 'Smith', 'active')`,
    );
    await admin.query(
      `INSERT INTO facility (id, kind, name, status) VALUES ('${FAC_ACTIVE}', 'other', 'Reference Lab', 'active')`,
    );
    registerMdmSeams({ store: createDbMdmStore(handle.db) });
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({
        isActive: baaActive,
        status: baaActive ? "executed" : "missing",
        expiresOn: null,
      }),
    } as never);
    const emitter = createDrizzleAlertEmitter(handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(handle.db);

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M29_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m11Outbox = {
      publish: (tx: unknown, e: any) =>
        publisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    const m29Outbox = {
      publish: (tx: any, e: any) => publisher.publish(tx, { ...e, callerModule: "m29" }),
    };
    svc = createDbOrderBackend(
      handle.db,
      m11Outbox,
      buildM11OrmRequestedPorts({
        patient: hl7OrmDemographicsInTx,
        feeds: buildDrizzleOutboundFeedResolver(),
        outboundEvidence: ormOutboundEvidenceForOrder,
      }),
    );
    const build = () =>
      createStuckTransmissionRecovery({
        db: handle.db,
        // F-182's own resend — the SAME guarded path an operator's click takes; no acting user.
        resend: (organizationId, orderId) => svc.resendLabTransmission(organizationId, "", orderId),
        baaCleared: outboundBaaCleared,
        alerts: emitter,
        feedsForOrders: ormOutboundFeedsForOrders,
      });
    recovery = build();
    recoveryB = build();

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM29OutboundDispatchConsumer({
          db: handle.db,
          outbox: m29Outbox,
          keys,
          transport,
          alerts: { emit: async () => undefined } as never,
          destinationPolicy: { allowPlain: true, allowLoopback: true },
        }),
        buildM11LabTransmissionApplierConsumer({ db: handle.db, outbox: m11Outbox }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    wires = [];
    mode = "ack";
    baaActive = true;
    // The sweeps are ORG-WIDE, so a previous test's orders must not be visible to the next one.
    await admin.query("SET session_replication_role = replica");
    await admin.query("DELETE FROM order_record WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query(
      "DELETE FROM order_transmission_attestation WHERE organization_id IN ($1,$2)",
      [ORG_A, ORG_B],
    );
    await admin.query("SET session_replication_role = DEFAULT");
    await admin.query(
      "DELETE FROM notification_delivery WHERE alert_id IN (SELECT id FROM alert WHERE organization_id IN ($1,$2))",
      [ORG_A, ORG_B],
    );
    await admin.query("DELETE FROM alert WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM outbox_event WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id IN ($1,$2)", [
      ORG_A,
      ORG_B,
    ]);
    await admin.query("DELETE FROM external_feed WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    feedA = await seedFeed(ORG_A);
  });

  // ── 1. AUTO-RETRY of an order refused before any outbound row existed ────────────────────────────────────────────

  it("a LAPSED BAA is NOT retried while it stays lapsed — nothing emitted, no attempt spent, the provider is not re-alerted", async () => {
    const id = await baaLapsedOrder();
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1); // the one alert, at the first refusal
    const requests = await count(id, "m11.order.hl7_orm_requested");

    for (let i = 0; i < 3; i++) {
      const res = await recovery.sweepAutoRetries(ORG_A);
      expect(res).toMatchObject({ examined: 1, retried: 0, causeNotCleared: 1 });
    }
    await settle();
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(requests); // nothing re-emitted
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1); // and no second alert
    expect(wires).toHaveLength(0);
    const row = await orderRow(id);
    expect(row.transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    expect(row.retries).toBe(0);
  });

  it("once the BAA is RESTORED the sweep re-dispatches EXACTLY once: delivered, transmitted, one attempt spent — and a later sweep does nothing", async () => {
    const id = await baaLapsedOrder();
    baaActive = true; // the compliance officer renews the BAA

    const res = await recovery.sweepAutoRetries(ORG_A);
    expect(res).toMatchObject({ examined: 1, retried: 1 });
    expect((await orderRow(id)).transmission_status).toBe("pending");
    await settle();

    expect(wires).toHaveLength(1);
    expect(wires[0]).toContain("ORM^O01");
    const after = await orderRow(id);
    expect(after.transmission_status).toBe("transmitted");
    expect(after.transmission_failure_reason).toBeNull();
    expect(after.retries).toBe(1);
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["acked"]);

    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ examined: 0, retried: 0 });
    await settle();
    expect(wires).toHaveLength(1);
  });

  it("a feed removed after sign (dispatch_refused:no_active_feed) is retried automatically once a feed is back — not before", async () => {
    const id = await signedLab();
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe(
      "dispatch_refused:no_active_feed",
    );

    // No feed yet: the producer itself refuses, so nothing is emitted and nothing is spent.
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ retried: 0, stillRefused: 1 });
    expect((await orderRow(id)).retries).toBe(0);
    await settle();
    expect(wires).toHaveLength(0);

    await seedFeed(ORG_A);
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ retried: 1 });
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });

  it("an emit-time refusal (orm_refused:physician_npi_unconfirmed) is retried automatically once the NPI is confirmed", async () => {
    await admin.query("UPDATE external_physician SET status='provisional', npi=NULL WHERE id=$1", [
      PH_ACTIVE,
    ]);
    const id = await signedLab();
    expect((await orderRow(id)).transmission_failure_reason).toBe(
      "orm_refused:physician_npi_unconfirmed",
    );
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ retried: 0, stillRefused: 1 });

    await admin.query(
      "UPDATE external_physician SET status='active', npi='1234567893' WHERE id=$1",
      [PH_ACTIVE],
    );
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ retried: 1 });
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });

  it("SUD-restricted and immutable-order refusals are NEVER retried automatically", async () => {
    for (const reason of [
      "orm_refused:sud_restricted",
      "orm_refused:no_routing_lab",
      "orm_refused:lab_test_codes_missing",
    ]) {
      const id = await signedLab();
      await settle();
      await arrange(
        "UPDATE order_record SET transmission_status='failed', transmission_failure_reason=$2, updated_at=now() WHERE id=$1",
        [id, reason],
      );
      const before = await count(id, "m11.order.hl7_orm_requested");
      const res = await recovery.sweepAutoRetries(ORG_A);
      expect(res.retried).toBe(0);
      expect(res.notEligible).toBeGreaterThanOrEqual(1);
      expect(await count(id, "m11.order.hl7_orm_requested")).toBe(before);
      expect((await orderRow(id)).transmission_failure_reason).toBe(reason);
      expect((await orderRow(id)).retries).toBe(0);
    }
  });

  it("a HELD order (dlq_exhausted — the lab may have it) is NEVER retried automatically", async () => {
    const id = await heldOrder();
    baaActive = true;
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ examined: 0, retried: 0 });
    await settle();
    expect(wires).toHaveLength(0);
    expect((await orderRow(id)).transmission_failure_reason).toBe("dlq_exhausted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq"]);
  });

  it("the BACKOFF gates a re-emission after an attempt: still waiting inside it, eligible once it has elapsed", async () => {
    const id = await baaLapsedOrder();
    baaActive = true;
    // One attempt already spent 1 minute ago — the first step is 10 minutes.
    await arrange(
      "UPDATE order_record SET transmission_auto_retry_count=1, transmission_auto_retry_at=now() - interval '1 minute' WHERE id=$1",
      [id],
    );
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ retried: 0, backoff: 1 });
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);

    await arrange(
      "UPDATE order_record SET transmission_auto_retry_at=now() - interval '11 minutes' WHERE id=$1",
      [id],
    );
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ retried: 1, backoff: 0 });
    expect((await orderRow(id)).retries).toBe(2);
  });

  it("at the ATTEMPT BOUND the sweep stops, raises its ONE 'operator must act' alert on the real emitter, and never alerts again", async () => {
    const id = await baaLapsedOrder();
    baaActive = true; // even with the cause cleared, the bound wins
    await arrange("UPDATE order_record SET transmission_auto_retry_count=$2 WHERE id=$1", [
      id,
      AUTO_RETRY_MAX_ATTEMPTS,
    ]);

    for (let i = 0; i < 3; i++) await recovery.sweepAutoRetries(ORG_A);
    await settle();
    expect(wires).toHaveLength(0); // never re-emitted
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
    expect((await orderRow(id)).exhausted_at).not.toBeNull();

    const alerts = await alertsOf(ORG_A, "m11.order.transmission_auto_retry_exhausted");
    expect(alerts).toHaveLength(1); // once — across three sweeps
    expect(alerts[0]?.severity).toBe("warn");
    expect(await recipientsOf((alerts[0] as { id: string }).id)).toEqual(
      [user.clinicalLead, user.orgAdmin].sort(),
    );
  });

  it("past the WINDOW (72 h since it failed) the sweep gives up the same way — even though the BAA is back", async () => {
    const id = await baaLapsedOrder();
    baaActive = true;
    await backdate(id, AUTO_RETRY_WINDOW_MS / HOUR + 8);
    const res = await recovery.sweepAutoRetries(ORG_A);
    expect(res).toMatchObject({ retried: 0, exhausted: 1 });
    await settle();
    expect(wires).toHaveLength(0);
    expect(await alertsOf(ORG_A, "m11.order.transmission_auto_retry_exhausted")).toHaveLength(1);
  });

  it("TWO concurrent sweeps dispatch exactly ONCE (F-182's row lock + conditional update — the same two guards a double-click relies on)", async () => {
    const id = await baaLapsedOrder();
    baaActive = true;
    const [a, b] = await Promise.all([
      recovery.sweepAutoRetries(ORG_A),
      recoveryB.sweepAutoRetries(ORG_A),
    ]);
    expect(a.retried + b.retried).toBe(1);
    // The loser lost a RACE — benign, never an error (see the deterministic case below).
    expect(a.errors + b.errors).toBe(0);
    await settle();
    expect(wires).toHaveLength(1);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(2); // the sign + exactly one re-emission
    expect((await orderRow(id)).retries).toBe(1);
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["acked"]);
  });

  it("ONE order's failure does not stop the sweep: the other orders are still retried and the error is counted, not swallowed", async () => {
    const poisoned = await baaLapsedOrder();
    const healthy = await signedLabAfterLapse();
    baaActive = true;
    const flaky = createStuckTransmissionRecovery({
      db: handle.db,
      resend: (organizationId, orderId) => {
        if (orderId === poisoned) throw new Error("the M40 lookup fell over");
        return svc.resendLabTransmission(organizationId, "", orderId);
      },
      baaCleared: outboundBaaCleared,
      alerts: { emit: async () => undefined },
    });
    const res = await flaky.sweepAutoRetries(ORG_A);
    expect(res).toMatchObject({ examined: 2, retried: 1, errors: 1 });
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(healthy)).transmission_status).toBe("transmitted");
    const stuck = await orderRow(poisoned);
    expect(stuck.transmission_status).toBe("failed"); // still stuck — and NOT charged an attempt
    expect(stuck.retries).toBe(0);
  });

  it("losing the row to a concurrent resend (a ConflictError) is BENIGN — counted as `raced`, never as an error, and never charged an attempt", async () => {
    const id = await baaLapsedOrder();
    baaActive = true;
    const loser = createStuckTransmissionRecovery({
      db: handle.db,
      // Exactly what F-182's resend throws when another sweeper / an operator's click got the row first.
      resend: () => {
        throw new ConflictError(
          "ORM resend not allowed (not_failed): the order was resent concurrently",
        );
      },
      baaCleared: outboundBaaCleared,
      alerts: { emit: async () => undefined },
    });
    const res = await loser.sweepAutoRetries(ORG_A);
    expect(res).toMatchObject({ examined: 1, retried: 0, raced: 1, errors: 0 });
    expect((await orderRow(id)).retries).toBe(0);
  });

  it("is tenant-scoped: sweeping ORG_A never touches ORG_B's stuck order", async () => {
    await seedFeed(ORG_B);
    baaActive = false;
    const inB = await signedLab(ORG_B, memberB);
    await settle();
    expect((await orderRow(inB)).transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    baaActive = true;

    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ examined: 0, retried: 0 });
    expect((await orderRow(inB)).transmission_status).toBe("failed"); // untouched
    expect(await recovery.sweepAutoRetries(ORG_B)).toMatchObject({ examined: 1, retried: 1 });
  });

  // ── 2. HELD orders: aging escalation and the worklist ─────────────────────────────────────────────────────────

  it("a held order inside its grace period pages nobody; at 4 h it pages ONCE (warn); at 24 h ONCE more (critical) — across many sweeps, on the real emitter", async () => {
    const id = await heldOrder();

    expect(await recovery.sweepHeldAging(ORG_A)).toMatchObject({ examined: 0, alerted: 0 });
    expect(await alertsOf(ORG_A, "m11.order.transmission_held_aging")).toHaveLength(0);

    await backdate(id, 5);
    for (let i = 0; i < 3; i++)
      expect(await recovery.sweepHeldAging(ORG_A)).toMatchObject({ examined: 1, errors: 0 });
    let alerts = await alertsOf(ORG_A, "m11.order.transmission_held_aging");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("warn");
    expect(alerts[0]?.correlation_id).toMatch(/:warn$/);
    expect(await recipientsOf((alerts[0] as { id: string }).id)).toEqual(
      [user.clinicalLead, user.orgAdmin].sort(),
    );

    await backdate(id, 25);
    for (let i = 0; i < 3; i++) await recovery.sweepHeldAging(ORG_A);
    alerts = await alertsOf(ORG_A, "m11.order.transmission_held_aging");
    expect(alerts.map((a) => a.severity)).toEqual(["warn", "critical"]);
    expect(alerts[1]?.correlation_id).toMatch(/:critical$/);

    // Never reaches a bystander in the same tenant or an admin of another tenant.
    const { rows } = await admin.query(
      `SELECT DISTINCT nd.recipient_user_id FROM notification_delivery nd JOIN alert a ON a.id = nd.alert_id
        WHERE a.event_type = 'm11.order.transmission_held_aging'`,
    );
    const reached = rows.map((r) => r.recipient_user_id as string);
    expect(reached).not.toContain(user.bystander);
    expect(reached).not.toContain(user.otherTenantAdmin);
    // The payload is ids and fixed tokens only.
    const payload = (
      await admin.query("SELECT payload FROM alert WHERE id=$1", [(alerts[0] as { id: string }).id])
    ).rows[0].payload;
    expect(JSON.stringify(payload)).not.toMatch(/Doe|Jane|MRN/);
  });

  it("the worklist lists ONLY held orders of the caller's tenant, oldest first, with reason, age, stage and feed", async () => {
    const oldest = await heldOrder();
    const newest = await heldOrder();
    await backdate(oldest, 30);
    await backdate(newest, 1);
    // Not held: refused before any row existed (auto-retry's business) and delivered.
    await baaLapsedOrder();
    baaActive = true;
    const delivered = await signedLab();
    await settle();
    expect((await orderRow(delivered)).transmission_status).toBe("transmitted");
    // Another tenant's held order.
    await seedFeed(ORG_B);
    mode = "refuse";
    const inB = await signedLab(ORG_B, memberB);
    await settle();
    mode = "ack";
    expect((await orderRow(inB)).transmission_failure_reason).toBe("dlq_exhausted");

    const page = await recovery.listHeld(ORG_A, { limit: 50 });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.orderId)).toEqual([oldest, newest]);
    expect(page.items[0]).toMatchObject({
      reason: "dlq_exhausted",
      stage: "critical",
      feedId: feedA,
    });
    expect(page.items[0]?.ageSeconds).toBeGreaterThanOrEqual(30 * 3600 - 5);
    expect(page.items[1]).toMatchObject({ stage: "none", feedId: feedA });
    expect(page.items.some((i) => i.orderId === inB)).toBe(false);
    expect((await recoveryB.listHeld(ORG_B, { limit: 50 })).items.map((i) => i.orderId)).toEqual([
      inB,
    ]);
  });

  it("GAP-030 — the worklist narrows to the given caseload: only those patients' held orders, and an empty caseload reads nothing", async () => {
    const mine = await heldOrder();
    const theirs = await heldOrder();
    const minePatient = (await orderRow(mine)).patient_id as string;
    const theirsPatient = (await orderRow(theirs)).patient_id as string;
    expect(minePatient).not.toBe(theirsPatient);

    const all = await recovery.listHeld(ORG_A, { limit: 50, patientIds: null });
    expect(all.items.map((i) => i.orderId)).toEqual(expect.arrayContaining([mine, theirs]));

    const narrowed = await recovery.listHeld(ORG_A, { limit: 50, patientIds: [minePatient] });
    expect(narrowed.items.map((i) => i.patientId)).toEqual(narrowed.items.map(() => minePatient));
    expect(narrowed.items.some((i) => i.orderId === mine)).toBe(true);
    expect(narrowed.items.some((i) => i.orderId === theirs)).toBe(false);

    expect(await recovery.listHeld(ORG_A, { limit: 50, patientIds: [] })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("the worklist paginates by a keyset cursor with no overlap or gap, and refuses a malformed cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await heldOrder();
      await backdate(id, 10 - i); // oldest first: ids[0] is the oldest
      ids.push(id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await recovery.listHeld(ORG_A, { limit: 2, cursor });
      seen.push(...page.items.map((i) => i.orderId));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(ids);

    await expect(
      recovery.listHeld(ORG_A, { limit: 2, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    const forged = Buffer.from(
      JSON.stringify({ u: "2026-01-01T00:00:00.000000Z", i: "x'); DROP TABLE order_record;--" }),
    ).toString("base64url");
    await expect(recovery.listHeld(ORG_A, { limit: 2, cursor: forged })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("a recovery_blocked order is held too (only the attested path can act on it), and application_reject is held", async () => {
    const a = await heldOrder();
    const b = await heldOrder();
    await arrange(
      "UPDATE order_record SET transmission_failure_reason='recovery_blocked:row_owns_order' WHERE id=$1",
      [a],
    );
    await arrange(
      "UPDATE order_record SET transmission_failure_reason='application_reject' WHERE id=$1",
      [b],
    );
    const page = await recovery.listHeld(ORG_A, { limit: 50 });
    expect(page.items.map((i) => i.reason).sort()).toEqual([
      "application_reject",
      "recovery_blocked:row_owns_order",
    ]);
    // ...and neither is ever auto-retried.
    baaActive = true;
    expect(await recovery.sweepAutoRetries(ORG_A)).toMatchObject({ examined: 0, retried: 0 });
  });
});
