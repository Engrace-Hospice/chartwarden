/**
 * F-187 (#248) — RECOVERY of lab orders that can never reach the lab, proven end to end over real Postgres.
 *
 * Two gaps left a signed lab order stuck with no way out:
 *
 *  1. AN M29 TERMINAL FAILURE (`dlq_exhausted` — incl. F-183's "held, delivery unverified" — or `application_reject`).
 *     The message WAS built and may have been received, so F-182's plain resend refuses it (a blind re-send orders the
 *     test twice). `recoverLabTransmission` is the way out, and it needs a HUMAN to establish what the lab holds:
 *       `not_received_by_lab` → re-dispatch exactly once (the single sanctioned exception to F-183's one-ORM-per-order),
 *       `received_by_lab`     → mark `transmitted`, send nothing.
 *     The attestation is recorded in the order's M4 write-audit diff (who / when / what).
 *  2. AN ORDER THE M29 WORKER REFUSED TO PERSIST (no/ambiguous/unlinked feed, incomplete MSH identity, lapsed BAA).
 *     F-175 returned silently, so the order stayed `pending` FOREVER and F-182's resend (which needs `failed`) could not
 *     reach it. The worker now publishes `m29.lab_order.dispatch_refused`; F-177's applier flips the order to `failed`
 *     (`dispatch_refused:<reason>`) and F-182's resend then re-runs it once the operator fixed the cause.
 *
 * Everything runs as the NOBYPASSRLS `wardenx_app` role, through the real catalog-validating publisher, M29's real T08
 * worker (a STUB `MllpTransport` — a permanent refusal to reach a real `dlq_exhausted`, then an AA), and F-177's real
 * applier. Every guard is negative-tested (the assertion fails with the guard removed).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m11:orm-recovery:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { hl7OrmDemographicsInTx } from "../src/modules/05-patient/seams/hl7-orm-demographics";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { createDbOrderBackend } from "../src/modules/11-orders/orders-route-service-db";
import { createDrizzleOrderEraseStore } from "../src/modules/11-orders/erasers/orders-eraser";
import { runVerbalOrderExpiryFanout } from "../src/modules/11-orders/jobs/verbal-order-expiry-worker";
import { buildM11OrmRequestedPorts } from "../src/modules/11-orders/orm-request/ports";
import { buildM11LabTransmissionApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-transmission-applier";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/events-by-m29";
import { parseMshEnvelope } from "../src/modules/29-external-interfaces/listener/mllp-framing";
import type { OutboundTenantKeyProvider } from "../src/modules/29-external-interfaces/outbound/dispatch-crypto";
import { buildM29OutboundDispatchConsumer } from "../src/modules/29-external-interfaces/outbound/dispatch-worker";
import { buildDrizzleOutboundFeedResolver } from "../src/modules/29-external-interfaces/outbound/feed-resolver";
import { ormOutboundEvidenceForOrder } from "../src/modules/29-external-interfaces/outbound/order-dispatch-dedupe";
import type {
  MllpTransport,
  MllpTransportSendInput,
} from "../src/modules/29-external-interfaces/outbound/mllp-transport";
import { createDbMdmStore, registerMdmSeams } from "../src/modules/40-mdm/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER_B = "44444444-4444-4444-4444-444444444444";
/** F-191 — two more ORG_A people: `USER_C` (a second co-signer / the alert test's requester), `USER_D` (the repeat-attester). */
const USER_C = "66666666-6666-6666-6666-666666666666";
const USER_D = "77777777-7777-7777-7777-777777777777";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

const PH_ACTIVE = "a0000000-0000-0000-0000-000000000001";
const FAC_ACTIVE = "b0000000-0000-0000-0000-000000000001";

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

describe.skipIf(!DB_URL)("F-187 — recovery of lab orders that cannot reach the lab, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let applier: ReturnType<typeof buildM11LabTransmissionApplierConsumer>;
  /** The real catalog-validating M11 publisher, kept so a case can build a second backend over it. */
  let m11OutboxPort: NonNullable<Parameters<typeof createDbOrderBackend>[1]>;
  let member: string;
  let memberB: string;
  /** F-191 — a SECOND person in ORG_A (`USER_B`): the co-signer of the two-person recovery control. */
  let memberA2: string;
  let memberC: string;
  let memberD: string;
  /** The ORM ports, kept so a case can build a second backend (a 1 ms TTL, a low anomaly threshold) over the same facts. */
  let ormPorts: ReturnType<typeof buildM11OrmRequestedPorts>;
  let recoveryAlerts: { emit: (org: string, input: Record<string, unknown>) => Promise<void> };
  /** F-191 — every compliance alert the recovery control raised (the real `AlertEmitter` port shape, captured). */
  let alertLog: { org: string; eventType: string; severity: string; correlationId: string; payload: Record<string, unknown> }[] = [];
  let wires: string[] = [];
  /** `refuse` → a permanent destination refusal (a real `dlq_exhausted` through the real worker); `ack` → AA. */
  let mode: "ack" | "refuse" = "ack";
  let baaActive = true;

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

  const transport: MllpTransport = {
    async send(input: MllpTransportSendInput) {
      if (mode === "refuse") return { kind: "destination_refused" as const, errorClass: "loopback_refused" as never };
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
               'WARDENX','HOSPICE-A','REFLAB','REFLAB-FAC')`,
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

  async function signedLab(kind = "lab", data: Record<string, unknown> = LAB_DATA): Promise<string> {
    const patientId = randomUUID();
    await seedPatient(patientId, ORG_A, `MRN-${patientId.slice(0, 6)}`);
    const draft = await svc.createDraft(ORG_A, member, {
      patientId,
      admissionId: ADMISSION,
      kind: kind as never,
      drafterDiscipline: "rn_case_manager",
      data,
      orderingPhysicianMdmId: PH_ACTIVE,
    });
    await svc.requestSignature(ORG_A, draft.id, { signerDiscipline: "rn_case_manager" });
    await svc.signOrder(ORG_A, member, draft.id, {
      signerDiscipline: "rn_case_manager",
      signedAtClient: new Date().toISOString(),
    });
    return draft.id;
  }

  /** A lab order that went out, was permanently refused, and the REAL applier marked `failed` / `dlq_exhausted`. */
  async function heldOrder(): Promise<string> {
    mode = "refuse";
    const id = await signedLab();
    await settle();
    mode = "ack";
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq"]);
    expect(wires).toHaveLength(0);
    return id;
  }

  async function count(aggregateId: string, eventType: string): Promise<number> {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
      [aggregateId, eventType],
    );
    return rows[0].n as number;
  }
  async function orderRow(id: string) {
    const { rows } = await admin.query(
      "SELECT status, transmission_status, transmission_ack_code, transmission_failure_reason, transmission_attempt_id FROM order_record WHERE id=$1",
      [id],
    );
    return rows[0];
  }
  async function outboundRows(orderId: string) {
    const { rows } = await admin.query(
      `SELECT status, message_control_id, idempotency_key FROM hl7_message_outbound
        WHERE organization_id=$1 AND source_aggregate_id=$2 ORDER BY queued_at, id`,
      [ORG_A, orderId],
    );
    return rows as { status: string; message_control_id: string; idempotency_key: string }[];
  }
  async function settle() {
    for (let i = 0; i < 5; i++) await dispatcher.tick();
  }

  /** F-188 — the STRUCTURED evidence every attestation now carries (who at the lab + the lab's own reference). */
  const EVIDENCE = { contactName: "Dana Reyes", labReference: "REF-2026-0041" };
  /**
   * F-191 — FILE a recovery. `not_received_by_lab` no longer executes: it returns `pending_cosign` and a request a
   * DIFFERENT person must co-sign. `received_by_lab` is still single-person and executes here.
   */
  const file = (
    id: string,
    attestation: "not_received_by_lab" | "received_by_lab",
    org = ORG_A,
    membership = member,
    user = USER,
    evidence: { contactName: string; labReference: string } = EVIDENCE,
  ) => svc.recoverLabTransmission(org, membership, id, attestation, evidence, undefined, user);
  /** F-191 — the SECOND person (`USER_B`, `memberA2`) co-signs the request, which executes the re-dispatch. */
  const cosign = (id: string, requestId: string, org = ORG_A, membership = memberA2, user = USER_B) =>
    svc.cosignLabTransmissionRecovery(org, membership, id, requestId, undefined, user);
  /**
   * The whole attested recovery as a caller of the ORIGINAL contract saw it: file, and — for the duplicate-risk
   * attestation — have the second person co-sign, returning the EXECUTION's result. Every pre-F-191 case asserts
   * through this, so what each one proves (single dispatch, the ledger, the blocked-request path…) is unchanged.
   */
  const recover = async (
    id: string,
    attestation: "not_received_by_lab" | "received_by_lab",
    org = ORG_A,
    membership = member,
    user = USER,
    evidence: { contactName: string; labReference: string } = EVIDENCE,
  ) => {
    const filed = await file(id, attestation, org, membership, user, evidence);
    if (filed.outcome !== "pending_cosign") return filed;
    return cosign(id, filed.recovery!.id, org);
  };
  /** Every `order_transmission_attestation` row for an order, oldest first (read as the superuser). */
  async function attestations(orderId: string) {
    const { rows } = await admin.query(
      `SELECT id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id,
              attested_by_membership_id, attested_by_user_id,
              cosigned_by_membership_id, cosigned_by_user_id, recovery_request_id
         FROM order_transmission_attestation WHERE order_record_id=$1 ORDER BY created_at, id`,
      [orderId],
    );
    return rows as {
      id: string;
      attestation: string;
      outcome: string;
      lab_contact_name: string;
      lab_reference: string;
      prior_failure_reason: string;
      attempt_id: string | null;
      attested_by_membership_id: string | null;
      attested_by_user_id: string | null;
      cosigned_by_membership_id: string | null;
      cosigned_by_user_id: string | null;
      recovery_request_id: string | null;
    }[];
  }
  const resend = (id: string) => svc.resendLabTransmission(ORG_A, member, id, undefined, USER);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')`,
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f184@x.test'),($2,'f184b@x.test'),($3,'f191c@x.test'),($4,'f191d@x.test')`,
      [USER, USER_B, USER_C, USER_D],
    );
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    memberB = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_B, ORG_B],
      )
    ).rows[0].id as string;
    memberA2 = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_B, ORG_A],
      )
    ).rows[0].id as string;
    memberC = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_C, ORG_A],
      )
    ).rows[0].id as string;
    memberD = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_D, ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, status) VALUES
         ('${PH_ACTIVE}', '1234567893', 'Sam', 'Smith', 'active')`,
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

    const catalog = buildBootOutboxCatalog([M11_OUTBOX_EVENTS, M29_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const m11Outbox = { publish: (tx: unknown, e: any) => publisher.publish(tx as never, { ...e, callerModule: "m11" }) };
    m11OutboxPort = m11Outbox as never;
    const m29Outbox = { publish: (tx: any, e: any) => publisher.publish(tx, { ...e, callerModule: "m29" }) };

    ormPorts = buildM11OrmRequestedPorts({
      patient: hl7OrmDemographicsInTx,
      feeds: buildDrizzleOutboundFeedResolver(),
      // F-188 — the evidence the attested recovery checks a `not_received_by_lab` against.
      outboundEvidence: ormOutboundEvidenceForOrder,
    });
    recoveryAlerts = {
      emit: async (org, input) => {
        alertLog.push({ org, ...input } as (typeof alertLog)[number]);
      },
    };
    svc = createDbOrderBackend(handle.db, m11Outbox, ormPorts, { alerts: recoveryAlerts as never });
    applier = buildM11LabTransmissionApplierConsumer({ db: handle.db, outbox: m11Outbox });

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
        applier,
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    alertLog = [];
    wires = [];
    mode = "ack";
    baaActive = true;
    await admin.query("DELETE FROM outbox_event WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM external_feed WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await seedFeed(ORG_A);
  });

  // ── 1. Attested `not_received_by_lab` → re-dispatched exactly once ────────────────────────────────────────

  it("a HELD order (real permanent refusal → dlq_exhausted) is re-dispatched ONCE on `not_received_by_lab`: new row, new MSH-10, delivered, transmitted", async () => {
    const id = await heldOrder();
    const [first] = await outboundRows(id);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);

    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
    expect(res.refusalReason).toBeNull();
    expect(res.order.transmissionStatus).toBe("pending");

    // State + event committed together. F-188: a `pending` order carries NO failure reason (F-187 parked a
    // `recovery_attested:` marker here); the attestation lives in `order_transmission_attestation`.
    const pending = await orderRow(id);
    expect(pending.transmission_status).toBe("pending");
    expect(pending.transmission_failure_reason).toBeNull();
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(2);

    await settle();
    expect(wires).toHaveLength(1);
    expect(wires[0]).toContain("ORM^O01");
    const after = await orderRow(id);
    expect(after.transmission_status).toBe("transmitted");
    expect(after.transmission_ack_code).toBe("AA");
    expect(after.transmission_failure_reason).toBeNull();

    const rows = await outboundRows(id);
    expect(rows.map((r) => r.status)).toEqual(["dlq", "acked"]);
    // A genuinely NEW attempt: its own MSH-10 and its own attestation-scoped idempotency key.
    expect(rows[1]!.message_control_id).not.toBe(first!.message_control_id);
    expect(rows[1]!.idempotency_key).not.toBe(first!.idempotency_key);
  });

  it("F-188 — the attestation has a PROPER HOME: one append-only row (who, what, the evidence, the prior reason, the attempt) and the M4 diff carries the real user on BOTH the order and the attestation", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");

    const [att] = await attestations(id);
    expect(await attestations(id)).toHaveLength(1);
    expect(att).toMatchObject({
      attestation: "not_received_by_lab",
      outcome: "redispatched",
      lab_contact_name: "Dana Reyes",
      lab_reference: "REF-2026-0041",
      prior_failure_reason: "dlq_exhausted",
      attested_by_membership_id: member,
      attested_by_user_id: USER,
      // F-191 — the SECOND person, and the request this ledger row executed.
      cosigned_by_membership_id: memberA2,
      cosigned_by_user_id: USER_B,
    });
    expect(att!.recovery_request_id).not.toBeNull();
    // The attestation started THE current attempt: the order row and the row agree, and the event carries it too.
    const order = await orderRow(id);
    expect(att!.attempt_id).toBe(order.transmission_attempt_id);
    const { rows: ev } = await admin.query(
      `SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.hl7_orm_requested'
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(ev[0].payload).toMatchObject({ attemptId: att!.attempt_id, redispatchAttestationId: att!.id });

    // The order's own write-audit diff still records WHO moved it failed → pending, and the reason is cleared.
    const { rows } = await admin.query(
      `SELECT actor_user_id, before->>'transmission_failure_reason' AS br, after->>'transmission_failure_reason' AS ar
         FROM audit_event
        WHERE resource_kind='order_record' AND resource_id=$1 AND event_type='order_record.update'
          AND before->>'transmission_status'='failed' AND after->>'transmission_status'='pending'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    // F-191 — the EXECUTION is the co-signer's act (the order moved in the second person's transaction); the requester is
    // on the ledger row (`attested_by_*`) and on the request's own INSERT audit below.
    expect(rows[0].actor_user_id).toBe(USER_B);
    expect(rows[0].br).toBe("dlq_exhausted");
    expect(rows[0].ar).toBeNull();
    // ... and the attestation row is audited under the same user, with the contact NAME scrubbed out of the diff.
    const { rows: aud } = await admin.query(
      `SELECT actor_user_id, after FROM audit_event
        WHERE resource_kind='order_transmission_attestation' AND resource_id=$1 AND event_type='order_transmission_attestation.insert'`,
      [att!.id],
    );
    expect(aud).toHaveLength(1);
    expect(aud[0].actor_user_id).toBe(USER_B);
    expect(JSON.stringify(aud[0].after)).not.toContain("Dana Reyes");
    expect(aud[0].after.lab_reference).toBe("REF-2026-0041");
    // F-191 — the request row is audited too: filed by the requester, resolved by the co-signer, NAME scrubbed both times.
    const { rows: reqAud } = await admin.query(
      `SELECT event_type, actor_user_id, after FROM audit_event
        WHERE resource_kind='order_recovery_request' AND resource_id=$1 ORDER BY created_at, id`,
      [att!.recovery_request_id],
    );
    expect(reqAud.map((r) => [r.event_type, r.actor_user_id])).toEqual([
      ["order_recovery_request.insert", USER],
      ["order_recovery_request.update", USER_B],
    ]);
    expect(JSON.stringify(reqAud)).not.toContain("Dana Reyes");
  });

  it("two CONCURRENT attested recoveries dispatch ONE message; the loser is refused 409 (already_pending / not_failed / not_pending)", async () => {
    const id = await heldOrder();
    const results = await Promise.allSettled([recover(id, "not_received_by_lab"), recover(id, "not_received_by_lab")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    // The order row is locked FOR UPDATE, so the two flows serialize; the loser meets the winner at whichever guard it
    // reaches first: a request already pending, an order no longer failed, or a request already resolved.
    expect(String(bad[0]!.reason.message)).toMatch(
      /Transmission recovery not allowed \((already_pending|not_failed|not_pending)\)/,
    );
    expect(bad[0]!.reason.statusCode).toBe(409);

    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(2); // the original + ONE attested
    await settle();
    expect(wires).toHaveLength(1);
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq", "acked"]);
  });

  it("a SEQUENTIAL second recovery after success is refused and sends nothing more", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    await settle();
    await expect(recover(id, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_failed"),
    });
    expect(wires).toHaveLength(1);
  });

  it("if the re-dispatch is refused AGAIN, a second attestation may try again — each attempt its own row, never a re-use", async () => {
    const id = await heldOrder();
    mode = "refuse";
    await recover(id, "not_received_by_lab");
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("dlq_exhausted");
    mode = "ack";
    await recover(id, "not_received_by_lab");
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq", "dlq", "acked"]);
    expect(wires).toHaveLength(1);
  });

  it("if the producer now REFUSES (a fact is missing) the order is left EXACTLY as it was — never rewritten to orm_refused:*", async () => {
    const id = await heldOrder();
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("still_refused");
    expect(res.refusalReason).toBe("no_active_feed");
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    // NOT `orm_refused:no_active_feed`: that would make F-182's plain resend (no attestation) reachable for an
    // order whose first attempt may have reached the lab.
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");
    await expect(resend(id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("not_an_orm_refusal") });
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
  });

  // ── 2. Attested `received_by_lab` → transmitted, nothing sent ─────────────────────────────────────────────

  it("`received_by_lab` marks the order transmitted WITHOUT sending, publishes the status change, and audits the attestation", async () => {
    const id = await heldOrder();
    const res = await recover(id, "received_by_lab");
    expect(res.outcome).toBe("marked_transmitted");
    expect(res.order.transmissionStatus).toBe("transmitted");

    await settle();
    expect(wires).toHaveLength(0);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1); // no new request
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["dlq"]);
    const { rows: ev } = await admin.query(
      `SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.transmission_status_changed'
        ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(ev[0].payload).toMatchObject({ fromStatus: "failed", toStatus: "transmitted" });

    const { rows } = await admin.query(
      `SELECT actor_user_id, after->>'transmission_failure_reason' AS ar FROM audit_event
        WHERE resource_kind='order_record' AND resource_id=$1 AND event_type='order_record.update'
          AND before->>'transmission_status'='failed' AND after->>'transmission_status'='transmitted'`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(USER);
    // F-188 — a DELIVERED order carries no failure reason and no attestation marker (F-187 left
    // `recovery_attested:received_by_lab:<uuid>` here forever); the attestation is in its own table.
    expect(rows[0].ar).toBeNull();
    const order = await orderRow(id);
    expect(order.transmission_status).toBe("transmitted");
    expect(order.transmission_failure_reason).toBeNull();
    const atts = await attestations(id);
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      attestation: "received_by_lab",
      outcome: "marked_transmitted",
      attempt_id: null, // nothing was sent, so no attempt was started
      prior_failure_reason: "dlq_exhausted",
      lab_reference: "REF-2026-0041",
    });
  });

  it("an AR-rejected order cannot be marked received (the lab explicitly refused it) — but can be re-dispatched", async () => {
    const id = await heldOrder();
    await admin.query("UPDATE order_record SET transmission_failure_reason='application_reject' WHERE id=$1", [id]);
    await expect(recover(id, "received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("lab_rejected_order"),
    });
    expect((await orderRow(id)).transmission_status).toBe("failed");
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
  });

  // ── 3. Eligibility: only an M29 terminal failure ──────────────────────────────────────────────────────────

  it("a DELIVERED order, a PENDING order and an emit-time refusal are NOT recoverable", async () => {
    const delivered = await signedLab();
    await settle();
    expect((await orderRow(delivered)).transmission_status).toBe("transmitted");
    await expect(recover(delivered, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_failed"),
    });

    const refused = await signedLab();
    await admin.query(
      "UPDATE order_record SET transmission_status='failed', transmission_failure_reason='orm_refused:patient_dob_missing' WHERE id=$1",
      [refused],
    );
    await expect(recover(refused, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_an_m29_terminal_failure"),
    });
    expect(wires).toHaveLength(1); // only the delivered order's original
  });

  it("a non-lab order is not recoverable (not_a_lab_order)", async () => {
    const id = await signedLab("dme", { hcpcs: "E0260" });
    await expect(recover(id, "not_received_by_lab")).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_a_lab_order"),
    });
  });

  it("another tenant's order is 404 (RLS) and left untouched; an unknown id is 404", async () => {
    const id = await heldOrder();
    await expect(recover(id, "not_received_by_lab", ORG_B, memberB, USER_B)).rejects.toMatchObject({ statusCode: 404 });
    expect((await orderRow(id)).transmission_failure_reason).toBe("dlq_exhausted");
    await expect(recover(randomUUID(), "not_received_by_lab")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("without the ORM ports (not configured) recovery is refused, never a silent no-op", async () => {
    const bare = createDbOrderBackend(handle.db);
    const id = await heldOrder();
    await expect(
      bare.recoverLabTransmission(ORG_A, member, id, "not_received_by_lab", EVIDENCE, undefined, USER),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("not_configured"),
    });
  });

  // ── 4. PENDING FOREVER: the worker's "wrote no row" exits now end in a terminal, resendable `failed` ──────

  it("a LAPSED BAA no longer leaves the order pending forever: it becomes failed (dispatch_refused:baa_inactive), alerts once, and F-182's resend delivers after the BAA is renewed", async () => {
    baaActive = false;
    const id = await signedLab();
    expect((await orderRow(id)).transmission_status).toBe("pending");
    await settle();

    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    expect(await outboundRows(id)).toHaveLength(0); // no row: nothing was ever sent
    expect(wires).toHaveLength(0);
    expect(await count(id, "m29.lab_order.dispatch_refused")).toBe(1);
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBe(1); // M36's ordering-provider alert
    expect(await count(id, "m11.order.transmission_status_changed")).toBe(1);

    baaActive = true; // the compliance officer renews the BAA
    const res = await resend(id);
    expect(res.outcome).toBe("requested");
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["acked"]);
  });

  it("a feed removed after sign (no_active_feed at dispatch) becomes failed (dispatch_refused:no_active_feed) and resends once a feed is back", async () => {
    const id = await signedLab();
    await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:no_active_feed");
    expect(wires).toHaveLength(0);

    await seedFeed(ORG_A);
    await resend(id);
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });

  it("an MSH identity that goes incomplete after sign becomes failed (dispatch_refused:feed_identity_incomplete) with a PHI-free event, and resends once the operator completes the feed", async () => {
    // (The F-181 emitter already refuses an incomplete identity AT SIGN as `orm_refused:*`; this is the window
    // between sign and dispatch — an operator edits the feed while the request is in the outbox.)
    const id = await signedLab();
    await admin.query("UPDATE external_feed SET msh_receiving_facility=NULL WHERE organization_id=$1", [ORG_A]);
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:feed_identity_incomplete");
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.dispatch_refused'",
      [id],
    );
    expect(JSON.stringify(rows[0].payload)).not.toMatch(/Doe|Jane|MRN|msh_receiving/);

    await admin.query("UPDATE external_feed SET msh_receiving_facility='REFLAB-FAC' WHERE organization_id=$1", [ORG_A]);
    await resend(id);
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
  });

  it("a STALE or redelivered refusal never disturbs an order that has moved on (applier applies it to `pending` only)", async () => {
    const id = await signedLab();
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    const before = await count(id, "m11.order.transmission_status_changed");
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: { orderId: id, organizationId: ORG_A, feedId: null, refusalId: randomUUID(), reason: "baa_inactive" },
    });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("transmitted");
    expect(row.transmission_failure_reason).toBeNull();
    expect(await count(id, "m11.order.transmission_status_changed")).toBe(before);
  });

  it("a refusal applies ONLY to a `pending` order — not to `pending_retry` or `not_required`, which the terminal-state check alone would let through", async () => {
    for (const status of ["pending_retry", "not_required"]) {
      const id = await signedLab();
      await admin.query("UPDATE order_record SET transmission_status=$2 WHERE id=$1", [id, status]);
      const before = await count(id, "m11.order.transmission_status_changed");
      await applier.handle({
        eventType: "m29.lab_order.dispatch_refused",
        organizationId: ORG_A,
        payload: { orderId: id, organizationId: ORG_A, feedId: null, refusalId: randomUUID(), reason: "no_active_feed" },
      });
      const row = await orderRow(id);
      expect(row.transmission_status, `status=${status}`).toBe(status);
      expect(await count(id, "m11.order.transmission_status_changed"), `status=${status}`).toBe(before);
    }
  });

  // ══ F-188 ════════════════════════════════════════════════════════════════════════════════════════════════════
  // Four residual risks of the F-187 attested recovery, closed. Every guard below is mutation-tested: the case named
  // in its comment fails with the guard removed.

  /** Assert a recovery was refused with a specific 409 code and changed NOTHING. */
  async function expectRefusedUntouched(
    id: string,
    attestation: "not_received_by_lab" | "received_by_lab",
    code: string,
  ): Promise<void> {
    const before = await orderRow(id);
    const requested = await count(id, "m11.order.hl7_orm_requested");
    const atts = (await attestations(id)).length;
    await expect(recover(id, attestation)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(code),
    });
    expect(await orderRow(id)).toEqual(before);
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(requested);
    expect((await attestations(id)).length).toBe(atts);
  }

  async function firstEnum(type: string): Promise<string> {
    const { rows } = await admin.query(`SELECT (enum_range(NULL::${type}))[1] AS v`);
    return rows[0].v as string;
  }
  /** A REAL M29 `lab_observation` matched to the order — the lab has already returned a result for it. */
  async function labObservationFor(orderId: string): Promise<void> {
    const { rows: pat } = await admin.query("SELECT patient_id FROM order_record WHERE id=$1", [orderId]);
    await admin.query(
      `INSERT INTO lab_observation
         (organization_id, provider_entity_id, source_message_id, patient_id, order_id, observation_date,
          result_status, loinc_code, loinc_display_text, terminology_validation, abnormal_summary)
       VALUES ($1,$2,$3,$4,$5, now(), $6, '2345-7','Glucose', $7, $8)`,
      [
        ORG_A,
        randomUUID(),
        randomUUID(),
        pat[0].patient_id,
        orderId,
        await firstEnum("lab_result_status"),
        await firstEnum("lab_terminology_validation"),
        await firstEnum("lab_abnormal_summary"),
      ],
    );
  }

  // ── Risk 1 — WRONG ATTESTATION: structured evidence + a contradiction check ─────────────────────────────

  it("F-188 risk 1: the DB itself rejects evidence that could carry a patient identifier (digits in a name, spaces in a reference) — nothing is dispatched, attested or changed", async () => {
    const id = await heldOrder();
    for (const bad of [
      { contactName: "Dana 5550100", labReference: "REF-2026-0041" }, // a phone number / MRN in the name
      { contactName: "Dana Reyes", labReference: "called about Jane Doe" }, // free text in the reference
      { contactName: "D", labReference: "REF-2026-0041" },
    ]) {
      const before = await orderRow(id);
      await expect(recover(id, "not_received_by_lab", ORG_A, member, USER, bad)).rejects.toThrow();
      // The transaction rolled back as a whole: still failed, no request event, no attestation, nothing on the wire.
      expect(await orderRow(id)).toEqual(before);
      expect(await count(id, "m11.order.hl7_orm_requested")).toBe(1);
      expect(await attestations(id)).toHaveLength(0);
    }
    await settle();
    expect(wires).toHaveLength(0);
  });

  it("F-188 risk 1: a result the lab ALREADY returned (order_record.results_*) refutes `not_received_by_lab` — 409 lab_result_received, nothing changes", async () => {
    const id = await heldOrder();
    await admin.query(
      "UPDATE order_record SET results_status='partial_results_received', results_first_received_at=now() WHERE id=$1",
      [id],
    );
    await expectRefusedUntouched(id, "not_received_by_lab", "lab_result_received");
    await settle();
    expect(wires).toHaveLength(0);
  });

  it("F-188 risk 1: an M29 `lab_observation` matched to the order refutes `not_received_by_lab` — the lab cannot have returned a result for an order it never got", async () => {
    const id = await heldOrder();
    await labObservationFor(id);
    await expectRefusedUntouched(id, "not_received_by_lab", "lab_result_received");
    // ... and the SAME evidence does not stand in the way of the truthful attestation: the lab HAS it.
    const res = await recover(id, "received_by_lab");
    expect(res.outcome).toBe("marked_transmitted");
  });

  it("F-188 risk 1: an outbound row the lab ACKNOWLEDGED refutes `not_received_by_lab` (lab_acknowledged) — but `received_by_lab` is not blocked", async () => {
    const id = await signedLab();
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect((await outboundRows(id)).map((r) => r.status)).toEqual(["acked"]);
    // A late failure signal marks the delivered order failed (e.g. a stale event); the lab's ACK is still on record.
    await admin.query(
      "UPDATE order_record SET transmission_status='failed', transmission_failure_reason='dlq_exhausted' WHERE id=$1",
      [id],
    );
    await expectRefusedUntouched(id, "not_received_by_lab", "lab_acknowledged");
    expect(wires).toHaveLength(1); // the original only
    const res = await recover(id, "received_by_lab");
    expect(res.outcome).toBe("marked_transmitted");
  });

  it("F-188 risk 1: a send still queued or in flight refutes `not_received_by_lab` (send_in_progress) — a second send would duplicate it", async () => {
    for (const status of ["queued", "in_flight"]) {
      const id = await heldOrder();
      await admin.query("UPDATE hl7_message_outbound SET status=$2 WHERE organization_id=$1 AND source_aggregate_id=$3", [
        ORG_A,
        status,
        id,
      ]);
      await expectRefusedUntouched(id, "not_received_by_lab", "send_in_progress");
    }
    expect(wires).toHaveLength(0);
  });

  it("F-188 risk 1: WITHOUT the evidence port the recovery FAILS CLOSED (evidence_unavailable) — a safety check that cannot run is not 'no contradiction'", async () => {
    const noEvidence = createDbOrderBackend(
      handle.db,
      m11OutboxPort,
      buildM11OrmRequestedPorts({ patient: hl7OrmDemographicsInTx, feeds: buildDrizzleOutboundFeedResolver() }),
    );
    const id = await heldOrder();
    await expect(
      noEvidence.recoverLabTransmission(ORG_A, member, id, "not_received_by_lab", EVIDENCE, undefined, USER),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("evidence_unavailable") });
    expect((await orderRow(id)).transmission_status).toBe("failed");
    expect(await attestations(id)).toHaveLength(0);
    // `received_by_lab` needs no outbound evidence, so it is not blocked by the missing port.
    const ok = await noEvidence.recoverLabTransmission(ORG_A, member, id, "received_by_lab", EVIDENCE, undefined, USER);
    expect(ok.outcome).toBe("marked_transmitted");
  });

  // ── Risk 2 — STALE REFUSAL: a refusal is bound to the attempt it refused ────────────────────────────────

  it("F-188 risk 2: every emission mints its own attempt id, persisted on the order and carried on the event — sign, F-182 resend and recovery", async () => {
    baaActive = false;
    const id = await signedLab();
    const signed = await orderRow(id);
    expect(signed.transmission_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    const { rows: ev0 } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m11.order.hl7_orm_requested'",
      [id],
    );
    expect(ev0[0].payload.attemptId).toBe(signed.transmission_attempt_id);
    await settle();
    expect((await orderRow(id)).transmission_status).toBe("failed");

    await resend(id);
    const resent = await orderRow(id);
    expect(resent.transmission_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resent.transmission_attempt_id).not.toBe(signed.transmission_attempt_id);
  });

  it("F-188 risk 2: a `dispatch_refused` redelivered AFTER the operator resent does NOT flip the order failed again; the refusal for the CURRENT attempt still does", async () => {
    baaActive = false;
    const id = await signedLab();
    await settle(); // refusal #1 (attempt A1) → failed / dispatch_refused:baa_inactive
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    const { rows: r1 } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.dispatch_refused'",
      [id],
    );
    const staleRefusal = r1[0].payload; // names attempt A1

    await resend(id); // attempt A2, order `pending` again — its request is queued in the outbox, not yet dispatched
    const a2 = (await orderRow(id)).transmission_attempt_id;
    expect(a2).not.toBe(staleRefusal.attemptId);
    const changed = await count(id, "m11.order.transmission_status_changed");

    // The relay redelivers refusal #1 (its consumer receipt was lost). Before F-188 the `pending` guard alone let it
    // through and flipped the freshly re-requested order back to `failed`.
    await applier.handle({ eventType: "m29.lab_order.dispatch_refused", organizationId: ORG_A, payload: staleRefusal });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("pending");
    expect(row.transmission_failure_reason).toBeNull();
    expect(await count(id, "m11.order.transmission_status_changed")).toBe(changed);

    // The BAA is still lapsed, so the worker now refuses attempt A2 — THAT refusal names the current attempt and applies.
    await settle();
    const after = await orderRow(id);
    expect(after.transmission_status).toBe("failed");
    expect(after.transmission_failure_reason).toBe("dispatch_refused:baa_inactive");
    expect(await count(id, "m29.lab_order.dispatch_refused")).toBe(2);
  });

  it("F-188 risk 2: a stale refusal is ignored after an ATTESTED recovery too (the recovery mints a new attempt)", async () => {
    const id = await heldOrder();
    const before = (await orderRow(id)).transmission_attempt_id;
    await recover(id, "not_received_by_lab");
    const current = (await orderRow(id)).transmission_attempt_id;
    expect(current).not.toBe(before);
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: {
        orderId: id,
        organizationId: ORG_A,
        feedId: null,
        refusalId: randomUUID(),
        reason: "baa_inactive",
        attemptId: before ?? randomUUID(), // the PREVIOUS attempt
      },
    });
    expect((await orderRow(id)).transmission_status).toBe("pending");
    // The refusal that names the CURRENT attempt applies.
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: {
        orderId: id,
        organizationId: ORG_A,
        feedId: null,
        refusalId: randomUUID(),
        reason: "baa_inactive",
        attemptId: current,
      },
    });
    expect((await orderRow(id)).transmission_status).toBe("failed");
  });

  it("F-188 risk 2: a refusal from a request that predates F-188 (no attempt id) is applied exactly as before", async () => {
    const id = await signedLab();
    await admin.query("UPDATE order_record SET transmission_attempt_id=NULL WHERE id=$1", [id]);
    await applier.handle({
      eventType: "m29.lab_order.dispatch_refused",
      organizationId: ORG_A,
      payload: { orderId: id, organizationId: ORG_A, feedId: null, refusalId: randomUUID(), reason: "no_active_feed" },
    });
    expect((await orderRow(id)).transmission_failure_reason).toBe("dispatch_refused:no_active_feed");
  });

  // ── Risk 3 — the attestation's home: append-only, RLS-scoped, and the delivered order is clean ──────────

  it("F-188 risk 3: the attestation table is APPEND-ONLY — the app role cannot UPDATE or DELETE a row, and not even a superuser can (trigger)", async () => {
    const id = await heldOrder();
    await recover(id, "received_by_lab");
    const [att] = await attestations(id);
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        tx.execute(sql`UPDATE order_transmission_attestation SET lab_reference = 'TAMPERED-001' WHERE id = ${att!.id}`),
      ),
    ).rejects.toThrow();
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        tx.execute(sql`DELETE FROM order_transmission_attestation WHERE id = ${att!.id}`),
      ),
    ).rejects.toThrow();
    // A role that DOES hold the privilege is still stopped by the trigger.
    await expect(
      admin.query("UPDATE order_transmission_attestation SET lab_reference='TAMPERED-001' WHERE id=$1", [att!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(admin.query("DELETE FROM order_transmission_attestation WHERE id=$1", [att!.id])).rejects.toThrow(
      /append-only/,
    );
    expect((await attestations(id))[0]).toMatchObject({ lab_reference: "REF-2026-0041" });
  });

  it("F-188 risk 3: cross-tenant — another org's context sees NO attestation rows and cannot write one for this org (RLS, as the real app role)", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    expect(await attestations(id)).toHaveLength(1);

    const visibleTo = async (organizationId: string): Promise<number> => {
      const res = await withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
        tx.execute(sql`SELECT id FROM order_transmission_attestation WHERE order_record_id = ${id}`),
      );
      return (res as unknown as { rows: unknown[] }).rows.length;
    };
    expect(await visibleTo(ORG_B)).toBe(0);
    expect(await visibleTo(ORG_A)).toBe(1);

    await expect(
      withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
        tx.execute(sql`INSERT INTO order_transmission_attestation
          (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id)
          VALUES (${ORG_A}, ${id}, 'not_received_by_lab', 'redispatched', 'Dana Reyes', 'REF-2026-0041', 'dlq_exhausted', ${randomUUID()})`),
      ),
    ).rejects.toThrow();
  });

  it("F-188 risk 3: the two outcome constraints agree — a `received_by_lab` row cannot claim an attempt, a re-dispatch must have one", async () => {
    const id = await heldOrder();
    await expect(
      admin.query(
        `INSERT INTO order_transmission_attestation
           (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id)
         VALUES ($1,$2,'received_by_lab','marked_transmitted','Dana Reyes','REF-2026-0041','dlq_exhausted',$3)`,
        [ORG_A, id, randomUUID()],
      ),
    ).rejects.toThrow(/outcome_agrees/);
    await expect(
      admin.query(
        `INSERT INTO order_transmission_attestation
           (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason, attempt_id)
         VALUES ($1,$2,'not_received_by_lab','redispatched','Dana Reyes','REF-2026-0041','dlq_exhausted',NULL)`,
        [ORG_A, id],
      ),
      // (no co-signer either: Postgres reports one violated CHECK, and this case is about the OUTCOME rule)
    ).rejects.toThrow(/outcome_agrees|dual_control/);
    await expect(
      admin.query(
        `INSERT INTO order_transmission_attestation
           (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason,
            attempt_id, attested_by_user_id, cosigned_by_user_id, recovery_request_id)
         VALUES ($1,$2,'not_received_by_lab','redispatched','Dana Reyes','REF-2026-0041','dlq_exhausted',NULL,$3,$4,$5)`,
        [ORG_A, id, USER, USER_B, randomUUID()],
      ),
    ).rejects.toThrow(/outcome_agrees/);
  });

  it("F-188 risk 3: a re-dispatch that is later DELIVERED ends with a clean order (no reason, no marker) and the attestation still on record", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    await settle();
    const order = await orderRow(id);
    expect(order.transmission_status).toBe("transmitted");
    expect(order.transmission_failure_reason).toBeNull();
    expect(await attestations(id)).toHaveLength(1);
  });

  // ── Risk 4 — BLOCKED ATTESTED REQUEST: never silently `pending` ─────────────────────────────────────────

  it("F-188 risk 4: an attested re-dispatch the worker cannot honour (a row appeared and owns the order) ends the order ACTIONABLE — failed / recovery_blocked:row_owns_order — not `pending` forever", async () => {
    const id = await heldOrder();
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
    const attempt = (await orderRow(id)).transmission_attempt_id;
    // Between the operator's request and the worker's claim, a send takes ownership of the order (e.g. the reclaim
    // sweep requeued the dead attempt) — the race the route-time evidence check cannot see.
    await admin.query("UPDATE hl7_message_outbound SET status='in_flight' WHERE organization_id=$1 AND source_aggregate_id=$2", [
      ORG_A,
      id,
    ]);
    await settle();

    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("recovery_blocked:row_owns_order");
    expect(wires).toHaveLength(0);
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.dispatch_refused'",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ reason: "attested_redispatch_blocked", attemptId: attempt });
    expect(JSON.stringify(rows[0].payload)).not.toMatch(/Doe|Jane|MRN/);
    expect(await count(id, "m11.order.transmission_terminal_failed")).toBeGreaterThanOrEqual(1); // M36's alert
  });

  it("F-188 risk 4: a `recovery_blocked` order is NOT resendable (a row exists), refuses a new attestation while that row still owns it, and is recoverable once it settles", async () => {
    const id = await heldOrder();
    await recover(id, "not_received_by_lab");
    await admin.query("UPDATE hl7_message_outbound SET status='in_flight' WHERE organization_id=$1 AND source_aggregate_id=$2", [
      ORG_A,
      id,
    ]);
    await settle();
    expect((await orderRow(id)).transmission_failure_reason).toBe("recovery_blocked:row_owns_order");

    // F-182's plain resend must not act on it: it would only be swallowed by F-183's order-level guard.
    await expect(resend(id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("not_an_orm_refusal") });
    // While the row still owns the order, the attested path re-verifies and refuses.
    await expectRefusedUntouched(id, "not_received_by_lab", "send_in_progress");

    // The owning row settles as a dead end (the send never reached the lab) → the attested path works again.
    await admin.query("UPDATE hl7_message_outbound SET status='dlq' WHERE organization_id=$1 AND source_aggregate_id=$2", [
      ORG_A,
      id,
    ]);
    const res = await recover(id, "not_received_by_lab");
    expect(res.outcome).toBe("redispatched");
    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect(await attestations(id)).toHaveLength(2); // both attestations are on record
  });

  // ── F-191 — the TWO-PERSON control on `not_received_by_lab` ─────────────────────────────────────────────────────
  //
  // `not_received_by_lab` is the duplicate-risk attestation (a wrong one orders the test twice). It now FILES a
  // `pending_cosign` request that a DIFFERENT authorized person must co-sign; M3 break-glass's shape (a status, a
  // `cosigned_by`, a distinctness CHECK, the guards in the UPDATE's WHERE). `received_by_lab` stays single-person.

  /** Every `order_recovery_request` row for an order, oldest first (read as the superuser). */
  async function requests(orderId: string) {
    const { rows } = await admin.query(
      "SELECT * FROM order_recovery_request WHERE order_record_id=$1 ORDER BY requested_at, id",
      [orderId],
    );
    return rows as Record<string, unknown>[];
  }
  /** A second ORG_A backend over the SAME facts and publisher — a different clock/TTL/threshold, the same alert log. */
  const backendWith = (controls: Record<string, unknown>) =>
    createDbOrderBackend(handle.db, m11OutboxPort, ormPorts, { alerts: recoveryAlerts as never, ...controls } as never);

  it("F-191: FILING a `not_received_by_lab` recovery re-dispatches NOTHING — a pending request (24 h), the order untouched", async () => {
    const id = await heldOrder();
    const before = await count(id, "m11.order.hl7_orm_requested");

    const res = await file(id, "not_received_by_lab");
    expect(res.outcome).toBe("pending_cosign");
    expect(res.recovery).toMatchObject({
      status: "pending_cosign",
      orderId: id,
      requestedByMembershipId: member,
      cosignedByMembershipId: null,
      resolvedAt: null,
    });
    expect(Date.parse(res.recovery!.expiresAt) - Date.parse(res.recovery!.requestedAt)).toBe(24 * 3_600_000);

    // The order is EXACTLY as it was: still failed for the same reason, no event, no ledger row, nothing on the wire.
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect(row.transmission_failure_reason).toBe("dlq_exhausted");
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(before);
    expect(await attestations(id)).toHaveLength(0);
    await settle();
    expect(wires).toHaveLength(0);
    expect(await requests(id)).toHaveLength(1);
  });

  it("F-191: a DIFFERENT person's co-signature executes it ONCE — the request `executed`, the ledger carries BOTH people, one message goes out", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");

    const done = await cosign(id, filed.recovery!.id);
    expect(done.outcome).toBe("redispatched");
    expect(done.recovery).toMatchObject({
      id: filed.recovery!.id,
      status: "executed",
      requestedByMembershipId: member,
      cosignedByMembershipId: memberA2,
    });
    const [req] = await requests(id);
    expect(req).toMatchObject({
      status: "executed",
      requested_by_user_id: USER,
      cosigned_by_user_id: USER_B,
    });
    expect(req!.resolved_at).not.toBeNull();
    const [att] = await attestations(id);
    expect(att).toMatchObject({
      attested_by_user_id: USER,
      cosigned_by_user_id: USER_B,
      recovery_request_id: filed.recovery!.id,
    });
    expect(req!.attestation_id).toBe(att!.id);

    await settle();
    expect(wires).toHaveLength(1);
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(2); // the original + ONE attested
  });

  it("F-191: the REQUESTER cannot co-sign their own request — 409 `self_cosign`, nothing dispatched, and the database refuses it too (CHECK)", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");

    await expect(cosign(id, filed.recovery!.id, ORG_A, member, USER)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("(self_cosign)"),
    });
    const row = await orderRow(id);
    expect(row.transmission_status).toBe("failed");
    expect((await requests(id))[0]!.status).toBe("pending_cosign");
    await settle();
    expect(wires).toHaveLength(0);

    // The at-rest twin: even a superuser cannot mark the request co-signed by the person who filed it.
    await expect(
      admin.query(
        `UPDATE order_recovery_request
            SET status='executed', cosigned_by_user_id=requested_by_user_id, cosigned_by_membership_id=requested_by_membership_id,
                resolved_at=now(), attestation_id=gen_random_uuid()
          WHERE id=$1`,
        [filed.recovery!.id],
      ),
    ).rejects.toThrow(/cosigner_distinct/);
  });

  it("F-191: two DIFFERENT co-signers racing on one request dispatch ONE message — the loser is refused 409", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");
    const results = await Promise.allSettled([
      cosign(id, filed.recovery!.id, ORG_A, memberA2, USER_B),
      cosign(id, filed.recovery!.id, ORG_A, memberC, USER_C),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(String(bad[0]!.reason.message)).toMatch(/Transmission recovery not allowed \((not_pending|not_failed)\)/);
    expect(bad[0]!.reason.statusCode).toBe(409);

    expect(await count(id, "m11.order.hl7_orm_requested")).toBe(2);
    await settle();
    expect(wires).toHaveLength(1);
    expect((await requests(id)).filter((r) => r.status === "executed")).toHaveLength(1);
    expect(await attestations(id)).toHaveLength(1);
  });

  it("F-191: at most ONE pending recovery per order — the service says so (409 `already_pending`) and a partial unique index backs it", async () => {
    const id = await heldOrder();
    await file(id, "not_received_by_lab");
    await expect(file(id, "not_received_by_lab", ORG_A, memberC, USER_C)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("(already_pending)"),
    });
    await expect(
      admin.query(
        `INSERT INTO order_recovery_request
           (organization_id, order_record_id, attestation, lab_contact_name, lab_reference, prior_failure_reason,
            requested_by_user_id, expires_at)
         VALUES ($1,$2,'not_received_by_lab','Dana Reyes','REF-2026-0041','dlq_exhausted',$3, now() + interval '1 hour')`,
        [ORG_A, id, USER_C],
      ),
    ).rejects.toThrow(/one_pending_uq/);
    expect(await requests(id)).toHaveLength(1);
  });

  it("F-191: a request that lapses (TTL) can no longer be co-signed (409 `expired`); the sweep marks it `expired`, alerts, and a NEW one may be filed", async () => {
    const short = backendWith({ ttlMs: 1 });
    const id = await heldOrder();
    const filed = await short.recoverLabTransmission(ORG_A, member, id, "not_received_by_lab", EVIDENCE, undefined, USER);
    expect(filed.outcome).toBe("pending_cosign");
    await new Promise((r) => setTimeout(r, 25));

    await expect(
      short.cosignLabTransmissionRecovery(ORG_A, memberA2, id, filed.recovery!.id, undefined, USER_B),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("(expired)") });
    expect((await orderRow(id)).transmission_status).toBe("failed");
    expect(wires).toHaveLength(0);

    // The hourly M11 timer's fan-out is what runs the sweep (it rides the verbal-order tick — no new queue).
    await runVerbalOrderExpiryFanout({
      connection: {} as never,
      service: short,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
    });
    const [req] = await requests(id);
    expect(req).toMatchObject({ status: "expired", cosigned_by_user_id: null, attestation_id: null });
    expect(req!.resolved_at).not.toBeNull();
    const lapsed = alertLog.filter((a) => a.eventType === "m11.order.recovery_expired");
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0]).toMatchObject({ org: ORG_A, severity: "warn" });
    expect(lapsed[0]!.payload).toMatchObject({ orderId: id, requestId: filed.recovery!.id });

    // The partial unique index only covers PENDING rows, so a fresh request is allowed — and completes normally.
    const again = await file(id, "not_received_by_lab");
    expect(again.outcome).toBe("pending_cosign");
    expect((await cosign(id, again.recovery!.id)).outcome).toBe("redispatched");
  });

  it("F-191: either person can CANCEL a pending request — a cancelled one cannot be co-signed, and a settled one cannot be cancelled again", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");

    const cancelled = await svc.cancelLabTransmissionRecovery(ORG_A, memberA2, id, filed.recovery!.id, undefined, USER_B);
    expect(cancelled.recovery.status).toBe("cancelled");
    const [req] = await requests(id);
    expect(req).toMatchObject({ status: "cancelled", cancelled_by_user_id: USER_B, cosigned_by_user_id: null });
    expect(alertLog.filter((a) => a.eventType === "m11.order.recovery_cancelled")).toHaveLength(1);
    expect(alertLog.find((a) => a.eventType === "m11.order.recovery_cancelled")!.severity).toBe("info");

    await expect(cosign(id, filed.recovery!.id, ORG_A, memberC, USER_C)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("(not_pending)"),
    });
    await expect(
      svc.cancelLabTransmissionRecovery(ORG_A, memberA2, id, filed.recovery!.id, undefined, USER_B),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      svc.cancelLabTransmissionRecovery(ORG_A, memberA2, id, randomUUID(), undefined, USER_B),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await orderRow(id)).transmission_status).toBe("failed");
    expect(wires).toHaveLength(0);

    // ... and after a cancel the order can be recovered afresh.
    const again = await file(id, "not_received_by_lab");
    expect((await cosign(id, again.recovery!.id)).outcome).toBe("redispatched");
  });

  it("F-191: `received_by_lab` stays SINGLE-person — it executes on the first call and files no request", async () => {
    const id = await heldOrder();
    const res = await file(id, "received_by_lab");
    expect(res.outcome).toBe("marked_transmitted");
    expect(res.recovery).toBeNull();
    expect((await orderRow(id)).transmission_status).toBe("transmitted");
    expect(await requests(id)).toHaveLength(0);
    expect((await attestations(id))[0]).toMatchObject({ cosigned_by_user_id: null, recovery_request_id: null });
  });

  it("F-191: the co-sign RE-CHECKS the evidence — a lab result that arrived after the request was filed refuses it (409), and it stays pending", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");
    await labObservationFor(id); // the lab answered in the meantime
    await expect(cosign(id, filed.recovery!.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("lab_result_received"),
    });
    expect((await requests(id))[0]!.status).toBe("pending_cosign");
    expect((await orderRow(id)).transmission_status).toBe("failed");
    expect(wires).toHaveLength(0);
  });

  it("F-191: the ledger itself refuses a single-person `not_received_by_lab` row (NOT VALID CHECK), and a co-signer equal to the attester", async () => {
    const id = await heldOrder();
    const insert = (cols: string, vals: unknown[]) =>
      admin.query(
        `INSERT INTO order_transmission_attestation
           (organization_id, order_record_id, attestation, outcome, lab_contact_name, lab_reference, prior_failure_reason,
            attempt_id, ${cols})
         VALUES ($1,$2,'not_received_by_lab','redispatched','Dana Reyes','REF-2026-0041','dlq_exhausted',$3, ${vals
           .slice(3)
           .map((_, i) => `$${i + 4}`)
           .join(",")})`,
        vals,
      );
    // no co-signer, no request
    await expect(insert("attested_by_user_id", [ORG_A, id, randomUUID(), USER])).rejects.toThrow(/dual_control/);
    // a co-signer but no request it executed
    await expect(
      insert("attested_by_user_id, cosigned_by_user_id", [ORG_A, id, randomUUID(), USER, USER_B]),
    ).rejects.toThrow(/dual_control/);
    // the SAME person twice
    await expect(
      insert("attested_by_user_id, cosigned_by_user_id, recovery_request_id", [
        ORG_A,
        id,
        randomUUID(),
        USER,
        USER,
        randomUUID(),
      ]),
    ).rejects.toThrow(/cosigner_distinct/);
    // both, distinct, with a request: allowed
    await insert("attested_by_user_id, cosigned_by_user_id, recovery_request_id", [
      ORG_A,
      id,
      randomUUID(),
      USER,
      USER_B,
      randomUUID(),
    ]);
    expect(await attestations(id)).toHaveLength(1);
  });

  it("F-191: a request is FROZEN once resolved and its evidence is immutable while pending; the app role can never delete one", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");
    await expect(
      admin.query("UPDATE order_recovery_request SET lab_reference='TAMPERED-001' WHERE id=$1", [filed.recovery!.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      admin.query("UPDATE order_recovery_request SET requested_by_user_id=$2 WHERE id=$1", [filed.recovery!.id, USER_C]),
    ).rejects.toThrow(/immutable/);
    await cosign(id, filed.recovery!.id);
    await expect(
      admin.query("UPDATE order_recovery_request SET status='cancelled' WHERE id=$1", [filed.recovery!.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        tx.execute(sql`DELETE FROM order_recovery_request WHERE id = ${filed.recovery!.id}`),
      ),
    ).rejects.toThrow();
    // Not even a superuser can delete one (only a non-superuser member of the destruction role can).
    await expect(admin.query("DELETE FROM order_recovery_request WHERE id=$1", [filed.recovery!.id])).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it("F-191: cross-tenant — another org's context sees NO request and cannot co-sign or cancel this org's (RLS, as the real app role)", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");
    const visibleTo = async (organizationId: string): Promise<number> => {
      const res = await withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
        tx.execute(sql`SELECT id FROM order_recovery_request WHERE order_record_id = ${id}`),
      );
      return (res as unknown as { rows: unknown[] }).rows.length;
    };
    expect(await visibleTo(ORG_B)).toBe(0);
    expect(await visibleTo(ORG_A)).toBe(1);
    await expect(cosign(id, filed.recovery!.id, ORG_B, memberB, USER_B)).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      svc.cancelLabTransmissionRecovery(ORG_B, memberB, id, filed.recovery!.id, undefined, USER_B),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await requests(id))[0]!.status).toBe("pending_cosign");
  });

  it("F-191: compliance ALERTS — executed warns, cancelled is info, lapsed warns; ids and counts ONLY (no lab contact, no reference, no patient); each correlation id distinct", async () => {
    // A requester (`USER_C`) no other test uses, so the repeat-attester count is exactly this test's own.
    const a = await heldOrder();
    const fa = await file(a, "not_received_by_lab", ORG_A, memberC, USER_C);
    await cosign(a, fa.recovery!.id);
    const b = await heldOrder();
    const fb = await file(b, "not_received_by_lab", ORG_A, memberC, USER_C);
    await svc.cancelLabTransmissionRecovery(ORG_A, memberA2, b, fb.recovery!.id, undefined, USER_B);
    const short = backendWith({ ttlMs: 1 });
    const c = await heldOrder();
    const fc = await short.recoverLabTransmission(ORG_A, memberC, c, "not_received_by_lab", EVIDENCE, undefined, USER_C);
    await new Promise((r) => setTimeout(r, 25));
    await short.expireStaleLabRecoveryRequests(ORG_A);

    const byKind = (k: string) => alertLog.filter((x) => x.eventType === k);
    expect(byKind("m11.order.recovery_executed")).toHaveLength(1);
    expect(byKind("m11.order.recovery_cancelled")).toHaveLength(1);
    expect(byKind("m11.order.recovery_expired")).toHaveLength(1);
    const executed = byKind("m11.order.recovery_executed")[0]!;
    // Only `fa` had been filed when it executed, so the repeat-attester count is exactly 1 (below the default 3).
    expect(executed).toMatchObject({ org: ORG_A, severity: "warn" });
    expect(executed.payload).toMatchObject({
      orderId: a,
      requestId: fa.recovery!.id,
      requestedByMembershipId: memberC,
      cosignedByMembershipId: memberA2,
      repeatAttester: false,
      requesterRequestsInWindow: 1,
      deepLink: `/orders/${a}`,
    });
    expect(byKind("m11.order.recovery_cancelled")[0]!.severity).toBe("info");
    expect(byKind("m11.order.recovery_expired")[0]).toMatchObject({ severity: "warn" });

    const serialized = JSON.stringify(alertLog);
    expect(serialized).not.toContain("Dana");
    expect(serialized).not.toContain("Reyes");
    expect(serialized).not.toContain("REF-2026");
    const patientIds = (await admin.query("SELECT DISTINCT patient_id FROM order_record")).rows.map((r) => r.patient_id);
    for (const p of patientIds) expect(serialized).not.toContain(String(p));
    const ids = alertLog.map((x) => x.correlationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^m11-recovery:m11\.order\.recovery_(executed|cancelled|expired):/);
    void fc;
  });

  it("F-191: a REPEAT attester is flagged — the same requester's Nth request inside the window turns the executed alert `critical` (threshold injectable, default 3)", async () => {
    const strict = backendWith({ anomalyThreshold: 2 });
    const run = async () => {
      const id = await heldOrder();
      const f = await strict.recoverLabTransmission(ORG_A, memberD, id, "not_received_by_lab", EVIDENCE, undefined, USER_D);
      await strict.cosignLabTransmissionRecovery(ORG_A, memberA2, id, f.recovery!.id, undefined, USER_B);
      return id;
    };
    const first = await run();
    const second = await run();
    const executed = alertLog.filter((x) => x.eventType === "m11.order.recovery_executed");
    expect(executed).toHaveLength(2);
    expect(executed[0]).toMatchObject({ severity: "warn" });
    expect(executed[0]!.payload).toMatchObject({ orderId: first, repeatAttester: false, requesterRequestsInWindow: 1, repeatAttesterThreshold: 2 });
    expect(executed[1]).toMatchObject({ severity: "critical" });
    expect(executed[1]!.payload).toMatchObject({ orderId: second, repeatAttester: true, requesterRequestsInWindow: 2, repeatAttesterThreshold: 2 });
  });

  it("F-191: the order DETAIL shows the attestation history and the pending request — the lab contact's name and reference only with `orders.amend`", async () => {
    const id = await heldOrder();
    const amender = { membershipId: member, roles: [], disciplines: [], permissions: new Set(["orders.amend"]) };
    const reader = { membershipId: member, roles: [], disciplines: [], permissions: new Set(["orders.read"]) };

    expect((await svc.getOrder(ORG_A, id, amender)).transmissionAttestations).toEqual([]);
    expect((await svc.getOrder(ORG_A, id, amender)).pendingRecovery).toBeNull();

    const filed = await file(id, "not_received_by_lab");
    expect((await svc.getOrder(ORG_A, id, amender)).pendingRecovery).toMatchObject({
      id: filed.recovery!.id,
      status: "pending_cosign",
      labContactName: "Dana Reyes",
      labReference: "REF-2026-0041",
    });
    // A reader who cannot recover sees THAT a recovery is pending, but not the third party's name or reference.
    expect((await svc.getOrder(ORG_A, id, reader)).pendingRecovery).toMatchObject({
      status: "pending_cosign",
      labContactName: null,
      labReference: null,
    });

    await cosign(id, filed.recovery!.id);
    const asAmender = await svc.getOrder(ORG_A, id, amender);
    expect(asAmender.pendingRecovery).toBeNull();
    expect(asAmender.transmissionAttestations).toHaveLength(1);
    expect(asAmender.transmissionAttestations[0]).toMatchObject({
      attestation: "not_received_by_lab",
      outcome: "redispatched",
      priorFailureReason: "dlq_exhausted",
      attestedByMembershipId: member,
      cosignedByMembershipId: memberA2,
      labContactName: "Dana Reyes",
      labReference: "REF-2026-0041",
    });
    expect(asAmender.transmissionAttestations[0]!.attemptId).toBe((await orderRow(id)).transmission_attempt_id);
    const asReader = await svc.getOrder(ORG_A, id, reader);
    expect(asReader.transmissionAttestations[0]).toMatchObject({
      attestedByMembershipId: member,
      cosignedByMembershipId: memberA2,
      labContactName: null,
      labReference: null,
    });
    // Another tenant cannot read this order's history at all (the order itself is a 404).
    await expect(svc.getOrder(ORG_B, id, amender)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("F-191: DESTRUCTION — a member of the destruction role erases an order's attestation ledger and recovery requests; the app role cannot, a superuser still cannot, another tenant's run reaches nothing", async () => {
    const id = await heldOrder();
    const filed = await file(id, "not_received_by_lab");
    await cosign(id, filed.recovery!.id);
    const patientId = (await admin.query("SELECT patient_id FROM order_record WHERE id=$1", [id])).rows[0].patient_id as string;
    expect(await attestations(id)).toHaveLength(1);
    expect(await requests(id)).toHaveLength(1);

    // The deployment's login role: `IN ROLE wardenx_destruction`, NOT a superuser (0157's contract).
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='f191_destroyer') THEN
         CREATE ROLE f191_destroyer LOGIN PASSWORD 'f191_destroyer_pw' IN ROLE wardenx_destruction;
       END IF; END $$;`,
    );
    const url = new URL(DB_URL as string);
    url.username = "f191_destroyer";
    url.password = "f191_destroyer_pw";
    const destroyer = createDbClient({ connectionString: url.toString() });
    try {
      // The app role cannot delete either table, and a superuser is stopped by the trigger.
      await expect(
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(sql`DELETE FROM order_transmission_attestation WHERE order_record_id = ${id}`),
        ),
      ).rejects.toThrow();
      await expect(admin.query("DELETE FROM order_transmission_attestation WHERE order_record_id=$1", [id])).rejects.toThrow(
        /append-only/,
      );
      // The destruction role can DELETE but never UPDATE (the append-only guarantee is unchanged for everything else).
      await expect(
        withOrgContext(destroyer.db, { organizationId: ORG_A, userId: "" }, (tx) =>
          tx.execute(sql`UPDATE order_transmission_attestation SET lab_reference = 'TAMPERED-001' WHERE order_record_id = ${id}`),
        ),
      ).rejects.toThrow();

      const store = createDrizzleOrderEraseStore(destroyer.db as never);
      const boundary = new Date(Date.now() + 86_400_000).toISOString();
      // ANOTHER tenant's destruction run is org-scoped: it reaches none of these rows.
      const foreign = await store.eraseOrdersSubtree(ORG_B, patientId, boundary);
      expect(foreign).toMatchObject({ orders: 0, transmissionAttestations: 0, recoveryRequests: 0 });
      expect(await attestations(id)).toHaveLength(1);
      expect(await requests(id)).toHaveLength(1);

      const counts = await store.eraseOrdersSubtree(ORG_A, patientId, boundary);
      expect(counts).toMatchObject({ transmissionAttestations: 1, recoveryRequests: 1 });
      expect(counts.orders).toBeGreaterThanOrEqual(1);
    } finally {
      await destroyer.close();
      await admin.query("DROP OWNED BY f191_destroyer");
      await admin.query("DROP ROLE f191_destroyer");
    }
    expect(await attestations(id)).toHaveLength(0);
    expect(await requests(id)).toHaveLength(0);
  });

});
