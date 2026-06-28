// @wardenx/gusto-client — raw Gusto → normalized mapping (pure, IO-free). Mirrors the M30 cahps-vendors
// `result.ts` parser style: defensive type-guards, structured throw on a malformed payload, money as
// INTEGER CENTS (M27 invariant — no floats past this boundary). No Gusto SDK shapes leak past here.
//
// The "raw" intermediate consumed here is the post-transport JSON the injected GustoHttpPort returns. We
// document a stable adapter intermediate (discipline + paid-hours + decimal-dollar salary/fringe) so this
// normalizer is testable without the live transport; the live Gusto mapping (payroll line items → this
// intermediate) is wired with the transport at M34 — see oauth.ts TODO(M34-oauth).
import type { NormalizedWageData, NormalizedWageRow } from "./types";

/** Thrown (as an Error message) when a raw Gusto payload does not match the documented shape. */
export const GUSTO_MALFORMED_RESPONSE = "GUSTO_MALFORMED_RESPONSE" as const;

function fail(detail: string): never {
  throw new Error(`${GUSTO_MALFORMED_RESPONSE}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(record: Record<string, unknown>, field: string): string {
  const v = record[field];
  if (typeof v !== "string" || v.length === 0) {
    fail(`'${field}' must be a non-empty string`);
  }
  return v as string;
}

function optStr(record: Record<string, unknown>, field: string): string | undefined {
  const v = record[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail(`'${field}' must be a string when present`);
  return v as string;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`'${field}' must be a finite number`);
  }
  return value as number;
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`'${field}' must be a non-negative integer`);
  }
  return value as number;
}

/** Convert a decimal-dollar amount to integer cents; rejects non-finite values. */
export function dollarsToCents(value: unknown, field: string): number {
  return Math.round(finiteNumber(value, field) * 100);
}

function normalizeWageRow(value: unknown): NormalizedWageRow {
  if (!isRecord(value)) fail("wage row must be an object");
  const record = value as Record<string, unknown>;
  return {
    discipline: str(record, "discipline"),
    paidHours: finiteNumber(record.paidHours, "paidHours"),
    salaryCents: dollarsToCents(record.salary, "salary"),
    fringeCents: dollarsToCents(record.fringe, "fringe"),
    period: optStr(record, "period"),
  };
}

/**
 * Map a raw Gusto wage payload (`{ employeeCount, rows: [...] }`) into a {@link NormalizedWageData}. Sums
 * paid hours and salary cents across the discipline rows; `employeeCount` is taken from the payload (a
 * distinct count the rows do not carry). Pure; throws {@link GUSTO_MALFORMED_RESPONSE} on a malformed
 * payload. `fromDate`/`toDate` come from the pull window (the caller's request), not the payload, so the
 * window is authoritative.
 */
export function normalizeWageData(
  body: unknown,
  fromDate: string,
  toDate: string,
): NormalizedWageData {
  if (!isRecord(body)) fail("wage payload must be an object");
  const record = body as Record<string, unknown>;
  const rawRows = record.rows;
  if (!Array.isArray(rawRows)) fail("'rows' must be an array");

  const rows = rawRows.map(normalizeWageRow);
  let totalPaidHours = 0;
  let totalSalaryCents = 0;
  for (const row of rows) {
    totalPaidHours += row.paidHours;
    totalSalaryCents += row.salaryCents;
  }
  return {
    fromDate,
    toDate,
    rows,
    employeeCount: nonNegativeInt(record.employeeCount, "employeeCount"),
    totalPaidHours,
    totalSalaryCents,
  };
}
