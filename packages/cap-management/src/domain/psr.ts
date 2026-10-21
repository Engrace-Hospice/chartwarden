// @chartwarden/cap-management — PS&R (Provider Statistical & Reimbursement) reconciliation (D9, Phase 1 = CSV).
// The MAC's PS&R report is the MAC's view of the hospice's cap status; M26 ingests the quarterly CSV, diffs
// each figure against its running ledger, and routes any variance above the per-tenant threshold (default
// $50) to the cap_psr_reconciliation queue with a categorical reason for the billing clerk.
//
// The parser is intentionally PERMISSIVE: handles a UTF-8 BOM, CRLF/LF, trailing whitespace, quoted fields,
// and the per-MAC column-name variants below. No PHI is logged; the MBI is a join key, never audit-captured.
import {
  DEFAULT_PSR_VARIANCE_THRESHOLD_CENTS,
  type MacRegion,
  type PsrReconScope,
  type PsrVarianceReason,
} from "./types";

/** Canonical PS&R fields M26 reconciles against, mapped from each MAC's column header variants. */
export interface PsrColumnDictionary {
  readonly mbi: readonly string[];
  readonly paidAmount: readonly string[];
  readonly inpatientDays: readonly string[];
}

/** Per-MAC header aliases (the "two layout variants currently in circulation", §5.1.5). Lower-cased match. */
export const PSR_COLUMN_DICTIONARY: Record<MacRegion, PsrColumnDictionary> = {
  ngs: {
    mbi: ["mbi", "hic", "hicn"],
    paidAmount: ["paid amount", "payments", "total paid"],
    inpatientDays: ["inpatient days", "gip+irc days", "ipu days"],
  },
  cgs: {
    mbi: ["mbi", "hic"],
    paidAmount: ["paid amount", "reimbursement"],
    inpatientDays: ["inpatient days", "ip days"],
  },
  palmetto: {
    mbi: ["mbi", "hicn"],
    paidAmount: ["paid amount", "payments"],
    inpatientDays: ["inpatient days"],
  },
  wps: {
    mbi: ["mbi", "hic"],
    paidAmount: ["paid amount", "total payments"],
    inpatientDays: ["inpatient days"],
  },
  noridian: {
    mbi: ["mbi", "hicn"],
    paidAmount: ["paid amount", "payments"],
    inpatientDays: ["inpatient days"],
  },
  first_coast: {
    mbi: ["mbi", "hic"],
    paidAmount: ["paid amount"],
    inpatientDays: ["inpatient days"],
  },
  novitas: {
    mbi: ["mbi", "hicn"],
    paidAmount: ["paid amount", "payments"],
    inpatientDays: ["inpatient days"],
  },
};

export interface PsrParsedRow {
  readonly mbi: string;
  readonly paidCents: number;
  readonly inpatientDays: number;
}

/** Strip a leading UTF-8 BOM and normalize line endings. */
function normalize(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** Split a single CSV line into fields (handles double-quoted fields with embedded commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** Parse a dollars string ("$33,494.01" / "33494.01" / "(50.00)") to signed cents. */
export function dollarsToCents(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[(),$\s]/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return 0;
  return (negative ? -1 : 1) * Math.round(value * 100);
}

/** Parse a PS&R CSV for a MAC region into canonical rows. Unknown/missing columns yield 0 for that field. */
export function parsePsrCsv(text: string, macRegion: MacRegion): PsrParsedRow[] {
  const lines = normalize(text)
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const dict = PSR_COLUMN_DICTIONARY[macRegion];
  const findCol = (aliases: readonly string[]): number =>
    header.findIndex((h) => aliases.includes(h));
  const mbiIdx = findCol(dict.mbi);
  const paidIdx = findCol(dict.paidAmount);
  const ipIdx = findCol(dict.inpatientDays);
  const rows: PsrParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]!);
    const mbi = (mbiIdx >= 0 ? fields[mbiIdx] : "")?.toUpperCase().replace(/-/g, "") ?? "";
    if (!mbi) continue;
    rows.push({
      mbi,
      paidCents: paidIdx >= 0 ? dollarsToCents(fields[paidIdx] ?? "") : 0,
      inpatientDays:
        ipIdx >= 0 ? Math.round(Number((fields[ipIdx] ?? "0").replace(/[^\d.-]/g, "")) || 0) : 0,
    });
  }
  return rows;
}

/** A beneficiary's M26 ledger figure to diff against PS&R, keyed by normalized MBI. */
export interface LedgerBeneficiary {
  readonly mbiNormalized: string;
  readonly patientId: string;
  readonly paidCents: number;
}

export interface PsrVarianceLine {
  readonly scope: PsrReconScope;
  readonly patientId: string | null;
  readonly m26AccrualCents: number | null;
  readonly psrAmountCents: number | null;
  readonly varianceCents: number; // psr − m26 (signed)
  readonly varianceReason: PsrVarianceReason | null;
  readonly aboveThreshold: boolean;
}

/** Heuristic categorical reason for a variance (the clerk confirms/overrides). */
export function classifyVariance(
  m26Cents: number | null,
  psrCents: number | null,
): PsrVarianceReason {
  if (m26Cents == null && psrCents != null) return "mbi_mismatch"; // PS&R has a beneficiary we don't
  if (psrCents == null && m26Cents != null) return "timing"; // we have a beneficiary PS&R hasn't posted yet
  return "unknown";
}

/**
 * What quarantined PS&R rows do to a reconcile (GAP-078 follow-up). A quarantined row is never zero-filled:
 * a recovered MBI is excluded from BOTH sides (no variance line, not in the aggregate); a row whose MBI is
 * unreadable cannot be excluded from the ledger, so ledger-only lines and the agency aggregate are
 * suppressed rather than raised as a false variance.
 */
export interface PsrQuarantineEffect {
  readonly unreconcilableMbis: ReadonlySet<string>;
  readonly hasUnattributableRows: boolean;
}
const NO_QUARANTINE: PsrQuarantineEffect = {
  unreconcilableMbis: new Set(),
  hasUnattributableRows: false,
};

/**
 * Diff M26 ledger beneficiaries against parsed PS&R rows by normalized MBI. Emits one beneficiary-scope
 * variance line per MBI present on either side, plus an agency-aggregate line. `aboveThreshold` marks the
 * lines that land on the reconciliation queue (variance ≥ the per-tenant threshold, default $50).
 */
export function reconcilePsr(
  ledger: readonly LedgerBeneficiary[],
  psr: readonly PsrParsedRow[],
  thresholdCents: number = DEFAULT_PSR_VARIANCE_THRESHOLD_CENTS,
  quarantine: PsrQuarantineEffect = NO_QUARANTINE,
): PsrVarianceLine[] {
  const flagged = quarantine.unreconcilableMbis;
  const byMbiLedger = new Map(
    ledger.filter((b) => !flagged.has(b.mbiNormalized)).map((b) => [b.mbiNormalized, b]),
  );
  const byMbiPsr = new Map(psr.filter((r) => !flagged.has(r.mbi)).map((r) => [r.mbi, r]));
  const allMbis = new Set<string>([...byMbiLedger.keys(), ...byMbiPsr.keys()]);
  const lines: PsrVarianceLine[] = [];
  let m26Total = 0;
  let psrTotal = 0;
  for (const mbi of allMbis) {
    const l = byMbiLedger.get(mbi);
    const p = byMbiPsr.get(mbi);
    const m26Cents = l ? l.paidCents : null;
    const psrCents = p ? p.paidCents : null;
    m26Total += m26Cents ?? 0;
    psrTotal += psrCents ?? 0;
    const varianceCents = (psrCents ?? 0) - (m26Cents ?? 0);
    if (varianceCents === 0 && m26Cents != null && psrCents != null) continue; // exact match — no line
    // A ledger-only beneficiary may be exactly the one a quarantined row (unreadable MBI) belonged to.
    if (quarantine.hasUnattributableRows && psrCents == null) continue;
    lines.push({
      scope: "beneficiary",
      patientId: l ? l.patientId : null,
      m26AccrualCents: m26Cents,
      psrAmountCents: psrCents,
      varianceCents,
      varianceReason: classifyVariance(m26Cents, psrCents),
      aboveThreshold: Math.abs(varianceCents) >= thresholdCents,
    });
  }
  // The aggregate cannot be trusted while a quarantined row of unknown beneficiary is missing from it.
  if (quarantine.hasUnattributableRows) return lines;
  const aggVariance = psrTotal - m26Total;
  lines.push({
    scope: "agency_aggregate",
    patientId: null,
    m26AccrualCents: m26Total,
    psrAmountCents: psrTotal,
    varianceCents: aggVariance,
    varianceReason: aggVariance === 0 ? null : "unknown",
    aboveThreshold: Math.abs(aggVariance) >= thresholdCents,
  });
  return lines;
}

// ── strict import validation (GAP-078) ─────────────────────────────────────────────────────────────
// The permissive `parsePsrCsv` above silently zero-fills a missing column — right for a viewer, wrong for a
// reconciliation: an unrecognised "Paid Amount" header would read as $0 for every beneficiary and raise a
// variance line per patient. The import path therefore uses the strict parser. Two tiers of failure:
//   • STRUCTURAL (empty file, no header, missing required MBI / paid-amount column, too many rows) — the
//     whole file is rejected (`issues`, → `parse_failed`).
//   • ROW-level (bad MBI shape, unparseable amount / days, wrong column count) — the row is QUARANTINED: it
//     is excluded from the totals and never zero-filled, and the import reconciles on the good rows.
//     Quarantine is bounded: a file with no good row, or more than {@link PSR_QUARANTINE_MAX_FRACTION} of
//     its data rows quarantined, is rejected as a whole rather than reconciling garbage.
// Issues and quarantine entries name only the line number + code, never a cell value (MBI + payment detail).

/** Hard ceiling on data rows in one PS&R extract (a hospice's whole-year beneficiary list is far below this). */
export const PSR_MAX_ROWS = 50_000;
/** More than this fraction of data rows quarantined ⇒ the file is rejected as a whole (20%). */
export const PSR_QUARANTINE_MAX_FRACTION = 0.2;
/** Cap on the quarantined lines persisted in the import's detail document (the count is always exact). */
export const PSR_QUARANTINE_DETAIL_MAX = 100;

export interface PsrCsvIssue {
  /** 1-based CSV line number (header = 1); 0 for a file-level issue. */
  readonly line: number;
  readonly code:
    | "empty_file"
    | "missing_mbi_column"
    | "missing_paid_amount_column"
    | "too_many_rows"
    | "all_rows_quarantined"
    | "quarantine_ceiling_exceeded";
}

export type PsrQuarantineCode =
  | "wrong_column_count"
  | "missing_mbi"
  | "invalid_mbi"
  | "invalid_paid_amount"
  | "invalid_inpatient_days";

export interface PsrQuarantinedRow {
  /** 1-based CSV line number (header = 1). */
  readonly line: number;
  readonly code: PsrQuarantineCode;
  /** The row's MBI when it is itself well-formed (so the beneficiary can be flagged); null otherwise.
   *  In-memory only — NEVER persist or log it (see {@link summarizePsrQuarantine}). */
  readonly recoveredMbi: string | null;
}

export interface PsrCsvResult {
  readonly rows: readonly PsrParsedRow[];
  /** Structural problems: when non-empty the caller must reject the whole file. */
  readonly issues: readonly PsrCsvIssue[];
  /** Malformed data rows set aside (excluded from `rows`). */
  readonly quarantined: readonly PsrQuarantinedRow[];
  /** True when the file carries an inpatient-days column (so inpatient reconciliation is meaningful). */
  readonly hasInpatientDays: boolean;
}

/** An 11-character alphanumeric MBI (the CMS position grammar is not enforced: layouts vary by MAC). */
const MBI_SHAPE = /^[A-Z0-9]{11}$/;
const STRICT_DOLLARS = /^\(?-?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?\)?$/;

/** Strict dollars → signed cents (exact integer math); null when the cell is not a money amount. */
export function dollarsToCentsStrict(raw: string): number | null {
  const s = raw.trim();
  if (!STRICT_DOLLARS.test(s)) return null;
  const negative = s.startsWith("(") || s.includes("-");
  const [whole = "0", frac = ""] = s.replace(/[(),$\s-]/g, "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -cents : cents;
}

const strictDays = (raw: string): number | null => {
  const s = raw.trim();
  return s === "" ? 0 : /^\d+$/.test(s) ? Number(s) : null;
};

/** Fold repeated MBIs (a beneficiary can span several PS&R lines) into one row each, summing the figures. */
export function aggregatePsrRows(rows: readonly PsrParsedRow[]): PsrParsedRow[] {
  const byMbi = new Map<string, PsrParsedRow>();
  for (const r of rows) {
    const prior = byMbi.get(r.mbi);
    byMbi.set(
      r.mbi,
      prior
        ? {
            mbi: r.mbi,
            paidCents: prior.paidCents + r.paidCents,
            inpatientDays: prior.inpatientDays + r.inpatientDays,
          }
        : r,
    );
  }
  return [...byMbi.values()];
}

interface PsrColumns {
  readonly mbi: number;
  readonly paid: number;
  readonly days: number;
  readonly width: number;
}

/** Validate one data row; a row is either good or quarantined with the FIRST problem found. */
function checkPsrRow(
  fields: readonly string[],
  line: number,
  c: PsrColumns,
): { row: PsrParsedRow } | { quarantined: PsrQuarantinedRow } {
  const mbi = (fields[c.mbi] ?? "").toUpperCase().replace(/-/g, "");
  const recoveredMbi = MBI_SHAPE.test(mbi) ? mbi : null;
  const fail = (code: PsrQuarantineCode) => ({ quarantined: { line, code, recoveredMbi } });
  if (fields.length !== c.width) return fail("wrong_column_count");
  if (!mbi) return fail("missing_mbi");
  if (!recoveredMbi) return fail("invalid_mbi");
  const paidCents = dollarsToCentsStrict(fields[c.paid] ?? "");
  if (paidCents === null) return fail("invalid_paid_amount");
  const inpatientDays = c.days >= 0 ? strictDays(fields[c.days] ?? "") : 0;
  if (inpatientDays === null) return fail("invalid_inpatient_days");
  return { row: { mbi, paidCents, inpatientDays } };
}

/** The whole-file rejection a too-damaged file earns: no good row at all, or over the 20% ceiling. */
function quarantineCeilingIssues(dataRows: number, quarantinedRows: number): PsrCsvIssue[] {
  if (quarantinedRows === 0) return [];
  if (quarantinedRows === dataRows) return [{ line: 0, code: "all_rows_quarantined" }];
  if (quarantinedRows > dataRows * PSR_QUARANTINE_MAX_FRACTION) {
    return [{ line: 0, code: "quarantine_ceiling_exceeded" }];
  }
  return [];
}

/**
 * Validate + parse a PS&R CSV. Required columns: an MBI column and a paid-amount column (per-MAC aliases in
 * {@link PSR_COLUMN_DICTIONARY}); an inpatient-days column is optional. A non-empty `issues` means the
 * caller must reject the whole file; otherwise `rows` are the good rows and `quarantined` the set-aside ones.
 */
export function parsePsrCsvStrict(text: string, macRegion: MacRegion): PsrCsvResult {
  const lines = normalize(text).split("\n");
  const nonEmpty = lines.map((l, i) => ({ l, line: i + 1 })).filter((x) => x.l.trim().length > 0);
  const reject = (issues: PsrCsvIssue[], hasInpatientDays = false): PsrCsvResult => ({
    rows: [],
    issues,
    quarantined: [],
    hasInpatientDays,
  });
  if (nonEmpty.length === 0) return reject([{ line: 0, code: "empty_file" }]);
  const headerFields = splitCsvLine(nonEmpty[0]!.l);
  const header = headerFields.map((h) => h.toLowerCase());
  const dict = PSR_COLUMN_DICTIONARY[macRegion];
  const col = (aliases: readonly string[]): number => header.findIndex((h) => aliases.includes(h));
  const cols: PsrColumns = {
    mbi: col(dict.mbi),
    paid: col(dict.paidAmount),
    days: col(dict.inpatientDays),
    width: headerFields.length,
  };
  const missing: PsrCsvIssue[] = [];
  if (cols.mbi < 0) missing.push({ line: 1, code: "missing_mbi_column" });
  if (cols.paid < 0) missing.push({ line: 1, code: "missing_paid_amount_column" });
  if (missing.length > 0) return reject(missing, cols.days >= 0);
  const data = nonEmpty.slice(1);
  if (data.length > PSR_MAX_ROWS) {
    return reject([{ line: 0, code: "too_many_rows" }], cols.days >= 0);
  }
  const rows: PsrParsedRow[] = [];
  const quarantined: PsrQuarantinedRow[] = [];
  for (const { l, line } of data) {
    const checked = checkPsrRow(splitCsvLine(l), line, cols);
    if ("row" in checked) rows.push(checked.row);
    else quarantined.push(checked.quarantined);
  }
  const issues = quarantineCeilingIssues(data.length, quarantined.length);
  return { rows, issues, quarantined, hasInpatientDays: cols.days >= 0 };
}

/** What the quarantined rows mean for the reconcile (see {@link PsrQuarantineEffect}). */
export function quarantineEffect(quarantined: readonly PsrQuarantinedRow[]): PsrQuarantineEffect {
  const flagged = new Set<string>();
  let unattributable = false;
  for (const q of quarantined) {
    if (q.recoveredMbi) flagged.add(q.recoveredMbi);
    else unattributable = true;
  }
  return { unreconcilableMbis: flagged, hasUnattributableRows: unattributable };
}

/** PHI-free quarantine summary persisted on the import: line numbers + codes only, never an MBI. */
export interface PsrQuarantineSummary {
  readonly rowsQuarantined: number;
  readonly detail: {
    readonly lines: readonly { readonly line: number; readonly code: PsrQuarantineCode }[];
    readonly truncated: boolean;
    /** Distinct beneficiaries flagged unreconcilable (MBI recovered) — a count, never the MBIs. */
    readonly flaggedBeneficiaries: number;
    /** Rows whose MBI could not be read: ledger-only lines + the agency aggregate were suppressed. */
    readonly unattributableRows: number;
  };
}

export function summarizePsrQuarantine(
  quarantined: readonly PsrQuarantinedRow[],
): PsrQuarantineSummary {
  return {
    rowsQuarantined: quarantined.length,
    detail: {
      lines: quarantined
        .slice(0, PSR_QUARANTINE_DETAIL_MAX)
        .map(({ line, code }) => ({ line, code })),
      truncated: quarantined.length > PSR_QUARANTINE_DETAIL_MAX,
      flaggedBeneficiaries: quarantineEffect(quarantined).unreconcilableMbis.size,
      unattributableRows: quarantined.filter((q) => q.recoveredMbi === null).length,
    },
  };
}

/** Render issues as a PHI-free `parse_error` string (line numbers + codes only), capped for the column. */
export function formatPsrIssues(issues: readonly PsrCsvIssue[], max = 20): string {
  const shown = issues
    .slice(0, max)
    .map((i) => (i.line > 0 ? `line ${i.line}: ${i.code}` : i.code));
  const more = issues.length > max ? `; +${issues.length - max} more` : "";
  return shown.join("; ") + more;
}

/** `parse_error` for a ceiling rejection: the file-level code, then the first quarantined lines (codes only). */
export function formatPsrRejection(result: PsrCsvResult, max = 20): string {
  const file = formatPsrIssues(result.issues, max);
  if (result.quarantined.length === 0) return file;
  const shown = result.quarantined.slice(0, max).map((q) => `line ${q.line}: ${q.code}`);
  const more = result.quarantined.length > max ? `; +${result.quarantined.length - max} more` : "";
  return `${file}; ${shown.join("; ")}${more}`;
}

export interface PsrInpatientLine {
  readonly m26InpatientDays: number;
  readonly psrInpatientDays: number;
  readonly varianceDays: number; // psr − m26 (signed)
}

/**
 * Agency-level inpatient-day diff (GIP + IRC): the PS&R figure vs the M26 ledger total. Returns a line for
 * ANY non-zero difference — a day is a day; there is no dollar-style tolerance on the 20% numerator.
 */
export function reconcilePsrInpatientDays(
  m26Days: number,
  psrDays: number,
): PsrInpatientLine | null {
  const varianceDays = psrDays - m26Days;
  return varianceDays === 0
    ? null
    : { m26InpatientDays: m26Days, psrInpatientDays: psrDays, varianceDays };
}
