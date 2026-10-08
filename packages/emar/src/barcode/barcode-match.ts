// @wardenx/emar — §2.9 / BCMA barcode-medication-administration verification (M13-T09). PURE, IO-free, shared
// with the Capacitor mobile eMAR so the bedside scan and the server-side re-verification agree on one
// `match_result` (no drift). The `@capacitor/camera` plugin reads the medication's NDC / RxNorm barcode and the
// patient's wristband at the bedside; M13 re-derives the canonical `barcode_scan_event.match_result` from the
// scanned tokens against the M12 order projection + the patient wristband digest at administration time (§3.3
// `barcode_scan_event`). The validator is a pure function so the same banner the mobile app shows
// (§6.2 Screen 1 — "banner if mismatch detected from a barcode scan") is the one the server enforces.
//
// The five enumerated results mirror the `match_result` column's domain
// (`'match' | 'wrong_drug' | 'wrong_patient' | 'expired' | 'no_order_active'`). `evaluateBarcodeScan` returns
// the result; `barcodeScanBlocks` names the three unsafe results the write path refuses (§2.9 BCMA: a
// wrong-patient/wrong-drug/expired scan is a hard `BARCODE_VERIFICATION_FAILED`, not a soft warning — the
// surveyor question "was the right drug given to the right patient?" must never resolve to a logged mismatch).

/** The `barcode_scan_event.match_result` domain (§3.3). */
export type BarcodeMatchResult =
  | "match"
  | "wrong_drug"
  | "wrong_patient"
  | "expired"
  | "no_order_active";

/** The bedside scan payload (the camera plugin's read; PHI-equivalent wristband payload is hashed, never raw). */
export interface BarcodeScanInput {
  readonly scannedNdc?: string | null;
  readonly scannedRxnormRxcui?: string | null;
  readonly scannedLotNumber?: string | null;
  /** Medication expiration on the scanned label (`YYYY-MM-DD`). */
  readonly scannedExpirationDate?: string | null;
  /** sha256 of the patient wristband payload (compared to the patient's on-file digest; raw never logged). */
  readonly patientWristbandPayloadDigest?: string | null;
}

/** The M12 order identity the scan is verified against (projected from `MedicationOrderProvider`). */
export interface BarcodeOrderContext {
  /** False when the order is discontinued / not active — a scan can never `match` a dead order. */
  readonly orderActive: boolean;
  readonly rxnormRxcui: string | null;
  readonly ndc: string | null;
}

/** The patient identity the wristband scan is verified against. */
export interface BarcodePatientContext {
  readonly wristbandPayloadDigest: string | null;
}

/** Case-insensitive, whitespace-trimmed token comparison; absent tokens never match. */
function sameToken(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Re-derive the canonical `match_result` for a bedside BCMA scan. The precedence is surveyor-meaningful and
 * fail-safe: an absent or discontinued order can never `match` (`no_order_active`); a scanned wristband that
 * disagrees with the patient on file is `wrong_patient` (the most safety-critical catch); a scanned medication
 * identity (RxCUI preferred, else NDC) that disagrees with the order is `wrong_drug`; an expiration on or before
 * the administration date is `expired`; otherwise `match`. A scan that carries no drug-identity tokens at all
 * (e.g. a wristband-only scan) does not fail the drug right — the order is the source of truth, and the scan
 * only contradicts it when it carries a conflicting token.
 */
export function evaluateBarcodeScan(
  scan: BarcodeScanInput,
  order: BarcodeOrderContext | null,
  patient: BarcodePatientContext,
  asOfDate: string,
): BarcodeMatchResult {
  if (order === null || !order.orderActive) return "no_order_active";

  // Right patient — a scanned wristband digest that disagrees with the patient on file. Only a scan that
  // carries a digest can contradict; a wristband-less scan does not fail this right. FAIL CLOSED: a scan that
  // DOES carry a digest while none is on file cannot be verified, so it is never reported as `match` (that would
  // claim a patient check that did not happen) - it is refused as `wrong_patient` until a digest is on file.
  if (
    scan.patientWristbandPayloadDigest != null &&
    !sameToken(scan.patientWristbandPayloadDigest, patient.wristbandPayloadDigest)
  ) {
    return "wrong_patient";
  }

  // Right drug — prefer RxCUI (terminology-stable) over NDC (package-specific). A scanned identity present on
  // BOTH the scan and the order that disagrees is a wrong-drug catch.
  const rxcuiConflict =
    scan.scannedRxnormRxcui != null &&
    order.rxnormRxcui != null &&
    !sameToken(scan.scannedRxnormRxcui, order.rxnormRxcui);
  const ndcConflict =
    scan.scannedRxnormRxcui == null &&
    scan.scannedNdc != null &&
    order.ndc != null &&
    !sameToken(scan.scannedNdc, order.ndc);
  if (rxcuiConflict || ndcConflict) return "wrong_drug";

  // Expired — an expiration date on or before the administration date.
  if (scan.scannedExpirationDate != null && scan.scannedExpirationDate <= asOfDate)
    return "expired";

  return "match";
}

/** The three BCMA results the administration write path refuses (§2.9 — a hard `BARCODE_VERIFICATION_FAILED`). */
export function barcodeScanBlocks(result: BarcodeMatchResult): boolean {
  return result === "wrong_patient" || result === "wrong_drug" || result === "expired";
}
