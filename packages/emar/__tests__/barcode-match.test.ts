// packages/emar/__tests__/barcode-match.test.ts — M13-T09 §2.9 BCMA barcode-verification unit tests.
// The pure `evaluateBarcodeScan` re-derives the canonical `barcode_scan_event.match_result` and
// `barcodeScanBlocks` names the unsafe results the administration write path refuses.
import type { WristbandVerdictStatus } from "@chartwarden/types";
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
const PATIENT: BarcodePatientContext = { wristband: { required: true, status: "verified" } };
const patientWith = (status: WristbandVerdictStatus, required = true): BarcodePatientContext => ({
  wristband: { required, status },
});
const ASOF = "2026-06-22";

describe("M13-T09 — §2.9 evaluateBarcodeScan", () => {
  it("a scan matching the order drug + patient wristband + unexpired label is `match`", () => {
    const r = evaluateBarcodeScan(
      {
        scannedRxnormRxcui: "313782",
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
    expect(evaluateBarcodeScan({}, ORDER, PATIENT, ASOF)).toBe("match");
  });

  describe("GAP-020 -- the wristband arm is driven by M5's verdict", () => {
    const DRUG_OK = { scannedRxnormRxcui: "313782" };
    const NOT_VERIFIED: WristbandVerdictStatus[] = [
      "mismatch",
      "not_presented",
      "not_on_file",
      "superseded",
      "voided",
      "malformed",
    ];

    it("a verified wristband passes whether or not the tenant requires one", () => {
      expect(evaluateBarcodeScan(DRUG_OK, ORDER, patientWith("verified", true), ASOF)).toBe(
        "match",
      );
      expect(evaluateBarcodeScan(DRUG_OK, ORDER, patientWith("verified", false), ASOF)).toBe(
        "match",
      );
    });

    it.each(NOT_VERIFIED)("required + %s is wrong_patient (fail closed)", (status) => {
      expect(evaluateBarcodeScan(DRUG_OK, ORDER, patientWith(status, true), ASOF)).toBe(
        "wrong_patient",
      );
    });

    it.each(["not_presented", "not_on_file"] as const)(
      "not required + %s passes (no wristband stock / nothing to contradict)",
      (status) => {
        expect(evaluateBarcodeScan(DRUG_OK, ORDER, patientWith(status, false), ASOF)).toBe("match");
      },
    );

    it.each(["mismatch", "superseded", "voided", "malformed"] as const)(
      "not required + %s is STILL wrong_patient: a band that was scanned and is wrong is never waved through",
      (status) => {
        expect(evaluateBarcodeScan(DRUG_OK, ORDER, patientWith(status, false), ASOF)).toBe(
          "wrong_patient",
        );
      },
    );

    it("wrong_patient is checked before wrong_drug and expired (the most safety-critical catch wins)", () => {
      expect(
        evaluateBarcodeScan(
          { scannedRxnormRxcui: "999999", scannedExpirationDate: "2020-01-01" },
          ORDER,
          patientWith("mismatch"),
          ASOF,
        ),
      ).toBe("wrong_patient");
    });

    it("an absent / discontinued order stays no_order_active regardless of the wristband (precedence unchanged)", () => {
      expect(evaluateBarcodeScan(DRUG_OK, null, patientWith("mismatch"), ASOF)).toBe(
        "no_order_active",
      );
      expect(
        evaluateBarcodeScan(DRUG_OK, { ...ORDER, orderActive: false }, patientWith("voided"), ASOF),
      ).toBe("no_order_active");
    });

    it("with a verified wristband the drug and expiry rights still bite", () => {
      expect(evaluateBarcodeScan({ scannedRxnormRxcui: "999999" }, ORDER, PATIENT, ASOF)).toBe(
        "wrong_drug",
      );
      expect(
        evaluateBarcodeScan(
          { ...DRUG_OK, scannedExpirationDate: "2026-06-22" },
          ORDER,
          PATIENT,
          ASOF,
        ),
      ).toBe("expired");
    });
  });

  it("barcodeScanBlocks refuses the three unsafe results and allows match/no_order_active", () => {
    expect(barcodeScanBlocks("wrong_patient")).toBe(true);
    expect(barcodeScanBlocks("wrong_drug")).toBe(true);
    expect(barcodeScanBlocks("expired")).toBe(true);
    expect(barcodeScanBlocks("match")).toBe(false);
    expect(barcodeScanBlocks("no_order_active")).toBe(false);
  });
});
