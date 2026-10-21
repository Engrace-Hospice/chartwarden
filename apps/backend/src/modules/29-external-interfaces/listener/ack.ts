// apps/backend/src/modules/29-external-interfaces/listener — MLLP ACK/NAK construction (M29-T03, §2.2). PURE.
//
// HL7 v2.5.1 application-acknowledgment semantics (§2.2): `AA` (Application Accept) on a parsed message,
// `AE` (Application Error) on a malformed one, `AR` (Application Reject) on a sender-allowlist violation.
// The ACK is an `ACK` message = an MSH segment (roles reversed: our receiving app/facility become the ACK's
// sending app/facility, and vice-versa) + an MSA segment carrying the ack code and the ORIGINAL message
// control id (so the sender's MLLP library correlates the ACK to its outstanding frame). `AE`/`AR` add an
// optional human-readable MSA-3 text.
//
// IO-free: the ACK datetime (MSH-7) and the ACK's own control id (MSH-10) are INJECTED — never a clock or a
// uuid call inside a pure builder — so the emitter is fully deterministic under test.
import type { Hl7OutboundAckStatus } from "@chartwarden/types";
import { type MshEnvelope, encodeMllpFrame } from "./mllp-framing";

/** Map an ack disposition to its HL7 MSA-1 code. `timeout` never produces an ACK we send (it is the
 *  SENDER's view of our silence) so it has no code here. */
const ACK_CODE: Record<Exclude<Hl7OutboundAckStatus, "timeout">, string> = {
  aa: "AA",
  ae: "AE",
  ar: "AR",
};

/** The disposition of an ACK we emit in response to an inbound frame (§2.2). */
export type InboundAckDisposition = Exclude<Hl7OutboundAckStatus, "timeout">;

export interface BuildAckInput {
  /** The disposition — `aa` parsed / `ae` malformed / `ar` allowlist-rejected. */
  readonly disposition: InboundAckDisposition;
  /** The inbound frame's parsed MSH envelope (roles are reversed into the ACK's MSH). */
  readonly inbound: Pick<
    MshEnvelope,
    | "messageControlId"
    | "sendingApplication"
    | "sendingFacility"
    | "receivingApplication"
    | "receivingFacility"
  >;
  /** The ACK's own MSH-10 control id (INJECTED — a uuid/ulid the caller minted). */
  readonly ackControlId: string;
  /** The ACK's MSH-7 datetime as an HL7 timestamp `YYYYMMDDHHMMSS` (INJECTED — no clock in a pure builder). */
  readonly ackTimestamp: string;
  /** Optional MSA-3 text for `AE`/`AR` (e.g. the parser diagnostic or the allowlist-reject reason). */
  readonly text?: string;
}

/**
 * Build an HL7 `ACK` message (segments joined by `\r`, per HL7 segment delimiting). The MSH echoes the
 * inbound message's RECEIVING app/facility as the ACK's SENDING app/facility (we were the receiver) and the
 * inbound SENDING app/facility as the ACK's RECEIVING app/facility (the ACK goes back to the sender).
 */
export function buildAckMessage(input: BuildAckInput): string {
  const code = ACK_CODE[input.disposition];
  const { inbound } = input;
  // MSH-3..MSH-6 with roles reversed; MSH-9 = ACK; MSH-10 = ackControlId; MSH-11 = P (production); MSH-12 = 2.5.1.
  const msh = [
    "MSH",
    "^~\\&",
    inbound.receivingApplication,
    inbound.receivingFacility,
    inbound.sendingApplication,
    inbound.sendingFacility,
    input.ackTimestamp,
    "",
    "ACK",
    input.ackControlId,
    "P",
    "2.5.1",
  ].join("|");
  // MSA-1 = ack code, MSA-2 = original inbound control id, MSA-3 = optional text.
  const msa = ["MSA", code, inbound.messageControlId, input.text ?? ""]
    .join("|")
    .replace(/\|+$/, "");
  return `${msh}\r${msa}`;
}

/** Build the MLLP-framed ACK bytes ready to write to the socket (`<VT> … <FS><CR>`). */
export function buildAckFrame(input: BuildAckInput): Buffer {
  return encodeMllpFrame(buildAckMessage(input));
}
