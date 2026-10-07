// @wardenx/x12-837-client — the pure HETS 270 (005010X279A1) request builder.
//
// Shape follows the CMS HETS 270/271 5010 Companion Guide, Appendix A ("minimum required data elements")
// and §7.3 (beneficiary search: MBI + last name + first name + DOB; no middle name, no gender — those make
// HETS answer with a 999). The 2100A payer is always `NM1*PR*2*CMS*****PI*CMS`; the 2100B information
// receiver is the hospice's NPI (it must be linked to the HETS Submitter ID in HETS Desktop, else AAA 41/51).
// Service type codes default to 30 (health benefit plan coverage → Part A entitlement) and 45 (hospice →
// CG §7.16: the hospice NOE/benefit-period loops are returned only when STC 45 is requested).
//
// MBI CONFINEMENT (M23 D13 / §3.6 / §8.7): the MBI goes into the returned string and nowhere else. This
// function holds no state, logs nothing and its error messages never echo an input value.
import { X12FormatError, isoToX12Date } from "./x12-envelope";

/** CMS MBI format (11 chars; letters exclude S, L, O, I, B, Z). Positions per the CMS MBI format spec. */
export const MBI_PATTERN =
  /^[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y]{2}[0-9]{2}$/;

/** HETS default service types: 30 (Part A/B entitlement) + 45 (hospice periods, CG §7.16). */
export const HETS_DEFAULT_SERVICE_TYPES: readonly string[] = ["30", "45"];

/** Everything needed to build ONE HETS 270. The subscriber block is transient (never persisted). */
export interface Hets270Request {
  /** The CMS-issued HETS Submitter ID (ISA06 / GS02). */
  readonly submitterId: string;
  /** The hospice (information receiver, 2100B). `npi` must be the 10-digit Medicare-enrolled NPI. */
  readonly provider: { readonly npi: string; readonly organizationName: string };
  /** TRANSIENT beneficiary identity (2100C). The MBI is placed in NM109 and nowhere else. */
  readonly subscriber: {
    readonly mbi: string;
    readonly lastName: string;
    readonly firstName: string;
    /** ISO date; null uses CG Table 9 "Alternate 2" (MBI + last + first). */
    readonly dateOfBirth: string | null;
  };
  /** Requested date(s) of service (ISO). HETS accepts up to 4 years back / 4 months ahead (CG §7.4). */
  readonly serviceDates: { readonly from: string; readonly to: string };
  readonly serviceTypeCodes?: readonly string[];
  /** ISA13 / GS06 interchange + group control number (1 … 999,999,999). */
  readonly controlNumber: number;
  /** TRN02 trace number — PHI-free (an opaque correlation id); echoed back as TRN*2 in the 271. */
  readonly traceNumber: string;
  /** ISA15: `P` production, `T` test. */
  readonly usage: "P" | "T";
  readonly now: Date;
}

/** Thrown when the request cannot be built. `field` names the bad input; the value is never echoed. */
export class Hets270BuildError extends X12FormatError {
  constructor(public readonly field: string) {
    super(`HETS 270 field '${field}' is missing or invalid`);
  }
}

const NAME_LIMITS = { last: 60, first: 35, organization: 60 } as const;

/** Upper-case + reduce to the X12 basic character set used by names (letters, digits, space, ' and -). */
function x12Name(value: string, max: number, field: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 '-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  if (cleaned.length === 0) throw new Hets270BuildError(field);
  return cleaned;
}

const pad = (value: string, width: number): string => value.padEnd(width, " ").slice(0, width);
const two = (n: number): string => String(n).padStart(2, "0");

/** Build a HETS 270 interchange (ISA … IEA). Pure; throws {@link Hets270BuildError} on bad input. */
export function build270(req: Hets270Request): string {
  const submitter = req.submitterId.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,15}$/.test(submitter)) throw new Hets270BuildError("submitterId");
  if (!/^\d{10}$/.test(req.provider.npi)) throw new Hets270BuildError("provider.npi");
  if (!MBI_PATTERN.test(req.subscriber.mbi)) throw new Hets270BuildError("subscriber.mbi");
  if (
    !Number.isInteger(req.controlNumber) ||
    req.controlNumber < 1 ||
    req.controlNumber > 999_999_999
  ) {
    throw new Hets270BuildError("controlNumber");
  }
  if (!/^[A-Za-z0-9-]{1,50}$/.test(req.traceNumber)) throw new Hets270BuildError("traceNumber");
  const serviceTypes = req.serviceTypeCodes ?? HETS_DEFAULT_SERVICE_TYPES;
  if (serviceTypes.length === 0 || !serviceTypes.every((c) => /^[A-Z0-9]{1,2}$/.test(c))) {
    throw new Hets270BuildError("serviceTypeCodes");
  }
  const from = isoToX12Date(req.serviceDates.from);
  const to = isoToX12Date(req.serviceDates.to);
  if (to < from) throw new Hets270BuildError("serviceDates");
  const dob = req.subscriber.dateOfBirth === null ? null : isoToX12Date(req.subscriber.dateOfBirth);

  const lastName = x12Name(req.subscriber.lastName, NAME_LIMITS.last, "subscriber.lastName");
  const firstName = x12Name(req.subscriber.firstName, NAME_LIMITS.first, "subscriber.firstName");
  const orgName = x12Name(
    req.provider.organizationName,
    NAME_LIMITS.organization,
    "provider.organizationName",
  );

  const n = req.now;
  const ccyymmdd = `${n.getUTCFullYear()}${two(n.getUTCMonth() + 1)}${two(n.getUTCDate())}`;
  const hhmm = `${two(n.getUTCHours())}${two(n.getUTCMinutes())}`;
  const control = String(req.controlNumber).padStart(9, "0");
  // TRN03 — originating company id: 10 chars, leading "9" + the submitter id (TR3 2000C TRN03 guidance).
  const originator = `9${submitter}`.padEnd(10, "0").slice(0, 10);

  const body = [
    ["ST", "270", "0001", "005010X279A1"],
    ["BHT", "0022", "13", req.traceNumber, ccyymmdd, hhmm],
    ["HL", "1", "", "20", "1"],
    ["NM1", "PR", "2", "CMS", "", "", "", "", "PI", "CMS"],
    ["HL", "2", "1", "21", "1"],
    ["NM1", "1P", "2", orgName, "", "", "", "", "XX", req.provider.npi],
    ["HL", "3", "2", "22", "0"],
    ["TRN", "1", req.traceNumber, originator],
    ["NM1", "IL", "1", lastName, firstName, "", "", "", "MI", req.subscriber.mbi],
    ...(dob ? [["DMG", "D8", dob]] : []),
    from === to ? ["DTP", "291", "D8", from] : ["DTP", "291", "RD8", `${from}-${to}`],
    ["EQ", serviceTypes.join("^")],
  ];
  const segments = [
    [
      "ISA",
      "00",
      pad("", 10),
      "00",
      pad("", 10),
      "ZZ",
      pad(submitter, 15),
      "ZZ",
      pad("CMS", 15),
      ccyymmdd.slice(2),
      hhmm,
      "^",
      "00501",
      control,
      "0",
      req.usage,
      "|",
    ],
    ["GS", "HS", submitter, "CMS", ccyymmdd, hhmm, String(req.controlNumber), "X", "005010X279A1"],
    ...body,
    ["SE", String(body.length + 1), "0001"],
    ["GE", "1", String(req.controlNumber)],
    ["IEA", "1", control],
  ];
  return segments.map((s) => `${s.join("*")}~`).join("");
}
