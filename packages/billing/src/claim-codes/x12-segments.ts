// @chartwarden/billing — the 837I (ASC X12N 005010X223A2) Loop 2300 segments that carry the discharge claim
// codes, and the claim document M23 sends to the X12 gateway's `POST /generate-837i`. PURE string building.
//
// This is the CONTRACT the external gateway must honour: given a `ClaimDocument837i.dischargeCodes`, the
// generated 837I must contain exactly the segments `buildDischargeCodeSegments` produces (element
// separator `*`, component separator `:`, segment terminator `~`). The gateway owns the rest of the claim.
//
// 005010X223A2 Loop 2300. The X12 implementation guide itself is licensed, so the element layout below is
// taken from public payer companion guides (CGS "ASC X12 837I 5010A2" UB-04 crosswalk, Palmetto GBA "EDI
// 837I v5010A2 crosswalk", Highmark "Readable Sample 837I", Maryland Medicaid 837I companion guide) and
// should be confirmed against the licensed guide by the gateway owner:
//   CL1  Institutional Claim Code — CL101 admission type code (REQUIRED in 5010A2), CL102 admission source
//        code (situational), CL103 patient status code (UB-04 FL 17).
//   HI   Condition Information — each composite `BG:<condition code>` (UB-04 FL 18-28), max 12 per HI.
//   HI   Occurrence Information — each composite `BH:<occurrence code>:D8:<CCYYMMDD>` (UB-04 FL 31-34),
//        max 12 per HI.
//   HI   Occurrence Span Information — each composite `BI:<span code>:RD8:<CCYYMMDD>-<CCYYMMDD>` (UB-04 FL
//        35-36), max 12 per HI. Today only the late-NOE span 77 (ch. 11 §20.1.1) is derived.
//
// CL101/CL102 are NOT derived by ChartWarden: the caller passes them (the gateway's own claim data). This module
// only guarantees CL103 and the BG/BH composites match the derived codes.
import type { IsoDate } from "../contracts";
import { toEpochDay } from "../domain/dates";
import type { OccurrenceSpan } from "../notice/late-noe";
import type { DischargeClaimCodes } from "./discharge-codes";

/** The X12 HI segment holds HI01..HI12. */
const HI_MAX_COMPOSITES = 12;

/** The claim-code part of the document M23 hands the gateway (`Generate837iRequest.claimDocument`). */
export interface ClaimDocument837i {
  readonly claimId: string;
  readonly claimControlNumber: string;
  readonly tob: string;
  readonly serviceFrom: IsoDate;
  readonly serviceTo: IsoDate;
  /** UB-04 FL 14 Type of Admission / CL101 — from the M6 admission; null = not recorded (the claim is blocked by
   *  `admission_codes_present` before it can be submitted). */
  readonly admissionTypeCode?: string | null;
  /** UB-04 FL 15 Point of Origin / CL102 (Stedi `admissionSourceCode`). */
  readonly admissionSourceCode?: string | null;
  /** UB-04 FL 39-41 / HI*BE — value code 61 (residence CBSA) / G8 (inpatient-facility CBSA); empty = none resolved. */
  readonly valueCodes?: readonly { readonly code: string; readonly cbsaCode: string }[];
  readonly dischargeCodes: {
    /** UB-04 FL 17 / CL103. */
    readonly patientStatus: string;
    /** UB-04 FL 18-28 / HI*BG. */
    readonly conditionCodes: readonly string[];
    /** UB-04 FL 31-34 / HI*BH (date CCYY-MM-DD; the segment builder renders D8 CCYYMMDD). */
    readonly occurrenceCodes: readonly { readonly code: string; readonly date: IsoDate }[];
  };
  /** UB-04 FL 35-36 / HI*BI — today the late-NOE provider-liable span 77 (`lateNoeOccurrenceSpan`). The
   *  gateway must also report the charges of the lines on those days as non-covered (ch. 11 §20.1.1). */
  readonly occurrenceSpans: readonly OccurrenceSpan[];
}

const CODE_RE = /^[0-9A-Z]{2}$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertCode(kind: string, code: string): void {
  if (!CODE_RE.test(code))
    throw new Error(`invalid ${kind} code '${code}' (expected 2 chars [0-9A-Z])`);
}

function d8(date: string): string {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`invalid occurrence date '${date}' (expected CCYY-MM-DD)`);
  return `${m[1]}${m[2]}${m[3]}`;
}

function hiSegments(composites: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < composites.length; i += HI_MAX_COMPOSITES) {
    out.push(`HI*${composites.slice(i, i + HI_MAX_COMPOSITES).join("*")}~`);
  }
  return out;
}

/** `CL1*<CL101>*<CL102>*<CL103>~`. CL101 is required in 005010X223A2, so it must be supplied. */
export function buildCl1Segment(input: {
  readonly admissionTypeCode: string;
  readonly admissionSourceCode?: string | null;
  readonly patientStatusCode: string;
}): string {
  if (!/^[0-9]$/.test(input.admissionTypeCode)) {
    throw new Error(`invalid CL101 admission type code '${input.admissionTypeCode}'`);
  }
  const source = input.admissionSourceCode ?? "";
  if (source !== "" && !/^[0-9A-Z]$/.test(source)) {
    throw new Error(`invalid CL102 admission source code '${source}'`);
  }
  assertCode("patient status", input.patientStatusCode);
  return `CL1*${input.admissionTypeCode}*${source}*${input.patientStatusCode}~`;
}

/** `HI*BG:<code>*BG:<code>...~` (none when there are no condition codes). */
export function buildConditionCodeSegments(codes: readonly string[]): string[] {
  for (const c of codes) assertCode("condition", c);
  return hiSegments(codes.map((c) => `BG:${c}`));
}

/** `HI*BH:<code>:D8:<CCYYMMDD>*...~` (none when there are no occurrence codes). */
export function buildOccurrenceCodeSegments(
  occurrences: readonly { readonly code: string; readonly date: string }[],
): string[] {
  for (const o of occurrences) assertCode("occurrence", o.code);
  return hiSegments(occurrences.map((o) => `BH:${o.code}:D8:${d8(o.date)}`));
}

/** `HI*BI:<code>:RD8:<CCYYMMDD>-<CCYYMMDD>*...~` (none when there are no occurrence spans). */
export function buildOccurrenceSpanSegments(spans: readonly OccurrenceSpan[]): string[] {
  for (const s of spans) {
    assertCode("occurrence span", s.code);
    if (toEpochDay(s.from) > toEpochDay(s.through)) {
      throw new Error(`inverted occurrence span ${s.code} (${s.from} > ${s.through})`);
    }
  }
  return hiSegments(spans.map((s) => `BI:${s.code}:RD8:${d8(s.from)}-${d8(s.through)}`));
}

/** The CL1 + condition HI + occurrence HI segments for one claim, in Loop 2300 order. */
export function buildDischargeCodeSegments(input: {
  readonly admissionTypeCode: string;
  readonly admissionSourceCode?: string | null;
  readonly dischargeCodes: ClaimDocument837i["dischargeCodes"];
}): string[] {
  return [
    buildCl1Segment({
      admissionTypeCode: input.admissionTypeCode,
      admissionSourceCode: input.admissionSourceCode ?? null,
      patientStatusCode: input.dischargeCodes.patientStatus,
    }),
    ...buildOccurrenceCodeSegments(input.dischargeCodes.occurrenceCodes),
    ...buildConditionCodeSegments(input.dischargeCodes.conditionCodes),
  ];
}

/**
 * Project resolved {@link DischargeClaimCodes} onto the document shape. THROWS on unresolved codes — the
 * validation rule blocks such a claim long before submission, so reaching here unresolved is a bug.
 */
export function claimDocumentDischargeCodes(
  codes: DischargeClaimCodes,
): ClaimDocument837i["dischargeCodes"] {
  if (codes.unresolved !== null || codes.patientStatus === null) {
    throw new Error(`discharge claim codes are unresolved (${codes.unresolved ?? "no status"})`);
  }
  return {
    patientStatus: codes.patientStatus,
    conditionCodes: [...codes.conditionCodes],
    occurrenceCodes: codes.occurrenceCodes.map((o) => ({ code: o.code, date: o.date })),
  };
}
