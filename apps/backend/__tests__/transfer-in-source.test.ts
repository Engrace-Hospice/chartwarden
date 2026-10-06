// M6 transfer-in source checks — the receiving hospice's side of CMS Pub. 100-04 ch. 11 §20.1.3: no transfer
// from the same CCN, at most one change of hospice per benefit period, and a check-digit-valid NPI.
import { describe, expect, it } from "vitest";
import {
  isNpiCheckDigitValid,
  transferInSourceRefusal,
} from "../src/modules/06-admission/discharge/transfer-in";

const OK = {
  otherHospiceCcn: "381777",
  otherHospiceNpi: "1234567893",
  ownCcn: "381501",
  transferAlreadyRecordedInPeriod: false,
};

describe("transferInSourceRefusal", () => {
  it("accepts another provider's transfer in a period with no earlier change", () => {
    expect(transferInSourceRefusal(OK)).toBeNull();
  });

  it("refuses our own CCN — a move between locations of one hospice is not a transfer", () => {
    expect(transferInSourceRefusal({ ...OK, otherHospiceCcn: "381501" })?.code).toBe(
      "TRANSFER_SAME_PROVIDER",
    );
  });

  it("refuses a second change of hospice in the same benefit period", () => {
    expect(
      transferInSourceRefusal({ ...OK, transferAlreadyRecordedInPeriod: true })?.code,
    ).toBe("TRANSFER_LIMIT_EXCEEDED");
  });

  it("refuses an NPI whose check digit fails", () => {
    expect(transferInSourceRefusal({ ...OK, otherHospiceNpi: "1234567894" })?.code).toBe(
      "TRANSFER_IN_SOURCE_INVALID",
    );
  });

  it("does not guess when either CCN is unknown (the 8xC then holds on PRIOR_HOSPICE_CCN_REQUIRED)", () => {
    expect(transferInSourceRefusal({ ...OK, otherHospiceCcn: null })).toBeNull();
    expect(transferInSourceRefusal({ ...OK, ownCcn: null })).toBeNull();
  });
});

describe("isNpiCheckDigitValid", () => {
  it("validates the Luhn check digit over the 80840 prefix", () => {
    expect(isNpiCheckDigitValid("1234567893")).toBe(true);
    expect(isNpiCheckDigitValid("1245319599")).toBe(true);
    expect(isNpiCheckDigitValid("1245319598")).toBe(false);
    expect(isNpiCheckDigitValid("12345")).toBe(false);
  });
});
