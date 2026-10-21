// @chartwarden/types - the typed render payloads of M6's CoP compliance documents (GAP-033, Wave 1): CTI, face-to-face
// attestation, notice of rights acknowledgment, revocation, discharge summary and transfer summary. M6 builds
// each in the transaction that signs the artifact (apps/backend/src/modules/06-admission/render-payloads) and
// publishes it as `renderPayload` on the existing `m6.*` event; M22's form compiler validates it at the render
// boundary. Previously the events carried identifiers only, so a bespoke layout had nothing to draw.
import { type Static, Type } from "@sinclair/typebox";
import {
  RENDER_PAYLOAD_VERSION,
  RenderDiagnosis,
  RenderPatientIdentity,
  SignatureRecord,
  UndatedSignatureRecord,
  assertRenderPayload,
} from "./common";

const id = Type.String({ minLength: 1 });
const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);
const nullableDate = nullableText;
const schemaVersion = Type.Literal(RENDER_PAYLOAD_VERSION);

// ── CTI (42 CFR 418.22) ────────────────────────────────────────────────────────────────────────────
export const CtiRenderPayload = Type.Object({
  schemaVersion,
  ctiId: id,
  electionPeriodId: id,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  /** Benefit period ordinal (1 = first 90 days ...), null when the period row has none. */
  benefitPeriodSequence: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  isRecertification: Type.Boolean(),
  periodStart: nullableDate,
  periodEnd: nullableDate,
  terminalDiagnoses: Type.Array(RenderDiagnosis),
  relatedConditions: Type.Array(RenderDiagnosis),
  /** Terminal-diagnosis ICD-10 codes withheld from the rendering under 42 CFR Part 2 (count only). */
  part2WithheldCount: Type.Integer({ minimum: 0 }),
  /** Related-condition ICD-10 codes withheld under Part 2 (count only). */
  relatedPart2WithheldCount: Type.Integer({ minimum: 0 }),
  /** The physician's brief narrative (418.22(b)(3)). Required: a CTI without one is not a certification. */
  narrative: text,
  signedLate: Type.Boolean(),
  lateReason: nullableText,
  hospiceMdSignature: SignatureRecord,
  /** Present only when the attending physician also signed (period 1 with an attending on file). */
  attendingSignature: Type.Union([SignatureRecord, Type.Null()]),
});
export type CtiRenderPayload = Static<typeof CtiRenderPayload>;
export const assertCtiRenderPayload = (p: unknown): CtiRenderPayload =>
  assertRenderPayload("cti", CtiRenderPayload, p);

// ── Face-to-face (42 CFR 418.22(a)(4), (b)(4)) ─────────────────────────────────────────────────────
export const F2fRenderPayload = Type.Object({
  schemaVersion,
  f2fId: id,
  electionPeriodId: id,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  encounterDate: nullableDate,
  encounterLocation: nullableText,
  performerRole: Type.Union([Type.Literal("hospice_md"), Type.Literal("hospice_np")]),
  withinWindow: Type.Union([Type.Boolean(), Type.Null()]),
  windowOverride: Type.Boolean(),
  windowOverrideReason: nullableText,
  telehealthEligibility: Type.Union([
    Type.Object({
      patientInMoratoriumArea: Type.Boolean(),
      hospiceUnderEnhancedOversight: Type.Boolean(),
      performerMedicareEnrolledOrOptedOut: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  /** Exactly one attestation source (R-F2F-06): the written narrative, or a signed clinical note. */
  attestationNarrative: nullableText,
  linkedNoteEncounterId: nullableText,
  attestation: SignatureRecord,
});
export type F2fRenderPayload = Static<typeof F2fRenderPayload>;
export const assertF2fRenderPayload = (p: unknown): F2fRenderPayload =>
  assertRenderPayload("f2f", F2fRenderPayload, p, (x) =>
    (x.attestationNarrative === null) === (x.linkedNoteEncounterId === null)
      ? ["/attestationNarrative: exactly one of attestationNarrative / linkedNoteEncounterId"]
      : [],
  );

// ── Notice of rights acknowledgment (42 CFR 418.52(a)) ─────────────────────────────────────────────
export const NorRenderPayload = Type.Object({
  schemaVersion,
  norAcknowledgmentId: id,
  admissionId: id,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  signerKind: Type.Union([Type.Literal("patient"), Type.Literal("representative")]),
  acknowledgedDate: text,
  acknowledgmentMethod: Type.Union([
    Type.Literal("wet_ink_scanned"),
    Type.Literal("electronic_witnessed"),
    Type.Literal("verbal_with_witness"),
  ]),
  /** The acknowledgment as a signature record: the beneficiary (or representative) acknowledging. */
  acknowledgment: SignatureRecord,
  /** The witness, when the method required one and a user is on record. */
  witness: Type.Union([UndatedSignatureRecord, Type.Null()]),
});
export type NorRenderPayload = Static<typeof NorRenderPayload>;
export const assertNorRenderPayload = (p: unknown): NorRenderPayload =>
  assertRenderPayload("nor", NorRenderPayload, p);

// ── Revocation (42 CFR 418.28) ─────────────────────────────────────────────────────────────────────
export const RevocationRenderPayload = Type.Object({
  schemaVersion,
  revocationEventId: id,
  admissionId: id,
  electionPeriodId: id,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  signerKind: Type.Union([Type.Literal("patient"), Type.Literal("representative")]),
  effectiveDate: text,
  signedDate: text,
  reason: text,
  narrative: nullableText,
  revocation: SignatureRecord,
});
export type RevocationRenderPayload = Static<typeof RevocationRenderPayload>;
export const assertRevocationRenderPayload = (p: unknown): RevocationRenderPayload =>
  assertRenderPayload("revocation", RevocationRenderPayload, p);

// ── Discharge summary (42 CFR 418.26) ──────────────────────────────────────────────────────────────
export const DischargeRenderPayload = Type.Object({
  schemaVersion,
  dischargeEventId: id,
  admissionId: id,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  dischargeType: text,
  status: Type.Union([
    Type.Literal("pending_cosign"),
    Type.Literal("completed"),
    Type.Literal("voided"),
  ]),
  effectiveDate: text,
  narrative: nullableText,
  forCauseReason: nullableText,
  /** The 418.26(b) physician discharge order, when one was required and recorded. */
  dischargeOrder: Type.Union([
    Type.Object({
      text: nullableText,
      reference: nullableText,
      signature: SignatureRecord,
    }),
    Type.Null(),
  ]),
  /** Who filed the summary (authorship, 418.104(b)); null for an external (HL7) source. */
  filedBy: Type.Union([SignatureRecord, Type.Null()]),
  cosign: Type.Object({
    required: Type.Boolean(),
    /** True once the medical-director cosign was recorded: the version then MUST carry its signature. */
    completed: Type.Boolean(),
    signature: Type.Union([SignatureRecord, Type.Null()]),
  }),
});
export type DischargeRenderPayload = Static<typeof DischargeRenderPayload>;
export const assertDischargeRenderPayload = (p: unknown): DischargeRenderPayload =>
  assertRenderPayload("discharge_summary", DischargeRenderPayload, p, (x) =>
    x.cosign.completed && x.cosign.signature === null
      ? ["/cosign/signature: a cosigned discharge must carry the cosigner's signature record"]
      : [],
  );

// ── Transfer summary (42 CFR 418.26) ───────────────────────────────────────────────────────────────
export const TransferRenderPayload = Type.Object({
  schemaVersion,
  transferEventId: id,
  admissionId: id,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  direction: Type.Union([Type.Literal("in"), Type.Literal("out")]),
  effectiveDate: text,
  otherHospiceName: nullableText,
  otherHospiceCcn: nullableText,
  receivingCareSetting: nullableText,
  benefitPeriodSequence: Type.Integer({ minimum: 1 }),
  narrative: nullableText,
});
export type TransferRenderPayload = Static<typeof TransferRenderPayload>;
export const assertTransferRenderPayload = (p: unknown): TransferRenderPayload =>
  assertRenderPayload("discharge_summary_transfer", TransferRenderPayload, p);
