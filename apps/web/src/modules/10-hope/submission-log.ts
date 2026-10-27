// apps/web/src/modules/10-hope — pure helpers for the HOPE submission worklist: KPI roll-up and the
// client-side "Export submission log" CSV. Batch-level metadata only; no patient data is ever in a row.
export interface LogRow {
  id: string;
  submissionPeriod: string;
  status: string;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  exportedAt?: string | null;
  submittedAt?: string | null;
  resultReportReference?: string | null;
  iqiesSubmissionReference?: string | null;
  needsCorrectionCount?: number;
  correctionInProgressCount?: number;
  resubmittedCount?: number;
}

/** Batches the user must still upload to the CMS portal and/or record a result for. */
export const AWAITING_STATUSES = ["exported", "submitted_pending_result"] as const;
export const REJECTED_STATUSES = ["rejected", "partially_accepted"] as const;

export interface SubmissionKpis {
  awaitingConfirmation: number;
  rejectedRecords: number;
  rejectedBatches: number;
  resubmissionsInProgress: number;
}

export function submissionKpis(rows: readonly LogRow[]): SubmissionKpis {
  return rows.reduce<SubmissionKpis>(
    (acc, r) => ({
      awaitingConfirmation:
        acc.awaitingConfirmation +
        ((AWAITING_STATUSES as readonly string[]).includes(r.status) ? 1 : 0),
      rejectedRecords: acc.rejectedRecords + (r.needsCorrectionCount ?? 0),
      rejectedBatches: acc.rejectedBatches + ((r.needsCorrectionCount ?? 0) > 0 ? 1 : 0),
      resubmissionsInProgress:
        acc.resubmissionsInProgress +
        (r.correctionInProgressCount ?? 0) +
        (r.resubmittedCount ?? 0),
    }),
    { awaitingConfirmation: 0, rejectedRecords: 0, rejectedBatches: 0, resubmissionsInProgress: 0 },
  );
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** RFC 4180 quoting plus CSV-injection defence: a leading =,+,-,@ (or tab/CR) is neutralised with a quote. */
export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const HEADER = [
  "Batch ID",
  "Period",
  "Status",
  "Items",
  "Accepted",
  "Rejected",
  "Exported at",
  "Submitted at",
  "Result report reference",
  "iQIES reference",
];

/** Excel needs a BOM to read the file as UTF-8. */
const UTF8_BOM = "\uFEFF";

export function submissionLogCsv(rows: readonly LogRow[]): string {
  const lines = rows.map((r) =>
    [
      r.id,
      r.submissionPeriod,
      r.status,
      r.itemCount,
      r.acceptedCount,
      r.rejectedCount,
      r.exportedAt,
      r.submittedAt,
      r.resultReportReference,
      r.iqiesSubmissionReference,
    ]
      .map(csvCell)
      .join(","),
  );
  return `${UTF8_BOM}${[HEADER.map(csvCell).join(","), ...lines].join("\r\n")}\r\n`;
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // revoking synchronously can cancel the download
}
