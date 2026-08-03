// apps/backend/src/modules/29-external-interfaces/listener — per-connection MLLP frame handling (M29-T03,
// §4.11.3). Orchestration over an abstract socket + an injected ingest sink, so the framing → allowlist →
// idempotency → ACK flow is unit-testable with a fake socket (the real `tls.Socket` wiring is in
// `listener/index.ts`).
//
// §4.11.3 PER FRAME:
//   1. Buffer bytes until a full `<VT> … <FS><CR>` frame (or the 60s read timeout closes the socket).
//   2. Pre-parse the MSH envelope (control id, message type, sending facility) — regex-light, fail-fast.
//   3. Sender allowlist (§4.11.2): the frame's MSH-4 sending facility must be in the feed's allowlist, else
//      `AR` NAK + the ingest records `parse_status='rejected'`. (The schema's `sending_facility_allowlist`
//      is the authoritative sender gate — the spec §4.11.2 CIDR sketch has no schema column; arch wins.)
//   4. Idempotency (D14): `(feed_id, message_control_id)` already seen → `AA` with the original control id,
//      no re-enqueue (the sender's MLLP re-send after an ACK-window timeout dedupes here).
//   5. Hand the frame to the ingest sink (persist-after-redact + enqueue parse — T04/T05 own that), which
//      returns the disposition; emit the MLLP-framed ACK only after the sink resolves (§4.11.3 step 6:
//      `AA` only after COMMIT).
//
// A malformed MSH (`MllpMshParseError`) → `AE`. A framing error (`MllpFramingError`) → close the socket
// (the stream is out of MLLP sync; no ACK is meaningful).
import {
  MllpFrameBuffer,
  MllpFramingError,
  MllpMshParseError,
  type MshEnvelope,
  parseMshEnvelope,
  sha256Hex,
} from "./mllp-framing";
import { type InboundAckDisposition, buildAckFrame } from "./ack";
import type { SupervisorFeedDescriptor } from "./supervisor";

/** The minimal socket surface the handler drives — satisfied by a `tls.Socket` and by a test fake. */
export interface MllpSocket {
  readonly remoteAddress?: string | undefined;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "close" | "error" | "timeout" | "end", listener: () => void): void;
  write(data: Buffer): void;
  destroy(): void;
  setTimeout(ms: number): void;
}

/** The ingest sink (implemented by T04/T05): persist-after-redact + enqueue the parse job; returns the
 *  disposition the listener ACKs (`aa` parsed-ok, `ae` on a durable-write failure). */
export interface MllpIngestSink {
  /** True when `(feedId, messageControlId)` was already received (permanent D14 dedup). */
  isDuplicate(input: { feedId: string; messageControlId: string }): Promise<boolean>;
  /** Persist (after redaction) + enqueue parse. Resolves to `aa` on success, `ae` on durable-write failure. */
  ingest(input: {
    feed: SupervisorFeedDescriptor;
    envelope: MshEnvelope;
    payload: string;
    sha256: string;
  }): Promise<InboundAckDisposition>;
  /** Record a sender-allowlist rejection (`parse_status='rejected'`) for the audit/disclosure record. */
  recordRejected(input: {
    feed: SupervisorFeedDescriptor;
    envelope: MshEnvelope;
    payload: string;
    sha256: string;
    reason: string;
  }): Promise<void>;
}

/** The IO-adjacent helpers the handler injects (all deterministic under test). */
export interface MllpConnectionDeps {
  sink: MllpIngestSink;
  /** Mint the ACK's own MSH-10 control id (a uuid/ulid). */
  mintAckControlId(): string;
  /** The decision clock. */
  now(): Date;
  /** Format an HL7 `YYYYMMDDHHMMSS` timestamp for the ACK's MSH-7. */
  hl7Timestamp(at: Date): string;
  /** The per-frame read timeout (§4.11.3 step 1 — 60s default). */
  readTimeoutMs: number;
  log(level: "info" | "warn", event: string, fields: Record<string, unknown>): void;
}

/** §4.11.3 default read timeout — 60s of no complete frame closes the socket. */
export const MLLP_READ_TIMEOUT_MS = 60_000;

/** True when the frame's MSH-4 sending facility is in the feed's allowlist. An EMPTY allowlist accepts none
 *  (fail-closed): an active inbound feed must name its senders (the BAA gate also required them). */
export function isSenderAllowed(feed: SupervisorFeedDescriptor, sendingFacility: string): boolean {
  return feed.sendingFacilityAllowlist.includes(sendingFacility);
}

/**
 * Process ONE fully-framed MLLP payload and return the MLLP-framed ACK bytes to write back. Pure over the
 * injected sink — no socket. Exposed for direct unit testing of the disposition ladder.
 */
export async function processInboundFrame(
  feed: SupervisorFeedDescriptor,
  payload: string,
  deps: MllpConnectionDeps,
): Promise<Buffer> {
  const sha256 = sha256Hex(payload);
  let envelope: MshEnvelope;
  try {
    envelope = parseMshEnvelope(payload);
  } catch (err) {
    if (err instanceof MllpMshParseError) {
      deps.log("warn", "hl7.inbound.msh_parse_error", { feedId: feed.id, message: err.message });
      // No control id to echo — use empty; the sender correlates by connection, not MSA-2, in this case.
      return buildAckFrame({
        disposition: "ae",
        inbound: {
          messageControlId: "",
          sendingApplication: "",
          sendingFacility: "",
          receivingApplication: "",
          receivingFacility: "",
        },
        ackControlId: deps.mintAckControlId(),
        ackTimestamp: deps.hl7Timestamp(deps.now()),
        text: "malformed MSH header",
      });
    }
    throw err;
  }

  const ackBase = {
    inbound: envelope,
    ackControlId: deps.mintAckControlId(),
    ackTimestamp: deps.hl7Timestamp(deps.now()),
  } as const;

  // §4.11.2 sender allowlist — MSH-4 must be named on the feed.
  if (!isSenderAllowed(feed, envelope.sendingFacility)) {
    deps.log("warn", "hl7.listener.allowlist_reject", {
      feedId: feed.id,
      sendingFacility: envelope.sendingFacility,
    });
    await deps.sink.recordRejected({
      feed,
      envelope,
      payload,
      sha256,
      reason: `sending facility '${envelope.sendingFacility}' not in feed allowlist`,
    });
    return buildAckFrame({ disposition: "ar", ...ackBase, text: "sender not allowlisted" });
  }

  // §4.11.3 idempotency (D14) — a re-send after an ACK-window timeout ACKs `AA` without re-enqueue.
  if (await deps.sink.isDuplicate({ feedId: feed.id, messageControlId: envelope.messageControlId })) {
    deps.log("info", "hl7.inbound.duplicate_dropped", {
      feedId: feed.id,
      messageControlId: envelope.messageControlId,
    });
    return buildAckFrame({ disposition: "aa", ...ackBase });
  }

  // Persist-after-redact + enqueue — the sink returns the disposition (AA after COMMIT, AE on write fail).
  const disposition = await deps.sink.ingest({ feed, envelope, payload, sha256 });
  return buildAckFrame({ disposition, ...ackBase });
}

/**
 * Attach the MLLP handler to a live socket (§4.11.3): buffer → drain complete frames → ACK each. A framing
 * error closes the socket; a per-frame processing error is logged and the socket closed (the sender re-sends,
 * and D14 dedupes the re-send once the transient clears).
 */
export function handleMllpConnection(
  socket: MllpSocket,
  feed: SupervisorFeedDescriptor,
  deps: MllpConnectionDeps,
): void {
  const buffer = new MllpFrameBuffer();
  socket.setTimeout(deps.readTimeoutMs);
  socket.on("timeout", () => {
    deps.log("warn", "hl7.listener.read_timeout", { feedId: feed.id, pending: buffer.pendingBytes });
    socket.destroy();
  });
  socket.on("data", (chunk: Buffer) => {
    void (async () => {
      let frames: string[];
      try {
        buffer.append(chunk);
        frames = buffer.drain();
      } catch (err) {
        if (err instanceof MllpFramingError) {
          deps.log("warn", "hl7.listener.framing_error", { feedId: feed.id, message: err.message });
          socket.destroy();
          return;
        }
        throw err;
      }
      for (const payload of frames) {
        try {
          const ack = await processInboundFrame(feed, payload, deps);
          socket.write(ack);
        } catch (err) {
          deps.log("warn", "hl7.inbound.ingest_error", {
            feedId: feed.id,
            message: err instanceof Error ? err.message : String(err),
          });
          socket.destroy();
          return;
        }
      }
    })();
  });
}
