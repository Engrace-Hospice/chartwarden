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

import type { WristbandVerdictStatus } from "@wardenx/types";

/** The `barcode_scan_event.match_result` domain (§3.3). */
export type BarcodeMatchResult =
  | "match"
  | "wrong_drug"
  | "wrong_patient"
  | "expired"
  | "no_order_active";

/**
 * The bedside scan payload (the camera plugin's / keyboard-wedge scanner's read). The wristband payload travels
 * RAW (over TLS) to M5, which hashes it; it is NEVER persisted or logged by M13, and the pure decider below does
 * not read it -- it reads M5's verdict via {@link BarcodePatientContext}.
 */
export interface BarcodeScanInput {
  readonly scannedNdc?: string | null;
  readonly scannedRxnormRxcui?: string | null;
  readonly scannedLotNumber?: string | null;
  /** Medication expiration on the scanned label (`YYYY-MM-DD`). */
  readonly scannedExpirationDate?: string | null;
  /** The RAW scanned wristband payload (`WXB1.<base32>.<crc>`); null/absent = no wristband was scanned. */
  readonly patientWristbandPayload?: string | null;
  /** ISO instant an OFFLINE device scanned the band (clamped server-side to <= now); online scans use server time. */
  readonly wristbandScannedAt?: string | null;
}

/** The M12 order identity the scan is verified against (projected from `MedicationOrderProvider`). */
export interface BarcodeOrderContext {
  /** False when the order is discontinued / not active — a scan can never `match` a dead order. */
  readonly orderActive: boolean;
  readonly rxnormRxcui: string | null;
  readonly ndc: string | null;
}

/**
 * The patient identity check, as M5's `PatientWristbandVerifier` concluded it (GAP-020). M13 holds no digest
 * and no token: only the verdict and whether the tenant's policy requires a verified band for a BCMA scan.
 */
export interface BarcodePatientContext {
  readonly wristband: {
    readonly required: boolean;
    readonly status: WristbandVerdictStatus;
  };
}

/** Statuses that mean "no band was presented / none exists": nothing contradicts the patient, so a tenant that
 *  does not require wristbands may proceed. Every other non-verified status is a POSITIVE contradiction. */
const NOTHING_TO_CONTRADICT: ReadonlySet<WristbandVerdictStatus> = new Set([
  "not_presented",
  "not_on_file",
]);

/** Right patient. Verified passes; a required band that is not verified fails; an optional band fails only
 *  when a scanned band positively contradicts the patient (mismatch / superseded / voided / malformed). */
function wristbandBlocks(patient: BarcodePatientContext): boolean {
  const { required, status } = patient.wristband;
  if (status === "verified") return false;
  if (required) return true;
  return !NOTHING_TO_CONTRADICT.has(status);
}

/** Case-insensitive, whitespace-trimmed token comparison; absent tokens never match. */
function sameToken(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Re-derive the canonical `match_result` for a bedside BCMA scan. The precedence is surveyor-meaningful and
 * fail-safe: an absent or discontinued order can never `match` (`no_order_active`); a scanned wristband that
 * is not verified for the patient is `wrong_patient` (the most safety-critical catch); a scanned medication
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

  // Right patient -- M5's verdict on the scanned wristband (GAP-020). FAIL CLOSED: with the tenant policy on
  // (the default) anything but `verified` is refused, so "no band presented" and "no band on file" cannot read
  // as a patient check that never happened. With it off, only a band that was scanned and is WRONG still refuses.
  if (wristbandBlocks(patient)) return "wrong_patient";

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
