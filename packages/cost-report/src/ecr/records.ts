import type { WorksheetCode } from "../contracts";
// @chartwarden/cost-report — M27 ECR record-type model + fixed-field formatting kernel (D11, §1.1 / §1.3).
// The Electronic Cost Report (ECR) is the CMS-specified, fixed-field-format TEXT file the agency uploads
// to MCReF; the CMS-1984-14 ECR specification defines record types, a worksheet/line/column addressing
// scheme, and exact byte columns for each field. This file is the typed record model + the deterministic
// fixed-width writer/reader for those records: every record serializes to a fixed-width line and the line
// parses back to the identical record (round-trip closure), which is the property the unit tests assert.
//
// TODO(CMS-fixture): the TRUE per-field byte offsets, the alpha/numeric record-type codes, the negative-
// number convention, the worksheet-code padding, and the line/column subscript layout require the CMS-
// published CMS-1984-14 ECR specification document (and an example ECR file to diff against, per §1.3
// "unit tests assert byte-for-byte conformance"). Until that fixture is in hand, the field widths and
// record-type bytes below are an internally-consistent, deterministic convention chosen so the writer
// round-trips its own output. The shapes (record id → worksheet → line → column → value) and the
// cents→dollars value formatting are faithful to the ECR model; only the exact column numbers are
// provisional. Swapping in the real layout is a constants-only edit — the record model does not change.
//
// PURE DOMAIN: reuses the M27 money kernel (`toDecimal`, D8) for the cents→dollars division only; no
// Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`. No PHI — aggregate financial /
// statistical values only (D18).
import { type Cents, toDecimal } from "../domain/money";

/**
 * The one-byte record-type codes that lead every ECR line. `header` carries the report-level identity
 * (CCN + fiscal-year window); `alpha` carries a text value; `money` carries an integer-cents value
 * rendered as dollars-and-cents; `count` carries a non-monetary numeric (patient days, visits, hours);
 * `trailer` carries the record-count control total. TODO(CMS-fixture): the real spec keys numeric type
 * (dollars vs. count) by worksheet/line/column position, not by a distinct record byte — this split is a
 * provisional, round-trippable stand-in.
 */
export const ECR_RECORD_TYPE_BYTES = {
  header: "1",
  alpha: "2",
  money: "3",
  count: "4",
  trailer: "9",
} as const;

/** The default ECR specification tag stamped into the header record. */
export const ECR_SPEC_VERSION = "CMS-1984-14" as const;

/** Record separator. CMS ECR files are CRLF-terminated fixed-field text. */
export const ECR_LINE_TERMINATOR = "\r\n" as const;

/**
 * Fixed-field column widths (in bytes). TODO(CMS-fixture): replace with the CMS-1984-14 ECR spec's true
 * widths/offsets. These are sized generously so no real cost-report value is ever truncated.
 */
export const ECR_FIELD_WIDTHS = {
  recordType: 1,
  // header record fields
  providerCcn: 10,
  fiscalDate: 8, // YYYYMMDD
  specVersion: 12,
  // data record fields
  worksheetCode: 7,
  lineNumber: 5,
  columnNumber: 5,
  value: 40,
  // trailer record field
  recordCount: 7,
} as const;

/** A single ECR value: alpha text, an integer-cents monetary amount, or a non-monetary numeric count. */
export type EcrValue =
  | { kind: "alpha"; text: string }
  | { kind: "money"; cents: Cents }
  | { kind: "count"; count: number };

/** Report-level identity record (one per ECR file, first line). */
export interface EcrHeaderRecord {
  recordKind: "header";
  providerCcn: string;
  /** ISO `YYYY-MM-DD`; rendered as `YYYYMMDD` in the file. */
  fiscalYearStartDate: string;
  /** ISO `YYYY-MM-DD`; rendered as `YYYYMMDD` in the file. */
  fiscalYearEndDate: string;
  ecrSpecVersion: string;
}

/** A single addressed cell: worksheet code + line + column + typed value. */
export interface EcrDataRecord {
  recordKind: "data";
  worksheetCode: WorksheetCode;
  lineNumber: number;
  columnNumber: number;
  value: EcrValue;
}

/** Control-total record (last line): count of header+data records preceding it. */
export interface EcrTrailerRecord {
  recordKind: "trailer";
  recordCount: number;
}

export type EcrRecord = EcrHeaderRecord | EcrDataRecord | EcrTrailerRecord;

// ── field-format helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Left-justify (alpha fields): the value occupies the leftmost bytes, the remainder is `fill`-padded.
 * Throws if the value is wider than the field — a fixed-field writer must never silently truncate a
 * cost-report value (a truncated dollar amount is a settlement error).
 */
export function padRight(value: string, width: number, fill = " "): string {
  if (value.length > width) {
    throw new RangeError(`padRight: value "${value}" exceeds field width ${width}`);
  }
  return value + fill.repeat(width - value.length);
}

/**
 * Right-justify (numeric fields): the value occupies the rightmost bytes, the leading bytes are `fill`-
 * padded. Throws on overflow for the same reason as {@link padRight}.
 */
export function padLeft(value: string, width: number, fill = " "): string {
  if (value.length > width) {
    throw new RangeError(`padLeft: value "${value}" exceeds field width ${width}`);
  }
  return fill.repeat(width - value.length) + value;
}

/**
 * Format integer cents as the ECR dollars-and-cents string (e.g. `12345` → `"123.45"`, `-5` → `"-0.05"`).
 * The cents→dollars division is the ONLY arithmetic here and runs through the money kernel's `decimal.js`
 * domain (D8) so it never touches float; an integer divided by 100 terminates exactly at two decimal
 * places, so `toFixed(2)` performs no rounding. TODO(CMS-fixture): confirm the spec's sign convention
 * (leading minus vs. trailing `CR`) and whether values are whole dollars vs. dollars-and-cents.
 */
export function centsToEcrDollars(cents: Cents): string {
  const negative = cents < 0;
  const magnitude = Math.abs(cents);
  const dollars = toDecimal(magnitude).div(100).toFixed(2);
  return negative ? `-${dollars}` : dollars;
}

/**
 * Inverse of {@link centsToEcrDollars}: parse an ECR dollars string back to exact integer cents using
 * integer string-splitting (no float, no division), so the writer→reader round-trip is lossless.
 */
export function ecrDollarsToCents(text: string): Cents {
  const trimmed = text.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [dollarsPart = "0", centsPartRaw = ""] = body.split(".");
  if (!/^\d*$/.test(dollarsPart) || !/^\d*$/.test(centsPartRaw)) {
    throw new RangeError(`ecrDollarsToCents: malformed dollars value "${text}"`);
  }
  const centsPart = `${centsPartRaw}00`.slice(0, 2);
  const magnitude =
    Number.parseInt(dollarsPart || "0", 10) * 100 + Number.parseInt(centsPart || "0", 10);
  return negative ? -magnitude : magnitude;
}

/** Render an ISO `YYYY-MM-DD` (or empty) as the ECR `YYYYMMDD` field body; empty/blank → empty. */
export function isoDateToEcr(iso: string): string {
  const digits = iso.replace(/-/g, "");
  return /^\d{8}$/.test(digits) ? digits : "";
}

/** Inverse of {@link isoDateToEcr}: `YYYYMMDD` → `YYYY-MM-DD`; blank → empty. */
export function ecrToIsoDate(field: string): string {
  const trimmed = field.trim();
  return /^\d{8}$/.test(trimmed)
    ? `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`
    : "";
}

/** The record-type byte an {@link EcrValue} serializes under. */
export function valueRecordByte(value: EcrValue): string {
  switch (value.kind) {
    case "alpha":
      return ECR_RECORD_TYPE_BYTES.alpha;
    case "money":
      return ECR_RECORD_TYPE_BYTES.money;
    case "count":
      return ECR_RECORD_TYPE_BYTES.count;
  }
}

// ── line (de)serialization ───────────────────────────────────────────────────────────────────────────

const W = ECR_FIELD_WIDTHS;

/** Serialize one ECR record to its fixed-width line (no terminator). */
export function formatRecordLine(record: EcrRecord): string {
  switch (record.recordKind) {
    case "header":
      return (
        ECR_RECORD_TYPE_BYTES.header +
        padRight(record.providerCcn, W.providerCcn) +
        padRight(isoDateToEcr(record.fiscalYearStartDate), W.fiscalDate) +
        padRight(isoDateToEcr(record.fiscalYearEndDate), W.fiscalDate) +
        padRight(record.ecrSpecVersion, W.specVersion)
      );
    case "trailer":
      return (
        ECR_RECORD_TYPE_BYTES.trailer + padLeft(String(record.recordCount), W.recordCount, "0")
      );
    case "data": {
      const valueField =
        record.value.kind === "alpha"
          ? padRight(record.value.text, W.value)
          : padLeft(serializeDataValue(record.value), W.value);
      return (
        valueRecordByte(record.value) +
        padRight(record.worksheetCode, W.worksheetCode) +
        padLeft(String(record.lineNumber), W.lineNumber, "0") +
        padLeft(String(record.columnNumber), W.columnNumber, "0") +
        valueField
      );
    }
  }
}

function serializeDataValue(value: Extract<EcrValue, { kind: "money" | "count" }>): string {
  return value.kind === "money" ? centsToEcrDollars(value.cents) : String(value.count);
}

function sliceField(line: string, start: number, width: number): string {
  return line.slice(start, start + width);
}

/** Parse one fixed-width line back into an ECR record. Inverse of {@link formatRecordLine}. */
export function parseRecordLine(line: string): EcrRecord {
  const typeByte = line.slice(0, W.recordType);
  if (typeByte === ECR_RECORD_TYPE_BYTES.header) {
    let cursor = W.recordType;
    const providerCcn = sliceField(line, cursor, W.providerCcn).trimEnd();
    cursor += W.providerCcn;
    const fyStart = ecrToIsoDate(sliceField(line, cursor, W.fiscalDate));
    cursor += W.fiscalDate;
    const fyEnd = ecrToIsoDate(sliceField(line, cursor, W.fiscalDate));
    cursor += W.fiscalDate;
    const specVersion = sliceField(line, cursor, W.specVersion).trimEnd();
    return {
      recordKind: "header",
      providerCcn,
      fiscalYearStartDate: fyStart,
      fiscalYearEndDate: fyEnd,
      ecrSpecVersion: specVersion,
    };
  }

  if (typeByte === ECR_RECORD_TYPE_BYTES.trailer) {
    const recordCount = Number.parseInt(
      sliceField(line, W.recordType, W.recordCount).trim() || "0",
      10,
    );
    return { recordKind: "trailer", recordCount };
  }

  // data record (alpha / money / count)
  let cursor = W.recordType;
  const worksheetCode = sliceField(line, cursor, W.worksheetCode).trimEnd() as WorksheetCode;
  cursor += W.worksheetCode;
  const lineNumber = Number.parseInt(sliceField(line, cursor, W.lineNumber).trim() || "0", 10);
  cursor += W.lineNumber;
  const columnNumber = Number.parseInt(sliceField(line, cursor, W.columnNumber).trim() || "0", 10);
  cursor += W.columnNumber;
  const valueField = sliceField(line, cursor, W.value);

  let value: EcrValue;
  if (typeByte === ECR_RECORD_TYPE_BYTES.money) {
    value = { kind: "money", cents: ecrDollarsToCents(valueField.trim()) };
  } else if (typeByte === ECR_RECORD_TYPE_BYTES.count) {
    value = { kind: "count", count: parseEcrCount(valueField.trim()) };
  } else {
    value = { kind: "alpha", text: valueField.trimEnd() };
  }

  return { recordKind: "data", worksheetCode, lineNumber, columnNumber, value };
}

function parseEcrCount(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new RangeError(`parseEcrCount: non-finite numeric value "${text}"`);
  }
  return n;
}

/** Join records into the full ECR file text (CRLF-terminated, trailing terminator included). */
export function recordsToText(records: readonly EcrRecord[]): string {
  return records.map(formatRecordLine).join(ECR_LINE_TERMINATOR) + ECR_LINE_TERMINATOR;
}

/** Split full ECR file text back into records. Inverse of {@link recordsToText}. */
export function textToRecords(text: string): EcrRecord[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map(parseRecordLine);
}
