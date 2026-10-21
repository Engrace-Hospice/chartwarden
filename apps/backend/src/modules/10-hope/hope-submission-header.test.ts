import { describe, expect, it } from "vitest";
import {
  type HopeSubmissionHeader,
  HopeSubmissionPayloadError,
  buildHopeSubmissionHeader,
  controlItemValue,
  readHopeSoftwareVendor,
} from "./hope-submission-header";

const VENDOR_ENV = {
  CHARTWARDEN_SOFTWARE_VENDOR_ID: "12-3456789",
  CHARTWARDEN_SOFTWARE_VENDOR_NAME: "ChartWarden Inc",
  CHARTWARDEN_SOFTWARE_VENDOR_EMAIL: "hope@chartwarden.example",
  APP_VERSION: "2026.9.26",
};

const HEADER: HopeSubmissionHeader = {
  facilityId: "123456",
  stateCode: "OR",
  vendor: readHopeSoftwareVendor(VENDOR_ENV),
};

// The v1.00.1 spec's value lists for the coded control items (itm_val).
const SPEC_OPTIONS: Record<string, readonly string[]> = {
  ITM_SBST_CD: ["HA", "HUV", "HD", "XX"],
  ASMT_SYS_CD: ["HOPE"],
  ITM_SET_VRSN_CD: ["1.00"],
  SPEC_VRSN_CD: ["1.00"],
  STATE_CD: ["NC", "OR", "WA"],
  CRCTN_NUM: ["00", "99"],
};
const ctx = (over: Partial<Parameters<typeof controlItemValue>[1]> = {}) => ({
  isc: "HA",
  header: HEADER,
  correctionNumber: 0,
  optionsFor: (code: string) => SPEC_OPTIONS[code] ?? [],
  ...over,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof HopeSubmissionPayloadError ? error.code : "not-a-payload-error";
  }
  return undefined;
};

describe("HOPE software vendor configuration", () => {
  it("reads the SFTWR_* values, stripping the EIN dash and defaulting the product name", () => {
    expect(readHopeSoftwareVendor(VENDOR_ENV)).toEqual({
      vendorId: "123456789",
      vendorName: "ChartWarden Inc",
      vendorEmail: "hope@chartwarden.example",
      productName: "ChartWarden",
      productVersion: "2026.9.26",
    });
  });

  it("uses the image's GIT_SHA (12 chars) when APP_VERSION is the dev default", () => {
    const vendor = readHopeSoftwareVendor({
      ...VENDOR_ENV,
      APP_VERSION: "dev",
      GIT_SHA: "0123456789abcdef0123",
    });
    expect(vendor.productVersion).toBe("0123456789ab");
  });

  it("refuses with every missing or invalid key named", () => {
    try {
      readHopeSoftwareVendor({ CHARTWARDEN_SOFTWARE_VENDOR_ID: "12345", APP_VERSION: "dev" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HopeSubmissionPayloadError);
      const e = error as HopeSubmissionPayloadError;
      expect(e.code).toBe("WX-HOPE-SUBMISSION-VENDOR-CONFIG");
      expect(e.message).toContain("CHARTWARDEN_SOFTWARE_VENDOR_ID");
      expect(e.message).toContain("CHARTWARDEN_SOFTWARE_VENDOR_NAME");
      expect(e.message).toContain("CHARTWARDEN_SOFTWARE_VENDOR_EMAIL");
      expect(e.message).toContain("APP_VERSION or GIT_SHA");
    }
  });

  it("enforces the CMS field lengths", () => {
    expect(
      codeOf(() =>
        readHopeSoftwareVendor({ ...VENDOR_ENV, CHARTWARDEN_SOFTWARE_VENDOR_NAME: "x".repeat(31) }),
      ),
    ).toBe("WX-HOPE-SUBMISSION-VENDOR-CONFIG");
  });
});

describe("HOPE submission header — provider facts", () => {
  const vendor = HEADER.vendor;

  it("normalizes the state code and keeps the facility ID", () => {
    expect(
      buildHopeSubmissionHeader({ iqiesFacilityId: " 123456 ", stateCode: "or" }, vendor),
    ).toEqual({ facilityId: "123456", stateCode: "OR", vendor });
  });

  it("refuses a provider that is not registered in iQIES, has no state, or is not found", () => {
    expect(
      codeOf(() => buildHopeSubmissionHeader({ iqiesFacilityId: null, stateCode: "OR" }, vendor)),
    ).toBe("WX-HOPE-SUBMISSION-FACILITY-ID");
    expect(
      codeOf(() => buildHopeSubmissionHeader({ iqiesFacilityId: "123", stateCode: null }, vendor)),
    ).toBe("WX-HOPE-SUBMISSION-STATE");
    expect(codeOf(() => buildHopeSubmissionHeader(null, vendor))).toBe(
      "WX-HOPE-SUBMISSION-PROVIDER",
    );
  });
});

describe("HOPE submission header — control item values", () => {
  it("derives every v1.00.1 control item from its source", () => {
    const values = Object.fromEntries(
      [
        "ITM_SBST_CD",
        "ITM_SET_VRSN_CD",
        "SPEC_VRSN_CD",
        "STATE_CD",
        "FAC_ID",
        "SFTWR_VNDR_ID",
        "SFTWR_VNDR_EMAIL_ADR",
        "SFTWR_PROD_NAME",
        "SFTWR_PROD_VRSN_CD",
        "SFTWR_VNDR_NAME",
        "CRCTN_NUM",
        "ASMT_SYS_CD",
      ].map((code) => [code, controlItemValue(code, ctx({ isc: "HUV", correctionNumber: 2 }))]),
    );
    expect(values).toEqual({
      ITM_SBST_CD: "HUV",
      ITM_SET_VRSN_CD: "1.00",
      SPEC_VRSN_CD: "1.00",
      STATE_CD: "OR",
      FAC_ID: "123456",
      SFTWR_VNDR_ID: "123456789",
      SFTWR_VNDR_EMAIL_ADR: "hope@chartwarden.example",
      SFTWR_PROD_NAME: "ChartWarden",
      SFTWR_PROD_VRSN_CD: "2026.9.26",
      SFTWR_VNDR_NAME: "ChartWarden Inc",
      CRCTN_NUM: "02",
      ASMT_SYS_CD: "HOPE",
    });
  });

  it("pads CRCTN_NUM to two digits and bounds it to 00-99", () => {
    expect(controlItemValue("CRCTN_NUM", ctx())).toBe("00");
    expect(controlItemValue("CRCTN_NUM", ctx({ correctionNumber: 99 }))).toBe("99");
    expect(codeOf(() => controlItemValue("CRCTN_NUM", ctx({ correctionNumber: 100 })))).toBe(
      "WX-HOPE-SUBMISSION-CONTROL-VALUE",
    );
  });

  it("checks coded values against the spec's value list", () => {
    const header = { ...HEADER, stateCode: "ZZ" };
    expect(codeOf(() => controlItemValue("STATE_CD", ctx({ header })))).toBe(
      "WX-HOPE-SUBMISSION-CONTROL-VALUE",
    );
    expect(codeOf(() => controlItemValue("ITM_SBST_CD", ctx({ isc: "QQ" })))).toBe(
      "WX-HOPE-SUBMISSION-CONTROL-VALUE",
    );
  });

  it("refuses a fixed-value item whose spec lists no single value, and any unknown control item", () => {
    expect(codeOf(() => controlItemValue("SPEC_VRSN_CD", ctx({ optionsFor: () => [] })))).toBe(
      "WX-HOPE-SUBMISSION-CONTROL-VALUE",
    );
    expect(codeOf(() => controlItemValue("NEW_CTRL_CD", ctx()))).toBe(
      "WX-HOPE-SUBMISSION-CONTROL-UNKNOWN",
    );
  });
});
