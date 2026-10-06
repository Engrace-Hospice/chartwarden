// apps/backend/src/modules/23-billing-medicare/services/claim-assembly-facts.ts
//
// The ONE place the claim-affecting facts are read from the consumed reader seams (M6 admission / election /
// certification / F2F / level of care, M40 provider + clinical participants, M23 reference data, M8 encounters,
// M18 EVV, M7 diagnoses, M38 terminology, M26 cap projection). Extracted from `claim-assembly.ts` so the
// assembly (which builds a DRAFT claim from these facts) and the re-validation path (GAP-070: the
// `validation-run` worker re-materialises the §11.A `ValidationContext` for an EXISTING claim) read them the
// same way and cannot drift apart. Behaviour of the assembly is unchanged: the block below is the former
// "walk the reader seams" step, moved verbatim (only the typed result object is new).
import {
  type Cents,
  ChcHoursError,
  type HippsRateTable,
  type SignedEncounterSnapshot,
  addDaysIso,
  calculateHipps,
  calculateSia,
} from "@wardenx/billing";
import { WardenXError } from "@wardenx/types";
import type { ClaimAssemblySeams, DateRange } from "./claim-assembly-types";

/** The CMS hospice fiscal year STARTING year for a service date (the rate year flips each Oct 1). */
export function hospiceFiscalYearStarting(serviceFrom: string): number {
  const year = Number(serviceFrom.slice(0, 4));
  const month = Number(serviceFrom.slice(5, 7));
  return month >= 10 ? year : year - 1;
}

export interface AssemblyFactsInput {
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
}

export async function readAssemblyFacts(
  seams: ClaimAssemblySeams,
  orgId: string,
  input: AssemblyFactsInput,
) {
  const { providerEntityId, patientId, serviceFrom, serviceTo } = input;
  const range: DateRange = { from: serviceFrom, to: serviceTo };
  const admission = await seams.admission.resolveForRange(orgId, patientId, range);
  if (!admission) {
    throw new WardenXError(
      "PATIENT_NOT_ELECTED",
      "no hospice admission covers the service window",
      409,
    );
  }
  if (admission.deceasedDate !== null && admission.deceasedDate < serviceFrom) {
    throw new WardenXError(
      "PATIENT_DECEASED_BEFORE_FROM",
      "the patient died before the claim's service_from",
      409,
    );
  }

  const resolvedPeriods = [
    ...(await seams.electionPeriods.coveringRange(orgId, patientId, range)),
  ].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );
  if (resolvedPeriods.length === 0) {
    throw new WardenXError(
      "PATIENT_NOT_ELECTED",
      "no active election covers the service window",
      409,
    );
  }
  const certifications = await seams.certifications.forPatient(orgId, patientId, range);
  const faceToFace = await seams.faceToFace.forPatient(orgId, patientId, range);
  const resolvedLoc = await seams.levelOfCare.periodsInRange(orgId, patientId, range);

  const pe = await seams.mdm.resolveProviderEntity(orgId, providerEntityId);
  if (!pe) {
    throw new WardenXError(
      "PROVIDER_ENTITY_UNRESOLVED",
      "the provider entity could not be resolved (M40)",
      422,
    );
  }
  const fiscalYearStarting = hospiceFiscalYearStarting(serviceFrom);
  const wageIndex = await seams.referenceData.wageIndexForCcn(pe.ccn, fiscalYearStarting, orgId);
  if (!wageIndex) {
    throw new WardenXError(
      "WAGE_INDEX_UNAVAILABLE",
      `no authoritative wage-index factor is available for CCN ${pe.ccn} fiscal year starting ${fiscalYearStarting} (D12); enter it (POST /api/v1/billing/wage-indexes, permission billing.wage_index.admin) and retry`,
      422,
    );
  }
  const rateScope = { orgId, providerEntityId, serviceFrom };
  const rateTable = await seams.referenceData.hippsRateTable(
    pe.macJurisdiction,
    fiscalYearStarting,
    rateScope,
  );
  const seqPolicy = await seams.referenceData.activeSequestrationPolicy(
    orgId,
    providerEntityId,
    serviceFrom,
  );
  if (!seqPolicy) {
    throw new WardenXError(
      "SEQUESTRATION_POLICY_UNAVAILABLE",
      `no sequestration policy covers service date ${serviceFrom} for provider entity ${providerEntityId} (D11); enter the Medicare sequestration schedule for that period (POST /api/v1/billing/sequestration-policies, permission billing.sequestration_policy.edit) and retry`,
      422,
    );
  }

  const billableEncounters = await seams.billableEncounters.forRange(
    orgId,
    providerEntityId,
    patientId,
    range,
  );
  const billableIds = billableEncounters
    .filter((e) => e.billability === "billable") // D10: awaiting_cosignature excluded entirely
    .map((e) => e.encounterId);
  const evvBrackets = await seams.evvCompliance.bracketsForEncounters(orgId, billableIds);
  const mdmResolution = await seams.mdm.resolveClinicalParticipants(
    orgId,
    patientId,
    serviceFrom,
    range,
  );
  // F-209 (#251) — the claim's real diagnosis sequence (M7), read BEFORE terminology so M38 can resolve
  // `icd10Billable` for exactly these codes. Not persisted to a claim column (no such column exists).
  const diagnosisRead = await seams.diagnoses.forRange(orgId, patientId, range);
  const icd10Sequence = diagnosisRead.sequence;
  const terminology = await seams.terminology.resolveForClaim(
    orgId,
    serviceFrom,
    icd10Sequence.map((d) => d.code),
  );
  // Line pointer policy (documented, deliberately simple): every line points at the TERMINAL diagnosis
  // position(s) only. Hospice per-diem lines all bill the terminal illness; a related/unrelated
  // condition is claim-level context, never a line-level pointer. No terminal ⇒ no pointer (the
  // `icd10_sequencing` rule reports the missing principal).
  const icdPointerPositions = icd10Sequence
    .filter((d) => d.relationship === "terminal")
    .map((d) => d.position);
  // M26 §11.A cap projection (D8). Cap year is the federal FY (Oct–Sep): a service date in Oct–Dec
  // belongs to the NEXT FY. The provider degrades to status:"unavailable" when M26 is unbound or has no
  // projection — the cap rules then warn-skip; a bound projection makes them live (warn-or-block, D8).
  const capServiceYear = Number(serviceFrom.slice(0, 4));
  const capServiceMonth = Number(serviceFrom.slice(5, 7));
  const capYear = capServiceMonth >= 10 ? capServiceYear + 1 : capServiceYear;
  const [capOrg, capPatient] = await Promise.all([
    seams.capProjection.projectionForOrg(orgId, providerEntityId, capYear),
    seams.capProjection.projectionForPatient(orgId, patientId, capYear),
  ]);
  const capProjectionBound = capOrg.status === "ok" && capPatient.status === "ok";
  const capProjectionCtx = capProjectionBound
    ? {
        patientWithinCap: capPatient.withinCap ?? true,
        orgPctOfCap: capOrg.pctOfCap ?? 0,
        ipuWithinCap: capOrg.ipuWithinCap ?? true,
      }
    : null;

  // SIA only when deceased; gather the last-7-days-of-life signed visits.
  let signedEncounters: readonly SignedEncounterSnapshot[] = [];
  if (admission.deceasedDate !== null) {
    const window: DateRange = {
      from: addDaysIso(admission.deceasedDate, -6),
      to: admission.deceasedDate,
    };
    signedEncounters = await seams.signedEncounters.inWindow(orgId, patientId, window);
  }
  return {
    admission,
    resolvedPeriods,
    certifications,
    faceToFace,
    resolvedLoc,
    pe,
    fiscalYearStarting,
    wageIndex,
    rateScope,
    rateTable,
    seqPolicy,
    billableEncounters,
    evvBrackets,
    mdmResolution,
    diagnosisRead,
    icd10Sequence,
    terminology,
    icdPointerPositions,
    capProjectionBound,
    capProjectionCtx,
    signedEncounters,
  };
}

export type AssemblyFacts = Awaited<ReturnType<typeof readAssemblyFacts>>;

/**
 * D7 — the HIPPS per-diem derivation over the resolved level-of-care periods + rate table. Shared by the
 * assembly (which builds the claim lines from it) and the re-validation path (which compares the persisted
 * lines against a fresh derivation, so a changed LOC/rate/wage-index surfaces as a failing rule).
 */
export function computeClaimHipps(
  facts: AssemblyFacts,
  window: { readonly serviceFrom: string; readonly serviceTo: string },
): ReturnType<typeof calculateHipps> {
  const { admission, resolvedLoc, rateTable, pe, fiscalYearStarting, wageIndex } = facts;
  try {
    return calculateHipps({
      claimServiceFrom: window.serviceFrom,
      claimServiceTo: window.serviceTo,
      hospiceAdmissionDate: admission.hospiceAdmissionDate,
      levelOfCarePeriods: resolvedLoc.map((p) => ({
        levelOfCare: p.levelOfCare,
        from: p.from,
        to: p.to,
        chcDocumentedHours: p.chcDocumentedHours,
      })),
      rateTable,
      wageIndexCcn: pe.ccn,
      wageIndexFiscalYear: fiscalYearStarting,
      wageIndexFactorDecimal: wageIndex.factorDecimal,
    });
  } catch (err) {
    // F-211 — CHC is paid hourly; an undocumented / sub-8h / >24h / non-quarter-hour CHC day cannot be priced.
    if (err instanceof ChcHoursError) {
      throw new WardenXError("CHC_HOURS_UNPRICEABLE", err.message, 422);
    }
    throw err;
  }
}

/** D6 — the SIA add-on (only when the patient died inside the claim; `null` when none applies). */
export async function computeClaimSia(
  seams: ClaimAssemblySeams,
  facts: AssemblyFacts,
): Promise<ReturnType<typeof calculateSia> | null> {
  const { admission, fiscalYearStarting, wageIndex, rateScope, signedEncounters } = facts;
  if (admission.deceasedDate === null) return null;
  const chcHourlyRateCents = await seams.referenceData.chcHourlyRateCents(
    fiscalYearStarting,
    wageIndex.factorDecimal,
    rateScope,
  );
  const sia = calculateSia({
    deceasedDate: admission.deceasedDate,
    chcHourlyRateCents,
    signedEncounters: signedEncounters.map((e) => ({
      encounterId: e.encounterId,
      serviceDate: e.serviceDate,
      discipline: e.discipline,
      durationMinutes: e.durationMinutes,
      signed: e.signed,
    })),
  });
  return sia.present ? sia : null;
}
