// @wardenx/cahps-vendors — SHP decedent-export CSV renderer (M30 §4.5 SHP layout). Pure, IO-free.
//
// SHP expects a fixed CSV column layout for the monthly decedent sample:
//   decedent_id, deceased_date, primary_caregiver_name, primary_caregiver_phone,
//   primary_caregiver_email, exclusion_reason, language_preference
// (the §4.13 platform-only `death_source` marker is deliberately absent — SHP never receives it). This
// module renders a `CahpsDecedentSampleRow[]` into that CSV as UTF-8 bytes.
import type { CahpsDecedentSampleRow } from "@wardenx/quality";

/** The SHP decedent CSV header, in column order (§4.5 SHP layout). */
export const SHP_DECEDENT_COLUMNS = [
  "decedent_id",
  "deceased_date",
  "primary_caregiver_name",
  "primary_caregiver_phone",
  "primary_caregiver_email",
  "exclusion_reason",
  "language_preference",
] as const;

/** RFC-4180 field escaping: quote + double inner quotes when the field holds a comma, quote, or newline. */
function csvField(value: string | null): string {
  const raw = value ?? "";
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

/** Render one decedent row to its ordered CSV cells. */
function rowCells(row: CahpsDecedentSampleRow): string {
  return [
    row.decedentId,
    row.deceasedDate,
    row.primaryCaregiverName,
    row.primaryCaregiverPhone,
    row.primaryCaregiverEmail,
    row.exclusionReason,
    row.languagePreference,
  ]
    .map(csvField)
    .join(",");
}

/**
 * Render the monthly decedent sample to the SHP CSV layout as UTF-8 bytes (CRLF line endings, per
 * RFC-4180 / SHP intake expectations). Pure: deterministic in its inputs.
 */
export function renderShpDecedentCsv(decedents: readonly CahpsDecedentSampleRow[]): Buffer {
  const lines = [SHP_DECEDENT_COLUMNS.join(","), ...decedents.map(rowCells)];
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8");
}

/** The SHP export filename for a sample period (`shp_cahps_decedents_<start>_<end>.csv`). */
export function shpExportFilename(samplePeriod: { start: string; end: string }): string {
  return `shp_cahps_decedents_${samplePeriod.start}_${samplePeriod.end}.csv`;
}
