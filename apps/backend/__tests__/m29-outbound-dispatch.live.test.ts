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
import { and, eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
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
  }> = [];
  const port: OutboundAlertPort = {
    async emit(organizationId, input) {
      emitted.push({
        organizationId,
        eventType: input.eventType,
        severity: input.severity,
        correlationId: input.correlationId,
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

  /** Seed one ACTIVE `orm_outbound` feed pointed at the mock server, org-scoped. */
  async function seedFeed(args: {
    readonly organizationId: string;
    readonly port: number;
    readonly rateLimitMsgPerSec?: number;
  }): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO external_feed
         (id, organization_id, kind, display_name, host, port, protocol, channel_cert_pin,
          status, proposed_by_membership_id, rate_limit_msg_per_sec)
       VALUES ($1,$2,'orm_outbound','Mock Reference Lab','127.0.0.1',$3,'mllp_plain',NULL,
               'active',$4,$5)`,
      [id, args.organizationId, args.port, randomUUID(), args.rateLimitMsgPerSec ?? 1000],
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

  it("BAA-inactive: no row written, no transmission_failed emitted", async () => {
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
        alerts: alerts.port,
      });

      const orderId = randomUUID();
      const payload = ormRequestedPayload({ orderId, organizationId: ORG_A });
      await consumer.handle(dispatchEvent(payload));

      const rows = await outboundRowFor(ORG_A, orderId);
      expect(rows).toHaveLength(0);
      expect(outbox.published).toHaveLength(0);
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
});
