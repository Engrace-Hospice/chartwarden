// packages/emar/__tests__/barcode-match.test.ts — M13-T09 §2.9 BCMA barcode-verification unit tests.
// The pure `evaluateBarcodeScan` re-derives the canonical `barcode_scan_event.match_result` and
// `barcodeScanBlocks` names the unsafe results the administration write path refuses.
import { describe, expect, it } from "vitest";
import {
  type BarcodeOrderContext,
  type BarcodePatientContext,
  barcodeScanBlocks,
  evaluateBarcodeScan,
} from "../src/barcode";

const ORDER: BarcodeOrderContext = {
  orderActive: true,
  rxnormRxcui: "313782",
  ndc: "00093-0058-01",
};
const PATIENT: BarcodePatientContext = { wristbandPayloadDigest: "sha256:patient-a" };
const ASOF = "2026-06-22";

describe("M13-T09 — §2.9 evaluateBarcodeScan", () => {
  it("a scan matching the order drug + patient wristband + unexpired label is `match`", () => {
    const r = evaluateBarcodeScan(
      {
        scannedRxnormRxcui: "313782",
        patientWristbandPayloadDigest: "sha256:patient-a",
        scannedExpirationDate: "2027-01-01",
      },
      ORDER,
      PATIENT,
      ASOF,
    );
    expect(r).toBe("match");
  });

  it("an absent or discontinued order is always `no_order_active` (fail-safe)", () => {
    expect(evaluateBarcodeScan({ scannedRxnormRxcui: "313782" }, null, PATIENT, ASOF)).toBe(
      "no_order_active",
    );
    expect(
      evaluateBarcodeScan(
        { scannedRxnormRxcui: "313782" },
        { ...ORDER, orderActive: false },
        PATIENT,
        ASOF,
      ),
    ).toBe("no_order_active");
  });

  it("a scanned wristband disagreeing with the patient on file is `wrong_patient`", () => {
    const r = evaluateBarcodeScan(
      { scannedRxnormRxcui: "313782", patientWristbandPayloadDigest: "sha256:patient-b" },
      ORDER,
      PATIENT,
      ASOF,
    );
    expect(r).toBe("wrong_patient");
  });

  it("a scanned RxCUI disagreeing with the order is `wrong_drug` (RxCUI preferred over NDC)", () => {
    const r = evaluateBarcodeScan(
      { scannedRxnormRxcui: "999999", scannedNdc: "00093-0058-01" },
      ORDER,
      PATIENT,
      ASOF,
    );
    expect(r).toBe("wrong_drug");
  });

  it("falls back to NDC for the drug right when no RxCUI is scanned", () => {
    expect(evaluateBarcodeScan({ scannedNdc: "11111-1111-11" }, ORDER, PATIENT, ASOF)).toBe(
      "wrong_drug",
    );
    expect(evaluateBarcodeScan({ scannedNdc: "00093-0058-01" }, ORDER, PATIENT, ASOF)).toBe(
      "match",
    );
  });

  it("an expiration on or before the administration date is `expired`", () => {
    expect(
      evaluateBarcodeScan(
        { scannedRxnormRxcui: "313782", scannedExpirationDate: "2026-06-22" },
        ORDER,
        PATIENT,
        ASOF,
      ),
    ).toBe("expired");
    expect(
      evaluateBarcodeScan(
        { scannedRxnormRxcui: "313782", scannedExpirationDate: "2026-06-21" },
        ORDER,
        PATIENT,
        ASOF,
      ),
    ).toBe("expired");
  });

  it("a wristband-only scan with no drug token does not fail the drug right", () => {
    expect(
      evaluateBarcodeScan(
        { patientWristbandPayloadDigest: "sha256:patient-a" },
        ORDER,
        PATIENT,
        ASOF,
      ),
    ).toBe("match");
  });

  it("wrong_patient is checked before wrong_drug (the most safety-critical catch wins)", () => {
    const r = evaluateBarcodeScan(
      { scannedRxnormRxcui: "999999", patientWristbandPayloadDigest: "sha256:patient-b" },
      ORDER,
      PATIENT,
      ASOF,
    );
    expect(r).toBe("wrong_patient");
  });

  it("barcodeScanBlocks refuses the three unsafe results and allows match/no_order_active", () => {
    expect(barcodeScanBlocks("wrong_patient")).toBe(true);
    expect(barcodeScanBlocks("wrong_drug")).toBe(true);
    expect(barcodeScanBlocks("expired")).toBe(true);
    expect(barcodeScanBlocks("match")).toBe(false);
    expect(barcodeScanBlocks("no_order_active")).toBe(false);
  });
});
