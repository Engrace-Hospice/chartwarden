import type { OrmRequestedPayload } from "@wardenx/types";
// apps/backend/src/modules/29-external-interfaces/__tests__ — M29-T06 outbound ORM unit tests (§4.12,
// W-XI-07/08/09). Every pure core: the ORM^O01 wire builder (D8 OBR-2, HL7 escaping, NTE, PHI-free summary),
// the BAA-gated dispatch planner (dispatch vs pre-persist refuse), the ACK correlation (AA / AR / AE /
// orphan), and the D9 retry / DLQ policy.
import { describe, expect, it } from "vitest";
import type { BaaGateDecision } from "../feed/baa-gate";
import { type CorrelatedOutboundRow, correlateAck, parseAckMsa } from "../outbound/ack-correlation";
import {
  ORM_SOURCE_KIND,
  type OutboundDispatchInput,
  outboundIdempotencyKey,
  planOutboundDispatch,
} from "../outbound/dispatch-planner";
import {
  type OrmEndpoint,
  buildOrmO01,
  escapeHl7,
  isoToHl7Timestamp,
  summarizeSegments,
} from "../outbound/orm-o01";
import { OUTBOUND_BACKOFF_MS, OUTBOUND_MAX_ATTEMPTS, decideRetry } from "../outbound/retry-policy";

const ORG = "org_engrace";
const FEED = "feed_quest_engrace_out";

const ENDPOINT: OrmEndpoint = {
  sendingApplication: "WARDENX",
  sendingFacility: "ENGRACE",
  receivingApplication: "LAB",
  receivingFacility: "QUEST",
};

function mkRequest(over: Partial<OrmRequestedPayload> = {}): OrmRequestedPayload {
  return {
    orderId: "ord_NEW_abc" as OrmRequestedPayload["orderId"],
    organizationId: ORG,
    labDestinationFacilityId: "fac_quest",
    priority: "R",
    requestedAt: "2026-08-01T12:00:00.000Z",
    labOrderPayload: {
      orderId: "ord_NEW_abc" as OrmRequestedPayload["labOrderPayload"]["orderId"],
      patientId: "pat_1" as OrmRequestedPayload["labOrderPayload"]["patientId"],
      placerOrderNumber: "ordNEWabc",
      observationIdentifier: { code: "2345-7", text: "Glucose", codingSystem: "LN" },
      orderingProviderNpi: "1234567890",
      orderingProviderName: { family: "House", given: "Gregory" },
      priority: "R",
      clinicalNotes: ["fasting specimen"],
      patientDemographics: {
        mrn: "MRN-001",
        internalMrnAuthority: "ENGRACE_INTERNAL",
        familyName: "Doe",
        givenName: "Jane",
        dateOfBirth: "1948-03-22",
        administrativeSex: "F",
        addressLine1: "1 Main St",
        addressCity: "Austin",
        addressState: "TX",
        addressPostal: "78701",
      },
    },
    ...over,
  };
}

const ALLOWED: BaaGateDecision = { allowed: true };

function dispatchInput(over: Partial<OutboundDispatchInput> = {}): OutboundDispatchInput {
  return {
    request: mkRequest(),
    feed: { id: FEED, organizationId: ORG, endpoint: ENDPOINT },
    baa: ALLOWED,
    destinationFacilityId: "fac_quest",
    outboundMessageId: "hmo_1",
    messageControlId: "MSH10-1",
    queuedAt: new Date("2026-08-01T12:00:05.000Z"),
    ...over,
  };
}

// ── ORM^O01 wire builder ─────────────────────────────────────────────────────────────────────────────────
describe("buildOrmO01", () => {
  it("builds MSH/PID/ORC/OBR/NTE with OBR-2 = the placer order number (D8)", () => {
    const wire = buildOrmO01({
      request: mkRequest(),
      endpoint: ENDPOINT,
      messageControlId: "MSH10-1",
      messageTimestamp: "20260801120005",
    });
    const segments = wire.split("\r");
    expect(segments[0]).toBe(
      "MSH|^~\\&|WARDENX|ENGRACE|LAB|QUEST|20260801120005||ORM^O01|MSH10-1|P|2.5.1",
    );
    const obr = segments.find((s) => s.startsWith("OBR"))!;
    const orc = segments.find((s) => s.startsWith("ORC"))!;
    // OBR-2 (index 2) and ORC-2 both carry the placer order number.
    expect(obr.split("|")[2]).toBe("ordNEWabc");
    expect(orc.split("|")[2]).toBe("ordNEWabc");
    // OBR-4 CWE = LOINC code^text^system.
    expect(obr.split("|")[4]).toBe("2345-7^Glucose^LN");
    // ORC is a New-order.
    expect(orc.split("|")[1]).toBe("NW");
  });

  it("emits one NTE per clinical note", () => {
    const wire = buildOrmO01({
      request: mkRequest({
        labOrderPayload: { ...mkRequest().labOrderPayload, clinicalNotes: ["note a", "note b"] },
      }),
      endpoint: ENDPOINT,
      messageControlId: "m",
      messageTimestamp: "20260801120005",
    });
    const ntes = wire.split("\r").filter((s) => s.startsWith("NTE"));
    expect(ntes).toEqual(["NTE|1||note a", "NTE|2||note b"]);
  });

  it("escapes HL7 delimiter characters in free-text so framing cannot break", () => {
    const wire = buildOrmO01({
      request: mkRequest({
        labOrderPayload: {
          ...mkRequest().labOrderPayload,
          orderingProviderName: { family: "A|B^C&D", given: "E~F" },
        },
      }),
      endpoint: ENDPOINT,
      messageControlId: "m",
      messageTimestamp: "20260801120005",
    });
    // The escaped provider appears; no raw delimiter leaked into the name components.
    expect(wire).toContain("A\\F\\B\\S\\C\\T\\D^E\\R\\F");
    // The wire still parses into the expected 5 segments (MSH/PID/ORC/OBR/NTE).
    expect(wire.split("\r")).toHaveLength(5);
  });

  it("summarizeSegments reports only segment counts + byte length (no PHI, §8.4)", () => {
    const wire = buildOrmO01({
      request: mkRequest(),
      endpoint: ENDPOINT,
      messageControlId: "m",
      messageTimestamp: "20260801120005",
    });
    const summary = summarizeSegments(wire);
    expect(summary.segments).toEqual({ MSH: 1, PID: 1, ORC: 1, OBR: 1, NTE: 1 });
    expect(summary.byteLength).toBe(Buffer.byteLength(wire, "utf8"));
    // The summary carries no field value — nothing that could be PHI.
    expect(JSON.stringify(summary)).not.toContain("Doe");
    expect(JSON.stringify(summary)).not.toContain("MRN-001");
  });

  it("escapeHl7 / isoToHl7Timestamp are deterministic helpers", () => {
    expect(escapeHl7("a^b")).toBe("a\\S\\b");
    expect(isoToHl7Timestamp("2026-08-01T12:00:05.000Z")).toBe("20260801120005");
    expect(isoToHl7Timestamp("not-a-date")).toBe("");
  });
});

// ── Dispatch planner ─────────────────────────────────────────────────────────────────────────────────────
describe("planOutboundDispatch", () => {
  it("W-XI-07: BAA active → a queued outbound row + dispatched audit + the built wire", () => {
    const plan = planOutboundDispatch(dispatchInput());
    expect(plan.kind).toBe("dispatch");
    if (plan.kind !== "dispatch") return;
    expect(plan.row.status).toBe("queued");
    expect(plan.row.messageType).toBe("ORM^O01");
    expect(plan.row.sourceAggregateKind).toBe(ORM_SOURCE_KIND);
    expect(plan.row.sourceAggregateId).toBe("ord_NEW_abc");
    expect(plan.row.retryCount).toBe(0);
    expect(plan.row.idempotencyKey).toBe(
      outboundIdempotencyKey(FEED, ORM_SOURCE_KIND, "ord_NEW_abc"),
    );
    // The sha256 digest matches the wire the worker will envelope-encrypt.
    expect(plan.wire).toContain("ORM^O01");
    expect(plan.audit.kind).toBe("hl7.outbound.dispatched");
    expect(plan.audit.orderRecordId).toBe("ord_NEW_abc");
    // §3.6 — the draft carries NO payload_cipher (the worker encrypts at persist).
    expect("payloadCipher" in plan.row).toBe(false);
  });

  it("W-XI-08: expired BAA refuses PRE-PERSIST (no row), audits baa_refuse, alerts compliance HIGH", () => {
    const plan = planOutboundDispatch(
      dispatchInput({ baa: { allowed: false, reason: "expired_baa", status: "expired" } }),
    );
    expect(plan.kind).toBe("baa_refused");
    if (plan.kind !== "baa_refused") return;
    expect(plan.reason).toBe("expired_baa");
    expect(plan.audit.kind).toBe("hl7.outbound.baa_refuse");
    expect(plan.audit.outboundMessageId).toBeNull();
    expect(plan.alert).toMatchObject({
      severity: "HIGH",
      channel: "compliance",
      kind: "external_feed.baa_expired",
    });
  });

  it("a missing BAA refuses with the missing alert variant", () => {
    const plan = planOutboundDispatch(
      dispatchInput({ baa: { allowed: false, reason: "missing_baa", status: "missing" } }),
    );
    expect(plan.kind).toBe("baa_refused");
    if (plan.kind !== "baa_refused") return;
    expect(plan.alert.kind).toBe("external_feed.baa_missing");
  });

  it("the idempotency key is stable across two dispatches of the same order (permanent dedup)", () => {
    const a = planOutboundDispatch(
      dispatchInput({ outboundMessageId: "hmo_1", messageControlId: "c1" }),
    );
    const b = planOutboundDispatch(
      dispatchInput({ outboundMessageId: "hmo_2", messageControlId: "c2" }),
    );
    if (a.kind !== "dispatch" || b.kind !== "dispatch") throw new Error("expected dispatch");
    expect(a.row.idempotencyKey).toBe(b.row.idempotencyKey);
  });
});

// ── ACK correlation ──────────────────────────────────────────────────────────────────────────────────────
describe("parseAckMsa", () => {
  it("reads MSA-1 code, MSA-2 control id, and MSA-3 text", () => {
    const ack = parseAckMsa(
      "MSH|^~\\&|LAB|QUEST|WARDENX|ENGRACE|20260801120010||ACK|A1|P|2.5.1\rMSA|AA|MSH10-1",
    );
    expect(ack).toEqual({ ackCode: "AA", messageControlId: "MSH10-1", text: "" });
  });

  it("returns null when there is no MSA segment", () => {
    expect(
      parseAckMsa("MSH|^~\\&|LAB|QUEST|WARDENX|ENGRACE|20260801120010||ACK|A1|P|2.5.1"),
    ).toBeNull();
  });

  it("captures the MSA-3 reject text on an AR", () => {
    const ack = parseAckMsa(
      "MSH|^~\\&|LAB|Q|W|E|20260801||ACK|A|P|2.5.1\rMSA|AR|MSH10-1|unknown patient",
    );
    expect(ack).toMatchObject({ ackCode: "AR", text: "unknown patient" });
  });
});

describe("correlateAck", () => {
  const outbound: CorrelatedOutboundRow = {
    id: "hmo_1",
    feedId: FEED,
    organizationId: ORG,
    sourceAggregateId: "ord_NEW_abc",
    retryCount: 1,
  };
  const at = new Date("2026-08-01T12:00:10.000Z");

  it("W-XI-07: AA → acked + transmitted event + transmittedAt set", () => {
    const r = correlateAck({
      ack: { ackCode: "AA", messageControlId: "MSH10-1", text: "" },
      outbound,
      ackReceivedAt: at,
      ackPayloadSha256: "sha_ack",
    });
    expect(r.kind).toBe("acked");
    if (r.kind !== "acked") return;
    expect(r.statusUpdate.status).toBe("acked");
    expect(r.statusUpdate.transmittedAt).toEqual(at);
    expect(r.event.name).toBe("m29.lab_order.transmitted");
    expect(r.event.payload).toMatchObject({ orderId: "ord_NEW_abc", messageControlId: "MSH10-1" });
    expect(r.audit.kind).toBe("hl7.outbound.acked");
  });

  it("AR → naked, NO transmittedAt, transmission_failed(application_reject), operator HIGH alert, no retry", () => {
    const r = correlateAck({
      ack: { ackCode: "AR", messageControlId: "MSH10-1", text: "unknown patient" },
      outbound,
      ackReceivedAt: at,
      ackPayloadSha256: "sha_ack",
    });
    expect(r.kind).toBe("rejected");
    if (r.kind !== "rejected") return;
    expect(r.statusUpdate.status).toBe("naked");
    expect(r.statusUpdate.transmittedAt).toBeNull();
    expect(r.event.payload).toMatchObject({
      reason: "application_reject",
      detail: "unknown patient",
      attemptCount: 1,
    });
    expect(r.alert).toMatchObject({ severity: "HIGH", channel: "operator-on-call" });
  });

  it("AE → transport_error handed to the retry policy (no state change here)", () => {
    const r = correlateAck({
      ack: { ackCode: "AE", messageControlId: "MSH10-1", text: "queue full" },
      outbound,
      ackReceivedAt: at,
      ackPayloadSha256: "sha_ack",
    });
    expect(r.kind).toBe("transport_error");
    if (r.kind !== "transport_error") return;
    expect(r.detail).toBe("queue full");
  });

  it("an ACK with no correlating row → orphan, discarded (§4.12.2)", () => {
    const r = correlateAck({
      ack: { ackCode: "AA", messageControlId: "MSH10-unknown", text: "" },
      outbound: null,
      ackReceivedAt: at,
      ackPayloadSha256: "sha_ack",
    });
    expect(r.kind).toBe("orphan");
    if (r.kind !== "orphan") return;
    expect(r.audit.kind).toBe("hl7.outbound.orphan_ack");
    expect(r.audit.messageControlId).toBe("MSH10-unknown");
  });
});

// ── Retry / DLQ policy ───────────────────────────────────────────────────────────────────────────────────
describe("decideRetry", () => {
  const now = new Date("2026-08-01T12:00:00.000Z");
  const row = { id: "hmo_1", feedId: FEED, organizationId: ORG, sourceAggregateId: "ord_NEW_abc" };

  it("schedules exponential backoff for attempts below the budget", () => {
    for (let retryCount = 0; retryCount < OUTBOUND_MAX_ATTEMPTS - 1; retryCount++) {
      const d = decideRetry({
        outbound: { ...row, retryCount },
        now,
        lastError: "tls_handshake_failed",
      });
      expect(d.kind).toBe("retry");
      if (d.kind !== "retry") return;
      expect(d.statusUpdate.status).toBe("queued");
      expect(d.statusUpdate.retryCount).toBe(retryCount + 1);
      expect(d.statusUpdate.nextRetryAt).toEqual(
        new Date(now.getTime() + OUTBOUND_BACKOFF_MS[retryCount]!),
      );
    }
  });

  it("W-XI-09: the fifth attempt DLQs + emits transmission_failed(dlq_exhausted) + operator HIGH alert", () => {
    const d = decideRetry({
      outbound: { ...row, retryCount: OUTBOUND_MAX_ATTEMPTS - 1 },
      now,
      lastError: "tls_handshake_failed",
    });
    expect(d.kind).toBe("dlq");
    if (d.kind !== "dlq") return;
    expect(d.statusUpdate.status).toBe("dlq");
    expect(d.statusUpdate.retryCount).toBe(OUTBOUND_MAX_ATTEMPTS);
    expect(d.statusUpdate.nextRetryAt).toBeNull();
    expect(d.event.payload).toMatchObject({
      reason: "dlq_exhausted",
      attemptCount: OUTBOUND_MAX_ATTEMPTS,
    });
    expect(d.alert).toMatchObject({ severity: "HIGH", channel: "operator-on-call" });
    expect(d.audit.kind).toBe("hl7.outbound.dlq");
  });
});
