/** Claim.MD /services/response/ is a normalized API feed, not an X12 acknowledgment. */
export const CLAIMMD_STATUS_INTERPRETER_VERSION = "bil1.3.v1";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const field = (value: RecordValue, key: string): string | null =>
  typeof value[key] === "string" && value[key].trim() ? value[key].trim() : null;

export interface CapturedClaimMdMessage {
  readonly eventId: string;
  readonly responseId: string | null;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly capturedAt: Date;
  readonly parent: unknown;
  readonly message: unknown;
}

export interface ClaimMdStatusInterpretation {
  readonly sourceRepresentation: "claimmd_normalized_api";
  readonly version: typeof CLAIMMD_STATUS_INTERPRETER_VERSION;
  readonly eventId: string;
  readonly responseId: string | null;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly capturedAt: Date;
  readonly vendorClaimId: string | null;
  readonly remoteClaimId: string | null;
  readonly claimMdClaimId: string | null;
  readonly senderId: string | null;
  readonly senderName: string | null;
  readonly messageCode: string | null;
  readonly parentStatus: string | null;
  readonly messageStatus: string | null;
  /** The protected inbox retains message text; this safe model carries no free text. */
  readonly responseTime: string | null;
  readonly stage: "clearinghouse" | "unverified_external" | "unknown";
  readonly meaning: "clearinghouse_receipt" | "informational" | "unknown";
  readonly proposedAction: "record_clearinghouse_receipt" | null;
  readonly authority: "documented_example" | "none";
  readonly reasonCode: "DOCUMENTED_CLAIMMD_ACK" | "UNVERIFIED_SENDER_OR_STATUS" | "MALFORMED_MESSAGE";
}

/**
 * Only the narrow CLMMD / ACK / A combination shown in the official API example
 * proposes a clearinghouse receipt. Payer-stage and rejected-like values require
 * independently verified transaction semantics before they can change claim state.
 */
export function interpretClaimMdStatus(input: CapturedClaimMdMessage): ClaimMdStatusInterpretation {
  const parent = record(input.parent) ? input.parent : null;
  const message = record(input.message) ? input.message : null;
  const senderId = parent ? field(parent, "senderid") : null;
  const parentStatus = parent ? field(parent, "status") : null;
  const messageStatus = message ? field(message, "status") : null;
  const messageCode = message ? field(message, "mesgid") : null;
  const validIdentity = message && input.responseId !== null && field(message, "responseid") === input.responseId;
  const receipt = validIdentity && senderId === "CLMMD" && messageCode === "ACK" &&
    parentStatus === "A" && messageStatus === "A";
  return {
    sourceRepresentation: "claimmd_normalized_api", version: CLAIMMD_STATUS_INTERPRETER_VERSION,
    eventId: input.eventId, responseId: input.responseId, accountReference: input.accountReference,
    usage: input.usage, capturedAt: input.capturedAt,
    vendorClaimId: parent ? field(parent, "claimid") : null,
    remoteClaimId: parent ? field(parent, "remote_claimid") : null,
    claimMdClaimId: parent ? field(parent, "claimmd_id") : null,
    senderId, senderName: parent ? field(parent, "sender_name") : null,
    messageCode, parentStatus, messageStatus, responseTime: parent ? field(parent, "response_time") : null,
    stage: senderId === "CLMMD" ? "clearinghouse" : senderId ? "unverified_external" : "unknown",
    meaning: receipt ? "clearinghouse_receipt" : message ? "informational" : "unknown",
    proposedAction: receipt ? "record_clearinghouse_receipt" : null,
    authority: receipt ? "documented_example" : "none",
    reasonCode: receipt ? "DOCUMENTED_CLAIMMD_ACK" : message ? "UNVERIFIED_SENDER_OR_STATUS" : "MALFORMED_MESSAGE",
  };
}
