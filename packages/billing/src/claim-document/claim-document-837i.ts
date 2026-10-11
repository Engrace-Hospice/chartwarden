import type { ClaimDocument837i } from "../claim-codes/x12-segments";
import type { ClaimDiagnosisSnapshotEntry } from "../claim-lines/claim-snapshot";
// @wardenx/billing — the DETAILED claim document: everything the 837I builders need that lives on the persisted claim
// (claim row + claim_line rows + the 1068 snapshot columns + the M6 admission date). It extends the thin gateway
// contract `ClaimDocument837i` and is PURE (no I/O, no clock).
//
// What it deliberately does NOT carry: the beneficiary's identity (MBI, name, DOB, sex, address) and the billing /
// submitter / receiver / payer parties. Those are read through their owning seams at load time, held in memory for
// one build, and never stored with the document (M23 D13 / §3.6 / §8.7).
//
// Nothing is invented: a field with no source is reported as a {@link ClaimGap}, never defaulted.
import type { IsoDate } from "../contracts";
import { inclusiveDayCount, toEpochDay } from "../domain/dates";
import { type ClaimGap, type GapResult, gap } from "./claim-gaps";

/** Claim frequencies (CLM05-3) the hospice 837I carries. */
const FREQUENCY_BY_TOB: Readonly<Record<string, string>> = {
  "811": "1",
  "812": "2",
  "813": "3",
  "814": "4",
  "817": "7",
  "818": "8",
};
const REPLACEMENT_FREQUENCIES: readonly string[] = ["7", "8"];

export interface ClaimDocumentLine {
  readonly lineNumber: number;
  /** 4-digit revenue code. */
  readonly revenueCode: string;
  /** The HCPCS on SV202: the line's own ancillary code (visit lines, G0679) else its Q50xx place-of-service code. */
  readonly hcpcs: string;
  readonly modifiers: readonly string[];
  readonly units: number;
  readonly chargeCents: number;
  /** Integer cents of the charge that Medicare does not cover (late-NOE span 77); 0 = none. */
  readonly noncoveredCents: number;
  readonly serviceDateFrom: IsoDate;
  readonly serviceDateTo: IsoDate;
}

export interface ClaimDocumentPhysician {
  readonly npi: string;
  readonly firstName: string;
  readonly lastName: string;
}

/** The claim as the 837I loader needs it. Extends the gateway document; every addition is required. */
export interface ClaimDocument837iDetail extends ClaimDocument837i {
  /** CLM05-3: 1/2/3/4 original, 7 replacement, 8 void (the last digit of the TOB). */
  readonly frequency: string;
  readonly admissionDate: IsoDate;
  readonly lines: readonly ClaimDocumentLine[];
  /** Sum of the lines' charges (integer cents) — equals CLM02. */
  readonly totalChargeCents: number;
  readonly nonCoveredChargeCents: number;
  /** Ordered by `sequence`; exactly one ABK. */
  readonly diagnoses: readonly ClaimDiagnosisSnapshotEntry[];
  readonly attendingPhysician: ClaimDocumentPhysician;
  /** Present only when the certifying physician differs from the attending. The 837I builders do not yet emit it. */
  readonly certifyingPhysician: ClaimDocumentPhysician | null;
  /** REF*F8 — the PREDECESSOR claim's payer control number; non-null exactly for frequency 7/8. */
  readonly payerClaimControlNumber: string | null;
}

/** The persisted claim row fields the document reads (a structural subset of `ClaimRecord`). */
export interface ClaimDocumentClaimSource {
  readonly id: string;
  readonly tob: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly totalChargeCents: number;
  readonly patientStatusCode: string | null;
  readonly conditionCodes: unknown;
  readonly occurrenceCodes: unknown;
  readonly occurrenceSpans: unknown;
  readonly valueCodes: unknown;
  readonly admissionTypeCode: string | null;
  readonly admissionSourceCode: string | null;
  readonly attendingPhysicianNpi: string | null;
  readonly certifyingPhysicianNpi: string | null;
  readonly attendingPhysicianFirstName: string | null;
  readonly attendingPhysicianLastName: string | null;
  readonly certifyingPhysicianFirstName: string | null;
  readonly certifyingPhysicianLastName: string | null;
  readonly diagnosisSnapshot: unknown;
}

/** The `claim_line` row fields the document reads (a structural subset of `ClaimLineRecord`). */
export interface ClaimDocumentLineSource {
  readonly lineNumber: number;
  readonly revenueCode: string;
  readonly qCode: string;
  readonly hcpcsCode: string | null;
  readonly modifiers: unknown;
  readonly unitCount: number;
  readonly unitRateCents: number;
  readonly lineChargeCents: number;
  readonly serviceDateFrom: string;
  readonly serviceDateTo: string;
}

export interface BuildClaimDocumentInput {
  readonly claim: ClaimDocumentClaimSource;
  readonly lines: readonly ClaimDocumentLineSource[];
  readonly claimControlNumber: string;
  /** M6 hospice admission date; null = the reader could not resolve one. */
  readonly admissionDate: IsoDate | null;
  /** The payer control number of the claim being replaced / voided (frequency 7/8); null = none on file. */
  readonly predecessorPayerClaimControlNumber: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The occurrence span code for the late-NOE non-covered days: the only span that yields non-covered cents. */
const NON_COVERED_SPAN_CODE = "77";

/** Per-diem revenue codes (RHC 0651, respite 0655, GIP 0656): one unit per day. CHC 0652 is 15-minute units. */
const PER_DIEM_REVENUE_CODES: readonly string[] = ["0651", "0655", "0656"];

/**
 * The part of a line's charge that falls in the non-covered (code 77) occurrence spans. Fully inside → the whole
 * charge; fully outside → 0; partially inside → `unitRate × overlapping days` ONLY for a per-diem revenue code whose
 * units equal its days and whose charge equals rate × units. Any other partial overlap cannot be apportioned
 * without guessing, so it is reported (`null`). Spans with any other code never affect the cents.
 */
export function noncoveredCentsForLine(
  line: ClaimDocumentLineSource,
  spans: readonly { readonly code?: string; readonly from: IsoDate; readonly through: IsoDate }[],
): number | null {
  const lineDays = inclusiveDayCount(line.serviceDateFrom, line.serviceDateTo);
  const covered = new Set<number>();
  for (const s of spans) {
    if (s.code !== NON_COVERED_SPAN_CODE) continue;
    const from = Math.max(toEpochDay(s.from), toEpochDay(line.serviceDateFrom));
    const through = Math.min(toEpochDay(s.through), toEpochDay(line.serviceDateTo));
    for (let d = from; d <= through; d += 1) covered.add(d);
  }
  if (covered.size === 0) return 0;
  if (covered.size === lineDays) return line.lineChargeCents;
  const perDiem =
    PER_DIEM_REVENUE_CODES.includes(line.revenueCode) &&
    line.unitCount === lineDays &&
    line.unitRateCents * line.unitCount === line.lineChargeCents;
  return perDiem ? line.unitRateCents * covered.size : null;
}

function mapLines(
  lines: readonly ClaimDocumentLineSource[],
  spans: readonly { readonly code: string; readonly from: IsoDate; readonly through: IsoDate }[],
  gaps: ClaimGap[],
): ClaimDocumentLine[] {
  if (lines.length === 0) gaps.push(gap("lines", "missing"));
  return [...lines]
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((l, i) => {
      const hcpcs = l.hcpcsCode ?? l.qCode;
      const noncovered = noncoveredCentsForLine(l, spans);
      if (noncovered === null) gaps.push(gap(`lines[${i}].noncoveredCents`, "invalid"));
      if (!Number.isSafeInteger(l.lineChargeCents) || l.lineChargeCents <= 0) {
        gaps.push(gap(`lines[${i}].chargeCents`, "invalid"));
      }
      return {
        lineNumber: l.lineNumber,
        revenueCode: l.revenueCode,
        hcpcs,
        modifiers: strings(l.modifiers),
        units: l.unitCount,
        chargeCents: l.lineChargeCents,
        noncoveredCents: noncovered ?? 0,
        serviceDateFrom: l.serviceDateFrom,
        serviceDateTo: l.serviceDateTo,
      };
    });
}

function mapDiagnoses(raw: unknown, gaps: ClaimGap[]): ClaimDiagnosisSnapshotEntry[] {
  const entries = Array.isArray(raw)
    ? raw.flatMap((e): ClaimDiagnosisSnapshotEntry[] => {
        if (!isRecord(e)) return [];
        const { icd10Code, sequence, qualifier } = e;
        return typeof icd10Code === "string" &&
          typeof sequence === "number" &&
          (qualifier === "ABK" || qualifier === "ABF")
          ? [{ icd10Code, sequence, qualifier }]
          : [];
      })
    : [];
  if (entries.length === 0) gaps.push(gap("diagnoses", "missing"));
  else if (entries.filter((e) => e.qualifier === "ABK").length !== 1) {
    gaps.push(gap("diagnoses.principal", "invalid"));
  }
  return [...entries].sort((a, b) => a.sequence - b.sequence);
}

function physician(
  prefix: string,
  npi: string | null,
  first: string | null,
  last: string | null,
  gaps: ClaimGap[],
): ClaimDocumentPhysician | null {
  if (npi === null) {
    gaps.push(gap(`${prefix}.npi`, "missing"));
    return null;
  }
  if (first === null || last === null) {
    gaps.push(gap(`${prefix}.name`, "missing"));
    return null;
  }
  return { npi, firstName: first, lastName: last };
}

/**
 * Build the detailed claim document, or report every gap at once. The thin gateway fields are produced exactly as
 * `claimDocumentFor` does; the additions are read from the claim lines and the 1068 snapshot columns.
 */
export function buildClaimDocument837iDetail(
  input: BuildClaimDocumentInput,
): GapResult<ClaimDocument837iDetail> {
  const { claim } = input;
  const gaps: ClaimGap[] = [];
  const frequency = FREQUENCY_BY_TOB[claim.tob];
  if (frequency === undefined) gaps.push(gap("tob", "invalid"));
  if (claim.patientStatusCode === null) gaps.push(gap("patientStatusCode", "missing"));
  if (claim.admissionTypeCode === null) gaps.push(gap("admissionTypeCode", "missing"));
  if (claim.admissionSourceCode === null) gaps.push(gap("admissionSourceCode", "missing"));
  if (input.admissionDate === null) gaps.push(gap("admissionDate", "missing"));

  const replacing = frequency !== undefined && REPLACEMENT_FREQUENCIES.includes(frequency);
  if (replacing && input.predecessorPayerClaimControlNumber === null) {
    gaps.push(gap("payerClaimControlNumber", "missing"));
  }

  const occurrenceSpans = Array.isArray(claim.occurrenceSpans)
    ? claim.occurrenceSpans.flatMap((o: unknown) =>
        isRecord(o) &&
        typeof o.code === "string" &&
        typeof o.from === "string" &&
        typeof o.through === "string"
          ? [{ code: o.code, from: o.from, through: o.through }]
          : [],
      )
    : [];
  const lines = mapLines(input.lines, occurrenceSpans, gaps);
  const totalChargeCents = lines.reduce((sum, l) => sum + l.chargeCents, 0);
  if (lines.length > 0 && totalChargeCents !== claim.totalChargeCents) {
    gaps.push(gap("totalChargeCents", "inconsistent"));
  }
  const nonCoveredChargeCents = lines.reduce((sum, l) => sum + l.noncoveredCents, 0);

  const diagnoses = mapDiagnoses(claim.diagnosisSnapshot, gaps);
  const attending = physician(
    "attendingPhysician",
    claim.attendingPhysicianNpi,
    claim.attendingPhysicianFirstName,
    claim.attendingPhysicianLastName,
    gaps,
  );
  // The certifying physician is optional: its NPI is only set when it differs from the attending.
  const certifying =
    claim.certifyingPhysicianNpi === null
      ? null
      : physician(
          "certifyingPhysician",
          claim.certifyingPhysicianNpi,
          claim.certifyingPhysicianFirstName,
          claim.certifyingPhysicianLastName,
          gaps,
        );

  if (
    gaps.length > 0 ||
    frequency === undefined ||
    attending === null ||
    input.admissionDate === null ||
    claim.patientStatusCode === null
  ) {
    return { ok: false, gaps };
  }

  const occurrenceCodes = Array.isArray(claim.occurrenceCodes)
    ? claim.occurrenceCodes.flatMap((o: unknown) =>
        isRecord(o) && typeof o.code === "string" && typeof o.date === "string"
          ? [{ code: o.code, date: o.date }]
          : [],
      )
    : [];
  const valueCodes = Array.isArray(claim.valueCodes)
    ? claim.valueCodes.flatMap((v: unknown) =>
        isRecord(v) && typeof v.code === "string" && typeof v.cbsaCode === "string"
          ? [{ code: v.code, cbsaCode: v.cbsaCode }]
          : [],
      )
    : [];
  return {
    ok: true,
    value: {
      claimId: claim.id,
      claimControlNumber: input.claimControlNumber,
      tob: claim.tob,
      serviceFrom: claim.serviceFrom,
      serviceTo: claim.serviceTo,
      admissionTypeCode: claim.admissionTypeCode,
      admissionSourceCode: claim.admissionSourceCode,
      valueCodes,
      dischargeCodes: {
        patientStatus: claim.patientStatusCode,
        conditionCodes: strings(claim.conditionCodes),
        occurrenceCodes,
      },
      occurrenceSpans,
      frequency,
      admissionDate: input.admissionDate,
      lines,
      totalChargeCents,
      nonCoveredChargeCents,
      diagnoses,
      attendingPhysician: attending,
      certifyingPhysician: certifying,
      payerClaimControlNumber: replacing ? input.predecessorPayerClaimControlNumber : null,
    },
  };
}
