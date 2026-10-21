// @wardenx/audit — Compliance export renderers (M4-T11, M4 spec §3.5 audit_export, §4.3, §4.4).
//
// The `audit.build_export` job renders a requested `audit_export` into a watermarked artifact
// (csv / ndjson / pdf per the `audit_export_format` enum) destined for MinIO with a TTL. SEC-052 /
// M04-F04 require the artifact carry a justification watermark; every renderer here embeds it so
// the watermark cannot be stripped by choosing a format.
//
// What an export contains is METADATA, never PHI values: id, time, actor, event/resource, outcome,
// severity, retention class. The `before`/`after` snapshots are already denylist-scrubbed at
// capture, but the compliance export deliberately omits them entirely — an Accounting/who-touched
// export is a provenance record, not a data extract. (The forensic single-event diff stays behind
// the permissioned detail route, §4.2.)
//
// Pure string rendering — no DB, no object store. The MinIO upload + watermark stamping into the
// PDF page chrome is the `audit.build_export` job's infra adapter (a tracked follow-up); the PDF
// renderer here emits a deterministic text layout (binary PDF via M22 DocLens is that follow-up).
import type { AuditEventRecord } from "../query/audit-query";

/** Output formats (mirrors the `audit_export_format` pg-enum: csv | ndjson | pdf). */
export type AuditExportFormat = "csv" | "ndjson" | "pdf";

/** A request to render a set of audit records into a watermarked artifact. */
export interface ExportRequest {
  readonly format: AuditExportFormat;
  /** The SEC-052 justification watermark stamped into every artifact (who/why/when). */
  readonly watermark: string;
  readonly records: readonly AuditEventRecord[];
}

/** A rendered export artifact, ready to upload to object storage. */
export interface ExportArtifact {
  readonly format: AuditExportFormat;
  /** The MIME type the stored object is served as. */
  readonly contentType: string;
  /** The rendered body (UTF-8). */
  readonly body: string;
  readonly recordCount: number;
  /** Echoed so the caller can assert the watermark is present (M04-F04). */
  readonly watermark: string;
}

/** The metadata columns an export surfaces — provenance only, never PHI values. */
const EXPORT_COLUMNS = [
  "id",
  "createdAt",
  "actorUserId",
  "actorRole",
  "actorKind",
  "eventType",
  "resourceKind",
  "resourceId",
  "outcome",
  "severity",
  "retentionClass",
  "legalHold",
] as const;

type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** Project one record to the export row shape (string cells; nullish → ""). */
function toRow(record: AuditEventRecord): Record<ExportColumn, string> {
  return {
    id: record.id,
    createdAt: record.createdAt,
    actorUserId: record.actorUserId ?? "",
    actorRole: record.actorRole ?? "",
    actorKind: record.actorKind,
    eventType: record.eventType,
    resourceKind: record.resourceKind,
    resourceId: record.resourceId ?? "",
    outcome: record.outcome,
    severity: record.severity,
    retentionClass: record.retentionClass,
    // GAP-008: the hashed base class is unchanged by a hold; this column is how an export shows a row as held.
    legalHold: record.legalHold === true ? "true" : "false",
  };
}

/** RFC-4180 CSV cell: quote and double internal quotes when the cell needs it. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV — leading `#`-comment watermark line, header row, then one record per line. */
function renderCsv(records: readonly AuditEventRecord[], watermark: string): string {
  const lines = [`# ${watermark}`, EXPORT_COLUMNS.join(",")];
  for (const record of records) {
    const row = toRow(record);
    lines.push(EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** NDJSON — a leading `{"_watermark": ...}` line, then one JSON object per record. */
function renderNdjson(records: readonly AuditEventRecord[], watermark: string): string {
  const lines = [JSON.stringify({ _watermark: watermark })];
  for (const record of records) {
    lines.push(JSON.stringify(toRow(record)));
  }
  return `${lines.join("\n")}\n`;
}

/** PDF — deterministic text layout with the watermark in the page header (binary render: follow-up). */
function renderPdf(records: readonly AuditEventRecord[], watermark: string): string {
  const lines = [
    "ChartWarden — Audit Compliance Export",
    `WATERMARK: ${watermark}`,
    `RECORDS: ${records.length}`,
    "",
  ];
  for (const record of records) {
    const row = toRow(record);
    lines.push(EXPORT_COLUMNS.map((c) => `${c}=${row[c]}`).join("  "));
  }
  return `${lines.join("\n")}\n`;
}

const CONTENT_TYPES: Record<AuditExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
  pdf: "application/pdf",
};

/**
 * Render an audit export into a watermarked artifact in the requested format. Every format embeds
 * the SEC-052 watermark (M04-F04) and emits provenance metadata only — never PHI values.
 */
export function renderAuditExport(req: ExportRequest): ExportArtifact {
  const body =
    req.format === "csv"
      ? renderCsv(req.records, req.watermark)
      : req.format === "ndjson"
        ? renderNdjson(req.records, req.watermark)
        : renderPdf(req.records, req.watermark);
  return {
    format: req.format,
    contentType: CONTENT_TYPES[req.format],
    body,
    recordCount: req.records.length,
    watermark: req.watermark,
  };
}
