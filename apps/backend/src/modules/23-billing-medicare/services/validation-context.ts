// apps/backend/src/modules/23-billing-medicare/services/validation-context.ts
//
// The pure builder of the §11.A `ValidationContext` from the facts the readers returned + the claim/lines/HIPPS/
// SIA the caller holds. Shared by the claim ASSEMBLY (initial run, over the claim it has just built) and the
// RE-VALIDATION path (`claim-validation-context-port.ts`, over an existing claim) so the two cannot disagree
// about what a rule sees. No I/O, no clock: every time-dependent value (eligibility age, NOE admission day) is
// computed by the caller and passed in.
import type {
  Cents,
  EligibilitySnapshot,
  IsoDate,
  NoeStatusSnapshot,
  RhcCarryOverSnapshot,
  ValidationContext,
  calculateHipps,
  repositories,
} from "@wardenx/billing";
import { claimAdmissionCodes, claimValueCodes } from "@wardenx/billing";
import type { AssemblyFacts } from "./claim-assembly-facts";
import { qCodeForPlaceOfService, visitLinesFor, visitReportingOf } from "./claim-assembly-lines";
import { claimDischargeCodes } from "./claim-discharge";

/** The claim-row facts the rules read (the rest of `ClaimSnapshot` comes from the admission/diagnosis facts). */
export interface ClaimFactsInput {
  readonly claimId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly tob: ValidationContext["claim"]["tob"];
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  readonly replacesClaimId: string | null;
  readonly totalChargeCents: Cents;
  readonly priorClaimTob: ValidationContext["claim"]["priorClaimTob"];
  readonly priorClaimServiceTo: IsoDate | null;
}

export interface AssembleValidationContextInput {
  readonly orgId: string;
  readonly facts: AssemblyFacts;
  readonly claim: ClaimFactsInput;
  readonly lines: readonly repositories.ClaimLineRecord[];
  readonly hipps: ReturnType<typeof calculateHipps>;
  readonly siaQualifyingVisitCount: number;
  readonly siaCents: Cents;
  /** `null` when no usable HETS determination exists (or the eligibility seam is unbound) — the rule skips. */
  readonly eligibility: EligibilitySnapshot | null;
  /** `null` when the admission has no NOE row yet. */
  readonly noe: NoeStatusSnapshot | null;
  readonly eligibilityBound: boolean;
  /** The RHC carry-over the claim is priced with (`rhc-carry-over.ts`); absent ⇒ the carry rule skips. */
  readonly rhcCarryOver?: RhcCarryOverSnapshot | null;
}

export function assembleValidationContext(
  input: AssembleValidationContextInput,
): ValidationContext {
  const { orgId, facts, claim, lines, hipps } = input;
  const {
    admission,
    resolvedPeriods,
    certifications,
    faceToFace,
    resolvedLoc,
    pe,
    fiscalYearStarting,
    wageIndex,
    seqPolicy,
    billableEncounters,
    evvBrackets,
    mdmResolution,
    diagnosisRead,
    icd10Sequence,
    terminology,
    capProjectionBound,
    capProjectionCtx,
    signedEncounters,
    electionAddendum,
    valueAreas,
  } = facts;
  // One derivation for the assembly and every re-validation (claim-discharge.ts): a revocation or transfer-out
  // ends the stay too, not only a completed discharge_event.
  const { discharge, codes: dischargeClaimCodes } = claimDischargeCodes(
    admission,
    resolvedPeriods,
    claim.serviceTo,
  );
  return {
    orgId,
    asOfDate: claim.serviceFrom,
    macJurisdiction: pe.macJurisdiction,
    claim: {
      claimId: claim.claimId,
      providerEntityId: claim.providerEntityId,
      patientId: claim.patientId,
      admissionId: admission.admissionId,
      tob: claim.tob,
      serviceFrom: claim.serviceFrom,
      serviceTo: claim.serviceTo,
      replacesClaimId: claim.replacesClaimId,
      icd10Sequence,
      diagnosesWithheldForConsent: diagnosisRead.withheldForConsentCount,
      terminalDiagnosisWithheldForConsent: diagnosisRead.terminalWithheldForConsent,
      totalChargeCents: claim.totalChargeCents,
      priorClaimTob: claim.priorClaimTob,
      priorClaimServiceTo: claim.priorClaimServiceTo,
      dischargeDate: discharge?.effectiveDate ?? null,
      dischargeReason: discharge?.kind ?? null,
      deathDate: discharge?.deathDate ?? null,
      dischargeClaimCodes,
      dischargeSourceEventId: discharge?.sourceEventId ?? null,
      ...claimAdmissionCodes(admission),
      ...(valueAreas
        ? {
            valueCodes: claimValueCodes(
              lines.map((l) => l.revenueCode),
              valueAreas,
            ),
          }
        : {}),
    },
    lines: lines.map((row) => ({
      claimLineId: row.id,
      serviceDate: row.serviceDateFrom,
      revenueCode: row.revenueCode,
      qCode: row.qCode,
      levelOfCare: row.levelOfCare,
      hcpcs: row.hcpcsCode,
      modifiers: row.modifiers,
      unitCount: row.unitCount,
      unitRateCents: row.unitRateCents,
      lineChargeCents: row.lineChargeCents,
      icdPointerPositions: row.icdPointerPositions,
      backingEncounterIds: row.backingEncounterIds,
    })),
    electionPeriods: resolvedPeriods.map(({ electionPeriodId: _id, ...rest }) => rest),
    certifications,
    faceToFace,
    levelOfCarePeriods: resolvedLoc.map(({ levelOfCarePeriodId: _id, ...rest }) => rest),
    billableEncounters,
    signedEncounters,
    evvBrackets,
    terminology,
    mdm: mdmResolution,
    hipps: {
      perDiemClassCode: hipps.perDiemClassCode,
      perDiemRateCents: hipps.perDiemRateCents,
      wageIndexFactorApplied: wageIndex.factorDecimal,
      segments: hipps.segments.map((s) => ({
        levelOfCare: s.levelOfCare,
        dateFrom: s.dateFrom,
        dateTo: s.dateTo,
        ratePerDiemCents: s.ratePerDiemCents,
        rhcDayBucket: s.rhcDayBucket,
      })),
    },
    sia:
      input.siaQualifyingVisitCount > 0
        ? {
            present: true,
            qualifyingVisitCount: input.siaQualifyingVisitCount,
            amountCents: input.siaCents,
            doubleCounted: false,
          }
        : null,
    capProjection: capProjectionCtx, // M26 §11.A live projection (or null → cap rules warn-skip, D8)
    eligibility: input.eligibility,
    noe: input.noe,
    rhcCarryOver: input.rhcCarryOver ?? null,
    sequestration: {
      percentage: seqPolicy.percentage,
      effectiveFrom: seqPolicy.effectiveFrom,
      effectiveTo: seqPolicy.effectiveTo,
    },
    wageIndex: {
      ccn: pe.ccn,
      fiscalYearStarting,
      factorDecimal: wageIndex.factorDecimal,
      cbsaCode: wageIndex.cbsaCode,
    },
    ...(electionAddendum ? { electionAddendum } : {}),
    // The visits the assembly could not report (the SAME derivation the assembly built its lines from).
    visitReporting: visitReportingOf(
      visitLinesFor({
        billableEncounters,
        resolvedLoc,
        qCode: qCodeForPlaceOfService(mdmResolution.placeOfService),
      }),
    ),
    seams: {
      capProjectionBound,
      mdmResolverBound: true,
      terminologyBound: true,
      eligibilityBound: input.eligibilityBound,
    },
  };
}
