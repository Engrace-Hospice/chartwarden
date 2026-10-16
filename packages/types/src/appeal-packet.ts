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
import type { DocumentDigest } from "./documents";

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

/** The most enclosures one appeal filing may carry (a MAC portal / fax packet has a hard ceiling). */
export const MAX_APPEAL_ENCLOSURES = 50;

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });
const cents = Type.Integer();
const nullableStr = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

/**
 * One enclosure document as the filing lists it: the reference the biller attached PLUS the facts M25 read from
 * M22's `DocumentReader` at submit (title, date, kind) so the letter identifies it in words, not by a short id.
 * Never the document's bytes or contents.
 */
const SupportingDocument = Type.Object({
  ordinal: Type.Integer({ minimum: 1 }),
  documentId: id,
  title: Type.String({ minLength: 1 }),
  /** When the document was created (ISO instant). */
  documentDate: isoInstant,
  /** The document's aggregate type (e.g. `election_statement`), humanized by the renderer. */
  documentKind: Type.String({ minLength: 1 }),
});
export type AppealSupportingDocument = Static<typeof SupportingDocument>;

/**
 * The claim as the MAC received it, read by M25 from M23 at submit (header + lines; no MBI, per M23 D13). An 837I has
 * no wet signature, so this is the as-submitted electronic claim, not a "signed" copy.
 */
export const AppealClaimCopy = Type.Object({
  controlNumber: Type.String({ minLength: 1 }),
  tob: Type.String({ minLength: 1 }),
  state: Type.String({ minLength: 1 }),
  serviceFrom: Type.String({ minLength: 1 }),
  serviceTo: Type.String({ minLength: 1 }),
  totalChargeCents: cents,
  lines: Type.Array(
    Type.Object({
      lineNumber: Type.Integer({ minimum: 1 }),
      revenueCode: Type.String({ minLength: 1 }),
      hcpcsCode: nullableStr,
      serviceFrom: Type.String({ minLength: 1 }),
      serviceTo: Type.String({ minLength: 1 }),
      units: Type.Integer(),
      chargeCents: cents,
    }),
  ),
});
export type AppealClaimCopy = Static<typeof AppealClaimCopy>;

/** The 835 claim payment the denial came from, read by M25 from its own remittance tables (no free text). */
export const AppealRemitCopy = Type.Object({
  remittanceAdviceId: id,
  receivedAt: isoInstant,
  paymentMethod: Type.String({ minLength: 1 }),
  checkOrEftTrace: nullableStr,
  payerIcn: nullableStr,
  claimStatusCode: Type.Integer(),
  chargeCents: cents,
  paidCents: cents,
  patientResponsibilityCents: cents,
  adjustments: Type.Array(
    Type.Object({
      group: Type.String({ minLength: 1 }),
      carc: Type.String({ minLength: 1 }),
      amountCents: cents,
    }),
  ),
  remarks: Type.Array(
    Type.Object({ kind: Type.String({ minLength: 1 }), rarc: Type.String({ minLength: 1 }) }),
  ),
  serviceLines: Type.Array(
    Type.Object({
      revenueCode: nullableStr,
      hcpcsCode: nullableStr,
      chargeCents: cents,
      paidCents: cents,
    }),
  ),
});
export type AppealRemitCopy = Static<typeof AppealRemitCopy>;

/**
 * One piece of documentation the redetermination notice named as missing (milestone 4). It is either enclosed (a
 * `documentId` that appears in `supportingDocuments`) or explained (`notAvailableReason`) - never both blank.
 */
export const AppealCitedEvidence = Type.Object({
  label: Type.String({ minLength: 1 }),
  documentId: nullableStr,
  notAvailableReason: nullableStr,
});
export type AppealCitedEvidence = Static<typeof AppealCitedEvidence>;

/**
 * The CMS request elements specific to a QIC reconsideration (hospice ADR/TPE/QIC PRD, milestone 4): the
 * redetermination MAC and notice, the missing documentation the notice cited, and the preclusion acknowledgement.
 * The beneficiary name and MBI are NOT here (M25 holds no MBI; the letter prints fill-in cells, like the ABN).
 */
export const AppealReconsiderationBlock = Type.Object({
  redeterminationMacName: Type.String({ minLength: 1 }),
  /** The date printed on the redetermination notice (YYYY-MM-DD). */
  redeterminationNoticeDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  /** The enclosed copy of the redetermination notice (must be in `supportingDocuments`). */
  redeterminationNoticeDocumentId: id,
  citedEvidence: Type.Array(AppealCitedEvidence),
  /** The attestation that the redetermination notice named no missing documentation. */
  citedEvidenceNone: Type.Boolean(),
  /** The person acknowledged that evidence left out of this request may be excluded at later levels. */
  evidencePreclusionAcknowledged: Type.Boolean(),
});
export type AppealReconsiderationBlock = Static<typeof AppealReconsiderationBlock>;

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
  supportingDocuments: Type.Array(SupportingDocument),
  /** Reference to the as-submitted claim (the M23 claim). The name predates the as-built wording: an 837I carries
   *  no wet signature, so the letter calls it the as-submitted claim. */
  signedClaimCopyRef: Type.Object({ claimId: id }),
  /** The claim's header and lines, so the filing shows what was billed instead of citing a short id. */
  claimCopy: AppealClaimCopy,
  /** Reference to the remittance (835) line the denial came from; null for a pre-835 (277CA / EVV) denial. */
  remitCopyRef: Type.Object({ remittanceLineId: Type.Union([id, Type.Null()]) }),
  /** The 835 payment detail behind `remitCopyRef`; absent exactly when there is no remittance line. */
  remitCopy: Type.Optional(AppealRemitCopy),
  /** The medical-records bundle the biller attached (an existing M22 document, validated like any enclosure). */
  medicalRecordsBundleRef: Type.Optional(
    Type.Object({
      documentId: id,
      title: Type.String({ minLength: 1 }),
      documentDate: isoInstant,
      documentKind: Type.String({ minLength: 1 }),
    }),
  ),
  macReferenceNumbers: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** Present exactly when `tier` is `reconsideration` (QIC request elements and the cited-evidence table). */
  reconsideration: Type.Optional(AppealReconsiderationBlock),
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
  /** The attached enclosures, in the order the biller chose, each with the metadata M25 read from M22. */
  readonly attachedDocuments: readonly Omit<AppealSupportingDocument, "ordinal">[];
  readonly claimCopy: AppealClaimCopy;
  readonly remitCopy?: AppealRemitCopy;
  readonly denial: {
    readonly carcCode: string;
    readonly rarcCode: string | null;
    readonly dollarValue: string;
    readonly remittanceLineId: string | null;
  };
  readonly lateGoodCause?: { readonly justification: string };
  readonly medicalRecordsBundle?: Omit<AppealSupportingDocument, "ordinal">;
  readonly reconsideration?: AppealReconsiderationBlock;
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
    supportingDocuments: facts.attachedDocuments.map((doc, i) => ({ ordinal: i + 1, ...doc })),
    signedClaimCopyRef: { claimId: facts.claimId },
    claimCopy: facts.claimCopy,
    remitCopyRef: { remittanceLineId: facts.denial.remittanceLineId },
    ...(facts.remitCopy ? { remitCopy: facts.remitCopy } : {}),
    ...(facts.medicalRecordsBundle
      ? {
          medicalRecordsBundleRef: {
            documentId: facts.medicalRecordsBundle.documentId,
            title: facts.medicalRecordsBundle.title,
            documentDate: facts.medicalRecordsBundle.documentDate,
            documentKind: facts.medicalRecordsBundle.documentKind,
          },
        }
      : {}),
    ...(facts.reconsideration ? { reconsideration: facts.reconsideration } : {}),
  };
  return assertAppealPacketRenderPayload(payload);
}

/** Why a document may not be enclosed in an appeal filing. */
export type AppealEnclosureRefusal =
  | "not_found"
  | "not_active"
  | "other_patient"
  | "part2_restricted";

/**
 * Pure: why `digest` (M22's `DocumentReader.documentMetadata`, or null when the document is not visible to the org)
 * may not be enclosed in an appeal for a claim of `claimPatientId`, or null when it may. M25 runs it at submit with
 * the claim's patient; M22 re-runs it at render time (`claimPatientId = null`: the patient was proven at submit, but
 * a document's status or retention class can change between submit and render).
 *   - a 42 CFR Part 2 record is never named in a payer filing from here (checked first: it wins over every other
 *     reason); there is no consent override on this reference-only path;
 *   - ACTIVE or on legal hold is enclosable (a hold blocks destruction, not use); superseded / destroyed is not;
 *   - the document must be linked to the claim's patient (a document with no patient is refused).
 */
export function appealEnclosureRefusal(
  digest: Pick<DocumentDigest, "status" | "patientId" | "retentionClass"> | null,
  claimPatientId: string | null,
): AppealEnclosureRefusal | null {
  if (digest === null) return "not_found";
  if (digest.retentionClass === "compliance_42cfr_part2") return "part2_restricted";
  if (digest.status !== "active" && digest.status !== "legal_hold") return "not_active";
  if (claimPatientId !== null && (digest.patientId === null || digest.patientId !== claimPatientId))
    return "other_patient";
  return null;
}

/**
 * Cross-field rules of the reconsideration block: present exactly for the reconsideration tier, and every document
 * it points at is an enclosure the letter lists. The domain guard (M25 `checkQicEvidence`) decides whether the
 * evidence is COMPLETE; this only refuses a payload that contradicts itself, so M22 never draws a half-true filing.
 */
function reconsiderationViolations(p: AppealPacketRenderPayload): string[] {
  const block = p.reconsideration;
  if (p.tier !== "reconsideration") {
    return block ? ["/reconsideration: only a reconsideration carries QIC request elements"] : [];
  }
  if (!block) return ["/reconsideration: required for a reconsideration"];
  const enclosed = new Set(p.supportingDocuments.map((d) => d.documentId));
  const errors: string[] = [];
  if (!enclosed.has(block.redeterminationNoticeDocumentId))
    errors.push("/reconsideration/redeterminationNoticeDocumentId: must be an enclosure");
  if (block.citedEvidenceNone && block.citedEvidence.length > 0)
    errors.push("/reconsideration/citedEvidence: must be empty when the notice named none");
  if (!block.citedEvidenceNone && block.citedEvidence.length === 0)
    errors.push(
      "/reconsideration/citedEvidence: list the cited items or attest the notice named none",
    );
  for (const item of block.citedEvidence) {
    if (item.documentId !== null && !enclosed.has(item.documentId))
      errors.push(`/reconsideration/citedEvidence: "${item.label}" is not among the enclosures`);
    if (item.documentId === null && item.notAvailableReason === null)
      errors.push(`/reconsideration/citedEvidence: "${item.label}" needs an enclosure or a reason`);
  }
  if (
    block.citedEvidence.some((i) => i.documentId === null) &&
    !block.evidencePreclusionAcknowledged
  )
    errors.push(
      "/reconsideration/evidencePreclusionAcknowledged: required when an item is not enclosed",
    );
  return errors;
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
    // A remittance reference and its payment detail travel together: a ref with no detail would print an empty
    // enclosure, and detail with no ref could not be traced to the denial.
    if (p.remitCopyRef.remittanceLineId !== null && p.remitCopy === undefined)
      errors.push("/remitCopy: required when the denial came from a remittance line");
    if (p.remitCopyRef.remittanceLineId === null && p.remitCopy !== undefined)
      errors.push("/remitCopy: must be absent when the denial has no remittance line");
    errors.push(...reconsiderationViolations(p));
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
