// @wardenx/x12-837-client — the ASC X12N 837I (005010X223A2) hospice claim, TOB 81x, frequencies 1/2/3/4 (original
// bills), 7 (replacement) and 8 (void). PURE string building (ADR-0037, ADR-0053 D9); no network, no clock.
// Golden fixtures are the payloads the Stedi sandbox accepted on 2026-10-09. "Passed edits" is not payer acceptance.
//
// Sandbox-observed rules honoured here (and re-checked by `checkStediEdits` in the tests):
//   • frequency 1/4 (final bills) conflict with patient status 30; frequency 2/3 (interim) are "still a patient";
//   • CLM02 equals the sum of the SV2 charges, so every chargeable line is a real line (`BHT06=CH` needs > $0);
//   • CL102 admission source is required; `DTP*096` (discharge hour) is the TM form;
//   • frequency 7/8 carries `REF*F8` (payer claim control number) as the segment right after CL1.
// Line modifiers (e.g. PM) are carried as data into SV2-02; deciding WHEN a modifier or a Q5006 weekly-reporting
// line applies is claim assembly (`@wardenx/billing`), not this serializer.
import { type Parties837i, partySegments } from "../x12/parties";
import {
  X12BuildError,
  type X12Envelope,
  type X12Physician,
  d8,
  hi,
  physicianName,
  prepareEnvelope,
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
const MAX_TOTAL_CENTS = 9_999_999_999;

export interface ClaimLine {
  /** 4-digit revenue code (e.g. 0651). */
  readonly revenueCode: string;
  /** 5-character HCPCS code (e.g. Q5001). */
  readonly hcpcs: string;
  /** Optional 2-character HCPCS modifiers, serialised into SV2-02 (`HC:Q5001:PM`). */
  readonly modifiers?: readonly string[];
  /** Integer cents, > 0. */
  readonly chargeCents: number;
  readonly units: number;
  readonly serviceDate: string;
}

export interface ClaimDocument {
  readonly controlNumber: string;
  /** Claim frequency (CLM05-3): 1/2/3/4 original, 7 replacement, 8 void. */
  readonly frequency: string;
  readonly statementFromDate: string;
  readonly statementThroughDate: string;
  readonly admissionDate: string;
  /** CL102 — required. */
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
  /** `amount` is a decimal string (e.g. a CBSA "38900"). */
  readonly valueCodes: readonly { readonly code: string; readonly amount: string }[];
  readonly lines: readonly ClaimLine[];
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
    throw e;
  }
}

const fail = (field: string): never => {
  throw new Claim837iBuildError(field);
};

const check = (ok: boolean, field: string): void => {
  if (!ok) fail(field);
};

const diagnosis = (value: string, field: string): string => {
  const dx = value.replace(".", "").trim().toUpperCase();
  check(/^[A-Z][0-9][0-9A-Z]{1,5}$/.test(dx), field);
  return dx;
};

const dollars = (cents: number): string =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

function lineSegments(
  lines: readonly ClaimLine[],
  from: string,
  through: string,
): { segments: string[][]; totalCents: number } {
  check(lines.length > 0, "claim.lines");
  let totalCents = 0;
  const segments = lines.flatMap((l, i) => {
    const modifiers = l.modifiers ?? [];
    check(/^\d{4}$/.test(l.revenueCode), "claim.lines");
    check(/^[A-Z0-9]{5}$/.test(l.hcpcs), "claim.lines");
    check(modifiers.length <= 4 && modifiers.every((m) => /^[A-Z0-9]{2}$/.test(m)), "claim.lines");
    check(Number.isSafeInteger(l.chargeCents) && l.chargeCents > 0, "claim.lines");
    check(Number.isSafeInteger(l.units) && l.units > 0 && l.units <= 999_999, "claim.lines");
    const date = d8(l.serviceDate, "claim.lines");
    check(date >= from && date <= through, "claim.lines");
    totalCents += l.chargeCents;
    return [
      ["LX", String(i + 1)],
      [
        "SV2",
        l.revenueCode,
        ["HC", l.hcpcs, ...modifiers].join(":"),
        dollars(l.chargeCents),
        "UN",
        String(l.units),
      ],
      ["DTP", "472", "D8", date],
    ];
  });
  check(totalCents <= MAX_TOTAL_CENTS, "claim.lines");
  return { segments, totalCents };
}

function buildClaim(input: Claim837iInput): string {
  const c = input.claim;
  check(/^[A-Za-z0-9-]{1,38}$/.test(c.controlNumber), "claim.controlNumber");
  check(Object.hasOwn(FREQUENCIES, c.frequency), "claim.frequency");
  const mustBeStillPatient = FREQUENCIES[c.frequency];
  check(/^[0-9A-Z]{2}$/.test(c.patientStatus), "claim.patientStatus");
  check(
    mustBeStillPatient === null || mustBeStillPatient === (c.patientStatus === STILL_PATIENT),
    "claim.patientStatus",
  );
  check(/^[0-9A-Z]$/.test(c.admissionSource), "claim.admissionSource");
  const replacing = c.frequency === "7" || c.frequency === "8";
  const pccn = c.payerClaimControlNumber;
  check(replacing === (pccn !== undefined), "claim.payerClaimControlNumber");
  check(pccn === undefined || /^[A-Za-z0-9]{1,50}$/.test(pccn), "claim.payerClaimControlNumber");

  const from = d8(c.statementFromDate, "claim.statementFromDate");
  const through = d8(c.statementThroughDate, "claim.statementThroughDate");
  check(through >= from, "claim.statementThroughDate");
  const admission = d8(c.admissionDate, "claim.admissionDate");
  check(
    c.dischargeHour === undefined || /^([01]\d|2[0-3])[0-5]\d$/.test(c.dischargeHour),
    "claim.dischargeHour",
  );

  const principal = diagnosis(c.principalDiagnosis, "claim.principalDiagnosis");
  check(c.otherDiagnoses.length <= MAX_HI_VALUES, "claim.otherDiagnoses");
  const others = c.otherDiagnoses.map((d) => diagnosis(d, "claim.otherDiagnoses"));
  check(c.conditionCodes.length <= MAX_HI_VALUES, "claim.conditionCodes");
  check(
    c.conditionCodes.every((x) => /^[0-9A-Z]{2}$/.test(x)),
    "claim.conditionCodes",
  );
  check(c.occurrenceCodes.length <= MAX_HI_VALUES, "claim.occurrenceCodes");
  const occurrences = c.occurrenceCodes.map((o) => {
    check(/^[0-9A-Z]{2}$/.test(o.code), "claim.occurrenceCodes");
    return `${o.code}:D8:${d8(o.date, "claim.occurrenceCodes")}`;
  });
  check(c.valueCodes.length <= MAX_HI_VALUES, "claim.valueCodes");
  const values = c.valueCodes.map((v) => {
    check(/^[0-9A-Z]{2}$/.test(v.code), "claim.valueCodes");
    check(/^\d{1,9}(\.\d{1,2})?$/.test(v.amount), "claim.valueCodes");
    return `${v.code}:::${v.amount}`;
  });

  const env = prepareEnvelope(input.envelope);
  const { segments: lineSegs, totalCents } = lineSegments(c.lines, from, through);
  const { ccyymmdd, hhmm } = env.stamp;

  const body: string[][] = [
    ["BHT", "0019", "00", c.controlNumber, ccyymmdd, hhmm, "CH"],
    ...partySegments(input, from < admission ? from : admission),
    ["CLM", c.controlNumber, dollars(totalCents), "", "", `81:A:${c.frequency}`, "", "A", "Y", "Y"],
    ["DTP", "434", "RD8", `${from}-${through}`],
    ["DTP", "435", "D8", admission],
    ...(c.dischargeHour === undefined ? [] : [["DTP", "096", "TM", c.dischargeHour]]),
    ["CL1", "1", c.admissionSource, c.patientStatus],
    ...(pccn === undefined ? [] : [["REF", "F8", pccn]]),
    ["HI", `ABK:${principal}`],
    ...hi("ABF", others),
    ...hi("BH", occurrences),
    ...hi("BE", values),
    ...hi("BG", c.conditionCodes),
    physicianName(input.attendingPhysician, "71", "attendingPhysician"),
    ...lineSegs,
  ];
  return wrapTransaction(env, { transactionSet: "837", body });
}
