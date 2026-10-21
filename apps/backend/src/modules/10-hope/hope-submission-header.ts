// apps/backend/src/modules/10-hope/hope-submission-header.ts — the CMS HOPE submission header: the twelve
// "Control" section items (spec v1.00.1 itm_mstr, active for every ISC) that every iQIES record carries
// but no clinician answers. They are computed at package time from their real sources — never stored as
// assessment answers — so a record can't be packaged with a stale facility ID or software version.
//
//   ITM_SBST_CD                         the record's ISC (HA / HUV / HD / XX)
//   ASMT_SYS_CD, ITM_SET_VRSN_CD,       the single value the frozen spec version lists for the item
//   SPEC_VRSN_CD                          (HOPE / 1.00 / 1.00 in v1.00.1)
//   STATE_CD                            the provider entity's state postal code (its address)
//   FAC_ID                              the provider entity's iQIES-assigned facility ID
//   SFTWR_VNDR_ID/_NAME/_EMAIL_ADR,     ChartWarden as the software vendor: configuration (see below)
//   SFTWR_PROD_NAME/_VRSN_CD
//   CRCTN_NUM                           how many times this record has been corrected (00 original)
//
// Any other control item in a future spec version fails packaging rather than being emitted blank.

/** A HOPE record or package that cannot be serialized for iQIES (re-exported by the serializer). */
export class HopeSubmissionPayloadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HopeSubmissionPayloadError";
  }
}

/** ChartWarden's identity as the HOPE software vendor (CMS SFTWR_* items). */
export interface HopeSoftwareVendor {
  /** Federal employer tax ID (EIN), 9 digits, no dash. */
  readonly vendorId: string;
  readonly vendorName: string;
  readonly vendorEmail: string;
  readonly productName: string;
  readonly productVersion: string;
}

/** Provider-level header facts, read once per package. */
export interface HopeSubmissionHeader {
  readonly facilityId: string;
  readonly stateCode: string;
  readonly vendor: HopeSoftwareVendor;
}

type EnvLike = Record<string, string | undefined>;

/**
 * The software-vendor block from configuration. Checked when a package is built (not at boot), so a
 * deployment without these keys keeps running and only HOPE packaging refuses, naming what to set.
 *   CHARTWARDEN_SOFTWARE_VENDOR_ID     EIN, 9 digits (dash allowed, stripped)
 *   CHARTWARDEN_SOFTWARE_VENDOR_NAME   ≤ 30 characters
 *   CHARTWARDEN_SOFTWARE_VENDOR_EMAIL  ≤ 50 characters
 *   CHARTWARDEN_SOFTWARE_PRODUCT_NAME  optional, default "ChartWarden", ≤ 50 characters
 * The product version is the image's APP_VERSION, else its GIT_SHA (both baked in by the Dockerfile).
 */
export function readHopeSoftwareVendor(env: EnvLike = process.env): HopeSoftwareVendor {
  const problems: string[] = [];
  const vendorId = (env.CHARTWARDEN_SOFTWARE_VENDOR_ID ?? "").replaceAll("-", "").trim();
  if (!/^\d{9}$/.test(vendorId)) problems.push("CHARTWARDEN_SOFTWARE_VENDOR_ID (9-digit EIN)");
  const vendorName = (env.CHARTWARDEN_SOFTWARE_VENDOR_NAME ?? "").trim();
  if (!vendorName || vendorName.length > 30)
    problems.push("CHARTWARDEN_SOFTWARE_VENDOR_NAME (1-30 characters)");
  const vendorEmail = (env.CHARTWARDEN_SOFTWARE_VENDOR_EMAIL ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vendorEmail) || vendorEmail.length > 50)
    problems.push("CHARTWARDEN_SOFTWARE_VENDOR_EMAIL (email, ≤ 50 characters)");
  const productName = (env.CHARTWARDEN_SOFTWARE_PRODUCT_NAME ?? "ChartWarden").trim();
  if (!productName || productName.length > 50)
    problems.push("CHARTWARDEN_SOFTWARE_PRODUCT_NAME (1-50 characters)");
  const appVersion = env.APP_VERSION && env.APP_VERSION !== "dev" ? env.APP_VERSION : undefined;
  const gitSha = env.GIT_SHA && env.GIT_SHA !== "unknown" ? env.GIT_SHA.slice(0, 12) : undefined;
  const productVersion = (appVersion ?? gitSha ?? "").slice(0, 20);
  if (!productVersion) problems.push("APP_VERSION or GIT_SHA (software product version)");
  if (problems.length > 0) {
    throw new HopeSubmissionPayloadError(
      `HOPE software vendor configuration is incomplete: set ${problems.join(", ")}`,
      "WX-HOPE-SUBMISSION-VENDOR-CONFIG",
      { missing: problems },
    );
  }
  return { vendorId, vendorName, vendorEmail, productName, productVersion };
}

/** Validate the provider-level facts and assemble the header. */
export function buildHopeSubmissionHeader(
  provider: { readonly iqiesFacilityId: string | null; readonly stateCode: string | null } | null,
  vendor: HopeSoftwareVendor,
): HopeSubmissionHeader {
  if (!provider) {
    throw new HopeSubmissionPayloadError(
      "The provider entity for this HOPE package was not found",
      "WX-HOPE-SUBMISSION-PROVIDER",
    );
  }
  const facilityId = provider.iqiesFacilityId?.trim() ?? "";
  if (!facilityId) {
    throw new HopeSubmissionPayloadError(
      "The provider entity has no iQIES facility ID (provider_entity.iqies_facility_id); CMS assigns it at iQIES provider registration",
      "WX-HOPE-SUBMISSION-FACILITY-ID",
    );
  }
  const stateCode = provider.stateCode?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(stateCode)) {
    throw new HopeSubmissionPayloadError(
      "The provider entity's address has no two-letter state code",
      "WX-HOPE-SUBMISSION-STATE",
    );
  }
  return { facilityId, stateCode, vendor };
}

/** The spec item's own CMS option values (`hope_spec_item_option.value_code`), for fixed/coded controls. */
export type SpecOptionsFor = (itemCode: string) => readonly string[];

/**
 * The CMS value for one control item. `correctionNumber` is the record's position in its correction
 * chain (0 = never corrected). Coded values are checked against the frozen spec's option list.
 */
export function controlItemValue(
  itemCode: string,
  ctx: {
    readonly isc: string;
    readonly header: HopeSubmissionHeader;
    readonly correctionNumber: number;
    readonly optionsFor: SpecOptionsFor;
  },
): string {
  const { header } = ctx;
  const listed = (code: string, value: string): string => {
    const options = ctx.optionsFor(code);
    if (options.length > 0 && !options.includes(value)) {
      throw new HopeSubmissionPayloadError(
        `${code} value "${value}" is not in the CMS spec's value list`,
        "WX-HOPE-SUBMISSION-CONTROL-VALUE",
        { itemCode: code },
      );
    }
    return value;
  };
  switch (itemCode) {
    case "ITM_SBST_CD":
      return listed(itemCode, ctx.isc);
    case "ASMT_SYS_CD":
    case "ITM_SET_VRSN_CD":
    case "SPEC_VRSN_CD": {
      const options = ctx.optionsFor(itemCode);
      if (options.length !== 1) {
        throw new HopeSubmissionPayloadError(
          `${itemCode} must have exactly one CMS spec value (found ${options.length})`,
          "WX-HOPE-SUBMISSION-CONTROL-VALUE",
          { itemCode },
        );
      }
      return options[0] as string;
    }
    case "STATE_CD":
      return listed(itemCode, header.stateCode);
    case "FAC_ID":
      return header.facilityId;
    case "SFTWR_VNDR_ID":
      return header.vendor.vendorId;
    case "SFTWR_VNDR_NAME":
      return header.vendor.vendorName;
    case "SFTWR_VNDR_EMAIL_ADR":
      return header.vendor.vendorEmail;
    case "SFTWR_PROD_NAME":
      return header.vendor.productName;
    case "SFTWR_PROD_VRSN_CD":
      return header.vendor.productVersion;
    case "CRCTN_NUM": {
      if (ctx.correctionNumber < 0 || ctx.correctionNumber > 99) {
        throw new HopeSubmissionPayloadError(
          "CRCTN_NUM must be between 00 and 99",
          "WX-HOPE-SUBMISSION-CONTROL-VALUE",
          { itemCode },
        );
      }
      return String(ctx.correctionNumber).padStart(2, "0");
    }
    default:
      throw new HopeSubmissionPayloadError(
        `No source is defined for HOPE control item ${itemCode}`,
        "WX-HOPE-SUBMISSION-CONTROL-UNKNOWN",
        { itemCode },
      );
  }
}
