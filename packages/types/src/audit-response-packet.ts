// @chartwarden/types — the typed render payload M25 hands M22 to render the cover sheet and enclosure index of a filed
// audit response (RAC / UPIC / SMRC / other; hospice ADR/TPE/QIC PRD, milestone 7a-2). M25 builds it at filing from the
// audit request and its frozen manifest (server side; nothing here comes from the request except the filing facts the
// person recorded); M22 validates it at the render boundary so a malformed packet fails the render (retry -> DLQ)
// instead of producing a blank retained record.
//
// Nothing here states what an audit contractor requires: the checklist labels and the deadlines are what the person
// TYPED from the request letter, the authority kind is a label, the channel is a label for how it was sent. The
// enclosure rules are the appeal packet's (active or on hold, the claim's patient, never 42 CFR Part 2). This payload
// only NAMES documents (id, title, date, kind); it never carries their content.
//
// Pure: no db / app import (leaf contract surface). Lives here, not in M22 or M25, because M25 produces it and M22
// consumes it and neither may import the other (ADR-0005).
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The most enclosures one audit response may carry (the same cap as an ADR response and an appeal). */
export const MAX_AUDIT_ENCLOSURES = 50;

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableStr = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

const AuditEnclosure = Type.Object({
  ordinal: Type.Integer({ minimum: 1 }),
  documentId: id,
  /** The live claim of the request the document was validated against. */
  claimId: id,
  title: Type.String({ minLength: 1 }),
  documentDate: isoInstant,
  documentKind: Type.String({ minLength: 1 }),
});
export type AuditEnclosure = Static<typeof AuditEnclosure>;

export const AuditResponsePacketRenderPayload = Type.Object({
  auditRequestId: id,
  /** A label only (rac | upic | smrc | other). */
  authorityKind: Type.String({ minLength: 1 }),
  authorityName: nullableStr,
  requestReference: nullableStr,
  requestDatedOn: nullableStr,
  receivedOn: Type.String({ minLength: 1 }),
  filedAt: isoInstant,
  filedLate: Type.Boolean(),
  filingChannel: Type.String({ minLength: 1 }),
  filingConfirmationRef: Type.String({ minLength: 1 }),
  reviewedAt: isoInstant,
  /** True when the person attested the request letter states no due date. */
  noDeadlineStatedAttested: Type.Boolean(),
  /** Dates as typed from the notice (never computed). */
  deadlines: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1 }),
      dueOn: Type.String({ minLength: 1 }),
      satisfiedOn: nullableStr,
    }),
  ),
  /** The checklist as typed from the request letter. */
  checklist: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1 }),
      state: Type.Union([Type.Literal("ready"), Type.Literal("not_applicable")]),
    }),
  ),
  claims: Type.Array(
    Type.Object({
      claimId: id,
      claimControlNumber: nullableStr,
    }),
  ),
  enclosures: Type.Array(AuditEnclosure, { minItems: 1, maxItems: MAX_AUDIT_ENCLOSURES }),
});
export type AuditResponsePacketRenderPayload = Static<typeof AuditResponsePacketRenderPayload>;

export interface AuditResponsePacketFacts {
  readonly auditRequestId: string;
  readonly authorityKind: string;
  readonly authorityName: string | null;
  readonly requestReference: string | null;
  readonly requestDatedOn: string | null;
  readonly receivedOn: string;
  readonly filedAt: string;
  readonly filedLate: boolean;
  readonly filingChannel: string;
  readonly filingConfirmationRef: string;
  readonly reviewedAt: string;
  readonly noDeadlineStatedAttested: boolean;
  readonly deadlines: AuditResponsePacketRenderPayload["deadlines"];
  readonly checklist: AuditResponsePacketRenderPayload["checklist"];
  readonly claims: AuditResponsePacketRenderPayload["claims"];
  /** In the order the assembler attached them, each with the metadata M25 read from M22. */
  readonly enclosures: readonly Omit<AuditEnclosure, "ordinal">[];
}

/** The first schema violations, as `path: message` strings (empty = valid). */
export function auditResponsePacketViolations(payload: unknown): string[] {
  return [...Value.Errors(AuditResponsePacketRenderPayload, payload)]
    .map((e) => `${e.path || "/"}: ${e.message}`)
    .slice(0, 5);
}

/** Validate at the M22 boundary: returns the typed payload or throws listing what is wrong. */
export function assertAuditResponsePacketRenderPayload(
  payload: unknown,
): AuditResponsePacketRenderPayload {
  const violations = auditResponsePacketViolations(payload);
  if (violations.length > 0)
    throw new Error(`invalid AuditResponsePacketRenderPayload: ${violations.join("; ")}`);
  return payload as AuditResponsePacketRenderPayload;
}

/** Pure: assemble the payload from the facts M25 holds. Throws if the result is not a valid packet. */
export function buildAuditResponsePacketRenderPayload(
  facts: AuditResponsePacketFacts,
): AuditResponsePacketRenderPayload {
  return assertAuditResponsePacketRenderPayload({
    ...facts,
    enclosures: facts.enclosures.map((e, i) => ({ ordinal: i + 1, ...e })),
  });
}
