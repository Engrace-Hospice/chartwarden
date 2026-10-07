// apps/backend/src/modules/30-quality/consumed-seam-adapters.ts — the M23/M27 forward-seam binds.
//
// `QUALITY_FORWARD_SEAM_DENY_STUBS` stubbed `billing` (M23) and `costReport` (M27) as ABSENT producers.
// Both modules are now built and both publish into the M1 registry, so these adapters resolve their live
// seams through `getSeam` and project them onto M30's consumer views. That is what un-suppresses the HCI
// claims-derived indicators and the CoP 418.310 failure-to-file indicator.
//
// DEGRADE PER METHOD, not per module. Every call is wrapped: if the seam is still the M1 deny-stub (it
// throws synchronously on any property call) or the producer is db-unbound, that ONE read returns the
// forward-seam marker and its measure suppresses. A partially-rolled-out M23 must not drag down a measure
// that only needed `patientDays`. Nothing here ever substitutes a zero for an unavailable read (D6 / D13).
import type {
  ForwardSeamMetric,
  QualityBillingConsumer,
  QualityClaimLineRollup,
  QualityCostReportConsumer,
  QualityFilingPosture,
  QualityPatientDays,
  QualityPeriod,
} from "@wardenx/quality";
import { FORWARD_SEAM_UNAVAILABLE } from "@wardenx/quality";
import { getSeam } from "../../bootstrap/index";

/** M23's `ClaimLineReader` as this adapter uses it (the registry holds it opaquely as `unknown`). */
interface ClaimLineReaderView {
  claimLineRollupForPeriod(
    orgId: string,
    fromIso: string,
    toIso: string,
  ): Promise<{
    totalPatientDays: number;
    byLevelOfCare: { rhc: number; chc: number; irc: number; gip: number };
    claimLineCount: number;
    rhcNursingFacilityDays: number;
  }>;
}

/** M23's `PatientDaysProvider` as this adapter uses it. */
interface PatientDaysProviderView {
  billedDaysForFiscalYear(
    orgId: string,
    fyStartIso: string,
    fyEndIso: string,
  ): Promise<{ totalPatientDays: number }>;
}

/** M27's `CostReportFilingStatusReader` as this adapter uses it. */
interface FilingStatusReaderView {
  filingStatusForOrg(orgId: string): Promise<readonly { pastDeadlineUnfiled: boolean }[]>;
}

/**
 * Run a live seam read, degrading ANY failure to the forward-seam marker.
 *
 * Deliberately catches broadly. The failure modes are all the same to a measure: the M1 deny-stub throws
 * synchronously, a db-unbound producer throws, RLS can reject, the seam may be missing entirely. In every
 * case the honest answer is "this input is unavailable, suppress the measure" — never a zero, which would
 * read as a perfect score.
 */
async function degradeToSuppressed<T>(read: () => Promise<T>): Promise<T | ForwardSeamMetric> {
  try {
    return await read();
  } catch {
    return FORWARD_SEAM_UNAVAILABLE;
  }
}

/**
 * Bind M30's `billing` consumer over M23's live seams. `claimLineRollup` reads the per-LOC day rollup +
 * line population; `patientDays` reads the billed census. The two resolve INDEPENDENTLY, so an M23 that
 * has registered one and not the other leaves only the affected measure suppressed.
 */
export function buildM30BillingConsumer(): QualityBillingConsumer {
  return {
    async claimLineRollup(organizationId, period) {
      return degradeToSuppressed<QualityClaimLineRollup>(async () => {
        const reader = getSeam("ClaimLineReader") as ClaimLineReaderView;
        const r = await reader.claimLineRollupForPeriod(organizationId, period.from, period.to);
        return {
          totalPatientDays: r.totalPatientDays,
          rhcDays: r.byLevelOfCare.rhc,
          chcDays: r.byLevelOfCare.chc,
          ircDays: r.byLevelOfCare.irc,
          gipDays: r.byLevelOfCare.gip,
          claimLineCount: r.claimLineCount,
          rhcNursingFacilityDays: r.rhcNursingFacilityDays,
          isForwardSeamDenyStub: false,
        };
      });
    },

    async patientDays(organizationId, period) {
      return degradeToSuppressed<QualityPatientDays>(async () => {
        const provider = getSeam("PatientDaysProvider") as PatientDaysProviderView;
        // M23's census read is FY-shaped; M30's measure periods are arbitrary windows. The producer
        // filters on service date either way, so the window maps straight onto the FY bounds.
        const r = await provider.billedDaysForFiscalYear(organizationId, period.from, period.to);
        return { totalPatientDays: r.totalPatientDays, isForwardSeamDenyStub: false };
      });
    },
  };
}

/**
 * Bind M30's `costReport` consumer over M27's live filing-status reader, reduced to the
 * numerator/denominator pair the CoP 418.310 indicator needs. An org whose provider entities have no cost
 * report at all yields 0/0 — the measure kernel then suppresses on the denominator floor rather than
 * publishing a spurious "0% non-compliant".
 */
export function buildM30CostReportConsumer(): QualityCostReportConsumer {
  return {
    async filingStatusForOrg(organizationId) {
      return degradeToSuppressed<QualityFilingPosture>(async () => {
        const reader = getSeam("CostReportFilingStatusReader") as FilingStatusReaderView;
        const rows = await reader.filingStatusForOrg(organizationId);
        return {
          pastDeadlineUnfiled: rows.filter((r) => r.pastDeadlineUnfiled).length,
          providerEntitiesAssessed: rows.length,
          isForwardSeamDenyStub: false,
        };
      });
    },
  };
}

/** Both live forward-seam overrides, ready to pass to `bindQualityConsumedSeams`. M15/M16 stay stubbed. */
export function buildM30LiveForwardSeams() {
  return {
    billing: buildM30BillingConsumer(),
    costReport: buildM30CostReportConsumer(),
  };
}
