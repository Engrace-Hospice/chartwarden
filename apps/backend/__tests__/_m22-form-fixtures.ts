// Shared fixtures for the GAP-033 form tests: a rich and a minimal valid typed payload per compiled form, with
// sentinel PHI strings so the canary test can prove where they do (and do not) appear.
import type {
  ClaimAcknowledgmentRenderPayload,
  CtiRenderPayload,
  DenialAppealCoverRenderPayload,
  DenialResolutionRenderPayload,
  DischargeRenderPayload,
  F2fRenderPayload,
  MedicaidClaimAcknowledgmentRenderPayload,
  MedicationOrderRenderPayload,
  NoeReceiptRenderPayload,
  NorRenderPayload,
  NotrReceiptRenderPayload,
  OrderRecordRenderPayload,
  RevocationRenderPayload,
  SignatureRecord,
  TransferRenderPayload,
} from "@wardenx/types";

export const SENTINEL_NAME = "Zelda Quillfeather-Ramirez";
export const SENTINEL_MRN = "MRN-ZQR-90417";
export const SENTINEL_DOB = "1941-03-07";

export const PATIENT = {
  patientId: "pat-00000000-0000-4000-8000-000000000001",
  name: SENTINEL_NAME,
  mrn: SENTINEL_MRN,
  dateOfBirth: SENTINEL_DOB,
} as const;

export const sig = (over: Partial<SignatureRecord> = {}): SignatureRecord => ({
  role: "Signer",
  printedName: "Dr. Imani Okafor",
  credentials: "MD",
  npi: "1234567893",
  capacity: null,
  signedAt: "2026-09-30T14:05:00.000Z",
  method: "electronic",
  meaning: "certification",
  recordId: "1a2b3c4d-0000-4000-8000-000000000009",
  ...over,
});

export const LONG_NARRATIVE = Array.from(
  { length: 40 },
  (_, i) =>
    `Sentence ${i + 1}: progressive decline over the last ninety days with weight loss, recurrent admissions, declining functional status, and a palliative performance scale of thirty percent, consistent with a prognosis of six months or less.`,
).join(" ");

export const CTI: CtiRenderPayload = {
  schemaVersion: 2,
  ctiId: "cti-00000000-0000-4000-8000-0000000000c1",
  electionPeriodId: "ep-1",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  benefitPeriodSequence: 3,
  isRecertification: true,
  periodStart: "2026-10-01",
  periodEnd: "2026-11-29",
  terminalDiagnoses: [{ code: "C34.90" }],
  relatedConditions: [{ code: "J44.9" }, { code: "I50.9" }],
  part2WithheldCount: 0,
  relatedPart2WithheldCount: 0,
  narrative: "Progressive decline with weight loss and a PPS of 30 percent; recurrent admissions.",
  signedLate: false,
  lateReason: null,
  hospiceMdSignature: sig({ role: "Hospice physician", meaning: "certification" }),
  attendingSignature: null,
};

export const F2F: F2fRenderPayload = {
  schemaVersion: 2,
  f2fId: "f2f-00000000-0000-4000-8000-0000000000f1",
  electionPeriodId: "ep-1",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  encounterDate: "2026-09-12",
  encounterLocation: "patient_home",
  performerRole: "hospice_np",
  withinWindow: true,
  windowOverride: false,
  windowOverrideReason: null,
  telehealthEligibility: null,
  attestationNarrative:
    "Visited the patient at home; findings: cachexia, dyspnea at rest, PPS 30 percent. Findings were shared with the certifying physician.",
  linkedNoteEncounterId: null,
  attestation: sig({ role: "NP", credentials: "NP", meaning: "attestation" }),
};

export const NOR: NorRenderPayload = {
  schemaVersion: 2,
  norAcknowledgmentId: "nor-00000000-0000-4000-8000-0000000000a1",
  admissionId: "adm-1",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  signerKind: "representative",
  acknowledgedDate: "2026-09-02",
  acknowledgmentMethod: "wet_ink_scanned",
  acknowledgment: sig({
    role: "Acknowledgment",
    printedName: SENTINEL_NAME,
    credentials: null,
    npi: null,
    capacity: "Authorized representative of the patient",
    signedAt: "2026-09-02",
    method: "wet_ink_scanned",
    meaning: "acknowledgment",
  }),
  witness: sig({
    role: "Witness",
    printedName: "Pat Witness",
    credentials: null,
    npi: null,
    signedAt: "2026-09-02",
    meaning: "witness",
  }),
};

export const REVOCATION: RevocationRenderPayload = {
  schemaVersion: 2,
  revocationEventId: "rev-00000000-0000-4000-8000-0000000000b1",
  admissionId: "adm-1",
  electionPeriodId: "ep-1",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  signerKind: "patient",
  effectiveDate: "2026-10-05",
  signedDate: "2026-10-04",
  reason: "seek_curative_treatment",
  narrative: null,
  revocation: sig({
    role: "Revocation",
    printedName: SENTINEL_NAME,
    credentials: null,
    npi: null,
    signedAt: "2026-10-04",
    meaning: "revocation",
  }),
};

export const DISCHARGE: DischargeRenderPayload = {
  schemaVersion: 2,
  dischargeEventId: "dis-00000000-0000-4000-8000-0000000000d1",
  admissionId: "adm-1",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  dischargeType: "for_cause",
  status: "completed",
  effectiveDate: "2026-10-06",
  narrative: "Discharged for cause after repeated unsafe-environment events.",
  forCauseReason: "Unsafe home environment for staff",
  dischargeOrder: {
    text: "Discharge per medical director order.",
    reference: "ORD-17",
    signature: sig({ role: "Discharge order", meaning: "discharge_order", credentials: "MD" }),
  },
  filedBy: sig({
    role: "Filed by",
    printedName: "Nina Filer",
    credentials: null,
    npi: null,
    meaning: "authorship",
  }),
  cosign: {
    required: true,
    completed: true,
    signature: sig({ role: "Cosign", meaning: "cosignature" }),
  },
};

export const TRANSFER: TransferRenderPayload = {
  schemaVersion: 2,
  transferEventId: "xfer-00000000-0000-4000-8000-0000000000e1",
  admissionId: "adm-1",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  direction: "out",
  effectiveDate: "2026-10-07",
  otherHospiceName: "Lakeside Hospice",
  otherHospiceCcn: "012345",
  receivingCareSetting: "home",
  benefitPeriodSequence: 2,
  narrative: "Patient moved to another county.",
};

export const ORDER_RECORD: OrderRecordRenderPayload = {
  schemaVersion: 2,
  orderId: "ord-00000000-0000-4000-8000-0000000000f1",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  kind: "lab",
  kindVersion: "lab.v1",
  priority: "urgent",
  indication: "Rising creatinine on the last visit.",
  orderingPhysician: { name: "Dr. Imani Okafor", credentials: "MD", npi: "1234567893" },
  details: [
    { label: "Tests", value: "Creatinine (LOINC 2160-0); Potassium (LOINC 2823-3)" },
    { label: "Fasting required", value: "No" },
    { label: "Collection instructions", value: "Draw at the next scheduled visit." },
  ],
  detailsNote: null,
  viaVerbal: false,
  replacesOrderId: null,
  fromStandingOrder: false,
  cosign: null,
  signature: sig({
    role: "Ordering clinician",
    credentials: null,
    npi: null,
    meaning: "order_authorization",
  }),
};

export const MEDICATION_ORDER: MedicationOrderRenderPayload = {
  schemaVersion: 2,
  orderId: "mo-00000000-0000-4000-8000-0000000000f2",
  patient: PATIENT,
  hospiceName: "Evergreen Hospice LLC",
  medClass: "controlled_substance",
  drugName: "Morphine sulfate oral solution",
  strength: "20 mg/mL",
  doseForm: "solution",
  route: "oral",
  sig: {
    doseQuantity: 5,
    doseUnit: "mg",
    route: "oral",
    frequencyCode: "q4h",
    duration: "30 days",
    asNeeded: true,
    asNeededReason: "dyspnea",
  },
  sigFreeText: "Give 5 mg by mouth every 4 hours as needed for shortness of breath.",
  indication: "Dyspnea at rest",
  clinicalJustification: "Opioid-naive patient with refractory dyspnea; low starting dose.",
  dispenseQuantity: { value: 30, unit: "mL" },
  daysSupply: 30,
  refillsAuthorized: 0,
  daw: false,
  deaSchedule: "II",
  compounded: null,
  coverage: { status: "covered_related", reason: null },
  allergyOverride: null,
  prescribingPhysician: { name: "Dr. Imani Okafor", credentials: "MD", npi: "1234567893" },
  viaVerbal: false,
  cosign: null,
  isSudTreatment: false,
  signature: sig({
    role: "Prescriber",
    meaning: "order_authorization",
  }),
};

export const NOE_RECEIPT: NoeReceiptRenderPayload = {
  noeControlNumber: "NOE-2026-000417",
  submittedAt: "2026-10-02T15:30:00.000Z",
};
export const NOTR_RECEIPT: NotrReceiptRenderPayload = {
  notrControlNumber: "NOTR-2026-000052",
  submittedAt: "2026-10-09T09:12:00.000Z",
};
export const CLAIM_ACK: ClaimAcknowledgmentRenderPayload = {
  claimControlNumber: "CLM-2026-0091",
  payerClaimControlNumber: "PAYER-7781234",
  acknowledgedAt: "2026-10-12T18:45:00.000Z",
};
export const MEDICAID_CLAIM_ACK: MedicaidClaimAcknowledgmentRenderPayload = {
  medicaidClaimControlNumber: "MCLM-2026-0044",
  payerClaimControlNumber: null,
  acknowledgedAt: "2026-10-13T08:00:00.000Z",
};
export const DENIAL_COVER: DenialAppealCoverRenderPayload = {
  claimControlNumber: "CLM-2026-0092",
  rejectionStage: "277ca",
  rejectionCodes: ["A7:51:85", "A3:21:IL"],
};
export const DENIAL_RESOLUTION: DenialResolutionRenderPayload = {
  closureOutcome: "resolved_no_appeal",
  resolvedAt: "2026-10-20T13:00:00.000Z",
  claimId: "cccccccc-0000-4000-8000-000000000003",
};

/** Every compiled form with its rich payload, for the data-driven tests. */
export const FORM_FIXTURES = {
  cti: CTI,
  f2f: F2F,
  nor: NOR,
  revocation: REVOCATION,
  discharge_summary: DISCHARGE,
  discharge_summary_transfer: TRANSFER,
  order_record: ORDER_RECORD,
  medication_order: MEDICATION_ORDER,
} as const;

/** The patient-independent billing correspondence (no patient identity, no MBI): rich payload per form. */
export const BILLING_FIXTURES = {
  noe_confirmation_receipt: NOE_RECEIPT,
  notr_confirmation_receipt: NOTR_RECEIPT,
  claim_acknowledgment_letter: CLAIM_ACK,
  medicaid_claim_acknowledgment_letter: MEDICAID_CLAIM_ACK,
  denial_appeal_cover_letter: DENIAL_COVER,
  denial_resolution_letter: DENIAL_RESOLUTION,
} as const;
