// Shared fixtures for the GAP-033 form tests: a rich and a minimal valid typed payload per compiled form, with
// sentinel PHI strings so the canary test can prove where they do (and do not) appear.
import type {
  CtiRenderPayload,
  DischargeRenderPayload,
  F2fRenderPayload,
  NorRenderPayload,
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

/** Every compiled form with its rich payload, for the data-driven tests. */
export const FORM_FIXTURES = {
  cti: CTI,
  f2f: F2F,
  nor: NOR,
  revocation: REVOCATION,
  discharge_summary: DISCHARGE,
  discharge_summary_transfer: TRANSFER,
} as const;
