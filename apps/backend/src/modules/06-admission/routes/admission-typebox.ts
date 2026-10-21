// apps/backend/src/modules/06-admission/routes/admission-typebox.ts — M6-T06 TypeBox route schemas
// (§4.2). Named `admission-typebox` (NOT `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Schemas mirror §4.2 1:1 (abbreviated where the spec is). Optimistic
// locking: state-change PATCH/POST routes carry `ifVersion`.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ADMISSION_SOURCE_CODES, ADMISSION_TYPE_CODES, ValidationError } from "@chartwarden/types";
import type {
  AdmissionDetail as ServiceAdmissionDetail,
  AdmissionReadinessResult as ServiceAdmissionReadinessResult,
  AdmissionSummary as ServiceAdmissionSummary,
  MutationResult as ServiceMutationResult,
  Page as ServicePage,
  PatientElectionCertificationView as ServicePatientElectionCert,
  ReferralReadView as ServiceReferralReadView,
  SummaryRow as ServiceSummaryRow,
} from "./service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set(
    "date",
    (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)),
  );
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}

// Slice ids are non-uuid synthetic (`adm_1`); routes accept a loose id param. Cross-module ids
// (patientId, physicianId) are validated as uuids per §4.2.
export const IdParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });
// Loose string (matches IdParamsSchema, not uuid-format) so the param convention is uniform across M6
// routes; the service resolves a non-existent patient to a truthful empty aggregate, never an error.
export const PatientIdParamsSchema = Type.Object({
  patientId: Type.String({ minLength: 1, maxLength: 64 }),
});

export const Uuid = () => Type.String({ format: "uuid" });
const Reason = (min = 10, max = 4000) => Type.String({ minLength: min, maxLength: max });
export const Version = () => Type.Integer({ minimum: 0 });
const Icd10 = () => Type.String({ pattern: "^[A-Z][0-9A-Z.]{1,7}$" });
const Npi = () => Type.String({ pattern: "^[0-9]{10}$" });

// ── Referral (routes 1–7) ──────────────────────────────────────────────────────────────────────
const REFERRAL_SOURCES = [
  "phone",
  "fax",
  "portal",
  "walk_in",
  "self_referral",
  "physician_office",
  "hospital_discharge_planner",
] as const;

export const ReferralCreateSchema = Type.Object({
  source: Type.Union(REFERRAL_SOURCES.map((s) => Type.Literal(s))),
  receivedAt: Type.String({ format: "date-time" }),
  receivingUserId: Type.Optional(Uuid()),
  patientId: Type.Optional(Uuid()),
  patientNameAtReceipt: Type.String({ minLength: 1, maxLength: 200 }),
  patientDobAtReceipt: Type.Optional(Type.String({ format: "date" })),
  // The patient's Medicare number (MBI) from the referrer; dashes/spaces allowed, normalized server-side.
  medicareNumberAtReceipt: Type.Optional(Type.String({ maxLength: 20 })),
  // The patient's Medicaid number from the referrer (1-14 letters/digits once dashes/spaces are removed).
  medicaidNumberAtReceipt: Type.Optional(Type.String({ maxLength: 24 })),
  sexAssignedAtBirth: Type.Optional(
    Type.Union([Type.Literal("F"), Type.Literal("M"), Type.Literal("O"), Type.Literal("U")]),
  ),
  referringDxText: Type.Optional(Type.String({ maxLength: 2000 })),
  referrerName: Type.Optional(Type.String({ maxLength: 200 })),
  referrerOrganization: Type.Optional(Type.String({ maxLength: 200 })),
  referrerPhone: Type.Optional(Type.String({ maxLength: 32 })),
  externalReferralId: Type.Optional(Type.String({ maxLength: 128 })),
});

export const ReferralListQuerySchema = Type.Object({
  status: Type.Optional(Type.String({ maxLength: 32 })),
  state: Type.Optional(Type.String({ maxLength: 32 })),
  source: Type.Optional(Type.String({ maxLength: 32 })),
  patientResolutionStatus: Type.Optional(Type.String({ maxLength: 32 })),
  priority: Type.Optional(Type.String({ maxLength: 32 })),
  assigned: Type.Optional(Type.Union([Type.Literal("mine"), Type.Literal("unassigned")])),
  includeConverted: Type.Optional(Type.Boolean()),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const ReferralTriageSchema = Type.Object({
  outcome: Type.Union([Type.Literal("eligible"), Type.Literal("ineligible")]),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
  ifVersion: Version(),
});

// ── The first benefit period of a NEW admission (intake/benefit-period.ts) ──────────────────────────
// Shared by direct intake, referral conversion and readmission. Absent = our own history's suggestion.
export const BenefitPeriodEntrySchema = Type.Object(
  {
    sequence: Type.Integer({
      minimum: 1,
      maximum: 200,
      description:
        "The benefit period the admission elects into (1 and 2 are 90 days, 3+ are 60). Medicare counts periods " +
        "per beneficiary across every hospice, so confirm it in HETS / ELGA / ELGH.",
    }),
    source: Type.Union(
      [
        Type.Literal("hets_confirmed"),
        Type.Literal("staff_entered_unverified"),
        Type.Literal("internal_history"),
      ],
      {
        description:
          '"hets_confirmed": checked against HETS / ELGA / ELGH (confirmedOn required). "staff_entered_unverified": ' +
          'entered without that check. "internal_history": our own history\'s suggestion, accepted as is.',
      },
    ),
    confirmedOn: Type.Optional(
      Type.String({
        format: "date",
        description: "The day the period was checked in HETS / ELGA / ELGH (hets_confirmed only).",
      }),
    ),
  },
  { additionalProperties: false },
);

const FirstBenefitPeriodFields = {
  benefitPeriod: Type.Optional(BenefitPeriodEntrySchema),
  f2fException: Type.Optional(
    Type.Object(
      {
        reason: Type.String({
          minLength: 20,
          maxLength: 2000,
          description:
            "Period 3+ only — the exceptional circumstance (weekend emergency admission, CMS systems down so the " +
            "period was unknown) that lets the face-to-face happen within 2 days after admission (MBPM ch. 9 §20.1(5)(d)).",
        }),
      },
      { additionalProperties: false },
    ),
  ),
  admissionDate: Type.Optional(
    Type.String({
      format: "date",
      description:
        "The planned admission / election date; anchors the period-3+ face-to-face window.",
    }),
  ),
};

export const ReferralAcceptSchema = Type.Object({
  patientId: Type.Optional(Uuid()),
  primaryDiagnosisIcd10: Icd10(),
  attendingPhysicianId: Type.Optional(Uuid()),
  ...FirstBenefitPeriodFields,
  ifVersion: Version(),
});

export const ReferralReviewSchema = Type.Object({ ifVersion: Version() });

export const ReferralPatientMatchSchema = Type.Object({ ifVersion: Version() });

export const ReferralPatientConfirmSchema = Type.Object({
  patientId: Uuid(),
  ifVersion: Version(),
});

export const ReferralPatientCreateSchema = Type.Object({ ifVersion: Version() });

export const ReferralQualifySchema = Type.Object({ ifVersion: Version() });

export const ReferralConvertSchema = ReferralAcceptSchema;

export const ReferralPrioritySchema = Type.Object({
  priority: Type.Union([Type.Literal("routine"), Type.Literal("high"), Type.Literal("urgent")]),
  ifVersion: Version(),
});

export const ReferralAssignSchema = Type.Object({
  assignedToUserId: Type.Optional(Uuid()),
  ifVersion: Version(),
});

export const ReferralNoteCreateSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 4000 }),
});

export const ReferralNoteResponseSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  referralId: Type.String({ minLength: 1 }),
  authorId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  authorDisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  content: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});

export const ReferralNoteListResponseSchema = Type.Object({
  items: Type.Array(ReferralNoteResponseSchema),
});

export const ReferralActivityListResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      referralId: Type.String({ minLength: 1 }),
      actorId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      action: Type.String(),
      fromStatus: Type.Union([Type.String(), Type.Null()]),
      toStatus: Type.Union([Type.String(), Type.Null()]),
      metadata: Type.Object({}, { additionalProperties: true }),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
});

export const ReferralDeclineSchema = Type.Object({
  reason: Reason(10, 1000),
  ifVersion: Version(),
});

export const ReferralPendingInformationSchema = Type.Object({
  reason: Reason(3, 2000),
  ifVersion: Version(),
});

export const ReferralTerminalSchema = Type.Object({
  reason: Type.Optional(Reason(3, 1000)),
  ifVersion: Version(),
});

export const ReferralUpdateSchema = Type.Object({
  // "" clears either number. Dashes/spaces allowed; normalized server-side.
  medicareNumberAtReceipt: Type.Optional(Type.String({ maxLength: 20 })),
  medicaidNumberAtReceipt: Type.Optional(Type.String({ maxLength: 24 })),
  referringDxText: Type.Optional(Type.String({ maxLength: 2000 })),
  referrerName: Type.Optional(Type.String({ maxLength: 200 })),
  referrerOrganization: Type.Optional(Type.String({ maxLength: 200 })),
  referrerPhone: Type.Optional(Type.String({ maxLength: 32 })),
  sexAssignedAtBirth: Type.Optional(
    Type.Union([Type.Literal("F"), Type.Literal("M"), Type.Literal("O"), Type.Literal("U")]),
  ),
  ifVersion: Version(),
});

// ── Admission (routes 8–14) ────────────────────────────────────────────────────────────────────
const INTAKE_METHODS = ["in_person", "phone", "referral_auto", "transfer_in"] as const;

/** UB-04 FL 14 Type of Admission (837I CL101): the NUBC codes a hospice claim carries (`ADMISSION_TYPE_CODES`). */
const AdmissionTypeCodeSchema = Type.Union(
  ADMISSION_TYPE_CODES.map((c) => Type.Literal(c)),
  {
    description:
      "UB-04 FL 14 Type of Admission: 1 emergency, 2 urgent, 3 elective, 5 trauma, 9 information not available.",
  },
);
/** UB-04 FL 15 Point of Origin (837I CL102): the NUBC codes a hospice claim carries (`ADMISSION_SOURCE_CODES`). */
const AdmissionSourceCodeSchema = Type.Union(
  ADMISSION_SOURCE_CODES.map((c) => Type.Literal(c)),
  {
    description:
      "UB-04 FL 15 Point of Origin: 1 non-health care facility, 2 clinic/physician office, 4 hospital transfer, 5 SNF/ICF transfer, 6 other health care facility, 8 court/law enforcement, 9 information not available.",
  },
);

export const AdmissionCreateSchema = Type.Object({
  patientId: Uuid(),
  referralId: Type.Optional(Uuid()),
  intakeMethod: Type.Union(INTAKE_METHODS.map((m) => Type.Literal(m))),
  attendingPhysicianId: Type.Optional(Uuid()),
  hospiceMedicalDirectorId: Uuid(),
  // Optional at creation: an admission opened before the type / origin is known is completed on PATCH, and M23's
  // `admission_codes_present` rule blocks the claim until both are recorded.
  admissionTypeCode: Type.Optional(AdmissionTypeCodeSchema),
  admissionSourceCode: Type.Optional(AdmissionSourceCodeSchema),
  readmittedFromAdmissionId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      description:
        "A readmission: the patient's earlier, live-discharged admission (GET /admissions/:id/readmission-context).",
    }),
  ),
  ...FirstBenefitPeriodFields,
});

export const AdmissionListQuerySchema = Type.Object({
  state: Type.Optional(Type.String({ maxLength: 32 })),
  patientId: Type.Optional(Uuid()),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

/** F-065 — the patient's admissions, newest first (`GET /patients/:patientId/admissions`). */
export const PatientAdmissionsResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Uuid(),
      state: Type.String(),
      admissionAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
      dischargedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    }),
  ),
});

export const AdmissionUpdateSchema = Type.Object({
  intakeMethod: Type.Optional(Type.Union(INTAKE_METHODS.map((m) => Type.Literal(m)))),
  hospicePhysicianId: Type.Optional(Uuid()),
  attendingPhysicianId: Type.Optional(Uuid()),
  admissionAt: Type.Optional(Type.String({ format: "date-time" })),

  providerEntityId: Type.Optional(Uuid()),
  locationId: Type.Optional(Uuid()),

  // `null` clears a mis-recorded value (the claim then fails `admission_codes_present` until it is corrected).
  admissionTypeCode: Type.Optional(Type.Union([AdmissionTypeCodeSchema, Type.Null()])),
  admissionSourceCode: Type.Optional(Type.Union([AdmissionSourceCodeSchema, Type.Null()])),

  ifVersion: Version(),
});

export const AdmissionActivateSchema = Type.Object({
  ifVersion: Version(),
  // #50 — the service location this admission is served from. Optional because it is DERIVED when the
  // elected provider entity has exactly one active location; required (422 `M6_LOCATION_REQUIRED`) when
  // it has more than one, since `location` carries no primary flag and there is no defensible pick.
  locationId: Type.Optional(Uuid()),
});
export const AdmissionHoldSchema = Type.Object({ reason: Reason(10, 500), ifVersion: Version() });
export const AdmissionResumeSchema = Type.Object({ ifVersion: Version() });
const UploadedEvidenceBaseSchema = {
  documentId: Uuid(),
  documentVersionId: Uuid(),
};
export const UploadedNoticeOfRightsSchema = Type.Object({
  ...UploadedEvidenceBaseSchema,
  acknowledgedAt: Type.Optional(Type.String({ format: "date-time" })),
  acknowledgedByName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  acknowledgedByRole: Type.Optional(
    Type.Union([
      Type.Literal("patient"),
      Type.Literal("legal_representative"),
      Type.Literal("caregiver"),
    ]),
  ),
});
export const UploadedElectionEvidenceSchema = Type.Object({
  ...UploadedEvidenceBaseSchema,
  documentState: Type.Union([Type.Literal("unsigned"), Type.Literal("signed")]),
  signerName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  signerRole: Type.Optional(
    Type.Union([
      Type.Literal("patient"),
      Type.Literal("legal_representative"),
      Type.Literal("caregiver"),
    ]),
  ),
  signedAt: Type.Optional(Type.String({ format: "date-time" })),
});
export const UploadedCtiEvidenceSchema = Type.Object({
  ...UploadedEvidenceBaseSchema,
  documentState: Type.Union([Type.Literal("unsigned"), Type.Literal("signed")]),
  signedAt: Type.Optional(Type.String({ format: "date-time" })),
});

// ── Election statement & period (routes 15–21) ───────────────────────────────────────────────────
export const ElectionStatementDraftSchema = Type.Object({
  electionPeriodId: Uuid(),
  effectiveDate: Type.String({ format: "date" }),
  primaryDiagnosisIcd10: Icd10(),
  electedProviderEntityId: Uuid(),
  electedAttendingPhysicianId: Type.Optional(Uuid()),
  waiverAcknowledged: Type.Boolean(),
  stateAddendum: Type.Optional(Type.String({ maxLength: 5000 })),
});

export const ElectionSignSchema = Type.Object({
  signingPatientName: Type.String({ minLength: 1, maxLength: 200 }),
  signingRole: Type.Union([
    Type.Literal("patient"),
    Type.Literal("legal_representative"),
    Type.Literal("caregiver"),
  ]),
  ifVersion: Version(),
});

export const ElectionVoidSchema = Type.Object({ reason: Reason(10, 1000), ifVersion: Version() });

export const ElectionPeriodCreateSchema = Type.Object({
  effectiveStart: Type.String({ format: "date" }),
  kind: Type.Union([Type.Literal("ninety_day"), Type.Literal("sixty_day")]),
});

export const ElectionPeriodPatchSchema = Type.Object({
  effectiveStart: Type.Optional(Type.String({ format: "date" })),
  ifVersion: Version(),
});

// ── CTI (routes 22–27) ───────────────────────────────────────────────────────────────────────────
export const CtiDraftSchema = Type.Object({
  hospiceMedicalDirectorId: Uuid(),
  attendingPhysicianId: Type.Optional(Uuid()),
  terminalDiagnosisIcd10: Icd10(),
  secondaryDiagnoses: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }))),
  prognosisStatement: Type.String({ minLength: 1, maxLength: 200 }),
  narrative: Type.String({ minLength: 1, maxLength: 4000 }),
  clinicalFindings: Type.Object({}, { additionalProperties: true }),
  isRecert: Type.Boolean(),
});

export const CtiSignSchema = Type.Object({ ifVersion: Version() });

export const CtiHospiceMdSignSchema = Type.Object({
  ifVersion: Version(),
  // The signing physician's § 418.22(b)(3) narrative, supplied at signature when the draft has none (a
  // transfer-in drafts our CTI without one) or to replace the draft's. A recert needs >= 200 characters;
  // the service answers 422 `CTI_NARRATIVE_REQUIRED` otherwise.
  narrative: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});

export const CtiVoidSchema = Type.Object({ reason: Reason(10, 500), ifVersion: Version() });

export const CtiMarkLateSchema = Type.Object({
  oralCertVerbalAt: Type.String({ format: "date-time" }),
  oralCertVerbalBy: Type.String({ minLength: 1, maxLength: 200 }),
  reason: Reason(10, 500),
  ifVersion: Version(),
});

// ── F2F (routes 28–32) ─────────────────────────────────────────────────────────────────────────
export const F2fScheduleSchema = Type.Object({
  electionPeriodId: Uuid(),
  scheduledDate: Type.String({ format: "date" }),
  windowStart: Type.String({ format: "date" }),
  windowEnd: Type.String({ format: "date" }),
  clinicianRole: Type.Union([Type.Literal("hospice_np"), Type.Literal("hospice_md")]),
  scheduledClinicianId: Uuid(),
});

/** The §3.2 `f2f_encounter_location` alphabet (R-F2F-05: `telehealth` is date-limited + attestation-gated). */
export const F2fEncounterLocationSchema = Type.Union([
  Type.Literal("patient_home"),
  Type.Literal("alf"),
  Type.Literal("snf"),
  Type.Literal("ipu"),
  Type.Literal("hospital"),
  Type.Literal("telehealth"),
]);

/** R-F2F-05 — the § 418.22(a)(4)(ii)(A)–(C) facts, attested by the completing clinician (no defaults). */
export const F2fTelehealthEligibilitySchema = Type.Object({
  patientInMoratoriumArea: Type.Boolean(),
  hospiceUnderEnhancedOversight: Type.Boolean(),
  performerMedicareEnrolledOrOptedOut: Type.Boolean(),
});

export const F2fCompleteSchema = Type.Object({
  encounterDate: Type.String({ format: "date" }),
  encounterLocation: F2fEncounterLocationSchema,
  /** Required when `encounterLocation` is `telehealth` and the encounter is on/after 2026-01-31. */
  telehealthEligibility: Type.Optional(F2fTelehealthEligibilitySchema),
  ifVersion: Version(),
});

/**
 * Exactly one attestation source (§ 418.22(b)(4)): a written `attestationNarrative` (≥ 100 chars), OR
 * `signedNoteEncounterId` — an M8 note signed and dated by the performer on the encounter date (R-F2F-06).
 */
export const F2fAttestSchema = Type.Object({
  attestationNarrative: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  signedNoteEncounterId: Type.Optional(Uuid()),
  ifVersion: Version(),
});

export const F2fOverrideWindowSchema = Type.Object({
  reason: Reason(20, 1000),
  ifVersion: Version(),
});

// ── Level of care (routes 33–35) ─────────────────────────────────────────────────────────────────
// `newLevel` uses the SAME canonical LevelOfCare strings as everywhere else in this module (M6's own
// `LEVELS_OF_CARE` validation, M24's `LOC_BY_M6_ENUM`) — a prior short-code scheme (rhc/crc/gip/iri) never
// matched what the service actually validated against, so every real call 422'd regardless of level
// (confirm-handshake fix, 2026-08-05). `facilityId` is required for IRC/GIP by the state machine's own
// IPU_FACILITY_REQUIRED guard, not duplicated here — the schema only validates shape.
export const LocChangeSchema = Type.Object({
  newLevel: Type.Union([
    Type.Literal("routine_home_care"),
    Type.Literal("continuous_home_care"),
    Type.Literal("inpatient_respite_care"),
    Type.Literal("general_inpatient_care"),
  ]),
  effectiveStart: Type.String({ format: "date" }),
  reason: Reason(10, 1000),
  facilityId: Type.Optional(Uuid()),
  // D12 — REQUIRED (all three true) when newLevel is general_inpatient_care; ignored otherwise. Enforced
  // server-side by `assertGipAttestations` (412 GIP_DOCUMENTATION_INCOMPLETE), not by this shape.
  gipAttestations: Type.Optional(
    Type.Object({
      symptomsNotManageableElsewhere: Type.Optional(Type.Boolean()),
      intensityWarrantsGip: Type.Optional(Type.Boolean()),
      inpatientSettingIdentified: Type.Optional(Type.Boolean()),
    }),
  ),
});

export const LocPatchSchema = Type.Object({ reason: Reason(10, 1000), ifVersion: Version() });

export const LocConfirmBedSchema = Type.Object({ ifVersion: Version() });

// ── Revocation / transfer / discharge (routes 36–40) ─────────────────────────────────────────────
export const RevocationCreateSchema = Type.Object({
  revocationDate: Type.String({ format: "date" }),
  narrative: Reason(10, 4000),
  signingPatientName: Type.String({ minLength: 1, maxLength: 200 }),
  signingRole: Type.Union([Type.Literal("patient"), Type.Literal("legal_representative")]),
  // `revocation_event.revocation_reason` is NOT NULL — the spec's route contract never collected it, a
  // real gap (architecture wins: the DB requires it, so the request must supply it).
  revocationReason: Type.Union([
    Type.Literal("seek_curative_treatment"),
    Type.Literal("dissatisfaction"),
    Type.Literal("transferred_out"),
    Type.Literal("other"),
  ]),
});

export const TransferOutSchema = Type.Object({
  direction: Type.Literal("out"),
  effectiveDate: Type.String({ format: "date" }),
  otherHospiceName: Type.String({ minLength: 1, maxLength: 200 }),
  otherHospiceCcn: Type.Optional(Type.String({ pattern: "^[0-9A-Z]{6}$" })),
  // Where the RECEIVING hospice cares for the patient — the claim's patient discharge status 50 (hospice,
  // home) vs 51 (hospice, medical facility), CMS Pub. 100-04 Ch. 11 §30.3. Persisted on
  // `transfer_event.receiving_care_setting` (migration 0370).
  receivingCareSetting: Type.Union([Type.Literal("home"), Type.Literal("facility")], {
    description:
      'REQUIRED. Where the RECEIVING hospice will care for the patient: "home" or "facility". Sets the ' +
      "Medicare claim's patient discharge status — 50 (discharged to hospice, home) or 51 (discharged to " +
      "hospice, medical facility), CMS Pub. 100-04 Ch. 11 §30.3. Missing or invalid → 422 " +
      "RECEIVING_CARE_SETTING_REQUIRED. A transfer recorded without it can be completed later with " +
      "POST /api/v1/transfers/{id}/receiving-care-setting.",
  }),
  narrative: Reason(10, 4000),
});

export const TransferInSchema = Type.Object({
  direction: Type.Literal("in"),
  effectiveDate: Type.String({
    format: "date",
    description:
      "The date the change of hospice is effective. The transferring hospice bills through and including " +
      "this date and the receiving hospice's transfer notice (TOB 8xC) reports it as the Statement From " +
      "date (CMS Pub. 100-04 ch. 11 §20.1.3).",
  }),
  otherHospiceName: Type.String({ minLength: 1, maxLength: 200 }),
  otherHospiceCcn: Type.Optional(
    Type.String({
      pattern: "^[0-9A-Z]{6}$",
      description:
        "The transferring hospice's CMS Certification Number. Our own CCN is refused (422 " +
        "TRANSFER_SAME_PROVIDER): a move between locations of one hospice is not a transfer (§20.1.3). " +
        "The 8xC transfer notice cannot be filed until it is known.",
    }),
  ),
  otherHospiceNpi: Type.Optional(
    Type.String({
      pattern: "^[0-9]{10}$",
      description:
        "The transferring hospice's NPI (10 digits, check digit validated → 422 TRANSFER_IN_SOURCE_INVALID).",
    }),
  ),
  priorBenefitPeriodSequence: Type.Integer({ minimum: 1 }),
  priorElectionStartDate: Type.String({ format: "date" }),
  // D9 — the receiving hospice's own CTI for the `next` pending period (the inherited period runs on
  // the sending hospice's certification, no CTI required from us).
  hospiceMedicalDirectorId: Uuid(),
  attendingPhysicianId: Type.Optional(Uuid()),
  narrative: Reason(10, 4000),
});

// The canonical reason list + the §6.3 permission/narrative policy live in the pure `discharge/`
// submodule (M6-T09); re-exported here so existing importers keep resolving `DischargeReason` from the
// TypeBox module and the schema union stays in lock-step with the policy table.
export { DISCHARGE_REASONS, type DischargeReason } from "../discharge";
import { DISCHARGE_REASONS } from "../discharge";
import { PHYSICIAN_SIGNER_CAPACITIES } from "../physician-authority";

/** 42 CFR 418.25(a) / 418.26(b) — the physician signer capacities (physician-authority.ts). */
export const PhysicianSignerCapacitySchema = Type.Union(
  PHYSICIAN_SIGNER_CAPACITIES.map((c) => Type.Literal(c)),
);

/**
 * 42 CFR 418.26(b) (effective 2026-10-01) — the written physician discharge order. Required (service-enforced,
 * `DISCHARGE_ORDER_REQUIRED`) for a live non-death, non-for-cause discharge dated on/after 2026-10-01. The
 * signer is a USER the server validates against the signer set; `capacity` is a claim that must be backed.
 */
export const DischargeOrderSchema = Type.Object({
  signedByUserId: Uuid(),
  signedAt: Type.String({ format: "date-time" }),
  capacity: Type.Optional(PhysicianSignerCapacitySchema),
  orderText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  orderReference: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

export const DischargeCreateSchema = Type.Object({
  reason: Type.Union(DISCHARGE_REASONS.map((r) => Type.Literal(r))),
  dischargeDate: Type.String({ format: "date" }),
  narrative: Reason(10, 4000),
  forCauseReason: Type.Optional(Type.String({ minLength: 20, maxLength: 2000 })),
  // R-DC-01 — required (service-enforced, see checkDischargeNarrative) when reason='death'; identifies
  // who certified the death (M40 external_physician or M2 user; app-validated, not a DB FK).
  deathCertifierId: Type.Optional(Uuid()),
  dischargeOrder: Type.Optional(DischargeOrderSchema),
  // Required (service-enforced, `checkPlaceOfDeath`) when reason='death', refused otherwise: where the
  // patient died — the claim's patient discharge status 40 / 41 / 42 (CMS Pub. 100-04 Ch. 11 §30.3).
  placeOfDeath: Type.Optional(
    Type.Union([Type.Literal("home"), Type.Literal("facility"), Type.Literal("unknown")], {
      description:
        'REQUIRED when reason is "death", refused otherwise. Where the patient died: "home", "facility" ' +
        'or "unknown". Sets the Medicare claim\'s patient discharge status — 40 (expired at home), 41 ' +
        "(expired in a medical facility) or 42 (expired, place unknown), CMS Pub. 100-04 Ch. 11 §30.3. " +
        "Missing or invalid on a death → 422 PLACE_OF_DEATH_REQUIRED; sent on another reason → 422 " +
        "PLACE_OF_DEATH_NOT_ALLOWED. A death recorded without it can be completed later with " +
        "POST /api/v1/discharges/{id}/place-of-death.",
    }),
  ),
});

/** Route 40 — the cosigning physician IS the discharge-order signer (418.26(b)); name/NPI are persisted. */
export const DischargeCosignSchema = Type.Object({
  cosignerName: Type.String({ minLength: 1, maxLength: 200 }),
  cosignerNpi: Npi(),
  capacity: Type.Optional(PhysicianSignerCapacitySchema),
  orderText: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  orderReference: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  ifVersion: Version(),
});

/** GAP-121 — a medical director declines a for-cause discharge awaiting cosign: the discharge is voided, the admission stays active. */
export const DischargeDeclineSchema = Type.Object({
  declineReason: Type.String({ minLength: 10, maxLength: 2000 }),
  ifVersion: Version(),
});

/** 42 CFR 418.26(b) — the admission's discharge order + route-40 cosigner (`GET /admissions/:id/discharge-order`). */
export const DischargeOrderResponseSchema = Type.Object({
  discharge: Type.Union([
    Type.Object({
      dischargeEventId: Type.String(),
      reason: Type.String(),
      status: Type.String(),
      dischargeDate: Type.String(),
      orderRequired: Type.Boolean(),
      order: Type.Union([
        Type.Object({
          signedByUserId: Type.String(),
          signedByName: Type.Union([Type.String(), Type.Null()]),
          capacity: PhysicianSignerCapacitySchema,
          signedAt: Type.String(),
          orderText: Type.Union([Type.String(), Type.Null()]),
          orderReference: Type.Union([Type.String(), Type.Null()]),
        }),
        Type.Null(),
      ]),
      cosigner: Type.Union([
        Type.Object({
          name: Type.String(),
          npi: Type.String(),
          cosignedAt: Type.Union([Type.String(), Type.Null()]),
        }),
        Type.Null(),
      ]),
    }),
    Type.Null(),
  ]),
});

/** 42 CFR 418.25(a) — the physician admission recommendation (route `POST /admissions/:id/admission-recommendation`). */
export const AdmissionRecommendationSchema = Type.Object({
  recommendedByUserId: Uuid(),
  recommendedAt: Type.String({ format: "date-time" }),
  capacity: Type.Optional(PhysicianSignerCapacitySchema),
  attendingConsulted: Type.Boolean(),
  attendingConsultNote: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  ifVersion: Version(),
});

/** The physicians who may sign for this admission's patient (the signer picker). */
export const PhysicianSignerListResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      userId: Type.String(),
      name: Type.Union([Type.String(), Type.Null()]),
      capacities: Type.Array(PhysicianSignerCapacitySchema),
    }),
  ),
});

// ── NOR & compliance windows (routes 41–46) ──────────────────────────────────────────────────────
const NOR_METHODS = ["wet_ink_scanned", "electronic_witnessed", "verbal_with_witness"] as const;

export const NorAcknowledgeSchema = Type.Object({
  // The current NOR acknowledgement persistence has no form-version column and the admission UI
  // has no form-version source. Keep the field accepted for forward compatibility, but do not
  // reject the functional acknowledgement flow for omitting a value that cannot be retained.
  formVersionId: Type.Optional(Uuid()),
  deliveryMethod: Type.Union(NOR_METHODS.map((m) => Type.Literal(m))),
  acknowledgedAt: Type.String({ format: "date-time" }),
  acknowledgedByName: Type.String({ minLength: 1, maxLength: 200 }),
  acknowledgedByRole: Type.Union([Type.Literal("patient"), Type.Literal("legal_representative")]),
});

export const ComplianceListQuerySchema = Type.Object({
  state: Type.Optional(Type.String({ maxLength: 32 })),
  cursor: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const ComplianceCloseSchema = Type.Object({ ifVersion: Version() });
export const ComplianceOverrideSchema = Type.Object({
  reason: Reason(20, 1000),
  ifVersion: Version(),
});

// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The read routes returned typed view shapes (`SummaryRow` / `AdmissionDetail` / `Page<SummaryRow>`) but
// published NO response contract, so the generated client typed every GET body as `never`. These DTOs
// mirror the service's read views 1:1 and are pinned to them by the compile-time `Conforms` aliases below,
// so a view field added or renamed breaks `bun run build` rather than silently drifting from the client.
export const SummaryRowResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const NullableDetailString = Type.Union([Type.String(), Type.Null()]);
export const NorDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(NullableDetailString),
  acknowledgedAt: Type.Optional(NullableDetailString),
  acknowledgedAtInstant: Type.Optional(NullableDetailString),
  acknowledgedByName: Type.Optional(NullableDetailString),
  acknowledgedByRole: Type.Optional(Type.String()),
  deliveryMethod: Type.Optional(Type.String()),
});
export const ElectionStatementDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(NullableDetailString),
  electionPeriodId: Type.Optional(Type.String()),
  effectiveDate: Type.Optional(NullableDetailString),
  primaryDiagnosisIcd10: Type.Optional(NullableDetailString),
  electedProviderEntityId: Type.Optional(NullableDetailString),
  electedAttendingPhysicianId: Type.Optional(NullableDetailString),
  waiverAcknowledged: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  stateAddendum: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  signerKind: Type.Optional(Type.String()),
  signedAt: Type.Optional(NullableDetailString),
});
export const CtiDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(NullableDetailString),
  electionPeriodId: Type.Optional(Type.String()),
  hospiceMedicalDirectorId: Type.Optional(Type.String()),
  attendingPhysicianId: Type.Optional(NullableDetailString),
  terminalDiagnosisIcd10: Type.Optional(NullableDetailString),
  secondaryDiagnoses: Type.Optional(Type.Array(Type.String())),
  prognosisStatement: Type.Optional(NullableDetailString),
  narrative: Type.Optional(NullableDetailString),
  clinicalFindings: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  ),
  hospiceMdSignedAt: Type.Optional(NullableDetailString),
  attendingMdSignedAt: Type.Optional(NullableDetailString),
  periodStart: Type.Optional(NullableDetailString),
  periodEnd: Type.Optional(NullableDetailString),
});
export const F2fDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(NullableDetailString),
  electionPeriodId: Type.Optional(Type.String()),
  scheduledClinicianId: Type.Optional(Type.String()),
  clinicianRole: Type.Optional(Type.String()),
  scheduledDate: Type.Optional(NullableDetailString),
  encounterDate: Type.Optional(NullableDetailString),
  requestedWindowStart: Type.Optional(NullableDetailString),
  requestedWindowEnd: Type.Optional(NullableDetailString),
  authoritativeWindowStart: Type.Optional(NullableDetailString),
  authoritativeWindowEnd: Type.Optional(NullableDetailString),
  withinWindow: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  windowOverride: Type.Optional(Type.Boolean()),
  attestationSignedAt: Type.Optional(NullableDetailString),
});
export const ElectionPeriodDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(NullableDetailString),
  sequenceNumber: Type.Optional(Type.Integer()),
  expectedStart: Type.Optional(NullableDetailString),
  effectiveAt: Type.Optional(NullableDetailString),
  scheduledEndAt: Type.Optional(NullableDetailString),
  actualEndAt: Type.Optional(NullableDetailString),
});
export const ElectionPeriodListResponseSchema = Type.Object({
  items: Type.Array(ElectionPeriodDetailResponseSchema),
});

/** Route 6 (accept) — the referral's post-accept summary + the `admission.draft_from_referral` seed's id. */
export const ReferralAcceptResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  admissionId: Type.String(),
});

const ActivationGapSchema = Type.Union([
  Type.Literal("election_signed"),
  Type.Literal("nor_acknowledged"),
  Type.Literal("cti_signed"),
]);

/** Route 10 — the admission aggregate: summary + the R-AC-01 activation gate (§7.2 / §5.2.5). */
export const AdmissionDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(Type.String()),
  referralId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  admissionAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  activatedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  providerEntityId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  locationId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  patientResidenceAddressId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  serviceAddressSnapshot: Type.Optional(
    Type.Union([
      Type.Object({
        line1: Type.String(),
        line2: Type.Union([Type.String(), Type.Null()]),
        city: Type.String(),
        state: Type.Union([Type.String(), Type.Null()]),
        postalCode: Type.String(),
        country: Type.String(),
      }),
      Type.Null(),
    ]),
  ),
  hospicePhysicianId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  hospicePhysician: Type.Optional(
    Type.Union([
      Type.Object({
        id: Type.String(),
        displayName: Type.String(),
        npi: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
  attendingPhysicianId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // UB-04 FL 14 / FL 15 (837I CL101 / CL102) a hospice claim carries; null until recorded on the admission.
  admissionTypeCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  admissionSourceCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  // 42 CFR 418.25(a) — the recorded physician admission recommendation (null until recorded).
  admissionRecommendation: Type.Optional(
    Type.Union([
      Type.Object({
        recommendedByUserId: Type.String(),
        capacity: PhysicianSignerCapacitySchema,
        recommendedAt: Type.String(),
        attendingConsulted: Type.Boolean(),
        attendingConsultNote: Type.Union([Type.String(), Type.Null()]),
      }),
      Type.Null(),
    ]),
  ),
  activationGate: Type.Object({
    ready: Type.Boolean(),
    missing: Type.Array(ActivationGapSchema),
  }),
});

const RequirementStatusSchema = Type.Union([
  Type.Literal("complete"),
  Type.Literal("action_required"),
  Type.Literal("awaiting_signature"),
  Type.Literal("pending"),
  Type.Literal("blocked"),
  Type.Literal("overdue"),
  Type.Literal("not_applicable"),
]);

const RequirementActionSchema = Type.Union([
  Type.Literal("RESOLVE_PATIENT"),
  Type.Literal("COMPLETE_ADMISSION_DETAILS"),
  Type.Literal("REVIEW_PRIVACY"),
  Type.Literal("COMPLETE_NOTICE_OF_RIGHTS"),
  Type.Literal("COMPLETE_ELECTION_STATEMENT"),
  Type.Literal("COMPLETE_ELECTION_SIGNATURE"),
  Type.Literal("COMPLETE_CTI"),
  Type.Literal("COMPLETE_CTI_SIGNATURE"),
  Type.Literal("REVIEW_F2F"),
  Type.Literal("RECORD_ADMISSION_RECOMMENDATION"),
  Type.Literal("COMPLETE_ELECTION_ADDENDUM"),
]);

const RequirementEvidenceSchema = Type.Object({
  sourceType: Type.Union([Type.Literal("structured"), Type.Literal("uploaded")]),
  evidenceId: Type.String(),
  documentId: Type.Optional(Type.String()),
  documentVersionId: Type.Optional(Type.String()),
  structuredEntityId: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
});

/** `patient_privacy`'s blocked reason (activation-gate.ts `PrivacyReasonCode`) — category-free. */
const RequirementReasonCodeSchema = Type.Union([
  Type.Literal("INTAKE_DETECTION_UNREVIEWED"),
  Type.Literal("CONSENT_REQUIRED"),
  Type.Literal("RESTRICTED"),
  Type.Literal("PATIENT_NOT_FOUND"),
  Type.Literal("PRIVACY_CLEARANCE_UNAVAILABLE"),
]);

const RequirementCodeSchema = Type.Union([
  Type.Literal("patient_identity"),
  Type.Literal("admission_details"),
  Type.Literal("patient_privacy"),
  Type.Literal("notice_of_rights"),
  Type.Literal("election_statement"),
  Type.Literal("cti"),
  Type.Literal("f2f"),
  Type.Literal("admission_recommendation"),
  Type.Literal("election_addendum"),
]);

export const AdmissionReadinessResponseSchema = Type.Object({
  admissionId: Type.String(),
  status: Type.Union([
    Type.Literal("blocked"),
    Type.Literal("action_required"),
    Type.Literal("ready"),
  ]),
  canActivate: Type.Boolean(),
  completed: Type.Integer(),
  blockingRemaining: Type.Integer(),
  requirements: Type.Array(
    Type.Object({
      code: RequirementCodeSchema,
      label: Type.String(),
      status: RequirementStatusSchema,
      blocking: Type.Boolean(),
      message: Type.Optional(Type.String()),
      action: Type.Optional(RequirementActionSchema),
      satisfiedBy: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("override")])),
      evidence: Type.Optional(RequirementEvidenceSchema),
      reasonCode: Type.Optional(RequirementReasonCodeSchema),
    }),
  ),
});

/** FY2027 — a compliance-window worklist row: the summary plus the window kind, admission and due instant. */
export const ComplianceWindowRowResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  admissionId: Type.Optional(Type.String()),
  windowKind: Type.Optional(Type.String()),
  severity: Type.Optional(Type.String()),
  dueAt: Type.Optional(Type.String()),
});
/** The bounded `{ items }` envelope of one admission's windows (no cursor). */
export const ComplianceWindowItemsResponseSchema = Type.Object({
  items: Type.Array(ComplianceWindowRowResponseSchema),
});
export const ComplianceWindowPageResponseSchema = Type.Object({
  items: Type.Array(ComplianceWindowRowResponseSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** The cursor-paginated page the list routes return (`{ items, nextCursor }`). */
export const SummaryPageResponseSchema = Type.Object({
  items: Type.Array(SummaryRowResponseSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** F-238 — `GET /api/v1/referrals`'s row: the summary plus who the referral is about, so a client can offer a
 *  referral LOOKUP (filing a prospect's older records against it). The DB service returns the full
 *  `ReferralReadView`; the extra fields are optional because the in-memory slice returns the summary only. */
export const ReferralListItemResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  patientResolutionStatus: Type.Optional(Type.String()),
  patientNameAtReceipt: Type.Optional(Type.String()),
  patientDobAtReceipt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  referrerOrganization: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  assignedToUserId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  assignedToDisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  receivedAt: Type.Optional(Type.String()),
});
export const ReferralListResponseSchema = Type.Object({
  items: Type.Array(ReferralListItemResponseSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** F-195 (#248) — `GET /api/v1/admissions`'s own row, widened with the hold/resume facts M6's spec
 *  (line 2983) names as "M30's operational dashboard" data — a dedicated schema, not a `SummaryRowResponseSchema`
 *  widening, since that shape is shared with the referral list (no hold concept). */
export const AdmissionSummaryResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  patientId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  holdReason: Type.Union([Type.String(), Type.Null()]),
  holdAt: Type.Union([Type.String(), Type.Null()]),
  releasedAt: Type.Union([Type.String(), Type.Null()]),
});

/** `GET /api/v1/admissions`'s own paginated page. */
export const AdmissionSummaryPageResponseSchema = Type.Object({
  items: Type.Array(AdmissionSummaryResponseSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** The bounded `{ items }` envelope the per-admission sub-list reads return (no cursor). */
export const SummaryItemsResponseSchema = Type.Object({
  items: Type.Array(SummaryRowResponseSchema),
});

// Patient-scoped Election & Certification aggregate (patient-chart tab). `admission` is null when the
// patient has no admission yet; the ladders are then empty. Dates are ISO strings (timestamps) or date
// strings. The period's calendar and status are typed; nested evidence bundles remain unknown here
// because publishing their full depth exceeds the generated client's TypeScript instantiation limit.
// The rich bundle shape remains `PatientElectionCertificationView.periods` in the service.
const NullableStr = Type.Union([Type.String(), Type.Null()]);
export const PatientElectionCertificationResponseSchema = Type.Object({
  admission: Type.Union([
    Type.Object({
      id: Type.String(),
      state: Type.String(),
      admissionAt: NullableStr,
      activatedAt: NullableStr,
      dischargedAt: NullableStr,
      version: Type.Integer(),
    }),
    Type.Null(),
  ]),
  periods: Type.Array(
    Type.Object({
      id: Type.String(),
      sequenceNumber: Type.Integer(),
      periodKind: Type.String(),
      effectiveAt: NullableStr,
      scheduledEndAt: NullableStr,
      actualEndAt: NullableStr,
      status: Type.String(),
      electionStatement: Type.Unknown(),
      cti: Type.Unknown(),
      faceToFace: Type.Unknown(),
    }),
  ),
  complianceWindows: Type.Array(
    Type.Object({
      id: Type.String(),
      windowKind: Type.String(),
      severity: Type.String(),
      status: Type.String(),
      mustCompleteBy: Type.String(),
      closedAt: NullableStr,
    }),
  ),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _SummaryRow = Conforms<Static<typeof SummaryRowResponseSchema>, ServiceSummaryRow>;
// F-238 — the DB service's referral read view satisfies the published list row.
type _ReferralListItem = Conforms<
  ServiceReferralReadView,
  Static<typeof ReferralListItemResponseSchema>
>;
type _ReferralAccept = Conforms<
  Static<typeof ReferralAcceptResponseSchema>,
  ServiceMutationResult & { admissionId: string }
>;
type _AdmissionDetail = Conforms<
  Static<typeof AdmissionDetailResponseSchema>,
  ServiceAdmissionDetail
>;
type _AdmissionReadiness = Conforms<
  Static<typeof AdmissionReadinessResponseSchema>,
  ServiceAdmissionReadinessResult
>;
type _SummaryPage = Conforms<
  Static<typeof SummaryPageResponseSchema>,
  ServicePage<ServiceSummaryRow>
>;
type _AdmissionSummaryPage = Conforms<
  Static<typeof AdmissionSummaryPageResponseSchema>,
  ServicePage<ServiceAdmissionSummary>
>;
type _SummaryItems = Conforms<
  Static<typeof SummaryItemsResponseSchema>,
  { readonly items: readonly ServiceSummaryRow[] }
>;
// The published election/cert schema keeps `admission` + `complianceWindows` pinned to the service view;
// `periods` is intentionally loose (see the schema note), so we pin only the flat, non-nested slices.
type _PatientElectionCertFlat = Conforms<
  Pick<
    Static<typeof PatientElectionCertificationResponseSchema>,
    "admission" | "complianceWindows"
  >,
  Pick<ServicePatientElectionCert, "admission" | "complianceWindows">
>;

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
