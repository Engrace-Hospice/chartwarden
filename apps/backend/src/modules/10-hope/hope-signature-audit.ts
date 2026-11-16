// apps/backend/src/modules/10-hope/hope-signature-audit.ts — R-05: the explicit audit evidence for the two
// places M10 turns a HOPE record into a SIGNED one (`signTimepoint` draft→signed, and `recordSfv`, which
// inserts an already-signed RFA-04). The M4 write-audit trigger records the row diff; this records the
// ceremony around it: that the signer attested, which attestation wording the SERVER held at that moment (its version
// and a SHA-256 of the exact statement text, so the wording can be proven later even after the text changes), whether
// the CLIENT NAMED that version, which step-up operation the route REQUIRED, and who signed.
// The claims are ones this code can stand behind: the service layer refuses a signature without
// `attestationConfirmed === true` (the field is a required `true` literal of the input, so a caller cannot forget the
// check) and refuses an attestation version that is not the current one. `attestationVersion` in the request is
// OPTIONAL, so the row never claims the signer saw the wording: it records the server's current version and hash under
// `serverCurrent*` keys, and `attestationVersionSupplied` says whether the client NAMED a version (when it did, that
// version equals the server's, or the request was refused first). Naming a version proves the string was sent, which a
// script can do; it does not prove a human read the text. The route's `requireStepUp` guard ran before the service (so
// the row names the operation it required, not a freshness the session "proved" — the step-up result itself lives in the
// auth/step-up audit trail).
//
// The row's `correlation_id` is ALWAYS server-generated (`hope-signature:<assessment id>`): the request's own
// `x-correlation-id` is client-suppliable, so it rides in `context.clientCorrelationId` as a trace hint, never as the
// key rows are joined on.
//
// Context is ids and enums only (no PHI). M10's acting id is the MEMBERSHIP id, so it rides in the context; the
// row's `actor_user_id` is the SESSION user the request context carries (as the read-audit rows fill it), and stays
// null for a direct service call that has none. The event type is a free string; M10 has no `m10.*` slice in the M4
// action catalog, and the un-prefixed `hope.*` names follow `hope.late_deadline_override`.
import { createHash } from "node:crypto";
import { type AuditContext, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import {
  HOPE_ATTESTATION_VERSION,
  HOPE_SFV_ATTESTATION_STATEMENT,
  HOPE_SIGN_ATTESTATION_STATEMENT,
  type HopeRfaKind,
} from "@chartwarden/types";

/** The `requireStepUp` operation keys on the two signing routes (also what the audit row names). */
export const HOPE_SIGN_STEP_UP_OPERATION = "hope.timepoint.sign";
export const HOPE_SFV_STEP_UP_OPERATION = "hope.sfv.record";

/** The longest user agent an audit row keeps, in CHARACTERS (code points); a header can be many KB. */
export const AUDIT_USER_AGENT_MAX_LENGTH = 256;

/**
 * Control (Cc) and format (Cf: zero-width, bidi overrides, byte-order mark) characters, the two line/paragraph
 * separators (Zl/Zp: U+2028/2029), and the code points that are not text at all: lone surrogates (Cs, which do not
 * survive UTF-8), private-use (Co) and unassigned (Cn) ones. None belong in a stored user agent: a log viewer or a
 * terminal acts on the first group, and the rest render as nothing or as whatever a font substitutes.
 */
const UNSAFE_USER_AGENT_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/gu;

/**
 * A user agent safe to store: unsafe characters removed, then cut at 256 CODE POINTS (an astral character is kept whole
 * or dropped whole, never left as a lone surrogate that would not survive UTF-8). `undefined` when nothing is left.
 */
export function sanitizeUserAgent(raw: string): string | undefined {
  const cleaned = [...raw.replace(UNSAFE_USER_AGENT_CHARS, "")]
    .slice(0, AUDIT_USER_AGENT_MAX_LENGTH)
    .join("");
  return cleaned === "" ? undefined : cleaned;
}

/** SHA-256 (hex) of the statement text the signer attested to, computed from the CURRENT exported constants. */
const statementSha256 = (statement: string): string =>
  createHash("sha256").update(statement, "utf8").digest("hex");

const STATEMENT_OF_EVENT = {
  "hope.timepoint_signed": HOPE_SIGN_ATTESTATION_STATEMENT,
  "hope.sfv_completed": HOPE_SFV_ATTESTATION_STATEMENT,
} as const;

interface HopeSignatureAuditInput {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly eventType: keyof typeof STATEMENT_OF_EVENT;
  readonly assessmentId: string;
  readonly rfaKind: HopeRfaKind;
  readonly version: number;
  /** The `requireStepUp` operation key the route demanded before the service ran. */
  readonly stepUpRequiredOperation: string;
  /**
   * The signer's attestation, which the service has already required (`requireAttestation`). A required `true` literal,
   * so a caller that forgot the check does not compile; it is written to the row as given, never hardcoded here.
   */
  readonly attestationConfirmed: true;
  /** The SFV an RFA-04 completion closed (an id, never content). */
  readonly sfvId?: string;
  /** The HTTP request id (the audit row's own `request_id` column), when the call came through a route. */
  readonly requestId?: string;
  /**
   * The request's correlation id, a TRACE HINT that ties this row to the request's other records. A client can supply
   * it (`x-correlation-id`, accepted when it is a safe short token), so it is stored under `context.clientCorrelationId`
   * and never as the row's `correlation_id`, which is always server-generated.
   */
  readonly correlationId?: string;
  /** The `attestationVersion` the CLIENT sent, when it sent one (it equals the current version, or the call was refused). */
  readonly attestationVersion?: string;
  /** The SESSION user (a uuid) that signed, for the row's `actor_user_id`; absent for a direct service call. */
  readonly actorUserId?: string;
  /** The caller's address and user agent as the request context recorded them (the row's own columns). */
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/** The request facts an M10 audit row records (ids and network facts only, never content). */
export interface HopeAuditRequestFacts {
  readonly requestId?: string;
  /** A client-suppliable trace hint (`x-correlation-id`): stored in the row's context, never as its correlation id. */
  readonly correlationId?: string;
  /** The SESSION user (a uuid) behind the request; M10's own acting id is the membership id. */
  readonly actorUserId?: string;
  readonly sourceIp?: string;
  readonly userAgent?: string;
}

/**
 * The actor of an M10 audit row: the session user when there is one, the request id and address, and a sanitised user
 * agent. `correlationId` is the SERVER-generated one the row is keyed on.
 */
export function hopeAuditActor(
  organizationId: string,
  correlationId: string,
  request: HopeAuditRequestFacts = {},
): AuditContext {
  const userAgent =
    request.userAgent === undefined ? undefined : sanitizeUserAgent(request.userAgent);
  return {
    organizationId,
    userId: request.actorUserId ?? null,
    // Both signing routes refuse an AI principal before the service runs, and a deadline override is a platform admin's.
    actorKind: "user",
    correlationId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    ...(request.sourceIp ? { sourceIp: request.sourceIp } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

/** The client's trace hint as a context entry (absent when the client sent none). */
export const clientCorrelationContext = (
  request: HopeAuditRequestFacts = {},
): { readonly clientCorrelationId?: string } =>
  request.correlationId ? { clientCorrelationId: request.correlationId } : {};

/** Write the signature event on the SAME transaction as the signed row, so they commit or roll back together. */
export async function auditHopeSignature(
  t: DbClient,
  input: HopeSignatureAuditInput,
): Promise<void> {
  await audit(
    t as never,
    hopeAuditActor(input.organizationId, `hope-signature:${input.assessmentId}`, input),
    {
      eventType: input.eventType,
      resourceKind: "hope_assessment",
      resourceId: input.assessmentId,
      outcome: "success",
      context: {
        rfaKind: input.rfaKind,
        // True by construction (a required literal of the input): the service threw M10_ATTESTATION_REQUIRED otherwise.
        attestationConfirmed: input.attestationConfirmed,
        // The wording the SERVER held when it accepted the signature. Whether the CLIENT named that version is the
        // separate `attestationVersionSupplied` (a client that sends none passes the stale check without naming one).
        serverCurrentAttestationVersion: HOPE_ATTESTATION_VERSION,
        serverCurrentAttestationStatementSha256: statementSha256(
          STATEMENT_OF_EVENT[input.eventType],
        ),
        attestationVersionSupplied: input.attestationVersion !== undefined,
        ...(input.attestationVersion !== undefined
          ? { suppliedAttestationVersion: input.attestationVersion }
          : {}),
        stepUpRequiredOperation: input.stepUpRequiredOperation,
        byMembershipId: input.membershipId,
        version: input.version,
        ...(input.sfvId ? { sfvId: input.sfvId } : {}),
        ...clientCorrelationContext(input),
      },
    },
  );
}
