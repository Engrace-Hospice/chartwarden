// @wardenx/x12-837-client — the ASC X12N 837I (005010X223A2) for a Medicare hospice Change of Provider /
// Transfer Notice (TOB 81C/82C), its date correction, and the 8xD void that removes a transfer submitted in
// error. PURE string building (ADR-0037: X12 is TypeScript in this M23-owned package); no network, no clock
// (the caller passes `createdAt`).
//
// Sources, re-verified 2026-10:
//   • CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4, Rev. 12847 (issued 2024-09-13, effective 2024-06-03)
//     https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/clm104c11.pdf
//     — TOB 81C/82C (81D/82D); Statement From = the effective date, no Through; the receiving hospice's own
//     admission date (the transfer date on an 8xD); Medicare primary + MBI (validate via HETS); principal ICD-10;
//     attending physician (the certifying physician when none); "other physician" = the certifying physician,
//     Loop 2310F, omitted when the same as the attending; OC 56 + CC D0 on a correction; OC 27 when the
//     transfer date is also the first day of the next benefit period.
//   • CMS 837I NOE Companion Guide v1.2 (April 2021) — covers every NOE-related TOB (CLM05-3 A–E)
//     https://www.cms.gov/files/document/cms-837i-noe-companion-guide.pdf
//     — CLM02 = 0; CL102 "1"; CL103 "30"; one SV2 (0650 / HC:Q5009 / description "NOE" / 0 / 1 unit);
//     2010BA REF, 2010BB REF, 2000C HL/PAT, 2010CA, 2300 CN1, 2300 REF payer claim control #, 2310A REF must
//     NOT be present; NM108 "PI" on the payer; BHT02 "00"; ISA12 "00501"; one ST-SE per GS-GE per ISA-IEA.
// The X12 TR3 itself is licensed; segment order and element positions below follow the public payer
// crosswalks already cited in `@wardenx/billing` `claim-codes/x12-segments.ts`.
import { MBI_PATTERN } from "../eligibility/build-270";
import { isoToX12Date } from "../eligibility/x12-envelope";

/** Thrown for an input the 837I cannot carry. Names the FIELD only, never its value (PHI). */
export class TransferNotice837iBuildError extends Error {
  public override readonly name = "TransferNotice837iBuildError";
  constructor(public readonly field: string) {
    super(`invalid transfer-notice 837I input: ${field}`);
  }
}

export interface X12Address {
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly state: string;
  /** 5 or 9 digits (a hyphen is stripped). */
  readonly postalCode: string;
}

export interface X12PersonName {
  readonly lastName: string;
  readonly firstName: string;
  readonly middleInitial?: string | null;
}

export interface X12Physician extends X12PersonName {
  readonly npi: string;
}

/** The facts half — structurally the `TransferNoticeDocument837i` `@wardenx/billing` hands the gateway. */
export interface TransferNoticeDocumentInput {
  readonly controlNumber: string;
  readonly action: "original" | "correction" | "void";
  readonly tob: string;
  readonly frequencyCode: "C" | "D";
  readonly statementFromDate: string;
  readonly admissionDate: string;
  readonly conditionCodes: readonly string[];
  readonly occurrenceCodes: readonly { readonly code: string; readonly date: string }[];
}

export interface TransferNotice837iInput {
  readonly envelope: {
    readonly senderId: string;
    readonly receiverId: string;
    /** GS03 — the MAC's application receiver code. */
    readonly applicationReceiverCode: string;
    /** ISA13 / GS06 / ST02 seed: 1..999 999 999. */
    readonly interchangeControlNumber: number;
    readonly usage: "P" | "T";
    readonly createdAt: Date;
  };
  readonly submitter: {
    readonly name: string;
    readonly id: string;
    readonly contactName: string;
    readonly contactPhone: string;
  };
  readonly receiver: { readonly name: string; readonly id: string };
  readonly billingProvider: {
    readonly organizationName: string;
    readonly npi: string;
    /** EIN, 9 digits. */
    readonly taxId: string;
    readonly address: X12Address;
  };
  /** The beneficiary — the subscriber IS the patient on an NOE (2000C must not be present). */
  readonly subscriber: X12PersonName & {
    readonly mbi: string;
    readonly address: X12Address;
    readonly birthDate: string;
    readonly sex: "M" | "F";
  };
  readonly payer: { readonly name: string; readonly payerId: string };
  readonly document: TransferNoticeDocumentInput;
  /** ICD-10-CM, with or without the dot. */
  readonly principalDiagnosis: string;
  readonly attendingPhysician: X12Physician;
  /** Loop 2310F; null when the certifying physician IS the attending. */
  readonly otherPhysician: X12Physician | null;
}

const NAME_LIMIT = 60;
const ORG_NAME_LIMIT = 60;
const FORBIDDEN = /[*~:^|]/;

function text(value: string | null | undefined, field: string, max: number): string {
  const v = (value ?? "").trim().toUpperCase();
  if (v.length === 0 || v.length > max || FORBIDDEN.test(v))
    throw new TransferNotice837iBuildError(field);
  return v;
}

function optionalText(value: string | null | undefined, field: string, max: number): string {
  if (value === null || value === undefined || value.trim() === "") return "";
  return text(value, field, max);
}

/** The NPI check digit: Luhn mod 10 over the "80840" card-issuer prefix + the first nine digits. */
export function isValidNpi(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const digits = `80840${value.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits.charAt(digits.length - 1 - i));
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(value.charAt(9));
}

/** "National Provider Identifiers will be validated against the NPI algorithm" (NOE companion guide). */
function npi(value: string, field: string): string {
  if (!isValidNpi(value)) throw new TransferNotice837iBuildError(field);
  return value;
}

function d8(iso: string, field: string): string {
  try {
    return isoToX12Date(iso);
  } catch {
    throw new TransferNotice837iBuildError(field);
  }
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ").slice(0, width);
}

function addressSegments(a: X12Address, field: string): string[][] {
  const zip = a.postalCode.replace("-", "");
  if (!/^\d{5}(\d{4})?$/.test(zip)) throw new TransferNotice837iBuildError(`${field}.postalCode`);
  if (!/^[A-Z]{2}$/.test(a.state.trim().toUpperCase())) {
    throw new TransferNotice837iBuildError(`${field}.state`);
  }
  const line2 = optionalText(a.line2, `${field}.line2`, 55);
  return [
    ["N3", text(a.line1, `${field}.line1`, 55), ...(line2 ? [line2] : [])],
    ["N4", text(a.city, `${field}.city`, 30), a.state.trim().toUpperCase(), zip],
  ];
}

function physicianName(p: X12Physician, qualifier: "71" | "DN", field: string): string[] {
  return [
    "NM1",
    qualifier,
    "1",
    text(p.lastName, `${field}.lastName`, NAME_LIMIT),
    text(p.firstName, `${field}.firstName`, 35),
    optionalText(p.middleInitial, `${field}.middleInitial`, 1),
    "",
    "",
    "XX",
    npi(p.npi, `${field}.npi`),
  ];
}

function hi(qualifier: string, values: readonly string[]): string[][] {
  // The HI segment holds 12 composites; a transfer notice carries at most two of each kind.
  return values.length === 0 ? [] : [["HI", ...values.map((v) => `${qualifier}:${v}`)]];
}

/** Build the 837I interchange for one transfer notice (ISA … IEA, one ST-SE). */
export function build837iTransferNotice(input: TransferNotice837iInput): string {
  const doc = input.document;
  if (!/^8[12][CD]$/.test(doc.tob) || doc.tob.charAt(2) !== doc.frequencyCode) {
    throw new TransferNotice837iBuildError("document.tob");
  }
  if ((doc.frequencyCode === "D") !== (doc.action === "void")) {
    throw new TransferNotice837iBuildError("document.action");
  }
  const hasD0 = doc.conditionCodes.includes("D0");
  const has56 = doc.occurrenceCodes.some((o) => o.code === "56");
  // §20.1.3: OC 56 and CC D0 together, or the notice is returned.
  if (hasD0 !== has56 || has56 !== (doc.action === "correction")) {
    throw new TransferNotice837iBuildError("document.correctionCodes");
  }
  if (!/^[A-Za-z0-9-]{1,38}$/.test(doc.controlNumber)) {
    throw new TransferNotice837iBuildError("document.controlNumber");
  }
  for (const c of doc.conditionCodes) {
    if (!/^[0-9A-Z]{2}$/.test(c)) throw new TransferNotice837iBuildError("document.conditionCodes");
  }
  for (const o of doc.occurrenceCodes) {
    if (!/^[0-9A-Z]{2}$/.test(o.code)) {
      throw new TransferNotice837iBuildError("document.occurrenceCodes");
    }
  }
  const from = d8(doc.statementFromDate, "document.statementFromDate");
  const admission = d8(doc.admissionDate, "document.admissionDate");
  if (doc.action === "void" && admission !== from) {
    // §20.1.4: on a transfer, the 8xD's From and admit dates must match the transfer date.
    throw new TransferNotice837iBuildError("document.admissionDate");
  }

  const s = input.subscriber;
  const mbi = s.mbi.trim().toUpperCase();
  if (!MBI_PATTERN.test(mbi)) throw new TransferNotice837iBuildError("subscriber.mbi");
  const dob = d8(s.birthDate, "subscriber.birthDate");
  if (dob > from) throw new TransferNotice837iBuildError("subscriber.birthDate");
  const dx = input.principalDiagnosis.replace(".", "").trim().toUpperCase();
  if (!/^[A-Z][0-9][0-9A-Z]{1,5}$/.test(dx)) {
    throw new TransferNotice837iBuildError("principalDiagnosis");
  }
  if (!/^\d{9}$/.test(input.billingProvider.taxId)) {
    throw new TransferNotice837iBuildError("billingProvider.taxId");
  }
  const sender = text(input.envelope.senderId, "envelope.senderId", 15);
  const receiver = text(input.envelope.receiverId, "envelope.receiverId", 15);
  const appReceiver = text(
    input.envelope.applicationReceiverCode,
    "envelope.applicationReceiverCode",
    15,
  );
  const icn = input.envelope.interchangeControlNumber;
  if (!Number.isInteger(icn) || icn < 1 || icn > 999_999_999) {
    throw new TransferNotice837iBuildError("envelope.interchangeControlNumber");
  }
  if (!/^\d{10}$/.test(input.submitter.contactPhone)) {
    throw new TransferNotice837iBuildError("submitter.contactPhone");
  }

  const n = input.envelope.createdAt;
  const ccyymmdd = `${n.getUTCFullYear()}${two(n.getUTCMonth() + 1)}${two(n.getUTCDate())}`;
  const hhmm = `${two(n.getUTCHours())}${two(n.getUTCMinutes())}`;
  const control = String(icn).padStart(9, "0");
  const st02 = String(icn).padStart(4, "0");

  const body: string[][] = [
    ["ST", "837", st02, "005010X223A2"],
    // BHT02 must be "00" (original); BHT06 "CH" chargeable.
    ["BHT", "0019", "00", doc.controlNumber, ccyymmdd, hhmm, "CH"],
    // Loop 1000A submitter / 1000B receiver.
    [
      "NM1",
      "41",
      "2",
      text(input.submitter.name, "submitter.name", ORG_NAME_LIMIT),
      "",
      "",
      "",
      "",
      "46",
      text(input.submitter.id, "submitter.id", 80),
    ],
    [
      "PER",
      "IC",
      text(input.submitter.contactName, "submitter.contactName", NAME_LIMIT),
      "TE",
      input.submitter.contactPhone,
    ],
    [
      "NM1",
      "40",
      "2",
      text(input.receiver.name, "receiver.name", ORG_NAME_LIMIT),
      "",
      "",
      "",
      "",
      "46",
      text(input.receiver.id, "receiver.id", 80),
    ],
    // Loop 2000A / 2010AA billing provider (NPI only — no secondary REF).
    ["HL", "1", "", "20", "1"],
    [
      "NM1",
      "85",
      "2",
      text(
        input.billingProvider.organizationName,
        "billingProvider.organizationName",
        ORG_NAME_LIMIT,
      ),
      "",
      "",
      "",
      "",
      "XX",
      npi(input.billingProvider.npi, "billingProvider.npi"),
    ],
    ...addressSegments(input.billingProvider.address, "billingProvider.address"),
    ["REF", "EI", input.billingProvider.taxId],
    // Loop 2000B subscriber = patient (2000C must not be present); Medicare Part A primary.
    ["HL", "2", "1", "22", "0"],
    ["SBR", "P", "18", "", "", "", "", "", "", "MA"],
    [
      "NM1",
      "IL",
      "1",
      text(s.lastName, "subscriber.lastName", NAME_LIMIT),
      text(s.firstName, "subscriber.firstName", 35),
      optionalText(s.middleInitial, "subscriber.middleInitial", 1),
      "",
      "",
      "MI",
      mbi,
    ],
    ...addressSegments(s.address, "subscriber.address"),
    ["DMG", "D8", dob, s.sex],
    // Loop 2010BB payer — NM108 "PI".
    [
      "NM1",
      "PR",
      "2",
      text(input.payer.name, "payer.name", ORG_NAME_LIMIT),
      "",
      "",
      "",
      "",
      "PI",
      text(input.payer.payerId, "payer.payerId", 80),
    ],
    // Loop 2300 — zero charge; CLM05 = facility type : A : frequency; assignment A / Y; release of info Y.
    [
      "CLM",
      doc.controlNumber,
      "0",
      "",
      "",
      `${doc.tob.slice(0, 2)}:A:${doc.frequencyCode}`,
      "",
      "A",
      "Y",
      "Y",
    ],
    // Statement From only (§20.1.3 "No through date is required"); the 837I RD8 range repeats it.
    ["DTP", "434", "RD8", `${from}-${from}`],
    ["DTP", "435", "D8", admission],
    ["CL1", "9", "1", "30"],
    ["HI", `ABK:${dx}`],
    ...hi(
      "BH",
      doc.occurrenceCodes.map((o) => `${o.code}:D8:${d8(o.date, "document.occurrenceCodes")}`),
    ),
    ...hi("BG", doc.conditionCodes),
    // Loop 2310A attending (no REF); Loop 2310F "other physician" = the certifying physician.
    physicianName(input.attendingPhysician, "71", "attendingPhysician"),
    ...(input.otherPhysician === null || input.otherPhysician.npi === input.attendingPhysician.npi
      ? []
      : [physicianName(input.otherPhysician, "DN", "otherPhysician")]),
    // Loop 2400 — the single default service line the NOE companion guide prescribes.
    ["LX", "1"],
    ["SV2", "0650", "HC:Q5009:::::NOE", "0", "UN", "1"],
    ["DTP", "472", "D8", from],
  ];
  const segments: string[][] = [
    [
      "ISA",
      "00",
      pad("", 10),
      "00",
      pad("", 10),
      "ZZ",
      pad(sender, 15),
      "ZZ",
      pad(receiver, 15),
      ccyymmdd.slice(2),
      hhmm,
      "^",
      "00501",
      control,
      "1",
      input.envelope.usage,
      ":",
    ],
    ["GS", "HC", sender, appReceiver, ccyymmdd, hhmm, String(icn), "X", "005010X223A2"],
    ...body,
    ["SE", String(body.length + 1), st02],
    ["GE", "1", String(icn)],
    ["IEA", "1", control],
  ];
  return segments.map((seg) => `${seg.join("*")}~`).join("");
}
