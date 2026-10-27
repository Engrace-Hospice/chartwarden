// @chartwarden/cahps-vendors — SHP aggregate-result parser (M30 §4.5 / WF-06). Pure, IO-free.
//
// SHP returns a monthly aggregate as an XLSX workbook. XLSX byte-decoding requires a heavy binary codec
// that is wired at the worker boundary in a later phase; this P2a parser consumes the NORMALIZED
// intermediate that decoder produces — a UTF-8 JSON document with one entry per provider/period — and
// maps it into our `CahpsResultSummaryInput` shape (vendor-of-record = `shp`). The dedup hash is computed
// here over the raw payload bytes so re-ingesting the same export is idempotent.
import { createHash } from "node:crypto";
import type { CahpsResultSummaryInput } from "@chartwarden/quality";
import { ChartWardenError } from "@chartwarden/types";

/** One entry in the normalized SHP aggregate (the XLSX-to-JSON decoder's per-provider/period row). */
interface ShpAggregateEntry {
  readonly providerEntityId: string;
  readonly reportingPeriodStart: string;
  readonly reportingPeriodEnd: string;
  readonly topBoxPercentages: Record<string, number>;
  readonly compositeScores: Record<string, number>;
  readonly responseCount: number;
  readonly attemptedSampleCount: number;
  readonly responseRate: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberMap(value: unknown, field: string): Record<string, number> {
  if (!isRecord(value)) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      `SHP aggregate '${field}' must be an object`,
      422,
    );
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        `SHP aggregate '${field}.${k}' must be a number`,
        422,
      );
    }
    out[k] = v;
  }
  return out;
}

function str(record: Record<string, unknown>, field: string): string {
  const v = record[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      `SHP aggregate '${field}' must be a non-empty string`,
      422,
    );
  }
  return v;
}

function int(record: Record<string, unknown>, field: string): number {
  const v = record[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      `SHP aggregate '${field}' must be a non-negative integer`,
      422,
    );
  }
  return v;
}

function parseEntry(value: unknown): ShpAggregateEntry {
  if (!isRecord(value)) {
    throw new ChartWardenError("VALIDATION_FAILED", "SHP aggregate entry must be an object", 422);
  }
  const rate = value.responseRate;
  return {
    providerEntityId: str(value, "providerEntityId"),
    reportingPeriodStart: str(value, "reportingPeriodStart"),
    reportingPeriodEnd: str(value, "reportingPeriodEnd"),
    topBoxPercentages: numberMap(value.topBoxPercentages, "topBoxPercentages"),
    compositeScores: numberMap(value.compositeScores, "compositeScores"),
    responseCount: int(value, "responseCount"),
    attemptedSampleCount: int(value, "attemptedSampleCount"),
    responseRate:
      rate === null || rate === undefined ? null : typeof rate === "number" ? rate : null,
  };
}

/**
 * Parse a normalized SHP aggregate payload into `CahpsResultSummaryInput[]`. The dedup hash
 * (`vendorResponsePayloadHash`) is SHA-256 over the raw payload bytes, identical across every row of one
 * upload so the ingest is idempotent per (provider, period, payload). Pure. Throws `VALIDATION_FAILED`
 * on a malformed payload.
 */
export function parseShpAggregate(payload: Buffer): CahpsResultSummaryInput[] {
  const payloadHash = createHash("sha256").update(payload).digest("hex");

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      "SHP aggregate payload is not valid UTF-8 JSON",
      422,
    );
  }
  if (!Array.isArray(decoded)) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      "SHP aggregate payload must be a JSON array",
      422,
    );
  }

  return decoded.map((raw) => {
    const entry = parseEntry(raw);
    return {
      providerEntityId: entry.providerEntityId,
      reportingPeriodStart: entry.reportingPeriodStart,
      reportingPeriodEnd: entry.reportingPeriodEnd,
      vendorAdapterId: "shp",
      topBoxPercentages: entry.topBoxPercentages,
      compositeScores: entry.compositeScores,
      responseCount: entry.responseCount,
      attemptedSampleCount: entry.attemptedSampleCount,
      responseRate: entry.responseRate,
      vendorResponsePayloadHash: payloadHash,
    };
  });
}
