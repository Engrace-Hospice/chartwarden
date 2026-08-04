// apps/backend/src/modules/29-external-interfaces/__tests__ — M29-T03 MLLP listener lifecycle unit tests
// (§4.11: framing, MSH pre-parse, ACK/NAK, allowlist, idempotency, circuit breaker, supervisor boot).
import { describe, expect, it, vi } from "vitest";

import type { ExternalInterfaceBaaResult } from "../feed/baa-gate";
import { buildAckMessage } from "../listener/ack";
import {
  LISTENER_DOWN_THRESHOLD_FLOOR_MS,
  evaluateListenerCircuit,
} from "../listener/circuit-breaker";
import {
  type MllpConnectionDeps,
  type MllpIngestSink,
  isSenderAllowed,
  processInboundFrame,
} from "../listener/connection";
import {
  MLLP_CR,
  MLLP_FS,
  MLLP_VT,
  MllpFrameBuffer,
  MllpFramingError,
  MllpMshParseError,
  encodeMllpFrame,
  parseMshEnvelope,
  sha256Hex,
} from "../listener/mllp-framing";
import {
  type SupervisorDeps,
  type SupervisorFeedDescriptor,
  bootFeedListeners,
  drainAndShutdown,
} from "../listener/supervisor";

const ADT = `MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260802120000||ADT^A01|MSGID123|P|2.5.1\rPID|1||MRN^^^H`;

function frameBytes(payload: string): Buffer {
  return encodeMllpFrame(payload);
}

describe("MLLP framing (§4.11.3)", () => {
  it("wraps + unwraps a single frame", () => {
    const buf = new MllpFrameBuffer();
    buf.append(frameBytes(ADT));
    expect(buf.drain()).toEqual([ADT]);
    expect(buf.pendingBytes).toBe(0);
  });

  it("reassembles a frame split across two TCP chunks", () => {
    const bytes = frameBytes(ADT);
    const buf = new MllpFrameBuffer();
    buf.append(bytes.subarray(0, 10));
    expect(buf.drain()).toEqual([]); // incomplete — nothing yet
    buf.append(bytes.subarray(10));
    expect(buf.drain()).toEqual([ADT]);
  });

  it("splits two frames delivered in one chunk", () => {
    const buf = new MllpFrameBuffer();
    buf.append(
      Buffer.concat([
        frameBytes("MSH|^~\\&|A|B|C|D|T||ADT^A01|M1|P|2.5.1"),
        frameBytes("MSH|^~\\&|A|B|C|D|T||ADT^A01|M2|P|2.5.1"),
      ]),
    );
    const frames = buf.drain();
    expect(frames).toHaveLength(2);
    expect(parseMshEnvelope(frames[0]!).messageControlId).toBe("M1");
    expect(parseMshEnvelope(frames[1]!).messageControlId).toBe("M2");
  });

  it("throws MllpFramingError on bytes with no <VT> start", () => {
    const buf = new MllpFrameBuffer();
    buf.append(Buffer.from("garbage-no-vt"));
    expect(() => buf.drain()).toThrow(MllpFramingError);
  });

  it("throws MllpFramingError when <FS> is not followed by <CR>", () => {
    const buf = new MllpFrameBuffer();
    buf.append(
      Buffer.concat([Buffer.from([MLLP_VT]), Buffer.from("MSH|x"), Buffer.from([MLLP_FS, 0x00])]),
    );
    expect(() => buf.drain()).toThrow(MllpFramingError);
  });

  it("uses the canonical MLLP control bytes", () => {
    expect([MLLP_VT, MLLP_FS, MLLP_CR]).toEqual([0x0b, 0x1c, 0x0d]);
  });
});

describe("MSH pre-parse (§4.11.3 step 2)", () => {
  it("extracts control id, message type, and sending facility", () => {
    const env = parseMshEnvelope(ADT);
    expect(env.messageControlId).toBe("MSGID123");
    expect(env.messageCode).toBe("ADT");
    expect(env.triggerEvent).toBe("A01");
    expect(env.sendingApplication).toBe("SENDAPP");
    expect(env.sendingFacility).toBe("SENDFAC");
    expect(env.receivingApplication).toBe("RECVAPP");
    expect(env.receivingFacility).toBe("RECVFAC");
  });

  it("throws when the frame does not start with MSH", () => {
    expect(() => parseMshEnvelope("PID|1||x")).toThrow(MllpMshParseError);
  });

  it("throws when MSH-10 is empty", () => {
    expect(() => parseMshEnvelope("MSH|^~\\&|A|B|C|D|T||ADT^A01||P|2.5.1")).toThrow(
      MllpMshParseError,
    );
  });

  it("hashes payloads deterministically", () => {
    expect(sha256Hex(ADT)).toBe(sha256Hex(ADT));
    expect(sha256Hex(ADT)).not.toBe(sha256Hex(`${ADT}x`));
  });
});

describe("ACK construction (§2.2)", () => {
  const inbound = {
    messageControlId: "MSGID123",
    sendingApplication: "SENDAPP",
    sendingFacility: "SENDFAC",
    receivingApplication: "RECVAPP",
    receivingFacility: "RECVFAC",
  };

  it("reverses roles and echoes the original control id in MSA-2 (AA)", () => {
    const ack = buildAckMessage({
      disposition: "aa",
      inbound,
      ackControlId: "ACK1",
      ackTimestamp: "20260802120001",
    });
    const [msh, msa] = ack.split("\r");
    expect(msh).toBe("MSH|^~\\&|RECVAPP|RECVFAC|SENDAPP|SENDFAC|20260802120001||ACK|ACK1|P|2.5.1");
    expect(msa).toBe("MSA|AA|MSGID123");
  });

  it("carries MSA-3 text on AE / AR", () => {
    const ae = buildAckMessage({
      disposition: "ae",
      inbound,
      ackControlId: "ACK1",
      ackTimestamp: "T",
      text: "malformed",
    });
    expect(ae.split("\r")[1]).toBe("MSA|AE|MSGID123|malformed");
    const ar = buildAckMessage({
      disposition: "ar",
      inbound,
      ackControlId: "ACK1",
      ackTimestamp: "T",
      text: "not allowlisted",
    });
    expect(ar.split("\r")[1]).toBe("MSA|AR|MSGID123|not allowlisted");
  });
});

describe("listener-down circuit breaker (§4.11.5 / D17)", () => {
  const base = {
    thresholdMs: LISTENER_DOWN_THRESHOLD_FLOOR_MS,
    inQuietWindow: false,
    nowMs: 10 * 60 * 1000,
  };

  it("stays CLOSED when a frame arrived within the window", () => {
    const d = evaluateListenerCircuit({
      ...base,
      current: "closed",
      lastFrameAtMs: base.nowMs - 60_000,
      probe: { tcpOk: false, tlsOk: false },
    });
    expect(d).toEqual({ state: "closed", transitioned: false, emit: null });
  });

  it("trips OPEN + emits listener_down when silent and the probe fails", () => {
    const d = evaluateListenerCircuit({
      ...base,
      current: "closed",
      lastFrameAtMs: 0, // > 5min ago
      probe: { tcpOk: false, tlsOk: false },
    });
    expect(d).toEqual({
      state: "open",
      transitioned: true,
      emit: "m29.external_feed.listener_down",
    });
  });

  it("does not re-emit while already OPEN", () => {
    const d = evaluateListenerCircuit({
      ...base,
      current: "open",
      lastFrameAtMs: 0,
      probe: { tcpOk: false, tlsOk: false },
    });
    expect(d).toEqual({ state: "open", transitioned: false, emit: null });
  });

  it("goes HALF_OPEN when silent but the probe recovers", () => {
    const d = evaluateListenerCircuit({
      ...base,
      current: "open",
      lastFrameAtMs: 0,
      probe: { tcpOk: true, tlsOk: true },
    });
    expect(d).toEqual({ state: "half_open", transitioned: true, emit: null });
  });

  it("recovers to CLOSED + emits listener_recovered on the next frame after OPEN", () => {
    const d = evaluateListenerCircuit({
      ...base,
      current: "half_open",
      lastFrameAtMs: base.nowMs - 1000,
      probe: { tcpOk: true, tlsOk: true },
    });
    expect(d).toEqual({
      state: "closed",
      transitioned: true,
      emit: "m29.external_feed.listener_recovered",
    });
  });

  it("never alerts inside a declared quiet window", () => {
    const d = evaluateListenerCircuit({
      ...base,
      current: "closed",
      lastFrameAtMs: 0,
      inQuietWindow: true,
      probe: { tcpOk: false, tlsOk: false },
    });
    expect(d).toEqual({ state: "closed", transitioned: false, emit: null });
  });
});

const FEED: SupervisorFeedDescriptor = {
  id: "feed-1",
  organizationId: "org-1",
  kind: "adt_inbound",
  displayName: "Partner ADT",
  port: 25000,
  protocol: "mllp_tls",
  status: "active",
  baaContractRef: "baa-1",
  sendingFacilityAllowlist: ["SENDFAC"],
};

function connDeps(sink: MllpIngestSink): MllpConnectionDeps {
  return {
    sink,
    mintAckControlId: () => "ACKID",
    now: () => new Date("2026-08-02T12:00:01.000Z"),
    hl7Timestamp: () => "20260802120001",
    readTimeoutMs: 60_000,
    log: () => {},
  };
}

describe("processInboundFrame disposition ladder (§4.11.3)", () => {
  it("AA for a fresh, allowlisted, parseable frame + ingests it", async () => {
    const ingest = vi.fn(async () => "aa" as const);
    const sink: MllpIngestSink = {
      isDuplicate: async () => false,
      ingest,
      recordRejected: async () => {},
    };
    const ack = (await processInboundFrame(FEED, ADT, connDeps(sink))).toString("utf8");
    expect(ack).toContain("MSA|AA|MSGID123");
    expect(ingest).toHaveBeenCalledOnce();
  });

  it("AR for a sender not on the feed allowlist + records rejected, no ingest", async () => {
    const ingest = vi.fn(async () => "aa" as const);
    const recordRejected = vi.fn(async () => {});
    const sink: MllpIngestSink = { isDuplicate: async () => false, ingest, recordRejected };
    const otherSender = ADT.replace("SENDFAC", "EVILFAC");
    const ack = (await processInboundFrame(FEED, otherSender, connDeps(sink))).toString("utf8");
    expect(ack).toContain("MSA|AR|MSGID123");
    expect(recordRejected).toHaveBeenCalledOnce();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("AA without re-ingest for a duplicate (D14)", async () => {
    const ingest = vi.fn(async () => "aa" as const);
    const sink: MllpIngestSink = {
      isDuplicate: async () => true,
      ingest,
      recordRejected: async () => {},
    };
    const ack = (await processInboundFrame(FEED, ADT, connDeps(sink))).toString("utf8");
    expect(ack).toContain("MSA|AA|MSGID123");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("AE for a malformed MSH", async () => {
    const sink: MllpIngestSink = {
      isDuplicate: async () => false,
      ingest: async () => "aa",
      recordRejected: async () => {},
    };
    const ack = (await processInboundFrame(FEED, "PID|garbage", connDeps(sink))).toString("utf8");
    expect(ack).toContain("MSA|AE|");
  });

  it("isSenderAllowed fails closed on an empty allowlist", () => {
    expect(isSenderAllowed({ ...FEED, sendingFacilityAllowlist: [] }, "SENDFAC")).toBe(false);
    expect(isSenderAllowed(FEED, "SENDFAC")).toBe(true);
  });
});

describe("supervisor boot + shutdown (§4.11.1 / §4.11.4)", () => {
  function makeDeps(
    feeds: SupervisorFeedDescriptor[],
    baa: ExternalInterfaceBaaResult,
  ): { deps: SupervisorDeps; started: string[]; state: { alerts: number } } {
    const started: string[] = [];
    const state = { alerts: 0 };
    const deps: SupervisorDeps = {
      loadActiveInboundFeeds: async () => feeds,
      loadFeedById: async (id) => feeds.find((f) => f.id === id) ?? null,
      baaGate: {
        baaStatusBySendingFacility: async () => baa,
        baaStatusByMdmEntity: async () => baa,
      },
      registry: {
        start: async (f) => {
          started.push(f.id);
        },
        stop: async (id) => {
          const i = started.indexOf(id);
          if (i >= 0) started.splice(i, 1);
        },
        boundFeedIds: () => [...started],
      },
      dispatchAlert: async () => {
        state.alerts += 1;
      },
      drainInflight: async () => {},
      emitShutdownAudit: async () => {},
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      log: () => {},
    };
    return { deps, started, state };
  }

  const activeBaa: ExternalInterfaceBaaResult = {
    isActive: true,
    status: "executed",
    expiresOn: null,
  };
  const missingBaa: ExternalInterfaceBaaResult = {
    isActive: false,
    status: "missing",
    expiresOn: null,
  };

  it("starts feeds that pass the BAA gate", async () => {
    const h = makeDeps([FEED], activeBaa);
    const summary = await bootFeedListeners(h.deps);
    expect(summary.startedCount).toBe(1);
    expect(h.started).toEqual(["feed-1"]);
  });

  it("skips + alerts a feed whose BAA gate refuses (never binds)", async () => {
    const h = makeDeps([FEED], missingBaa);
    const summary = await bootFeedListeners(h.deps);
    expect(summary.startedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({ started: false, reason: "missing_baa" });
    expect(h.started).toEqual([]);
    expect(h.state.alerts).toBe(1);
  });

  it("skips an outbound feed (no listener binds)", async () => {
    const outbound: SupervisorFeedDescriptor = { ...FEED, id: "feed-out", kind: "orm_outbound" };
    const h = makeDeps([outbound], activeBaa);
    const summary = await bootFeedListeners(h.deps);
    expect(summary.outcomes[0]).toMatchObject({ started: false, reason: "not_inbound" });
    expect(h.started).toEqual([]);
  });

  it("drains + unbinds every bound listener on shutdown", async () => {
    const h = makeDeps([FEED], activeBaa);
    await bootFeedListeners(h.deps);
    const drained = await drainAndShutdown(h.deps);
    expect(drained).toEqual(["feed-1"]);
    expect(h.started).toEqual([]);
  });
});
