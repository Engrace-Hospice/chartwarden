// apps/backend/src/modules/23-billing-medicare/services/claim-discharge.ts
//
// Resolve HOW and WHEN the stay ended from the M6 facts the assembly already read, then derive the claim's
// discharge codes (CMS Pub. 100-04 Ch. 11 §30.3, `deriveDischargeClaimCodes`). PURE: no I/O, no clock.
//
// M6 records the end of a stay in three places, and only one of them is a `discharge_event`:
//   * a completed `discharge_event` (death, moved out of the service area, no longer terminal, for cause,
//     other) — the seam already ignores voided and pending-cosign rows;
//   * a transfer-OUT (`transfer_event`, direction `out`) — discharges the admission with NO discharge_event;
//   * a revocation (`revocation_event`, surfaced as the election period's `revoked` + `revocationDate`) —
//     also with NO discharge_event.
// A completed discharge_event wins over the other two (it is the explicit terminal record); otherwise the
// earliest of transfer-out / revocation ends the stay.
import {
  type ClaimDischargeFact,
  type DischargeClaimCodes,
  type IsoDate,
  type PlaceOfDeath,
  type ReceivingCareSetting,
  deriveDischargeClaimCodes,
} from "@wardenx/billing";
import type { AdmissionContext } from "./claim-assembly-types";

const PLACES: readonly string[] = ["home", "facility", "unknown"];
const SETTINGS: readonly string[] = ["home", "facility"];

/** The stay-ending fact for the admission, or `null` while the patient is still on service. */
export function resolveClaimDischarge(
  admission: AdmissionContext,
  electionPeriods: readonly { readonly revoked: boolean; readonly revocationDate: IsoDate | null }[],
): ClaimDischargeFact | null {
  if (admission.dischargeDate !== null && admission.dischargeReason !== null) {
    const isDeath = admission.dischargeReason === "death";
    return {
      kind: admission.dischargeReason,
      effectiveDate: admission.dischargeDate,
      deathDate: isDeath ? admission.deceasedDate : null,
      placeOfDeath:
        isDeath && admission.placeOfDeath !== null && PLACES.includes(admission.placeOfDeath)
          ? (admission.placeOfDeath as PlaceOfDeath)
          : null,
    };
  }
  const candidates: ClaimDischargeFact[] = [];
  if (admission.transferOut !== null) {
    const setting = admission.transferOut.receivingCareSetting;
    candidates.push({
      kind: "transfer",
      effectiveDate: admission.transferOut.effectiveDate,
      receivingCareSetting:
        setting !== null && SETTINGS.includes(setting) ? (setting as ReceivingCareSetting) : null,
    });
  }
  const revocation = electionPeriods
    .filter((p) => p.revoked && p.revocationDate !== null)
    .map((p) => p.revocationDate as IsoDate)
    .sort()[0];
  if (revocation !== undefined) candidates.push({ kind: "revocation", effectiveDate: revocation });
  candidates.sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0));
  return candidates[0] ?? null;
}

/** The `claim` row columns (migration 0371) for a derived code set. */
export function claimDischargeCodeColumns(codes: DischargeClaimCodes): {
  readonly patientStatusCode: string | null;
  readonly conditionCodes: string[];
  readonly occurrenceCodes: { code: string; date: string }[];
} {
  return {
    patientStatusCode: codes.patientStatus,
    conditionCodes: [...codes.conditionCodes],
    occurrenceCodes: codes.occurrenceCodes.map((o) => ({ code: o.code, date: o.date })),
  };
}

/** The discharge codes for a claim whose window ends on `serviceTo`. */
export function claimDischargeCodes(
  admission: AdmissionContext,
  electionPeriods: readonly { readonly revoked: boolean; readonly revocationDate: IsoDate | null }[],
  serviceTo: IsoDate,
): { readonly discharge: ClaimDischargeFact | null; readonly codes: DischargeClaimCodes } {
  const discharge = resolveClaimDischarge(admission, electionPeriods);
  return { discharge, codes: deriveDischargeClaimCodes({ serviceTo, discharge }) };
}
