// @chartwarden/x12-837-client — the ASC X12N 837I (005010X223A2) hospice claim, TOB 81x, frequencies 1/2/3/4 (original
// bills), 7 (replacement) and 8 (void). PURE string building (ADR-0037, ADR-0053 D9); no network, no clock.
// Golden fixtures are the payloads the Stedi sandbox accepted on 2026-10-09. "Passed edits" is not payer acceptance.
//
// Sandbox-observed rules honoured here (and re-checked by `checkStediEdits` in the tests):
//   • frequency 1/4 (final bills) conflict with patient status 30; frequency 2/3 (interim) are "still a patient";
//   • CLM02 equals the sum of the SV2 charges, so every chargeable line is a real line (`BHT06=CH` needs > $0);
//   • CL102 admission source is required; `DTP*096` (discharge hour) is the TM form;
//   • frequency 7/8 carries `REF*F8` (payer claim control number) as the segment right after CL1.
// Line modifiers (e.g. PM) are carried as data into SV2-02; deciding WHEN a modifier or a Q5006 weekly-reporting
// line applies is claim assembly (`@chartwarden/billing`), not this serializer.
import { type Parties837i, partySegments } from "../x12/parties";
import {
  NAME_LIMIT,
  ORG_NAME_LIMIT,
  X12BuildError,
  type X12Envelope,
  type X12Physician,
  d8,
  hi,
  matches,
  optionalText,
  physicianName,
  prepareEnvelope,
  text,
  wrapTransaction,
} from "../x12/writer";

/** Thrown for an input the claim cannot carry. Names the FIELD only, never its value (PHI). */
export class Claim837iBuildError extends X12BuildError {
  public override readonly name = "Claim837iBuildError";
  constructor(field: string) {
    super(field, `invalid 837I claim input: ${field}`);
  }
}

const STILL_PATIENT = "30";
/** Whether CL103 must (true), must not (false) be 30, or may be anything (null) for a claim frequency. */
const FREQUENCIES: Readonly<Record<string, boolean | null>> = {
  "1": false,
  "2": true,
  "3": true,
  "4": false,
  "7": null,
  "8": null,
};
const MAX_HI_VALUES = 12;
const HHMM = /^([01]\d|2[0-3])[0-5]\d$/;
const MAX_TOTAL_CENTS = 9_999_999_999;
// UB-04 FL 14 / CL101 and FL 15 / CL102 values valid on a hospice claim. Mirrors `ADMISSION_TYPE_CODES` and
// `ADMISSION_SOURCE_CODES` in @chartwarden/types; this package is a dependency-free leaf, so the sets are copied.
const ADMISSION_TYPE_CODES: readonly string[] = ["1", "2", "3", "5", "9"];
const ADMISSION_SOURCE_CODES: readonly string[] = ["1", "2", "4", "5", "6", "8", "9"];

export interface ClaimLine {
  /** 4-digit revenue code (e.g. 0651). */
  readonly revenueCode: string;
  /**
   * 5-character HCPCS code (e.g. Q5001). Required on a Medicare claim; a commercial claim (`commercial` set) may bill a
   * revenue code alone, which leaves SV2-02 empty.
   */
  readonly hcpcs?: string;
  /** Optional 2-character HCPCS modifiers, serialised into SV2-02 (`HC:Q5001:PM`). */
  readonly modifiers?: readonly string[];
  /** Integer cents, > 0. */
  readonly chargeCents: number;
  readonly units: number;
  /** First (or only) date of service. */
  readonly serviceDate: string;
  /** Last date of service. Absent or equal to `serviceDate` emits `DTP*472*D8`; later emits `RD8`. */
  readonly serviceThroughDate?: string;
  /** Integer cents of the line charge that is not covered (SV207). Absent or 0 emits nothing; at most `chargeCents`. */
  readonly noncoveredCents?: number;
}

/**
 * Loop 2320 — another payer responsible for part of the claim (coordination of benefits). Only meaningful on a
 * commercial primary claim, where Medicare (`MA`) or Medicaid (`MC`) is secondary. The subscriber is the patient, so
 * the 2330A name is the claim's subscriber name; `memberId` is that payer's id for the patient (an MBI for Medicare).
 */
export interface ClaimOtherPayer {
  /** SBR01: S secondary, T tertiary. */
  readonly responsibility: "S" | "T";
  /** SBR09 for the other payer: `MA` Medicare Part A, `MC` Medicaid. */
  readonly claimFilingIndicator: "MA" | "MC";
  readonly memberId: string;
  readonly payerName: string;
  readonly payerId: string;
}

/** An occurrence span (HI*BI): a code with a from-through date range, e.g. 77 (provider-liable late-NOE days). */
export interface ClaimOccurrenceSpan {
  readonly code: string;
  readonly fromDate: string;
  readonly throughDate: string;
}

export interface ClaimDocument {
  readonly controlNumber: string;
  /** Claim frequency (CLM05-3): 1/2/3/4 original, 7 replacement, 8 void. */
  readonly frequency: string;
  readonly statementFromDate: string;
  readonly statementThroughDate: string;
  readonly admissionDate: string;
  /** Optional admission hour, HHMM. Present turns `DTP*435` from `D8` into the `DT` date-time form. */
  readonly admissionHour?: string;
  /** CL101 type of admission (UB-04 FL 14) — required, from the admission. */
  readonly admissionTypeCode: string;
  /** CL102 point of origin (UB-04 FL 15) — required. */
  readonly admissionSource: string;
  /** CL103, 2 characters (30 = still a patient). */
  readonly patientStatus: string;
  /** REF*F8 — required for frequency 7/8, refused otherwise. */
  readonly payerClaimControlNumber?: string;
  /** DTP*096 discharge hour, HHMM. */
  readonly dischargeHour?: string;
  /** ICD-10-CM, with or without the dot. */
  readonly principalDiagnosis: string;
  readonly otherDiagnoses: readonly string[];
  readonly conditionCodes: readonly string[];
  readonly occurrenceCodes: readonly { readonly code: string; readonly date: string }[];
  /** HI*BI occurrence spans. Absent = none. */
  readonly occurrenceSpans?: readonly ClaimOccurrenceSpan[];
  /**
   * Claim-level total of the non-covered line charges. 5010A2 has no claim-level segment for it (it is the sum of
   * the SV207s), so this is NOT emitted: when given it must equal the sum of the lines' `noncoveredCents`.
   */
  readonly nonCoveredChargeCents?: number;
  /** `amount` is a decimal string (e.g. a CBSA "38900"). */
  readonly valueCodes: readonly { readonly code: string; readonly amount: string }[];
  readonly lines: readonly ClaimLine[];
  /** Loop 2320/2330A/2330B. Commercial primary only: refused on a Medicare claim. At most two. */
  readonly otherPayers?: readonly ClaimOtherPayer[];
}

export interface Claim837iInput extends Parties837i {
  readonly envelope: X12Envelope;
  readonly claim: ClaimDocument;
  readonly attendingPhysician: X12Physician;
}

/** Build the 837I interchange for one claim (ISA … IEA, one ST-SE). */
export function build837iClaim(input: Claim837iInput): string {
  try {
    return buildClaim(input);
  } catch (e) {
    // The shared writer's helpers throw the base error; callers of this builder catch its own type.
    if (e instanceof X12BuildError && !(e instanceof Claim837iBuildError)) {
      throw new Claim837iBuildError(e.field);
    }
    // Untyped input (a missing section, a number where text belongs) must still fail as a build error.
    if (e instanceof TypeError) throw new Claim837iBuildError("input");
    throw e;
  }
}

const fail = (field: string): never => {
  throw new Claim837iBuildError(field);
};

const check = (ok: boolean, field: string): void => {
  if (!ok) fail(field);
};

export const diagnosis = (value: string, field: string): string => {
  check(typeof value === "string", field);
  const dx = value.replace(".", "").trim().toUpperCase();
  check(matches(/^[A-Z][0-9][0-9A-Z]{1,5}$/, dx), field);
  return dx;
};

export const dollars = (cents: number): string =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** `DTP*472`: D8 for one day, RD8 for a from-through range; both ends inside the statement window. */
function lineDate(l: ClaimLine, from: string, through: string): string[] {
  const start = d8(l.serviceDate, "claim.lines");
  const end = l.serviceThroughDate === undefined ? start : d8(l.serviceThroughDate, "claim.lines");
  check(start >= from && end <= through && start <= end, "claim.lines");
  return start === end ? ["DTP", "472", "D8", start] : ["DTP", "472", "RD8", `${start}-${end}`];
}

function lineSegments(
  lines: readonly ClaimLine[],
  from: string,
  through: string,
  hcpcsOptional: boolean,
): { segments: string[][]; totalCents: number; noncoveredCents: number } {
  check(Array.isArray(lines) && lines.length > 0, "claim.lines");
  let totalCents = 0;
  let noncoveredCents = 0;
  const segments = lines.flatMap((l, i) => {
    check(typeof l === "object" && l !== null, "claim.lines");
    const modifiers = l.modifiers ?? [];
    check(Array.isArray(modifiers), "claim.lines");
    check(matches(/^\d{4}$/, l.revenueCode), "claim.lines");
    check(l.hcpcs === undefined ? hcpcsOptional : matches(/^[A-Z0-9]{5}$/, l.hcpcs), "claim.lines");
    check(
      modifiers.length <= 4 && modifiers.every((m) => matches(/^[A-Z0-9]{2}$/, m)),
      "claim.lines",
    );
    check(Number.isSafeInteger(l.chargeCents) && l.chargeCents > 0, "claim.lines");
    check(Number.isSafeInteger(l.units) && l.units > 0 && l.units <= 999_999, "claim.lines");
    const noncovered = l.noncoveredCents ?? 0;
    check(
      Number.isSafeInteger(noncovered) && noncovered >= 0 && noncovered <= l.chargeCents,
      "claim.lines",
    );
    const dateSegment = lineDate(l, from, through);
    totalCents += l.chargeCents;
    noncoveredCents += noncovered;
    return [
      ["LX", String(i + 1)],
      [
        "SV2",
        l.revenueCode,
        l.hcpcs === undefined ? "" : ["HC", l.hcpcs, ...modifiers].join(":"),
        dollars(l.chargeCents),
        "UN",
        String(l.units),
        // SV206 (unit rate) is left empty so the non-covered charge lands in SV207.
        ...(noncovered > 0 ? ["", dollars(noncovered)] : []),
      ],
      dateSegment,
    ];
  });
  check(totalCents <= MAX_TOTAL_CENTS, "claim.lines");
  return { segments, totalCents, noncoveredCents };
}

/** 2320 SBR/OI, 2330A subscriber name, 2330B other payer name, for each other payer (commercial primary only). */
function otherPayerSegments(input: Claim837iInput): string[][] {
  const others = input.claim.otherPayers ?? [];
  check(Array.isArray(others) && others.length <= 2, "claim.otherPayers");
  if (others.length === 0) return [];
  check(input.commercial !== undefined, "claim.otherPayers");
  const s = input.subscriber;
  return others.flatMap((o) => {
    check(o.responsibility === "S" || o.responsibility === "T", "claim.otherPayers");
    check(o.claimFilingIndicator === "MA" || o.claimFilingIndicator === "MC", "claim.otherPayers");
    check(matches(/^[A-Za-z0-9-]{2,60}$/, o.memberId), "claim.otherPayers.memberId");
    return [
      ["SBR", o.responsibility, "18", "", "", "", "", "", "", o.claimFilingIndicator],
      ["OI", "", "", "Y", "", "", "Y"],
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
        o.memberId.trim().toUpperCase(),
      ],
      [
        "NM1",
        "PR",
        "2",
        text(o.payerName, "claim.otherPayers.payerName", ORG_NAME_LIMIT),
        "",
        "",
        "",
        "",
        "PI",
        text(o.payerId, "claim.otherPayers.payerId", 80),
      ],
    ];
  });
}

function buildClaim(input: Claim837iInput): string {
  const c = input.claim;
  check(matches(/^[A-Za-z0-9-]{1,38}$/, c.controlNumber), "claim.controlNumber");
  check(Object.hasOwn(FREQUENCIES, c.frequency), "claim.frequency");
  const mustBeStillPatient = FREQUENCIES[c.frequency];
  check(matches(/^[0-9A-Z]{2}$/, c.patientStatus), "claim.patientStatus");
  check(
    mustBeStillPatient === null || mustBeStillPatient === (c.patientStatus === STILL_PATIENT),
    "claim.patientStatus",
  );
  check(ADMISSION_TYPE_CODES.includes(c.admissionTypeCode), "claim.admissionTypeCode");
  check(ADMISSION_SOURCE_CODES.includes(c.admissionSource), "claim.admissionSource");
  const spanList = c.occurrenceSpans ?? [];
  check(Array.isArray(spanList), "claim.occurrenceSpans");
  for (const [list, field] of [
    [c.otherDiagnoses, "claim.otherDiagnoses"],
    [c.conditionCodes, "claim.conditionCodes"],
    [c.occurrenceCodes, "claim.occurrenceCodes"],
    [c.valueCodes, "claim.valueCodes"],
  ] as const) {
    check(Array.isArray(list), field);
  }
  check(
    [...c.occurrenceCodes, ...c.valueCodes].every((x) => typeof x === "object" && x !== null),
    "claim.occurrenceCodes",
  );
  const replacing = c.frequency === "7" || c.frequency === "8";
  const pccn = c.payerClaimControlNumber ?? undefined;
  check(replacing === (pccn !== undefined), "claim.payerClaimControlNumber");
  check(
    pccn === undefined || matches(/^[A-Za-z0-9]{1,50}$/, pccn),
    "claim.payerClaimControlNumber",
  );

  const from = d8(c.statementFromDate, "claim.statementFromDate");
  const through = d8(c.statementThroughDate, "claim.statementThroughDate");
  check(through >= from, "claim.statementThroughDate");
  const admission = d8(c.admissionDate, "claim.admissionDate");
  check(admission <= through, "claim.admissionDate");
  check(c.dischargeHour === undefined || matches(HHMM, c.dischargeHour), "claim.dischargeHour");
  check(c.admissionHour === undefined || matches(HHMM, c.admissionHour), "claim.admissionHour");

  const principal = diagnosis(c.principalDiagnosis, "claim.principalDiagnosis");
  check(c.otherDiagnoses.length <= MAX_HI_VALUES, "claim.otherDiagnoses");
  const others = c.otherDiagnoses.map((d) => diagnosis(d, "claim.otherDiagnoses"));
  check(c.conditionCodes.length <= MAX_HI_VALUES, "claim.conditionCodes");
  check(
    c.conditionCodes.every((x) => matches(/^[0-9A-Z]{2}$/, x)),
    "claim.conditionCodes",
  );
  check(c.occurrenceCodes.length <= MAX_HI_VALUES, "claim.occurrenceCodes");
  const occurrences = c.occurrenceCodes.map((o) => {
    check(matches(/^[0-9A-Z]{2}$/, o.code), "claim.occurrenceCodes");
    return `${o.code}:D8:${d8(o.date, "claim.occurrenceCodes")}`;
  });
  check(spanList.length <= MAX_HI_VALUES, "claim.occurrenceSpans");
  const spans = spanList.map((o) => {
    check(typeof o === "object" && o !== null, "claim.occurrenceSpans");
    check(matches(/^[0-9A-Z]{2}$/, o.code), "claim.occurrenceSpans");
    const spanFrom = d8(o.fromDate, "claim.occurrenceSpans");
    const spanThrough = d8(o.throughDate, "claim.occurrenceSpans");
    check(spanFrom <= spanThrough, "claim.occurrenceSpans");
    return `${o.code}:RD8:${spanFrom}-${spanThrough}`;
  });
  check(c.valueCodes.length <= MAX_HI_VALUES, "claim.valueCodes");
  const values = c.valueCodes.map((v) => {
    check(matches(/^[0-9A-Z]{2}$/, v.code), "claim.valueCodes");
    check(matches(/^\d{1,9}(\.\d{1,2})?$/, v.amount), "claim.valueCodes");
    return `${v.code}:::${v.amount}`;
  });

  const env = prepareEnvelope(input.envelope);
  const {
    segments: lineSegs,
    totalCents,
    noncoveredCents,
  } = lineSegments(c.lines, from, through, input.commercial !== undefined);
  const otherPayerSegs = otherPayerSegments(input);
  check(
    c.nonCoveredChargeCents === undefined || c.nonCoveredChargeCents === noncoveredCents,
    "claim.nonCoveredChargeCents",
  );
  const { ccyymmdd, hhmm } = env.stamp;

  const body: string[][] = [
    ["BHT", "0019", "00", c.controlNumber, ccyymmdd, hhmm, "CH"],
    ...partySegments(input, from < admission ? from : admission),
    ["CLM", c.controlNumber, dollars(totalCents), "", "", `81:A:${c.frequency}`, "", "A", "Y", "Y"],
    ...(c.dischargeHour === undefined ? [] : [["DTP", "096", "TM", c.dischargeHour]]),
    ["DTP", "434", "RD8", `${from}-${through}`],
    c.admissionHour === undefined
      ? ["DTP", "435", "D8", admission]
      : ["DTP", "435", "DT", `${admission}${c.admissionHour}`],
    ["CL1", c.admissionTypeCode, c.admissionSource, c.patientStatus],
    ...(pccn === undefined ? [] : [["REF", "F8", pccn]]),
    ["HI", `ABK:${principal}`],
    ...hi("ABF", others),
    ...hi("BH", occurrences),
    ...hi("BI", spans),
    ...hi("BE", values),
    ...hi("BG", c.conditionCodes),
    physicianName(input.attendingPhysician, "71", "attendingPhysician"),
    ...otherPayerSegs,
    ...lineSegs,
  ];
  return wrapTransaction(env, { transactionSet: "837", body });
}
