// @chartwarden/billing — the hospice CBSA value code by level of care (CMS Pub. 100-04 ch. 11 §30.3; FISS "Value
// Codes FL 39-41"): value code 61 carries the CBSA of the beneficiary's residence on home levels of care
// (revenue 0651/0652); value code G8 carries the CBSA of the facility on inpatient levels (0655/0656). The CBSA
// itself (the code amount) is NOT derived here — it needs the beneficiary-residence / facility location.
// PURE: no I/O.

/** `61` home levels, `G8` inpatient levels; `null` for any other revenue code. */
export function hospiceValueCodeForRevenue(revenueCode: string): "61" | "G8" | null {
  switch (revenueCode) {
    case "0651":
    case "0652":
      return "61";
    case "0655":
    case "0656":
      return "G8";
    default:
      return null;
  }
}
