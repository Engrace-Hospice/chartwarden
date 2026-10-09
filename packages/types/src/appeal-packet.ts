// @wardenx/types — the typed render payload M25 hands M22 to render a tier-specific appeal packet (M25 spec
// section 1.1 "The appeal packet"; GAP-036). M25 builds it at submit from the appeal case + its denial (server
// side — nothing here is trusted from the client except the clinician's own narrative and the document ids it
// chose to attach); M22 validates it at the render boundary before it draws a letter that goes to a MAC / QIC /
// ALJ, so a malformed packet fails the render (retry -> DLQ) instead of producing a blank filing.
//
// Pure: no db / app import (leaf contract surface, like the rest of this package). Lives in the leaf types package
// (not @wardenx/forms) because M25 produces it and M22 consumes it - neither may import the other (ADR-0005).
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const APPEAL_TIERS = [
  "redetermination",
  "reconsideration",
  "alj",
  "council",
  "federal_court",
] as const;
export type AppealTier = (typeof APPEAL_TIERS)[number];

/** The letter's title and addressee per Medicare appeal level (42 CFR part 405 subpart I). */
export const APPEAL_TIER_LETTERS: Readonly<
  Record<AppealTier, { readonly title: string; readonly addressee: string }>
> = {
  redetermination: {
    title: "Request for Redetermination",
    addressee: "Medicare Administrative Contractor (MAC)",
  },
  reconsideration: {
    title: "Request for Reconsideration",
    addressee: "Qualified Independent Contractor (QIC)",
  },
  alj: {
    title: "Request for Administrative Law Judge (ALJ) Hearing",
    addressee: "Office of Medicare Hearings and Appeals (OMHA)",
  },
  council: {
    title: "Request for Review by the Medicare Appeals Council",
    addressee: "Medicare Appeals Council, Departmental Appeals Board",
  },
  federal_court: {
    title: "Notice of Intent to Seek Federal District Court Review",
    addressee: "Medicare Appeals Council / U.S. District Court",
  },
};

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });

export const AppealPacketRenderPayload = Type.Object({
  appealCaseId: id,
  denialCaseId: id,
  claimId: id,
  tier: Type.Union(APPEAL_TIERS.map((t) => Type.Literal(t))),
  /** The tier-specific letter heading (derived from `tier`, carried so the render needs no lookup). */
  tierLetterTitle: Type.String({ minLength: 1 }),
  /** Who the letter is addressed to at this tier. */
  addressee: Type.String({ minLength: 1 }),
  tierDeadlineAt: isoInstant,
  submittedAt: isoInstant,
  /** The statement of the appeal as the biller wrote it — the body of the letter. */
  appealNarrative: Type.String({ minLength: 1 }),
  /** A CMS good-cause late filing (42 CFR 405.942(b)); the justification is then required. */
  lateGoodCauseFiling: Type.Optional(Type.Boolean()),
  goodCauseJustification: Type.Optional(Type.String({ minLength: 1 })),
  denial: Type.Object({
    carcCode: Type.String({ minLength: 1 }),
    rarcCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    dollarValue: Type.String({ minLength: 1 }),
  }),
  /** The index of attached supporting documents, in the order the biller attached them. */
  supportingDocuments: Type.Array(
    Type.Object({ ordinal: Type.Integer({ minimum: 1 }), documentId: id }),
  ),
  /** Reference to the signed claim copy (the M23 claim). */
  signedClaimCopyRef: Type.Object({ claimId: id }),
  /** Reference to the remittance (835) line the denial came from; null for a pre-835 (277CA / EVV) denial. */
  remitCopyRef: Type.Object({ remittanceLineId: Type.Union([id, Type.Null()]) }),
  /** Reference to the medical-records bundle, when one has been assembled for this claim. */
  medicalRecordsBundleRef: Type.Optional(Type.Object({ documentId: id })),
  macReferenceNumbers: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type AppealPacketRenderPayload = Static<typeof AppealPacketRenderPayload>;

export interface AppealPacketFacts {
  readonly appealCaseId: string;
  readonly denialCaseId: string;
  readonly claimId: string;
  readonly tier: AppealTier;
  readonly tierDeadlineAt: string;
  readonly submittedAt: string;
  readonly appealNarrative: string;
  readonly attachedDocumentIds: readonly string[];
  readonly denial: {
    readonly carcCode: string;
    readonly rarcCode: string | null;
    readonly dollarValue: string;
    readonly remittanceLineId: string | null;
  };
  readonly lateGoodCause?: { readonly justification: string };
  readonly medicalRecordsBundleDocumentId?: string;
}

/** Pure: assemble the packet payload from the facts M25 holds. Throws if the result is not a valid packet. */
export function buildAppealPacketRenderPayload(
  facts: AppealPacketFacts,
): AppealPacketRenderPayload {
  const letter = APPEAL_TIER_LETTERS[facts.tier];
  const payload: AppealPacketRenderPayload = {
    appealCaseId: facts.appealCaseId,
    denialCaseId: facts.denialCaseId,
    claimId: facts.claimId,
    tier: facts.tier,
    tierLetterTitle: letter.title,
    addressee: letter.addressee,
    tierDeadlineAt: facts.tierDeadlineAt,
    submittedAt: facts.submittedAt,
    appealNarrative: facts.appealNarrative,
    ...(facts.lateGoodCause
      ? { lateGoodCauseFiling: true, goodCauseJustification: facts.lateGoodCause.justification }
      : {}),
    denial: {
      carcCode: facts.denial.carcCode,
      rarcCode: facts.denial.rarcCode,
      dollarValue: facts.denial.dollarValue,
    },
    supportingDocuments: facts.attachedDocumentIds.map((documentId, i) => ({
      ordinal: i + 1,
      documentId,
    })),
    signedClaimCopyRef: { claimId: facts.claimId },
    remitCopyRef: { remittanceLineId: facts.denial.remittanceLineId },
    ...(facts.medicalRecordsBundleDocumentId
      ? { medicalRecordsBundleRef: { documentId: facts.medicalRecordsBundleDocumentId } }
      : {}),
  };
  return assertAppealPacketRenderPayload(payload);
}

/** The first schema violations, as `path: message` strings (empty = valid). */
export function appealPacketViolations(payload: unknown): string[] {
  const errors = [...Value.Errors(AppealPacketRenderPayload, payload)].map(
    (e) => `${e.path || "/"}: ${e.message}`,
  );
  if (errors.length === 0) {
    const p = payload as AppealPacketRenderPayload;
    if (p.lateGoodCauseFiling === true && !p.goodCauseJustification)
      errors.push("/goodCauseJustification: required for a late good-cause filing");
  }
  return errors.slice(0, 5);
}

/** Validate at the M22 boundary: returns the typed payload or throws listing what is wrong. */
export function assertAppealPacketRenderPayload(payload: unknown): AppealPacketRenderPayload {
  const violations = appealPacketViolations(payload);
  if (violations.length > 0)
    throw new Error(`invalid AppealPacketRenderPayload: ${violations.join("; ")}`);
  return payload as AppealPacketRenderPayload;
}
