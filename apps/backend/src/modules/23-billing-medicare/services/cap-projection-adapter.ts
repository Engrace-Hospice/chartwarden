// apps/backend/src/modules/23-billing-medicare/services/cap-projection-adapter.ts — the M23 ← M26 cap
// projection bind (D8). M23's §11.A `aggregate_cap_projection` / `ipu_cap_projection` rules consume the
// M23-shaped `CapProjectionProvider`; M26 publishes its own rich interface (date-keyed projection reads).
// This adapter wraps the M1-registry seam (cast to a minimal M26-facing VIEW — the opaque rich-seam pattern,
// no @wardenx/cap-management import / no compile edge) and maps it to M23's consumer contract.
//
// DEGRADE, never throw (D8): a deny-stub throw (M26 db-unbound) or an absent projection resolves to
// `status:"unavailable"` so the cap rules WARN-degrade rather than block claim submission. M26 is the
// authoritative cap engine; M23 never fabricates a cap figure.
import type { CapOrgProjectionResult, CapPatientProjectionResult, CapProjectionProvider } from "@wardenx/billing";
import { fromDecimal, RegulatoryDecimal } from "@wardenx/shared/money";
import { getSeam } from "../../../bootstrap/index";

/** The minimal M26 `CapProjectionProvider` surface M23 consumes (date-keyed; M23 has the claim service date). */
interface M26ProjectionSeam {
  getProjectionForServiceDate(
    orgId: string,
    serviceDate: string,
    scope: "agency_aggregate" | "patient_aggregate",
    patientId?: string,
  ): Promise<{ totalAllocatedCap: string; utilizationPct: number; band: string } | null>;
  getInpatientProjectionForServiceDate(
    orgId: string,
    serviceDate: string,
  ): Promise<{ band: string } | null>;
}

const ORG_UNAVAILABLE: CapOrgProjectionResult = {
  status: "unavailable",
  aggregateProjectedCents: null,
  aggregateCapCents: null,
  pctOfCap: null,
  ipuWithinCap: null,
};
const PATIENT_UNAVAILABLE: CapPatientProjectionResult = {
  status: "unavailable",
  projectedCapCents: null,
  capLimitCents: null,
  withinCap: null,
};

/** A representative service date inside the cap year (FYxxxx runs Oct–Sep; Sep 30 is its terminal day). */
const serviceDateForCapYear = (capYear: number): string => `${capYear}-09-30`;

// Decimal-exact (PARAM-003): `allocatedCapStr` is a decimal-string cents figure from the M26 seam; lifting
// it into decimal.js before the percent multiply avoids a float round-trip on a value that gates claim
// submission.
const projectedCents = (allocatedCapStr: string, utilizationPct: number): number =>
  fromDecimal(new RegulatoryDecimal(allocatedCapStr).times(utilizationPct).div(100));

/**
 * Build the M23 cap-projection provider over the M1-registry `CapProjectionProvider` seam. `resolve`
 * defaults to the live registry lookup; tests inject a stub seam. Both methods degrade to
 * `status:"unavailable"` when M26 is unbound or has no projection for the cap year.
 */
export function buildM23CapProjectionAdapter(
  resolve: () => M26ProjectionSeam = () => getSeam("CapProjectionProvider") as M26ProjectionSeam,
): CapProjectionProvider {
  return {
    async projectionForOrg(orgId, _providerEntityId, capYear) {
      try {
        const seam = resolve();
        const serviceDate = serviceDateForCapYear(capYear);
        const [agency, inpatient] = await Promise.all([
          seam.getProjectionForServiceDate(orgId, serviceDate, "agency_aggregate"),
          seam.getInpatientProjectionForServiceDate(orgId, serviceDate),
        ]);
        if (!agency) return ORG_UNAVAILABLE;
        return {
          status: "ok",
          aggregateProjectedCents: projectedCents(agency.totalAllocatedCap, agency.utilizationPct),
          aggregateCapCents: Number(agency.totalAllocatedCap),
          pctOfCap: agency.utilizationPct,
          // No inpatient projection ⇒ no GIP/IRC days ⇒ within the inpatient cap (true), never null on `ok`.
          ipuWithinCap: inpatient ? inpatient.band !== "breach" : true,
        };
      } catch {
        return ORG_UNAVAILABLE;
      }
    },
    async projectionForPatient(orgId, patientId, capYear) {
      try {
        const seam = resolve();
        const patient = await seam.getProjectionForServiceDate(
          orgId,
          serviceDateForCapYear(capYear),
          "patient_aggregate",
          patientId,
        );
        if (!patient) return PATIENT_UNAVAILABLE;
        return {
          status: "ok",
          projectedCapCents: projectedCents(patient.totalAllocatedCap, patient.utilizationPct),
          capLimitCents: Number(patient.totalAllocatedCap),
          withinCap: patient.band !== "breach",
        };
      } catch {
        return PATIENT_UNAVAILABLE;
      }
    },
  };
}
