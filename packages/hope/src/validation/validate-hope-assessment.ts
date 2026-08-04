// @wardenx/hope — the CMS HOPE pre-submission validator (M10-T04; §2.3, §3, §86). PURE, IO-free,
// deterministic — the §9.1 coverage target. Runs the CMS HOPE submission rule set over ONE signed
// `hope_assessment` and returns a `hope_validation_finding` descriptor per violation; it never throws and
// never mutates. The recording service (M10-T06) calls this on every signed assessment + on any tenant
// value-set update affecting the M38 codes M10 consumes, persists the descriptors as rows, and blocks
// iQIES submission while any unresolved `error` finding exists (`hasBlockingError`). Distinct from the
// record-time guards in `../recording/timepoint-gate.ts`: those THROW the §4.4 code at write time; the
// pre-submission rules ACCUMULATE findings so the whole assessment is reported at once.
//
// Every fact is injected (the value-set oracle pre-resolved from M38 as of target_date; the sibling
// timepoint dates; the iQIES envelope identifiers) — the engine imports only `@wardenx/types` and this
// package's own pure helpers, so there is no cross-module schema edge.
import type { HopeDischargeReason, HopeRfaKind, IsoInstant } from "@wardenx/types";
import { missingRequiredSections } from "../sections/required-items";
import { HOPE_VALIDATION_RULES, type HopeValidationFindingDescriptor, finding } from "./findings";
import type { HopeValueSetOracle } from "./value-set-oracle";

/** Section I (Active Diagnoses) — the validation-relevant projection of `data.I`. */
export interface SectionIInput {
  /** Hospice terminal ICD-10-CM primary diagnosis; null when the section is absent/unset. */
  readonly primaryDiagnosisIcd10: string | null;
}

/** Section J (Health Conditions) — the validation-relevant projection of `data.J` (§2.1). */
export interface SectionJInput {
  /** J2030 — pain screened "Yes". */
  readonly painScreenedYes: boolean;
  /** Pain characteristics captured (required when J2030 = Yes). */
  readonly painCharacteristicsPresent: boolean;
  /** J2050 — shortness-of-breath screened "Yes". */
  readonly dyspneaScreenedYes: boolean;
  /** Dyspnea characteristics captured (required when J2050 = Yes). */
  readonly dyspneaCharacteristicsPresent: boolean;
  /** The J-item / symptom codes recorded in J2051 (validated against the M38 HOPE J-code value set). */
  readonly jCodes: readonly string[];
}

/** Section N (Medications) — the validation-relevant projection of `data.N` (§2.1). */
export interface SectionNInput {
  readonly opioidPrescribed: boolean;
  readonly scheduledBowelRegimenPresent: boolean;
  readonly bowelRegimenContraindicationDocumented: boolean;
}

/** iQIES envelope-level identifiers cross-checked against the admission / patient snapshots (§2.3). */
export interface IqiesEnvelopeInput {
  readonly assessmentCcn: string;
  readonly admissionCcnAtElection: string;
  readonly assessmentMbi: string;
  readonly patientMbiSnapshot: string;
}

/** Cross-RFA temporal context (sibling target dates), injected from the admission's timepoint set. Only
 * meaningful for HUV1 (needs the Admission date) and HUV2 (needs the HUV1 date). */
export interface TemporalContextInput {
  readonly targetDate: IsoInstant;
  readonly admissionTargetDate?: IsoInstant | null;
  readonly huv1TargetDate?: IsoInstant | null;
}

/** The full pre-submission validation input for one signed `hope_assessment`. */
export interface HopeAssessmentValidationInput {
  readonly rfaKind: HopeRfaKind;
  /** The Discharge-RFA branch (D9); null for non-discharge RFAs. */
  readonly dischargeReason: HopeDischargeReason | null;
  /** The HOPE Section letters present in the typed `data` payload (§2.1). */
  readonly presentSections: readonly string[];
  readonly sectionI: SectionIInput;
  readonly sectionJ: SectionJInput;
  readonly sectionN: SectionNInput;
  readonly envelope: IqiesEnvelopeInput;
  /** Optional — supplied for HUV1/HUV2 cross-RFA temporal checks. */
  readonly temporal?: TemporalContextInput;
}

const norm = (s: string): string => s.trim().toUpperCase();

/**
 * §2.3 / §3 / §86 — run the CMS HOPE pre-submission rule set over one signed assessment and return every
 * violation as a finding descriptor (errors block submission; warnings are advisory). Deterministic and
 * side-effect-free: the same input always yields the same ordered findings.
 */
export function validateHopeAssessment(
  input: HopeAssessmentValidationInput,
  oracle: HopeValueSetOracle,
): readonly HopeValidationFindingDescriptor[] {
  const findings: HopeValidationFindingDescriptor[] = [];

  // 1. Required-items-per-RFA presence (§2.3 matrix) — each missing section is one blocking error.
  for (const section of missingRequiredSections(input.rfaKind, input.presentSections)) {
    findings.push(
      finding(
        HOPE_VALIDATION_RULES.REQUIRED_SECTION_MISSING,
        "error",
        section,
        `Required Section ${section} is missing for RFA ${input.rfaKind}.`,
      ),
    );
  }

  // 2. Section I — primary diagnosis ∈ M38 active hospice-terminal-diagnosis value set (§86). Only the
  // comprehensive + discharge instruments carry a diagnosis section (the focused SFV does not).
  if (sectionIIsRelevant(input.rfaKind)) {
    const dx = input.sectionI.primaryDiagnosisIcd10;
    if (dx != null && dx.trim() !== "" && !oracle.isHospiceTerminalDiagnosis(dx)) {
      findings.push(
        finding(
          HOPE_VALIDATION_RULES.SECTION_I_DIAGNOSIS_NOT_IN_VALUE_SET,
          "error",
          "I",
          `Section I primary diagnosis '${norm(dx)}' is not in the active hospice terminal diagnosis value set at the assessment target date.`,
          norm(dx),
        ),
      );
    }
  }

  // 3. Section J — every recorded J-code ∈ the M38 CMS HOPE J-code value set (M10-F07: transposed codes
  // are corrected against the CMS value set). Advisory: the server-authoritative J2051 trigger already
  // fired on severity regardless of the code label, so an unrecognised code is a warning, not a blocker.
  for (const jCode of input.sectionJ.jCodes) {
    if (jCode.trim() !== "" && !oracle.isRecognizedHopeJCode(jCode)) {
      findings.push(
        finding(
          HOPE_VALIDATION_RULES.SECTION_J_CODE_NOT_IN_VALUE_SET,
          "warning",
          "J",
          `Section J code '${norm(jCode)}' is not in the CMS HOPE J-code value set.`,
          norm(jCode),
        ),
      );
    }
  }

  // 4. Section J cross-field consistency (§86): screened-Yes implies characteristics captured.
  if (input.sectionJ.painScreenedYes && !input.sectionJ.painCharacteristicsPresent) {
    findings.push(
      finding(
        HOPE_VALIDATION_RULES.J2030_PAIN_CHARACTERISTICS_MISSING,
        "error",
        "J",
        "J2030 indicates pain screened 'Yes' but pain characteristics are not documented.",
        "J2030",
      ),
    );
  }
  if (input.sectionJ.dyspneaScreenedYes && !input.sectionJ.dyspneaCharacteristicsPresent) {
    findings.push(
      finding(
        HOPE_VALIDATION_RULES.J2050_DYSPNEA_CHARACTERISTICS_MISSING,
        "error",
        "J",
        "J2050 indicates shortness of breath screened 'Yes' but dyspnea characteristics are not documented.",
        "J2050",
      ),
    );
  }

  // 5. Section N consistency (§2.3): opioid ⇒ scheduled bowel regimen or documented contraindication.
  // Advisory clinical best-practice — does not block the CMS submission.
  if (
    input.sectionN.opioidPrescribed &&
    !input.sectionN.scheduledBowelRegimenPresent &&
    !input.sectionN.bowelRegimenContraindicationDocumented
  ) {
    findings.push(
      finding(
        HOPE_VALIDATION_RULES.SECTION_N_BOWEL_REGIMEN_MISSING,
        "warning",
        "N",
        "An opioid is prescribed without a scheduled bowel regimen or a documented contraindication.",
      ),
    );
  }

  // 6. Section Q for the Discharge RFA (§2.3 / D9): death omits Q; every live branch requires it.
  if (input.rfaKind === "05_discharge") {
    const qPresent = new Set(input.presentSections).has("Q");
    if (input.dischargeReason === "death" && qPresent) {
      findings.push(
        finding(
          HOPE_VALIDATION_RULES.SECTION_Q_FORBIDDEN,
          "error",
          "Q",
          "Section Q (Participation) is present on a death-discharge HOPE assessment (forbidden, D9).",
        ),
      );
    }
    if (input.dischargeReason != null && input.dischargeReason !== "death" && !qPresent) {
      findings.push(
        finding(
          HOPE_VALIDATION_RULES.SECTION_Q_REQUIRED,
          "error",
          "Q",
          `Section Q (Participation) is required on a '${input.dischargeReason}' discharge HOPE assessment (D9).`,
        ),
      );
    }
  }

  // 7. Cross-RFA temporal order (§2.3): HUV1 target > Admission target; HUV2 target > HUV1 target.
  if (input.temporal) {
    const { targetDate, admissionTargetDate, huv1TargetDate } = input.temporal;
    if (
      input.rfaKind === "02_huv1" &&
      admissionTargetDate != null &&
      !isAfter(targetDate, admissionTargetDate)
    ) {
      findings.push(
        finding(
          HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER,
          "error",
          "A",
          "HUV1 target date is not after the Admission target date.",
        ),
      );
    }
    if (
      input.rfaKind === "03_huv2" &&
      huv1TargetDate != null &&
      !isAfter(targetDate, huv1TargetDate)
    ) {
      findings.push(
        finding(
          HOPE_VALIDATION_RULES.CROSS_RFA_TEMPORAL_ORDER,
          "error",
          "A",
          "HUV2 target date is not after the HUV1 target date.",
        ),
      );
    }
  }

  // 8. iQIES envelope-level constraints (§2.3): CCN + MBI match the admission / patient snapshots.
  if (norm(input.envelope.assessmentCcn) !== norm(input.envelope.admissionCcnAtElection)) {
    findings.push(
      finding(
        HOPE_VALIDATION_RULES.ENVELOPE_CCN_MISMATCH,
        "error",
        "ENVELOPE",
        "ProviderEntity CCN does not match the admission's CCN at election.",
      ),
    );
  }
  if (norm(input.envelope.assessmentMbi) !== norm(input.envelope.patientMbiSnapshot)) {
    findings.push(
      finding(
        HOPE_VALIDATION_RULES.ENVELOPE_MBI_MISMATCH,
        "error",
        "ENVELOPE",
        "Patient MBI does not match the election-time snapshot.",
      ),
    );
  }

  return findings;
}

/** True when Section I is part of the instrument for `rfaKind` (the comprehensive + discharge RFAs; the
 * focused SFV does not carry a diagnosis section). */
function sectionIIsRelevant(rfaKind: HopeRfaKind): boolean {
  return rfaKind !== "04_sfv";
}

/** Strict instant ordering (`a` strictly after `b`), comparing parsed UTC milliseconds. */
function isAfter(a: IsoInstant, b: IsoInstant): boolean {
  return Date.parse(a) > Date.parse(b);
}
