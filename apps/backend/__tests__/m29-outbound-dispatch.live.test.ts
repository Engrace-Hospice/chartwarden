/**
 * M29 External Interfaces — F-175 (#248): the T08 outbound MLLP dispatch worker, proven against REAL
 * Postgres (as the NOBYPASSRLS `wardenx_app` role) and a real in-process mock MLLP server over `node:net`
 * (the transport's own `mllp_plain` test-only protocol — see `mllp-transport.ts`'s header).
 *
 * Drives `buildM29OutboundDispatchConsumer(...).handle(event)` and `runOutboundRetrySweepOnce(...)`
 * DIRECTLY (the `m24-state-channel-health.live.test.ts` precedent — no BullMQ wrapper needed; the value
 * under test is the real Drizzle reads/writes under RLS, the real envelope encryption round-trip, the real
 * TCP MLLP exchange, and the real ack/retry/DLQ state machine, not the BullMQ scheduler).
 *
 * Gated on a live DB: WARDENX_TEST_DATABASE_URL=postgres://... bunx vitest run <this file>
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { join } from "node:path";
import { createDbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/events-by-m29";
import { createDrizzleAlertEmitter, wireAlertRuleSeed } from "../src/modules/36-messaging/index";
import { buildDrizzleOutboundFeedResolver } from "../src/modules/29-external-interfaces/outbound/feed-resolver";
import {
  ormDispatchExistsForOrder,
  ormDispatchLookupQuery,
} from "../src/modules/29-external-interfaces/outbound/order-dispatch-dedupe";
import {
  type MllpTransport,
  createNodeMllpTransport,
} from "../src/modules/29-external-interfaces/outbound/mllp-transport";
import type { OutboundTenantKeyProvider } from "../src/modules/29-external-interfaces/outbound/dispatch-crypto";
import { createOutboundPayloadCipher } from "../src/modules/29-external-interfaces/outbound/dispatch-crypto";
import {
  type OutboundAlertPort,
  buildM29OutboundDispatchConsumer,
  runOutboundRetrySweepOnce,
} from "../src/modules/29-external-interfaces/outbound/dispatch-worker";
import {
  MllpFrameBuffer,
  encodeMllpFrame,
  parseMshEnvelope,
} from "../src/modules/29-external-interfaces/listener/mllp-framing";
import { appRoleUrl, LIVE_APP_ROLE_PASSWORD } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const TEST_DEK = Buffer.alloc(32, 7);
const OUTBOUND_HMO = schema.hl7MessageOutbound;
const FEED = schema.externalFeed;

function fakeKeyProvider(): OutboundTenantKeyProvider {
  return {
    async dekForOrg() {
      return { version: "v1", key: TEST_DEK };
    },
    async dekForOrgVersion(_orgId, version) {
      return { version, key: TEST_DEK };
    },
  };
}

function fakeOutbox() {
  const published: Array<{
    eventName: string;
    organizationId: string;
    aggregateKind: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    published,
    port: {
      async publish(_tx: unknown, event: (typeof published)[number]) {
        published.push(event);
      },
    },
  };
}

function fakeAlerts() {
  const emitted: Array<{
    organizationId: string;
    eventType: string;
    severity: string;
    correlationId: string;
    payload: unknown;
  }> = [];
  const port: OutboundAlertPort = {
    async emit(organizationId, input) {
      emitted.push({
        organizationId,
        eventType: input.eventType,
        severity: input.severity,
        correlationId: input.correlationId,
        payload: input.payload,
      });
    },
  };
  return { emitted, port };
}

function fakeActiveOrgs(...orgIds: string[]) {
  return {
    async listActiveOrgs() {
      return orgIds.map((organizationId) => ({ organizationId }));
    },
  };
}

/** Build a minimal valid ORM-ack wire (`MSH`+`MSA`), echoing the request's own MSH-10 into MSA-2. */
function buildAckWire(
  requestEnvelope: ReturnType<typeof parseMshEnvelope>,
  ackCode: "AA" | "AR" | "AE",
  text = "",
): string {
  const msh = [
    "MSH",
    "^~\\&",
    requestEnvelope.receivingApplication,
    requestEnvelope.receivingFacility,
    requestEnvelope.sendingApplication,
    requestEnvelope.sendingFacility,
    "20260101000000",
    "",
    "ACK",
    `${requestEnvelope.messageControlId}-ack`,
    "P",
    "2.5.1",
  ].join("|");
  const msa = ["MSA", ackCode, requestEnvelope.messageControlId, text].join("|");
  return [msh, msa].join("\r");
}

type MockAction = { kind: "ack"; ackCode: "AA" | "AR" | "AE" } | { kind: "close_no_response" };

interface MockMllpServer {
  readonly port: number;
  readonly receivedWires: string[];
  close(): Promise<void>;
}

/** A real in-process `mllp_plain` MLLP server (`node:net`) — reads one framed request per connection,
 *  consults `nextAction()` for how to respond, then lets the transport close the connection (it always
 *  closes after settling — this server never initiates the close on an `ack` response). */
function startMockMllpServer(nextAction: () => MockAction): Promise<MockMllpServer> {
  return new Promise((resolve, reject) => {
    const receivedWires: string[] = [];
    const server = createServer((socket: Socket) => {
      const buf = new MllpFrameBuffer();
      socket.on("data", (chunk) => {
        let frames: string[];
        try {
          buf.append(chunk);
          frames = buf.drain();
        } catch {
          socket.destroy();
          return;
        }
        if (frames.length === 0) return;
        const requestWire = frames[0]!;
        receivedWires.push(requestWire);
        const action = nextAction();
        if (action.kind === "close_no_response") {
          socket.end();
          return;
        }
        const envelope = parseMshEnvelope(requestWire);
        const ackWire = buildAckWire(envelope, action.ackCode);
        socket.write(encodeMllpFrame(ackWire));
      });
      socket.on("error", () => {
        /* a settled transport destroying the socket after a write is expected, not a server error */
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve({
          port: addr.port,
          receivedWires,
          close: () => new Promise((res) => server.close(() => res())),
        });
      } else {
        reject(new Error("failed to bind mock MLLP server"));
      }
    });
    server.on("error", reject);
  });
}

/** F-181 — the live suite dials loopback `mllp_plain` test doubles, which the production-safe default policy
 *  refuses; every worker here is built with this explicit non-production policy instead. */
const TEST_POLICY = { allowPlain: true, allowLoopback: true } as const;

const DEFAULT_FACILITY_ID = "33333333-3333-3333-3333-333333333333";

function ormRequestedPayload(overrides: {
  orderId: string;
  organizationId: string;
  labDestinationFacilityId?: string | null;
}) {
  return {
    orderId: overrides.orderId,
    organizationId: overrides.organizationId,
    // `hl7_message_outbound.destination_facility_id` is a real `uuid` column — a human-readable code
    // would fail the insert with `22P02 invalid input syntax for type uuid` (the correct, honest
    // behavior; M11 always publishes a real M40 facility id in production).
    labDestinationFacilityId: overrides.labDestinationFacilityId ?? DEFAULT_FACILITY_ID,
    priority: "R" as const,
    requestedAt: new Date().toISOString(),
    labOrderPayload: {
      orderId: overrides.orderId,
      patientId: randomUUID(),
      placerOrderNumber: overrides.orderId.replace(/-/g, ""),
      observationIdentifier: { code: "2345-7", text: "Glucose", codingSystem: "LN" },
      orderingProviderNpi: "1234567890",
      orderingProviderName: { family: "Smith", given: "Jane" },
      priority: "R" as const,
      clinicalNotes: ["fasting draw"],
      patientDemographics: {
        mrn: "MRN-1",
        internalMrnAuthority: "WARDENX",
        familyName: "Doe",
        givenName: "John",
        dateOfBirth: "1950-01-01",
        administrativeSex: "M" as const,
      },
    },
  };
}

function dispatchEvent(payload: ReturnType<typeof ormRequestedPayload>) {
  return {
    id: randomUUID(),
    organizationId: payload.organizationId,
    eventType: "m11.order.hl7_orm_requested",
    aggregateKind: "order_record",
    aggregateId: payload.orderId,
    payload,
    attemptCount: 1,
    createdAt: new Date(),
  };
}

describe.skipIf(!DB_URL)("M29 outbound MLLP dispatch worker — LIVE Postgres (F-175, #248)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  async function seedOrg(orgId: string, slug: string): Promise<void> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [orgId, slug],
    );
  }

  /** Seed one ACTIVE `orm_outbound` feed pointed at the mock server, org-scoped. F-181: the MSH identity
   *  columns default to a COMPLETE set (pass `null` to leave one unset) and the destination link to NULL. */
  async function seedFeed(args: {
    readonly organizationId: string;
    readonly port: number;
    readonly rateLimitMsgPerSec?: number;
    readonly labDestinationFacilityId?: string | null;
    readonly mshSendingFacility?: string | null;
    readonly mshReceivingApplication?: string | null;
    readonly mshReceivingFacility?: string | null;
    /** F-183 — the operator's dedupe declaration (default false, the schema default) and per-feed lease. */
    readonly receiverDedupesControlId?: boolean;
    readonly inFlightLeaseSeconds?: number | null;
  }): Promise<string> {
    const id = randomUUID();
    const pick = <T>(v: T | null | undefined, dflt: T): T | null => (v === undefined ? dflt : v);
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, host, port, protocol, channel_cert_pin,
          status, proposed_by_membership_id, rate_limit_msg_per_sec,
          lab_destination_facility_id, msh_sending_facility, msh_receiving_application, msh_receiving_facility,
          receiver_dedupes_control_id, in_flight_lease_seconds)
       VALUES ($1,$2,'orm_outbound','Mock Reference Lab','127.0.0.1',$3,'mllp_plain',NULL,
               'active',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        args.organizationId,
        args.port,
        randomUUID(),
        args.rateLimitMsgPerSec ?? 1000,
        args.labDestinationFacilityId ?? null,
        pick(args.mshSendingFacility, "ENGRACE-HOSPICE"),
        pick(args.mshReceivingApplication, "REFLAB-LIS"),
        pick(args.mshReceivingFacility, "REFLAB-MAIN"),
        args.receiverDedupesControlId ?? false,
        args.inFlightLeaseSeconds ?? null,
      ],
    );
    return id;
  }

  async function outboundRowFor(organizationId: string, orderId: string) {
    return withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
      tx
        .select()
        .from(OUTBOUND_HMO)
        .where(
          and(
            eq(OUTBOUND_HMO.organizationId, organizationId),
            eq(OUTBOUND_HMO.sourceAggregateId, orderId),
          ),
        ),
    );
  }

  function registerActiveBaa(): void {
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: true, status: "executed", expiresOn: null }),
    } as never);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    await seedOrg(ORG_A, "org-a");
    await seedOrg(ORG_B, "org-b");
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  afterEach(() => __resetSeamsForTest());

  // Each test seeds its own `external_feed`(s) against the shared ORG_A/ORG_B fixtures; without cleanup a
  // later test would see every earlier test's feed too (breaking the "resolve the org's ONE active feed"
  // contract via ambiguity) and could collide with a fixed test port on the `(organizationId, port, kind)`
  // unique index. Clear both tables for both orgs before every test.
  beforeEach(async () => {
    await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id IN ($1,$2)", [
      ORG_A,
      ORG_B,
    ]);
    await admin.query("DELETE FROM external_feed WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
  });

  it("happy path: AA-acked dispatch — row ends acked, transmitted event emitted, wire round-trips encrypted-at-rest", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const feedId = await seedFeed({ organizationId: ORG_A, port: server.port });
      const outbox = fakeOutbox();
      const alerts = fakeAlerts();
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
        alerts: alerts.port,
      });

      const orderId = randomUUID();
      const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
      await consumer.handle(dispatchEvent(payload));

      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("acked");
      expect(rows[0]?.ackStatus).toBe("aa");
      expect(rows[0]?.feedId).toBe(feedId);
      expect(rows[0]?.transmittedAt).not.toBeNull();

      expect(outbox.published).toHaveLength(1);
      expect(outbox.published[0]).toMatchObject({
        eventName: "m29.lab_order.transmitted",
        organizationId: ORG_A,
        aggregateKind: "hl7_message_outbound",
      });
      expect(outbox.published[0]?.payload).toMatchObject({ orderId });

      // The wire genuinely round-tripped over the real TCP connection, framed correctly.
      expect(server.receivedWires).toHaveLength(1);
      expect(server.receivedWires[0]).toContain("ORM^O01");

      // And it is encrypted-at-rest: the persisted cipher decrypts back to EXACTLY what the mock server
      // received on the wire — proving the DB row is not storing plaintext.
      const cipher = createOutboundPayloadCipher(fakeKeyProvider());
      const decrypted = await cipher.decrypt(ORG_A, "payload", rows[0]!.payloadCipher);
      expect(decrypted).toBe(server.receivedWires[0]);
      expect(rows[0]!.payloadCipher).not.toContain("ORM^O01");

      const ackDecrypted = await cipher.decrypt(ORG_A, "ack_payload", rows[0]!.ackPayloadCipher as string);
      expect(ackDecrypted).toContain("MSA|AA");
    } finally {
      await server.close();
    }
  });

  it("BAA-inactive: no row written, no transmission_failed emitted — but a terminal `dispatch_refused` (F-187: never a silently `pending` order)", async () => {
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: false, status: "missing", expiresOn: null }),
    } as never);
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const outbox = fakeOutbox();
      const alerts = fakeAlerts();
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
        alerts: alerts.port,
      });

      const orderId = randomUUID();
      const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
      await consumer.handle(dispatchEvent(payload));

      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows).toHaveLength(0);
      // `transmission_failed` needs an outbound row to cite — there is none. F-175 published nothing at all, which
      // left the order `pending` forever; F-187 publishes the row-less terminal signal M11 consumes instead.
      expect(outbox.published.filter((e) => e.eventName === "m29.lab_order.transmission_failed")).toHaveLength(0);
      const refused = outbox.published.filter((e) => e.eventName === "m29.lab_order.dispatch_refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({ orderId, organizationId: ORG_A, reason: "baa_inactive" });
      expect(server.receivedWires).toHaveLength(0); // never even attempted the socket
      // The BAA refusal alert intent still fires (compliance-facing), just never `transmission_failed`.
      expect(alerts.emitted.some((a) => a.eventType === "external_feed.baa_missing")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("AR-rejected ack: terminal, no retry, transmission_failed reason application_reject", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AR" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const outbox = fakeOutbox();
      const alerts = fakeAlerts();
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
        alerts: alerts.port,
      });

      const orderId = randomUUID();
      const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
      await consumer.handle(dispatchEvent(payload));

      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("naked");
      expect(rows[0]?.ackStatus).toBe("ar");
      expect(rows[0]?.nextRetryAt).toBeNull();

      expect(outbox.published).toHaveLength(1);
      expect(outbox.published[0]).toMatchObject({ eventName: "m29.lab_order.transmission_failed" });
      expect(outbox.published[0]?.payload).toMatchObject({
        orderId,
        reason: "application_reject",
      });
      expect(alerts.emitted.some((a) => a.eventType === "hl7_outbound.transmission_failed")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("transport failure schedules a retry (not an immediate DLQ)", async () => {
    registerActiveBaa();
    // Nothing listens on this port — every connection attempt fails ECONNREFUSED.
    const deadPort = 1; // privileged/reserved port, nothing binds it in this test sandbox
    await seedFeed({ organizationId: ORG_A, port: deadPort });
    const outbox = fakeOutbox();
    const alerts = fakeAlerts();
    const consumer = buildM29OutboundDispatchConsumer({
      db: handle.db,
      outbox: outbox.port,
      keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
      alerts: alerts.port,
    });

    const orderId = randomUUID();
    const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
    await consumer.handle(dispatchEvent(payload));

    const rows = await outboundRowFor(ORG_A, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.retryCount).toBe(1);
    expect(rows[0]?.nextRetryAt).not.toBeNull();
    expect(outbox.published).toHaveLength(0); // not terminal yet
  });

  it("5th-attempt exhaustion DLQs and emits transmission_failed reason dlq_exhausted", async () => {
    registerActiveBaa();
    const deadPort = 1;
    await seedFeed({ organizationId: ORG_A, port: deadPort });
    const outbox = fakeOutbox();
    const alerts = fakeAlerts();
    const consumer = buildM29OutboundDispatchConsumer({
      db: handle.db,
      outbox: outbox.port,
      keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
      alerts: alerts.port,
    });

    const orderId = randomUUID();
    const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
    await consumer.handle(dispatchEvent(payload)); // attempt 1 — retryCount 0→1

    const activeOrgs = fakeActiveOrgs(ORG_A);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      // Fast-forward past the backoff window directly in Postgres rather than waiting real minutes.
      await admin.query(
        "UPDATE hl7_message_outbound SET next_retry_at = now() - interval '1 second' WHERE organization_id=$1 AND source_aggregate_id=$2",
        [ORG_A, orderId],
      );
      await runOutboundRetrySweepOnce({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
        alerts: alerts.port,
        activeOrgs,
      });
    }

    const rows = await outboundRowFor(ORG_A, orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("dlq");
    expect(rows[0]?.retryCount).toBe(5);
    expect(rows[0]?.nextRetryAt).toBeNull();

    const dlqEvents = outbox.published.filter((e) => e.eventName === "m29.lab_order.transmission_failed");
    expect(dlqEvents).toHaveLength(1);
    expect(dlqEvents[0]?.payload).toMatchObject({ orderId, reason: "dlq_exhausted", attemptCount: 5 });
  });

  it("redelivery idempotency: the same outbox event delivered twice never double-dispatches", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const outbox = fakeOutbox();
      const alerts = fakeAlerts();
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
        alerts: alerts.port,
      });

      const orderId = randomUUID();
      const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
      const event = dispatchEvent(payload);
      await consumer.handle(event);
      await consumer.handle(event); // redelivery of the SAME event

      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows).toHaveLength(1); // never double-dispatched
      expect(server.receivedWires).toHaveLength(1); // the wire was only ever sent once
      expect(outbox.published.filter((e) => e.eventName === "m29.lab_order.transmitted")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  // ── F-181 (#248, migration 0262): routing link, MSH identity, concurrent-redelivery race ────────────────────

  const FACILITY_X = "44444444-4444-4444-4444-444444444444";
  const FACILITY_Y = "55555555-5555-5555-5555-555555555555";

  function buildConsumer(outbox = fakeOutbox(), alerts = fakeAlerts(), transport?: MllpTransport) {
    return {
      outbox,
      alerts,
      consumer: buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        alerts: alerts.port,
        destinationPolicy: TEST_POLICY,
        ...(transport ? { transport } : {}),
      }),
    };
  }

  it("F-181 routing: an order rides the feed LINKED to its lab destination, never the sibling feed", async () => {
    registerActiveBaa();
    const serverX = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const serverY = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const feedX = await seedFeed({ organizationId: ORG_A, port: serverX.port, labDestinationFacilityId: FACILITY_X });
      await seedFeed({ organizationId: ORG_A, port: serverY.port, labDestinationFacilityId: FACILITY_Y });
      const { consumer } = buildConsumer();
      const orderId = randomUUID();
      await consumer.handle(
        dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A, labDestinationFacilityId: FACILITY_X })),
      );
      expect(serverX.receivedWires).toHaveLength(1);
      expect(serverY.receivedWires).toHaveLength(0);
      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.feedId).toBe(feedX);
      expect(rows[0]!.destinationFacilityId).toBe(FACILITY_X);
    } finally {
      await serverX.close();
      await serverY.close();
    }
  });

  it("F-181 routing: a SINGLE feed linked to a DIFFERENT facility is refused (no fallback), alerted, nothing sent", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port, labDestinationFacilityId: FACILITY_Y });
      const { consumer, alerts } = buildConsumer();
      const orderId = randomUUID();
      await consumer.handle(
        dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A, labDestinationFacilityId: FACILITY_X })),
      );
      expect(await outboundRowFor(ORG_A, orderId)).toHaveLength(0);
      expect(server.receivedWires).toHaveLength(0);
      expect(JSON.stringify(alerts.emitted)).toContain("no_feed_for_destination");
    } finally {
      await server.close();
    }
  });

  it("F-181 identity: the wire carries the feed's configured MSH-3/4/5/6, not its display name", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const { consumer } = buildConsumer();
      await consumer.handle(
        dispatchEvent(ormRequestedPayload({ orderId: randomUUID(), organizationId: ORG_A })),
      );
      const env = parseMshEnvelope(server.receivedWires[0]!);
      expect(env.sendingApplication).toBe("WARDENX");
      expect(env.sendingFacility).toBe("ENGRACE-HOSPICE");
      expect(env.receivingApplication).toBe("REFLAB-LIS");
      expect(env.receivingFacility).toBe("REFLAB-MAIN");
      expect(server.receivedWires[0]).not.toContain("Mock Reference Lab");
    } finally {
      await server.close();
    }
  });

  it("F-181/F-187 identity: a feed with an unset MSH field is REFUSED — no row, no wire, and a PHI-free terminal `dispatch_refused` (never a silent pending, never a throw)", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const feedId = await seedFeed({ organizationId: ORG_A, port: server.port, mshReceivingFacility: null });
      const { consumer, alerts, outbox } = buildConsumer();
      const orderId = randomUUID();
      // F-187: the worker no longer THROWS (the outbox's dead-letter left the order `pending` forever); it publishes
      // the terminal signal in the claim transaction and returns.
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));
      expect(await outboundRowFor(ORG_A, orderId)).toHaveLength(0);
      expect(server.receivedWires).toHaveLength(0);
      expect(JSON.stringify(alerts.emitted)).toContain("feed_identity_incomplete");
      const refused = outbox.published.filter((e) => e.eventName === "m29.lab_order.dispatch_refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({ orderId, organizationId: ORG_A, feedId, reason: "feed_identity_incomplete" });
      // Ids and an enum only — never the order's patient, a value, or even the missing field's name.
      expect(JSON.stringify(refused[0]!.payload)).not.toMatch(/Doe|John|MRN|mshReceivingFacility/);
    } finally {
      await server.close();
    }
  });

  it("F-181 idempotency: two CONCURRENT deliveries of the same event dispatch exactly once", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const a = buildConsumer();
      const b = buildConsumer();
      const orderId = randomUUID();
      const event = dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A }));
      await Promise.all([a.consumer.handle(event), b.consumer.handle(event)]);
      expect(await outboundRowFor(ORG_A, orderId)).toHaveLength(1);
      expect(server.receivedWires).toHaveLength(1);
      const transmitted = [...a.outbox.published, ...b.outbox.published].filter(
        (e) => e.eventName === "m29.lab_order.transmitted",
      );
      expect(transmitted).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("F-181 schema: the MSH CHECK refuses a value that would break HL7 framing; RLS hides org A's feed link from org B", async () => {
    const feedId = await seedFeed({ organizationId: ORG_A, port: 6100, labDestinationFacilityId: FACILITY_X });
    await expect(
      admin.query("UPDATE external_feed SET msh_receiving_facility = 'A|B' WHERE id = $1", [feedId]),
    ).rejects.toThrow(/external_feed_msh_identity_chk/);
    await expect(
      admin.query("UPDATE external_feed SET msh_sending_facility = E'A\\rB' WHERE id = $1", [feedId]),
    ).rejects.toThrow(/external_feed_msh_identity_chk/);
    const asB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
      tx.select().from(schema.externalFeed).where(eq(schema.externalFeed.id, feedId)),
    );
    expect(asB).toHaveLength(0);
    const asA = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      tx.select().from(schema.externalFeed).where(eq(schema.externalFeed.id, feedId)),
    );
    expect(asA[0]!.labDestinationFacilityId).toBe(FACILITY_X);
  });

  it("cross-tenant isolation: org A's dispatch never touches org B's feed or rows", async () => {
    registerActiveBaa();
    const serverA = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const serverB = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: serverA.port });
      await seedFeed({ organizationId: ORG_B, port: serverB.port });
      const outbox = fakeOutbox();
      const alerts = fakeAlerts();
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
        alerts: alerts.port,
      });

      const orderId = randomUUID();
      const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
      await consumer.handle(dispatchEvent(payload));

      const rowsA = await outboundRowFor(ORG_A, orderId);
      const rowsB = await outboundRowFor(ORG_B, orderId);
      expect(rowsA).toHaveLength(1);
      expect(rowsB).toHaveLength(0);
      expect(serverA.receivedWires).toHaveLength(1);
      expect(serverB.receivedWires).toHaveLength(0); // org B's feed/connection was never touched
      expect(outbox.published.every((e) => e.organizationId === ORG_A)).toBe(true);
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });

  // ── F-181 — the destination policy inside the real worker ───────────────────────────────────────────────

  // ── F-182 — the `in_flight` lease + reclaim sweep ────────────────────────────────────────────────────────
  // The worker now commits the `in_flight` claim BEFORE the socket send and finalizes in a second transaction.
  // Before F-182 the whole send ran in ONE transaction: a crash mid-send rolled the row back (no committed
  // `in_flight` row to find) and the outbox redelivery inserted a NEW row with a NEW MSH-10.

  const MINUTE = 60_000;

  /** Simulates the process dying AFTER the receiver got the message but BEFORE the outcome was written. */
  function dyingAfterDelivery(real: MllpTransport): MllpTransport {
    return {
      async send(req) {
        await real.send(req);
        throw new Error("simulated process death before finalize");
      },
    };
  }

  function sweep(args: {
    readonly now: Date;
    readonly outbox?: ReturnType<typeof fakeOutbox>;
    readonly alerts?: ReturnType<typeof fakeAlerts>;
    readonly orgs?: readonly string[];
    readonly outboxPort?: { publish(tx: unknown, e: never): Promise<unknown> };
    /** Delay each per-row feed lookup INSIDE the claim transaction so overlapping sweeps genuinely race. */
    readonly slowClaimMs?: number;
  }) {
    const realResolver = buildDrizzleOutboundFeedResolver();
    const feedResolver = args.slowClaimMs
      ? {
          ...realResolver,
          async resolveById(...a: Parameters<typeof realResolver.resolveById>) {
            await new Promise((r) => setTimeout(r, args.slowClaimMs));
            return realResolver.resolveById(...a);
          },
        }
      : realResolver;
    const outbox = args.outbox ?? fakeOutbox();
    const alerts = args.alerts ?? fakeAlerts();
    return {
      outbox,
      alerts,
      run: () =>
        runOutboundRetrySweepOnce({
          db: handle.db,
          outbox: (args.outboxPort ?? outbox.port) as never,
          keys: fakeKeyProvider(),
          alerts: alerts.port,
          destinationPolicy: TEST_POLICY,
          activeOrgs: fakeActiveOrgs(...(args.orgs ?? [ORG_A])),
          now: () => args.now,
          feedResolver,
        }),
    };
  }

  /** Crash a fresh dispatch after the wire was delivered; returns the stuck row. */
  async function crashedDispatch(
    server: MockMllpServer,
    organizationId = ORG_A,
    feed: { receiverDedupesControlId?: boolean; inFlightLeaseSeconds?: number | null } = {},
  ) {
    registerActiveBaa();
    // F-183 — the F-182 cases below exercise the REQUEUE path, which is now the operator-declared
    // `receiver_dedupes_control_id = true` behaviour; the held (false) path has its own cases.
    await seedFeed({ organizationId, port: server.port, receiverDedupesControlId: true, ...feed });
    const orderId = randomUUID();
    const { consumer } = buildConsumer(
      fakeOutbox(),
      fakeAlerts(),
      dyingAfterDelivery(createNodeMllpTransport()),
    );
    await expect(
      consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId }))),
    ).rejects.toThrow("simulated process death");
    const [row] = await outboundRowFor(organizationId, orderId);
    return { orderId, row: row! };
  }

  const controlIdsOf = (wires: readonly string[]) =>
    new Set(wires.map((w) => parseMshEnvelope(w).messageControlId));

  it("F-182 crash recovery: a send that died after delivery leaves a COMMITTED in_flight row, which is reclaimed and re-sent with the SAME MSH-10 — one order from the receiver's view", async () => {
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const { orderId, row } = await crashedDispatch(server);
      // The row survived the crash (pre-F-182 the whole transaction rolled back and this array was EMPTY).
      expect(row.status).toBe("in_flight");
      expect(row.retryCount).toBe(0);
      expect(row.nextRetryAt).not.toBeNull(); // the lease expiry
      expect(server.receivedWires).toHaveLength(1);

      const t0 = Date.now();
      // Tick 1, lease expired: RECLAIM only — a state transition, no socket.
      const s1 = sweep({ now: new Date(t0 + 10 * MINUTE) });
      await s1.run();
      const [reclaimed] = await outboundRowFor(ORG_A, orderId);
      expect(reclaimed!.status).toBe("queued");
      expect(reclaimed!.retryCount).toBe(1);
      expect(server.receivedWires).toHaveLength(1);
      expect(s1.alerts.emitted).toHaveLength(1);
      expect(s1.alerts.emitted[0]!.eventType).toBe("hl7_outbound.transmission_failed");
      expect(s1.alerts.emitted[0]!.severity).toBe("warn"); // F-188: the EMITTER's alert_severity enum (HIGH/NORMAL threw at the INSERT)

      // Tick 2, backoff elapsed: the existing retry path re-sends the STORED wire.
      const s2 = sweep({ now: new Date(t0 + 11 * MINUTE) });
      await s2.run();
      const [done] = await outboundRowFor(ORG_A, orderId);
      expect(done!.status).toBe("acked");
      expect(server.receivedWires).toHaveLength(2); // at-least-once on the wire…
      expect(controlIdsOf(server.receivedWires).size).toBe(1); // …but ONE MSH-10, so the receiver dedupes.
      expect(controlIdsOf(server.receivedWires).has(done!.messageControlId)).toBe(true);
      expect(s2.outbox.published.map((e) => e.eventName)).toEqual(["m29.lab_order.transmitted"]);
    } finally {
      await server.close();
    }
  });

  it("F-182 lease: an in_flight row whose lease has NOT expired (a live worker) is never touched", async () => {
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const { orderId } = await crashedDispatch(server);
      const s = sweep({ now: new Date(Date.now() + MINUTE) }); // one minute into a five-minute lease
      await s.run();
      const [row] = await outboundRowFor(ORG_A, orderId);
      expect(row!.status).toBe("in_flight");
      expect(row!.retryCount).toBe(0);
      expect(s.alerts.emitted).toHaveLength(0);
      expect(server.receivedWires).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("F-182 race: two CONCURRENT sweepers reclaim a stale row exactly once (one attempt counted, one alert)", async () => {
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const { orderId } = await crashedDispatch(server);
      const inner = fakeAlerts();
      // The alert emit runs INSIDE the reclaim transaction, so a slow emitter holds the first sweeper's row
      // lock open long enough for the others to genuinely overlap it (without this the three sweeps finish
      // back-to-back and the race never happens — the guards below would look untested).
      const alerts = {
        emitted: inner.emitted,
        port: {
          async emit(...args: Parameters<typeof inner.port.emit>) {
            await new Promise((r) => setTimeout(r, 200));
            return inner.port.emit(...args);
          },
        },
      } as ReturnType<typeof fakeAlerts>;
      const now = new Date(Date.now() + 10 * MINUTE);
      await Promise.all([
        sweep({ now, alerts }).run(),
        sweep({ now, alerts }).run(),
        sweep({ now, alerts }).run(),
      ]);
      const [row] = await outboundRowFor(ORG_A, orderId);
      expect(row!.status).toBe("queued");
      expect(row!.retryCount).toBe(1);
      expect(alerts.emitted).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("F-182 claim: two OVERLAPPING sweeps send a due retry once — the claim is committed before the send (pre-F-182 both read it `queued` and both transmitted)", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const orderId = randomUUID();
      // A first attempt that fails at connect leaves a `queued` retry row (retry_count 1, +30s backoff).
      const failing: MllpTransport = {
        async send() {
          return { kind: "connect_error", errorClass: "econnrefused" } as never;
        },
      };
      const { consumer } = buildConsumer(fakeOutbox(), fakeAlerts(), failing);
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));
      expect((await outboundRowFor(ORG_A, orderId))[0]!.status).toBe("queued");

      const now = new Date(Date.now() + 10 * MINUTE);
      await Promise.all([
        sweep({ now, slowClaimMs: 200 }).run(),
        sweep({ now, slowClaimMs: 200 }).run(),
      ]);
      expect(server.receivedWires).toHaveLength(1);
      expect((await outboundRowFor(ORG_A, orderId))[0]!.status).toBe("acked");
    } finally {
      await server.close();
    }
  });

  it("F-182 race: a SLOW worker that lost its lease finalizes into nothing — no second event, the reclaimer's attempt stands", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port, receiverDedupesControlId: true });
      const orderId = randomUUID();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const inSend = new Promise<void>((r) => (entered = r));
      const slow: MllpTransport = {
        async send(req) {
          entered();
          await gate; // the worker is "alive" but stalled past its lease
          const env = parseMshEnvelope(req.wireMessage);
          return { kind: "ack", rawAckPayload: buildAckWire(env, "AA") };
        },
      };
      const outbox = fakeOutbox();
      const { consumer } = buildConsumer(outbox, fakeAlerts(), slow);
      const done = consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));
      await inSend;

      // Lease expires while the slow worker is still mid-send: the sweeper takes the row back.
      await sweep({ now: new Date(Date.now() + 10 * MINUTE) }).run();
      const [reclaimed] = await outboundRowFor(ORG_A, orderId);
      expect(reclaimed!.status).toBe("queued");
      expect(reclaimed!.retryCount).toBe(1);

      release();
      await done; // the stalled worker now tries to write its ACK…
      const [after] = await outboundRowFor(ORG_A, orderId);
      expect(after!.status).toBe("queued"); // …and the claim guard makes that a no-op
      expect(after!.retryCount).toBe(1);
      expect(outbox.published).toHaveLength(0); // no `transmitted` for an attempt that lost its claim
    } finally {
      await server.close();
    }
  });

  it("F-182 budget: reclaims draw on the shared attempt budget — the last one goes terminal DLQ through the REAL catalog-validating publisher, never a loop", async () => {
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const { orderId, row } = await crashedDispatch(server);
      await admin.query("UPDATE hl7_message_outbound SET retry_count=4 WHERE id=$1", [row.id]);
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M29_OUTBOX_EVENTS]));
      const s = sweep({
        now: new Date(Date.now() + 10 * MINUTE),
        outboxPort: {
          publish: (tx: unknown, e: never) =>
            publisher.publish(tx as never, { ...(e as object), callerModule: "m29" } as never),
        },
      });
      await s.run();
      const [dlq] = await outboundRowFor(ORG_A, orderId);
      expect(dlq!.status).toBe("dlq");
      expect(dlq!.retryCount).toBe(5);
      expect(dlq!.nextRetryAt).toBeNull();
      const { rows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.transmission_failed'",
        [row.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ orderId, reason: "dlq_exhausted", attemptCount: 5 });
      expect(s.alerts.emitted).toHaveLength(1);
      expect(s.alerts.emitted[0]!.severity).toBe("critical"); // F-188: the EMITTER's alert_severity enum (HIGH/NORMAL threw at the INSERT)
      // Terminal means terminal: another sweep sends nothing further.
      await sweep({ now: new Date(Date.now() + 30 * MINUTE) }).run();
      expect(server.receivedWires).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("F-182: an ack correlating to a DIFFERENT MSH-10 used to strand the row in_flight forever — it now sits on its lease and is reclaimed", async () => {
    registerActiveBaa();
    await seedFeed({ organizationId: ORG_A, port: 2575, receiverDedupesControlId: true });
    const orderId = randomUUID();
    const wrongAck: MllpTransport = {
      async send(req) {
        const env = parseMshEnvelope(req.wireMessage);
        return { kind: "ack", rawAckPayload: buildAckWire({ ...env, messageControlId: "SOMEONE-ELSES" }, "AA") };
      },
    };
    const { consumer } = buildConsumer(fakeOutbox(), fakeAlerts(), wrongAck);
    await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));
    const [stuck] = await outboundRowFor(ORG_A, orderId);
    expect(stuck!.status).toBe("in_flight");
    const s = sweep({ now: new Date(Date.now() + 10 * MINUTE) });
    await s.run();
    const [reclaimed] = await outboundRowFor(ORG_A, orderId);
    expect(reclaimed!.status).toBe("queued");
    expect(reclaimed!.retryCount).toBe(1);
  });

  it("F-182 isolation: a sweep scoped to org A reclaims only org A's stale rows; org B's stay put until B is swept, and each alert goes to its own org", async () => {
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const serverB = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const a = await crashedDispatch(server, ORG_A);
      const b = await crashedDispatch(serverB, ORG_B);
      const now = new Date(Date.now() + 10 * MINUTE);

      const sA = sweep({ now, orgs: [ORG_A] });
      await sA.run();
      expect((await outboundRowFor(ORG_A, a.orderId))[0]!.status).toBe("queued");
      expect((await outboundRowFor(ORG_B, b.orderId))[0]!.status).toBe("in_flight");
      expect(sA.alerts.emitted.map((e) => e.organizationId)).toEqual([ORG_A]);

      const sB = sweep({ now, orgs: [ORG_B] });
      await sB.run();
      expect((await outboundRowFor(ORG_B, b.orderId))[0]!.status).toBe("queued");
      expect(sB.alerts.emitted.map((e) => e.organizationId)).toEqual([ORG_B]);
    } finally {
      await server.close();
      await serverB.close();
    }
  });

  // ── F-183 — the per-feed reclaim policy: receiver-dedupe flag, per-feed lease, lease re-arm, audit kinds ─────

  /** Every `m29.outbound.audit_intent` record the worker logged (the audit kinds with no M4 write-API). */
  type AuditIntent = { kind: string; outboundMessageId: string | null; feedId: string | null };
  function auditIntentsOf(info: { mock: { calls: readonly unknown[][] } }): AuditIntent[] {
    return info.mock.calls
      .filter((c) => c[0] === "m29.outbound.audit_intent")
      .map((c) => c[1] as AuditIntent);
  }

  it("F-183 held: on a feed NOT marked as deduping MSH-10 a stale in_flight row is HELD — terminal dlq through the REAL publisher, HIGH alert, audit kind `held`, and it is NEVER re-sent", async () => {
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { orderId, row } = await crashedDispatch(server, ORG_A, { receiverDedupesControlId: false });
      expect(row.status).toBe("in_flight");
      expect(server.receivedWires).toHaveLength(1);

      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M29_OUTBOX_EVENTS]));
      const s = sweep({
        now: new Date(Date.now() + 10 * MINUTE),
        outboxPort: {
          publish: (tx: unknown, e: never) =>
            publisher.publish(tx as never, { ...(e as object), callerModule: "m29" } as never),
        },
      });
      await s.run();

      const [held] = await outboundRowFor(ORG_A, orderId);
      expect(held!.status).toBe("dlq");
      expect(held!.retryCount).toBe(1); // the true number of attempts, not a fake exhausted budget
      expect(held!.nextRetryAt).toBeNull();
      const { rows } = await admin.query(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m29.lab_order.transmission_failed'",
        [row.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        orderId,
        reason: "dlq_exhausted",
        detail: "in_flight_lease_expired_delivery_unverified",
        attemptCount: 1,
      });
      expect(s.alerts.emitted).toHaveLength(1);
      expect(s.alerts.emitted[0]!.severity).toBe("critical"); // F-188: the EMITTER's alert_severity enum (HIGH/NORMAL threw at the INSERT)
      expect(JSON.stringify(s.alerts.emitted[0])).toMatch(/NOT re-sent/);
      expect(auditIntentsOf(info)).toContainEqual(
        expect.objectContaining({ kind: "hl7.outbound.held", outboundMessageId: row.id }),
      );

      // Held means held: no later sweep ever puts a second wire in front of the lab.
      await sweep({ now: new Date(Date.now() + 60 * MINUTE) }).run();
      expect(server.receivedWires).toHaveLength(1);
      expect((await outboundRowFor(ORG_A, orderId))[0]!.status).toBe("dlq");
    } finally {
      info.mockRestore();
      await server.close();
    }
  });

  it("F-183 per-feed decision: in ONE sweep the deduping feed's row is requeued (audit `reclaimed`) and the non-deduping feed's row is held (audit `held`), each in its own org", async () => {
    const serverA = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const serverB = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const a = await crashedDispatch(serverA, ORG_A, { receiverDedupesControlId: true });
      const b = await crashedDispatch(serverB, ORG_B, { receiverDedupesControlId: false });
      const s = sweep({ now: new Date(Date.now() + 10 * MINUTE), orgs: [ORG_A, ORG_B] });
      await s.run();

      const [rowA] = await outboundRowFor(ORG_A, a.orderId);
      const [rowB] = await outboundRowFor(ORG_B, b.orderId);
      expect(rowA!.status).toBe("queued");
      expect(rowA!.retryCount).toBe(1);
      expect(rowB!.status).toBe("dlq");
      const kinds = auditIntentsOf(info);
      expect(kinds).toContainEqual(expect.objectContaining({ kind: "hl7.outbound.reclaimed", outboundMessageId: a.row.id }));
      expect(kinds).toContainEqual(expect.objectContaining({ kind: "hl7.outbound.held", outboundMessageId: b.row.id }));
      // The reclaim requeue no longer masquerades as an ordinary dispatch.
      expect(kinds.filter((k) => k.outboundMessageId === a.row.id).map((k) => k.kind)).not.toContain("hl7.outbound.dispatched");
    } finally {
      info.mockRestore();
      await serverA.close();
      await serverB.close();
    }
  });

  it("F-183 lease: a feed's OWN shorter lease is what its claim commits and what the reclaim honours — a 60s feed is reclaimed at +2min while a default-lease feed is untouched", async () => {
    const serverA = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const serverB = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const a = await crashedDispatch(serverA, ORG_A, { inFlightLeaseSeconds: 60 });
      const b = await crashedDispatch(serverB, ORG_B, { inFlightLeaseSeconds: null });
      // The committed lease is exactly the feed's own length (claim time and lease expiry share one `now`).
      expect(a.row.nextRetryAt!.getTime() - a.row.queuedAt.getTime()).toBe(60_000);
      expect(b.row.nextRetryAt!.getTime() - b.row.queuedAt.getTime()).toBe(5 * MINUTE);

      await sweep({ now: new Date(Date.now() + 2 * MINUTE), orgs: [ORG_A, ORG_B] }).run();
      expect((await outboundRowFor(ORG_A, a.orderId))[0]!.status).toBe("queued");
      expect((await outboundRowFor(ORG_B, b.orderId))[0]!.status).toBe("in_flight");
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });

  it("F-183 lease: a feed's OWN longer lease protects a slow receiver — a 30min feed is untouched at +10min while a default-lease feed is reclaimed", async () => {
    const serverA = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const serverB = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const a = await crashedDispatch(serverA, ORG_A, { inFlightLeaseSeconds: 1800 });
      const b = await crashedDispatch(serverB, ORG_B, { inFlightLeaseSeconds: null });
      expect(a.row.nextRetryAt!.getTime() - a.row.queuedAt.getTime()).toBe(1800_000);

      await sweep({ now: new Date(Date.now() + 10 * MINUTE), orgs: [ORG_A, ORG_B] }).run();
      expect((await outboundRowFor(ORG_A, a.orderId))[0]!.status).toBe("in_flight");
      expect((await outboundRowFor(ORG_B, b.orderId))[0]!.status).toBe("queued");
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });

  it("F-183 lease: the RETRY sweep's claim (queued → in_flight) also takes the feed's own lease, not the platform default", async () => {
    registerActiveBaa();
    await seedFeed({ organizationId: ORG_A, port: 2575, receiverDedupesControlId: true, inFlightLeaseSeconds: 90 });
    const orderId = randomUUID();
    const failing: MllpTransport = {
      async send() {
        return { kind: "connect_error", errorClass: "econnrefused" } as never;
      },
    };
    const { consumer } = buildConsumer(fakeOutbox(), fakeAlerts(), failing);
    await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));
    expect((await outboundRowFor(ORG_A, orderId))[0]!.status).toBe("queued");

    const sweepNow = new Date(Date.now() + 10 * MINUTE);
    let leaseDuringSend: number | null = null;
    const observing: MllpTransport = {
      async send(req) {
        const [r] = await outboundRowFor(ORG_A, orderId);
        leaseDuringSend = r!.nextRetryAt!.getTime() - sweepNow.getTime();
        return { kind: "ack", rawAckPayload: buildAckWire(parseMshEnvelope(req.wireMessage), "AA") };
      },
    };
    await runOutboundRetrySweepOnce({
      db: handle.db,
      outbox: fakeOutbox().port,
      keys: fakeKeyProvider(),
      alerts: fakeAlerts().port,
      destinationPolicy: TEST_POLICY,
      transport: observing,
      activeOrgs: fakeActiveOrgs(ORG_A),
      now: () => sweepNow,
    });
    expect(leaseDuringSend).toBe(90_000);
    expect((await outboundRowFor(ORG_A, orderId))[0]!.status).toBe("acked");
  });

  /** A limiter whose wait advances a virtual clock: the worker's `now` is `clock`, so a "long wait" is instant. */
  function slowLimiterWorld(args: { readonly waitMs: number; readonly onWaited?: () => Promise<void> }) {
    const clock = { now: new Date() };
    const startedAt = clock.now.getTime();
    const rateLimiter = {
      async acquire() {
        clock.now = new Date(clock.now.getTime() + args.waitMs);
        await args.onWaited?.();
      },
    };
    return { clock, startedAt, rateLimiter };
  }

  it("F-183 limiter: a long rate-limiter wait cannot get a LIVE sender reclaimed — the lease is re-armed when the send BEGINS", async () => {
    registerActiveBaa();
    await seedFeed({ organizationId: ORG_A, port: 2575, receiverDedupesControlId: true, inFlightLeaseSeconds: 60 });
    const orderId = randomUUID();
    const world = slowLimiterWorld({ waitMs: 50_000 }); // the wait eats 50s of the 60s lease before the socket opens
    let statusInSend: string | undefined;
    let leaseInSend: Date | null = null;
    const transport: MllpTransport = {
      async send(req) {
        // The worker is mid-send. 80s after the claim: past the ORIGINAL 60s lease, inside the re-armed one.
        await sweep({ now: new Date(world.startedAt + 80_000) }).run();
        const [r] = await outboundRowFor(ORG_A, orderId);
        statusInSend = r!.status;
        leaseInSend = r!.nextRetryAt;
        return { kind: "ack", rawAckPayload: buildAckWire(parseMshEnvelope(req.wireMessage), "AA") };
      },
    };
    const outbox = fakeOutbox();
    const alerts = fakeAlerts();
    const consumer = buildM29OutboundDispatchConsumer({
      db: handle.db,
      outbox: outbox.port,
      keys: fakeKeyProvider(),
      alerts: alerts.port,
      transport,
      destinationPolicy: TEST_POLICY,
      rateLimiter: world.rateLimiter,
      now: () => world.clock.now,
    });
    await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));

    expect(statusInSend).toBe("in_flight"); // NOT reclaimed mid-send
    expect(leaseInSend!.getTime()).toBe(world.startedAt + 50_000 + 60_000); // re-armed: send-start + 60s
    const [done] = await outboundRowFor(ORG_A, orderId);
    expect(done!.status).toBe("acked");
    expect(done!.retryCount).toBe(0); // no phantom attempt was counted
    expect(outbox.published.map((e) => e.eventName)).toEqual(["m29.lab_order.transmitted"]);
    expect(alerts.emitted).toHaveLength(0);
  });

  it("F-183 limiter: if a reclaimer takes the row DURING the limiter wait, the worker sends NOTHING (the reclaimer's attempt stands) and logs the lost claim", async () => {
    registerActiveBaa();
    await seedFeed({ organizationId: ORG_A, port: 2575, receiverDedupesControlId: true, inFlightLeaseSeconds: 60 });
    const orderId = randomUUID();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = slowLimiterWorld({
      waitMs: 50_000,
      // While this worker waits on the limiter another process finds the 60s lease expired and reclaims the row.
      onWaited: async () => {
        await sweep({ now: new Date(Date.now() + 2 * MINUTE) }).run();
      },
    });
    let sends = 0;
    const transport: MllpTransport = {
      async send() {
        sends += 1;
        return { kind: "connect_error", errorClass: "should_not_be_called" } as never;
      },
    };
    const outbox = fakeOutbox();
    try {
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        alerts: fakeAlerts().port,
        transport,
        destinationPolicy: TEST_POLICY,
        rateLimiter: world.rateLimiter,
        now: () => world.clock.now,
      });
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));

      expect(sends).toBe(0); // the stale claimant never opened a socket
      const [row] = await outboundRowFor(ORG_A, orderId);
      expect(row!.status).toBe("queued"); // the reclaimer's requeue stands
      expect(row!.retryCount).toBe(1);
      expect(outbox.published).toHaveLength(0);
      expect(warn.mock.calls.some((c) => c[0] === "m29.outbound.claim_lost")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("F-183 schema: safe defaults, the 60..3600 CHECK, and RLS on the new columns", async () => {
    const feedA = randomUUID();
    await admin.query(
      `INSERT INTO external_feed (id, organization_id, kind, display_name, host, port, protocol,
          status, proposed_by_membership_id)
       VALUES ($1,$2,'orm_outbound','Defaults Lab','127.0.0.1',2601,'mllp_plain','active',$3)`,
      [feedA, ORG_A, randomUUID()],
    );
    const defaults = await admin.query(
      "SELECT receiver_dedupes_control_id AS d, in_flight_lease_seconds AS l FROM external_feed WHERE id=$1",
      [feedA],
    );
    expect(defaults.rows[0]).toEqual({ d: false, l: null }); // safe by default: never assume a deduping receiver

    for (const bad of [59, 0, -1, 3601]) {
      await expect(
        admin.query("UPDATE external_feed SET in_flight_lease_seconds=$2 WHERE id=$1", [feedA, bad]),
      ).rejects.toThrow(/external_feed_in_flight_lease_chk/);
    }
    for (const ok of [60, 3600, null]) {
      await admin.query("UPDATE external_feed SET in_flight_lease_seconds=$2 WHERE id=$1", [feedA, ok]);
    }
    await admin.query("UPDATE external_feed SET receiver_dedupes_control_id=true, in_flight_lease_seconds=90 WHERE id=$1", [feedA]);

    // RLS as the real NOBYPASSRLS role: org A sees its own policy columns, org B sees no trace of the feed.
    const asA = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      tx.select().from(FEED).where(eq(FEED.id, feedA)),
    );
    expect(asA).toHaveLength(1);
    expect(asA[0]).toMatchObject({ receiverDedupesControlId: true, inFlightLeaseSeconds: 90 });
    const asB = await withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
      tx.select().from(FEED).where(eq(FEED.id, feedA)),
    );
    expect(asB).toHaveLength(0);
  });

  it("F-181: a mllp_plain feed under the production-safe policy is refused BEFORE any socket — terminal DLQ, one attempt, no retry", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const outbox = fakeOutbox();
      const alerts = fakeAlerts();
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        alerts: alerts.port,
        destinationPolicy: { allowPlain: false, allowLoopback: false },
      });
      const orderId = randomUUID();
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));

      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("dlq");
      expect(rows[0]?.retryCount).toBe(1);
      expect(rows[0]?.nextRetryAt).toBeNull();
      expect(server.receivedWires).toHaveLength(0); // the receiver saw nothing — no connection was even opened
      expect(outbox.published).toHaveLength(1);
      expect(outbox.published[0]).toMatchObject({ eventName: "m29.lab_order.transmission_failed" });
      expect(outbox.published[0]?.payload).toMatchObject({
        orderId,
        reason: "dlq_exhausted",
        detail: "plain_protocol_refused",
        attemptCount: 1,
      });
      expect(alerts.emitted.some((a) => a.eventType === "hl7_outbound.transmission_failed")).toBe(true);
      // PHI discipline: the terminal event/alert carry a fixed label, never the wire message.
      expect(JSON.stringify([outbox.published, alerts.emitted])).not.toContain("Doe");
    } finally {
      await server.close();
    }
  });

  // ── F-188 — the worker's alerts, through the REAL M36 emitter, reach a PERSON ───────────────────────────────
  // Every case above hands the worker a FAKE alerts port, which is exactly how three defects hid: the worker's
  // `HIGH`/`NORMAL` severity threw at the real `alert` INSERT (swallowed by design), no platform-default rule
  // existed for the three kinds, and the per-feed correlation id could only ever notify once. Here a real dispatch
  // produces the intent and the real emitter routes it. (Kind/recipient/throttle detail: `m29-alert-routing.live`.)
  let alertRecipients: { orgAdmin: string; compliance: string; clinicalLead: string } | null = null;
  async function seedAlertRecipients(): Promise<NonNullable<typeof alertRecipients>> {
    if (alertRecipients) return alertRecipients;
    const add = async (tag: string, roleKey: string, category: string): Promise<string> => {
      const roleId = (
        await admin.query(
          "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,$3) RETURNING id",
          [ORG_A, roleKey, category],
        )
      ).rows[0].id as string;
      const userId = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}@f186-outbound.test`])
      ).rows[0].id as string;
      const membershipId = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [userId, ORG_A],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [ORG_A, membershipId, roleId],
      );
      return userId;
    };
    await wireAlertRuleSeed(handle.db);
    alertRecipients = {
      orgAdmin: await add("f186-admin", "org_admin", "admin_executive"),
      compliance: await add("f186-compliance", "compliance_officer", "compliance_quality"),
      clinicalLead: await add("f186-lead", "clinical_lead", "clinical_leadership"),
    };
    return alertRecipients;
  }
  const deliveredTo = async (eventType: string): Promise<string[]> =>
    (
      await admin.query(
        `SELECT DISTINCT nd.recipient_user_id FROM notification_delivery nd JOIN alert a ON a.id = nd.alert_id
          WHERE a.organization_id = $1 AND a.event_type = $2`,
        [ORG_A, eventType],
      )
    ).rows
      .map((r) => r.recipient_user_id as string)
      .sort();

  it("F-188 end to end: a BAA-refused dispatch notifies the compliance officer (and the org_admin backstop) through the real emitter", async () => {
    const who = await seedAlertRecipients();
    registerSeam("BaaStatusProvider", {
      baaStatusByMdmEntity: async () => ({ isActive: false, status: "missing", expiresOn: null }),
    } as never);
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: fakeOutbox().port,
        keys: fakeKeyProvider(),
        destinationPolicy: TEST_POLICY,
        alerts: createDrizzleAlertEmitter(handle.db) as unknown as OutboundAlertPort,
      });
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId: randomUUID(), organizationId: ORG_A })));

      expect(await deliveredTo("external_feed.baa_missing")).toEqual([who.compliance, who.orgAdmin].sort());
      const { rows } = await admin.query(
        "SELECT severity FROM alert WHERE organization_id=$1 AND event_type='external_feed.baa_missing'",
        [ORG_A],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].severity).toBe("critical");
    } finally {
      await server.close();
    }
  });

  it("F-188 end to end: a dead-lettered transmission notifies the operator and the M11 owners through the real emitter", async () => {
    const who = await seedAlertRecipients();
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: fakeOutbox().port,
        keys: fakeKeyProvider(),
        // production-safe policy ⇒ plain MLLP is refused before any socket ⇒ a terminal DLQ (the F-181 path)
        destinationPolicy: { allowPlain: false, allowLoopback: false },
        alerts: createDrizzleAlertEmitter(handle.db) as unknown as OutboundAlertPort,
      });
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId: randomUUID(), organizationId: ORG_A })));

      expect(await deliveredTo("hl7_outbound.transmission_failed")).toEqual(
        [who.orgAdmin, who.clinicalLead].sort(),
      );
    } finally {
      await server.close();
    }
  });

  it("F-181: with plain allowed but loopback refused (production shape), the transport's destination refusal is also a terminal DLQ — no retry burn", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      await seedFeed({ organizationId: ORG_A, port: server.port });
      const outbox = fakeOutbox();
      const alerts = fakeAlerts();
      const consumer = buildM29OutboundDispatchConsumer({
        db: handle.db,
        outbox: outbox.port,
        keys: fakeKeyProvider(),
        alerts: alerts.port,
        destinationPolicy: { allowPlain: true, allowLoopback: false },
      });
      const orderId = randomUUID();
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));

      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows[0]?.status).toBe("dlq");
      expect(rows[0]?.retryCount).toBe(1);
      expect(server.receivedWires).toHaveLength(0);
      expect(outbox.published[0]?.payload).toMatchObject({ detail: "destination_loopback", attemptCount: 1 });
    } finally {
      await server.close();
    }
  });

  // ── F-187 — the index behind F-183's ORDER-level dispatch dedupe ──────────────────────────────────────────
  // `ormDispatchExistsForOrder` runs once per delivery. Migration 0265 adds `idx_hmo_org_source_aggregate`. Proven:
  //  (a) on ~40k rows across 4 partitions (incl. DEFAULT), under the real NOBYPASSRLS role (RLS qual in the plan),
  //      every partition holding rows is read through an index attached to the F-187 parent index and NO row is
  //      fetched-then-filtered;
  //  (b) the assertion is sensitive: with the index dropped (rolled-back txn) the planner falls back to the org's
  //      `(organization_id, feed_id)` index on the org prefix ALONE — a Bitmap Heap Scan that fetches every row of
  //      the org and filters them — so the same query does thousands of rows of filtering and an order of magnitude
  //      more buffer work. Node TYPE is not the signal (the fallback is not a Seq Scan); WORK DONE is;
  //  (c) every existing partition, and a newly created month, carry the index; (d) answers + tenant isolation of the
  //      lookup are unchanged.
  describe("F-187 order-lookup index (idx_hmo_org_source_aggregate)", () => {
    const INDEX = "idx_hmo_org_source_aggregate";
    const KIND = "m11.order_record";

    type PlanNode = {
      "Node Type": string;
      "Relation Name"?: string;
      "Index Name"?: string;
      "Rows Removed by Filter"?: number;
      "Shared Hit Blocks"?: number;
      "Shared Read Blocks"?: number;
      Plans?: PlanNode[];
    };

    function scanNodes(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
      if (node["Relation Name"] !== undefined || node["Index Name"] !== undefined) out.push(node);
      for (const child of node.Plans ?? []) scanNodes(child, out);
      return out;
    }
    function rowsRemoved(node: PlanNode): number {
      return (node["Rows Removed by Filter"] ?? 0) + (node.Plans ?? []).reduce((a, c) => a + rowsRemoved(c), 0);
    }
    /** buffer blocks touched by the whole statement (the root node's counters include its children). */
    function buffers(root: PlanNode): number {
      return (root["Shared Hit Blocks"] ?? 0) + (root["Shared Read Blocks"] ?? 0);
    }

    /** rows loaded per partition, by partition name (the plan's scan nodes carry the leaf partition name). */
    async function loadedPartitions(): Promise<Map<string, number>> {
      const r = await admin.query(
        "SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM hl7_message_outbound GROUP BY 1",
      );
      return new Map(r.rows.map((x: { part: string; n: number }) => [x.part, x.n]));
    }

    /** the per-partition index names attached (pg_inherits) to the parent F-187 index — the planner reports these. */
    async function childIndexNames(): Promise<Set<string>> {
      const r = await admin.query(
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = $1`,
        [INDEX],
      );
      return new Set(r.rows.map((x: { relname: string }) => x.relname));
    }

    async function seedBulk(feedA: string, feedB: string): Promise<{ knownOrder: string; partitions: number }> {
      // 4 partitions: this month, +1, +2 (all pre-created by 0146) and 2 years back (the DEFAULT partition).
      const spans = ["now()", "now() + interval '1 month'", "now() + interval '2 months'", "now() - interval '2 years'"];
      for (const [org, feed] of [[ORG_A, feedA], [ORG_B, feedB]] as const) {
        for (const at of spans) {
          await admin.query(
            `INSERT INTO hl7_message_outbound
               (id, organization_id, feed_id, message_type, message_control_id, payload_cipher, payload_sha256,
                segments_summary, source_aggregate_kind, source_aggregate_id, queued_at, idempotency_key)
             SELECT gen_random_uuid(), $1, $2, 'ORM^O01', md5(random()::text || g::text), 'x', 'x', '{}'::jsonb,
                    $3, gen_random_uuid(), ${at}, md5(random()::text || g::text) || $4::text
               FROM generate_series(1, 5000) g`,
            [org, feed, KIND, org],
          );
        }
      }
      const knownOrder = randomUUID();
      await admin.query(
        `INSERT INTO hl7_message_outbound
           (organization_id, feed_id, message_type, message_control_id, payload_cipher, payload_sha256,
            segments_summary, source_aggregate_kind, source_aggregate_id, queued_at, idempotency_key)
         VALUES ($1, $2, 'ORM^O01', 'ctl-known', 'x', 'x', '{}'::jsonb, $3, $4, now() + interval '1 month', 'known-key')`,
        [ORG_A, feedA, KIND, knownOrder],
      );
      await admin.query("ANALYZE hl7_message_outbound");
      return { knownOrder, partitions: (await loadedPartitions()).size };
    }

    function planFrom(rows: Array<Record<string, unknown>>): PlanNode {
      const plan = (rows[0]?.["QUERY PLAN"] ?? Object.values(rows[0] ?? {})[0]) as Array<{ Plan: PlanNode }>;
      return plan[0]!.Plan;
    }

    /** EXPLAIN (ANALYZE, BUFFERS) exactly the seam's statement under the real app role + RLS (`withOrgContext`). */
    async function explainAsApp(orgId: string, orderId: string): Promise<PlanNode> {
      return withOrgContext(handle.db, { organizationId: orgId, userId: "" }, async (tx) => {
        const q = ormDispatchLookupQuery(tx as never, orgId, orderId);
        const res = (await tx.execute(sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.getSQL()}`)) as unknown as
          | Array<Record<string, unknown>>
          | { rows: Array<Record<string, unknown>> };
        return planFrom(Array.isArray(res) ? res : res.rows);
      });
    }

    /** the same statement on the superuser connection (used for the drop-the-index control only). */
    async function explainAsAdmin(orgId: string, orderId: string): Promise<PlanNode> {
      const q = ormDispatchLookupQuery(handle.db as never, orgId, orderId).toSQL();
      const r = await admin.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, q.params as unknown[]);
      return planFrom(r.rows);
    }

    it("the planner reads every LOADED partition through the F-187 index and fetches no row it then discards", async () => {
      const feedA = await seedFeed({ organizationId: ORG_A, port: 2591 });
      const feedB = await seedFeed({ organizationId: ORG_B, port: 2592 });
      const { knownOrder, partitions } = await seedBulk(feedA, feedB);
      expect(partitions).toBeGreaterThanOrEqual(4); // the load really spans >= 2 partitions (incl. DEFAULT)

      const loaded = await loadedPartitions();
      expect([...loaded.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(40_000);
      const children = await childIndexNames();
      expect(children.size).toBeGreaterThanOrEqual(14); // 13 monthly partitions + DEFAULT each carry a child index

      // A known order (lives in the +1 month partition) AND an absent one (no partition can short-circuit LIMIT 1).
      for (const orderId of [knownOrder, randomUUID()]) {
        const plan = await explainAsApp(ORG_A, orderId);
        const onLoaded = scanNodes(plan).filter((n) => n["Relation Name"] !== undefined && loaded.has(n["Relation Name"]!));
        expect(onLoaded.length).toBeGreaterThanOrEqual(1);
        for (const n of onLoaded) {
          expect(n["Node Type"], `${n["Relation Name"]}`).not.toBe("Seq Scan");
          expect(children.has(n["Index Name"] ?? ""), `${n["Relation Name"]} must use a child of ${INDEX}`).toBe(true);
        }
        expect(rowsRemoved(plan), "an exact-match index scan discards nothing").toBe(0);
      }
    }, 180_000);

    it("control: with the index dropped (rolled-back txn) the same statement does thousands of rows of filtering and ~10x the buffer work", async () => {
      const feedA = await seedFeed({ organizationId: ORG_A, port: 2591 });
      const feedB = await seedFeed({ organizationId: ORG_B, port: 2592 });
      await seedBulk(feedA, feedB);
      const absent = randomUUID(); // absent => every partition of the org must be exhausted, no early exit

      const withIndex = await explainAsAdmin(ORG_A, absent);
      const withChildren = await childIndexNames();

      await admin.query("BEGIN");
      let without: PlanNode;
      try {
        await admin.query(`DROP INDEX ${INDEX}`);
        without = await explainAsAdmin(ORG_A, absent);
      } finally {
        await admin.query("ROLLBACK");
      }
      // the rollback really restored the parent index and every child
      expect((await childIndexNames()).size).toBe(withChildren.size);

      // no scan in the dropped-index plan can be using an F-187 child (they did not exist)
      expect(scanNodes(without).some((n) => withChildren.has(n["Index Name"] ?? ""))).toBe(false);
      expect(rowsRemoved(withIndex)).toBe(0);
      expect(rowsRemoved(without), "org-prefix scan fetches the org's rows then filters them").toBeGreaterThan(5_000);
      expect(buffers(without)).toBeGreaterThan(buffers(withIndex) * 10);
    }, 180_000);

    it("every existing partition (incl. DEFAULT) carries the index, and a NEWLY created month inherits it", async () => {
      const parts = await admin.query(
        `SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = 'hl7_message_outbound'`,
      );
      expect((await childIndexNames()).size).toBe(parts.rows[0].n); // one child index per partition, none missing

      const part = "hl7_message_outbound_2031_01";
      await admin.query("SELECT create_hl7_message_outbound_partition('2031-01-01')");
      try {
        const idx = await admin.query(
          `SELECT pi.indexrelid::regclass::text AS idx
             FROM pg_index pi JOIN pg_class c ON c.oid = pi.indrelid
             JOIN pg_inherits inh ON inh.inhrelid = pi.indexrelid
             JOIN pg_class parent ON parent.oid = inh.inhparent
            WHERE c.relname = $1 AND parent.relname = $2`,
          [part, INDEX],
        );
        expect(idx.rowCount).toBe(1); // the new partition's index is attached to the parent index
      } finally {
        await admin.query(`DROP TABLE IF EXISTS ${part}`);
      }
    });

    it("the lookup's answers and tenant isolation are unchanged: known order true, unknown false, other tenant's order invisible", async () => {
      const feedA = await seedFeed({ organizationId: ORG_A, port: 2591 });
      const feedB = await seedFeed({ organizationId: ORG_B, port: 2592 });
      const { knownOrder } = await seedBulk(feedA, feedB);
      const otherTenantOrder = (
        await admin.query(
          "SELECT source_aggregate_id AS id FROM hl7_message_outbound WHERE organization_id = $1 LIMIT 1",
          [ORG_B],
        )
      ).rows[0].id as string;

      const exists = (org: string, order: string) =>
        withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
          ormDispatchExistsForOrder(tx as never, org, order),
        );
      expect(await exists(ORG_A, knownOrder)).toBe(true);
      expect(await exists(ORG_A, randomUUID())).toBe(false);
      // ORG_B's order asked for as ORG_A: false both by the explicit org predicate and by RLS
      expect(await exists(ORG_A, otherTenantOrder)).toBe(false);
      expect(await exists(ORG_B, otherTenantOrder)).toBe(true);
      // RLS alone: ORG_A's context asking with ORG_B's org id + order id still sees nothing
      const smuggled = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        ormDispatchExistsForOrder(tx as never, ORG_B, otherTenantOrder),
      );
      expect(smuggled).toBe(false);
    }, 180_000);
  });

  // ── F-187 — the attested re-dispatch exception to the order-level guard, and the row-less refusals ─────────

  /** Dispatch an order normally (acked by the mock lab), then force its one row into `status`. */
  async function orderWithRowIn(server: { port: number }, status: string): Promise<string> {
    await seedFeed({ organizationId: ORG_A, port: server.port });
    const { consumer } = buildConsumer();
    const orderId = randomUUID();
    await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));
    await admin.query(
      "UPDATE hl7_message_outbound SET status=$3 WHERE organization_id=$1 AND source_aggregate_id=$2",
      [ORG_A, orderId, status],
    );
    return orderId;
  }
  const attested = (orderId: string) => ({
    ...ormRequestedPayload({ orderId, organizationId: ORG_A }),
    redispatchAttestationId: randomUUID(),
  });

  it("F-187 guard: an ATTESTED re-dispatch is refused while ANY earlier row still owns the order (acked / queued / in_flight) — the lab may hold it", async () => {
    registerActiveBaa();
    for (const status of ["acked", "queued", "in_flight"]) {
      const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
      try {
        const orderId = await orderWithRowIn(server, status);
        const wiresBefore = server.receivedWires.length;
        const { consumer } = buildConsumer();
        await consumer.handle(dispatchEvent(attested(orderId)));
        expect(await outboundRowFor(ORG_A, orderId), `status=${status}`).toHaveLength(1);
        expect(server.receivedWires.length, `status=${status}`).toBe(wiresBefore);
      } finally {
        await server.close();
        await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id=$1", [ORG_A]);
        await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
      }
    }
  });

  it("F-187: an ATTESTED re-dispatch over a DEAD-END row (dlq / naked / failed) adds ONE new row and sends once; redelivering the SAME attested event adds nothing", async () => {
    registerActiveBaa();
    for (const status of ["dlq", "naked", "failed"]) {
      const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
      try {
        const orderId = await orderWithRowIn(server, status);
        expect(server.receivedWires).toHaveLength(1); // the original attempt
        const { consumer } = buildConsumer();
        const event = dispatchEvent(attested(orderId));
        await consumer.handle(event);
        const rows = await outboundRowFor(ORG_A, orderId);
        expect(rows, `status=${status}`).toHaveLength(2);
        expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
        expect(new Set(rows.map((r) => r.messageControlId)).size).toBe(2);
        expect(server.receivedWires, `status=${status}`).toHaveLength(2);
        // At-least-once redelivery of the very same attested event: the attestation-scoped key finds its own row.
        await consumer.handle(event);
        await Promise.all([consumer.handle(event), consumer.handle(event)]);
        expect(await outboundRowFor(ORG_A, orderId), `status=${status}`).toHaveLength(2);
        expect(server.receivedWires, `status=${status}`).toHaveLength(2);
      } finally {
        await server.close();
        await admin.query("DELETE FROM hl7_message_outbound WHERE organization_id=$1", [ORG_A]);
        await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
      }
    }
  });

  it("F-187: WITHOUT the attestation a dead-end row still blocks a redelivery — F-183's one-ORM-per-order guard is unchanged", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    try {
      const orderId = await orderWithRowIn(server, "dlq");
      const { consumer } = buildConsumer();
      await consumer.handle(dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A })));
      expect(await outboundRowFor(ORG_A, orderId)).toHaveLength(1);
      expect(server.receivedWires).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("F-187: every row-less feed refusal publishes ONE `dispatch_refused` with its reason — no_active_feed, ambiguous_feed, no_feed_for_destination", async () => {
    registerActiveBaa();
    const server = await startMockMllpServer(() => ({ kind: "ack", ackCode: "AA" }));
    const FAC_X = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const FAC_Y = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    async function refusalFor(setup: () => Promise<void>, facility?: string) {
      await admin.query("DELETE FROM external_feed WHERE organization_id=$1", [ORG_A]);
      await setup();
      const { consumer, outbox } = buildConsumer();
      const orderId = randomUUID();
      await consumer.handle(
        dispatchEvent(ormRequestedPayload({ orderId, organizationId: ORG_A, labDestinationFacilityId: facility })),
      );
      expect(await outboundRowFor(ORG_A, orderId)).toHaveLength(0);
      const refused = outbox.published.filter((e) => e.eventName === "m29.lab_order.dispatch_refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({ orderId, organizationId: ORG_A });
      return refused[0]!.payload as { reason: string; feedId: string | null; refusalId: string };
    }
    try {
      const none = await refusalFor(async () => {});
      expect(none).toMatchObject({ reason: "no_active_feed", feedId: null });
      expect(none.refusalId).toMatch(/^[0-9a-f-]{36}$/);

      const ambiguous = await refusalFor(async () => {
        await seedFeed({ organizationId: ORG_A, port: server.port });
        await seedFeed({ organizationId: ORG_A, port: server.port + 1 }); // (org, port, kind) is unique
      });
      expect(ambiguous.reason).toBe("ambiguous_feed");

      const elsewhere = await refusalFor(async () => {
        await seedFeed({ organizationId: ORG_A, port: server.port, labDestinationFacilityId: FAC_Y });
      }, FAC_X);
      expect(elsewhere.reason).toBe("no_feed_for_destination");
      expect(server.receivedWires).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
