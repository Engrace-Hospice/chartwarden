// @wardenx/types — the typed render payload M25 hands M22 to render the cover sheet and enclosure index of a
// filed ADR response (hospice ADR/TPE/QIC PRD, milestone 2b). M25 builds it at filing from the case and its
// frozen manifest (server side; nothing here comes from the request except the filing facts the person recorded);
// M22 validates it at the render boundary so a malformed packet fails the render (retry -> DLQ) instead of
// producing a blank retained record.
//
// The enclosure rules are the appeal packet's (`appealEnclosureRefusal`): active or on hold, the claim's patient,
// never 42 CFR Part 2. This payload only NAMES documents (id, title, date, kind); it never carries their content.
//
// Pure: no db / app import (leaf contract surface). Lives here, not in M22 or M25, because M25 produces it and M22
// consumes it and neither may import the other (ADR-0005).
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** The most enclosures one ADR response may carry (a MAC portal / fax packet has a hard ceiling). */
export const MAX_ADR_ENCLOSURES = 100;

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const nullableStr = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

const AdrEnclosure = Type.Object({
  ordinal: Type.Integer({ minimum: 1 }),
  documentId: id,
  title: Type.String({ minLength: 1 }),
  documentDate: isoInstant,
  documentKind: Type.String({ minLength: 1 }),
  /** The checklist item the document answers, when the assembler tagged one. */
  checklistKey: nullableStr,
});
export type AdrEnclosure = Static<typeof AdrEnclosure>;

export const AdrPacketRenderPayload = Type.Object({
  adrCaseId: id,
  claimId: id,
  macName: Type.String({ minLength: 1 }),
  reviewType: Type.Union([Type.Literal("adr"), Type.Literal("re_adr")]),
  adrReference: nullableStr,
  /** The date on the ADR letter, and the response due date derived from it (ISO instant, provider zone). */
  requestedOn: Type.String({ minLength: 1 }),
  responseDueAt: isoInstant,
  filedAt: isoInstant,
  filedLate: Type.Boolean(),
  filingChannel: Type.String({ minLength: 1 }),
  filingConfirmationRef: Type.String({ minLength: 1 }),
  reviewedAt: isoInstant,
  checklist: Type.Array(
    Type.Object({
      key: Type.String({ minLength: 1 }),
      state: Type.Union([Type.Literal("ready"), Type.Literal("not_applicable")]),
    }),
  ),
  enclosures: Type.Array(AdrEnclosure, { minItems: 1, maxItems: MAX_ADR_ENCLOSURES }),
});
export type AdrPacketRenderPayload = Static<typeof AdrPacketRenderPayload>;

export interface AdrPacketFacts {
  readonly adrCaseId: string;
  readonly claimId: string;
  readonly macName: string;
  readonly reviewType: "adr" | "re_adr";
  readonly adrReference: string | null;
  readonly requestedOn: string;
  readonly responseDueAt: string;
  readonly filedAt: string;
  readonly filedLate: boolean;
  readonly filingChannel: string;
  readonly filingConfirmationRef: string;
  readonly reviewedAt: string;
  readonly checklist: readonly {
    readonly key: string;
    readonly state: "ready" | "not_applicable";
  }[];
  /** In the order the assembler attached them, each with the metadata M25 read from M22. */
  readonly enclosures: readonly Omit<AdrEnclosure, "ordinal">[];
}

/** The first schema violations, as `path: message` strings (empty = valid). */
export function adrPacketViolations(payload: unknown): string[] {
  return [...Value.Errors(AdrPacketRenderPayload, payload)]
    .map((e) => `${e.path || "/"}: ${e.message}`)
    .slice(0, 5);
}

/** Validate at the M22 boundary: returns the typed payload or throws listing what is wrong. */
export function assertAdrPacketRenderPayload(payload: unknown): AdrPacketRenderPayload {
  const violations = adrPacketViolations(payload);
  if (violations.length > 0)
    throw new Error(`invalid AdrPacketRenderPayload: ${violations.join("; ")}`);
  return payload as AdrPacketRenderPayload;
}

/** Pure: assemble the payload from the facts M25 holds. Throws if the result is not a valid packet. */
export function buildAdrPacketRenderPayload(facts: AdrPacketFacts): AdrPacketRenderPayload {
  return assertAdrPacketRenderPayload({
    ...facts,
    checklist: facts.checklist.map((c) => ({ key: c.key, state: c.state })),
    enclosures: facts.enclosures.map((e, i) => ({ ordinal: i + 1, ...e })),
  });
}
