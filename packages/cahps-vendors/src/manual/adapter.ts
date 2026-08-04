import { createHash } from "node:crypto";
import type {
  CahpsDecedentSampleRow,
  CahpsResultSummaryInput,
  CahpsVendorAdapter,
} from "@wardenx/quality";
// @wardenx/cahps-vendors — manual adapter (M30 §4.5; tenants without a vendor contract).
//
// The manual adapter needs no credentials: it renders a decedent CSV the QAPI Coordinator emails to a
// vendor of their choice, NEVER pushes (returns `no_push`), and ingests an aggregate the coordinator
// uploads back as CSV (R-16). Column schemas + CSV helpers live in ./csv_format.
import { WardenXError } from "@wardenx/types";
import { MANUAL_DECEDENT_COLUMNS, MANUAL_RESULT_COLUMNS, parseCsv, renderCsv } from "./csv_format";

function jsonNumberMap(raw: string, field: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    throw new WardenXError("VALIDATION_FAILED", `manual result '${field}' is not valid JSON`, 422);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WardenXError(
      "VALIDATION_FAILED",
      `manual result '${field}' must be a JSON object`,
      422,
    );
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "number" || Number.isNaN(v)) {
      throw new WardenXError(
        "VALIDATION_FAILED",
        `manual result '${field}.${k}' must be a number`,
        422,
      );
    }
    out[k] = v;
  }
  return out;
}

function intField(value: string, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new WardenXError(
      "VALIDATION_FAILED",
      `manual result '${field}' must be a non-negative integer`,
      422,
    );
  }
  return n;
}

/** The manual (no-contract) CAHPS adapter. Pure except for the SHA-256 dedup hash over the upload. */
export class ManualCahpsAdapter implements CahpsVendorAdapter {
  readonly vendor = "manual" as const;

  validateConfig(
    _config: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; errors: { field: string; reason: string }[] }> {
    // The manual workflow needs no credentials, so any config (including {}) is valid.
    return Promise.resolve({ ok: true });
  }

  renderExport(
    _orgId: string,
    samplePeriod: { start: string; end: string },
    decedents: CahpsDecedentSampleRow[],
  ): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
    const rows = decedents.map((d) => [
      d.decedentId,
      d.deceasedDate,
      d.primaryCaregiverName,
      d.primaryCaregiverPhone,
      d.primaryCaregiverEmail,
      d.exclusionReason,
      d.languagePreference,
    ]);
    return Promise.resolve({
      filename: `manual_cahps_decedents_${samplePeriod.start}_${samplePeriod.end}.csv`,
      mimeType: "text/csv",
      bytes: renderCsv(MANUAL_DECEDENT_COLUMNS, rows),
    });
  }

  pushExport(
    _orgId: string,
    _file: { filename: string; mimeType: string; bytes: Buffer },
    _config: Record<string, unknown>,
  ): Promise<{ status: "pushed"; vendorJobId: string } | { status: "no_push"; reason: string }> {
    return Promise.resolve({ status: "no_push", reason: "manual_vendor" });
  }

  parseResultIngest(payload: Buffer): Promise<CahpsResultSummaryInput[]> {
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const { records } = parseCsv(payload);
    const inputs = records.map<CahpsResultSummaryInput>((r) => {
      for (const col of MANUAL_RESULT_COLUMNS) {
        if (!(col in r)) {
          throw new WardenXError(
            "VALIDATION_FAILED",
            `manual result CSV is missing column '${col}'`,
            422,
          );
        }
      }
      const rateRaw = (r.response_rate ?? "").trim();
      return {
        providerEntityId: r.provider_entity_id ?? "",
        reportingPeriodStart: r.reporting_period_start ?? "",
        reportingPeriodEnd: r.reporting_period_end ?? "",
        vendorAdapterId: "manual",
        topBoxPercentages: jsonNumberMap(
          r.top_box_percentages_json ?? "",
          "top_box_percentages_json",
        ),
        compositeScores: jsonNumberMap(r.composite_scores_json ?? "", "composite_scores_json"),
        responseCount: intField(r.response_count ?? "", "response_count"),
        attemptedSampleCount: intField(r.attempted_sample_count ?? "", "attempted_sample_count"),
        responseRate: rateRaw.length === 0 ? null : Number(rateRaw),
        vendorResponsePayloadHash: payloadHash,
      };
    });
    return Promise.resolve(inputs);
  }

  minimumCellSize(): number {
    return 30;
  }
}
