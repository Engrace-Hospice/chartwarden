// @wardenx/cap-management — PS&R (Provider Statistical & Reimbursement) reconciliation (D9, Phase 1 = CSV).
// The MAC's PS&R report is the MAC's view of the hospice's cap status; M26 ingests the quarterly CSV, diffs
// each figure against its running ledger, and routes any variance above the per-tenant threshold (default
// $50) to the cap_psr_reconciliation queue with a categorical reason for the billing clerk.
//
// The parser is intentionally PERMISSIVE: handles a UTF-8 BOM, CRLF/LF, trailing whitespace, quoted fields,
// and the per-MAC column-name variants below. No PHI is logged; the MBI is a join key, never audit-captured.
import { DEFAULT_PSR_VARIANCE_THRESHOLD_CENTS, type MacRegion, type PsrReconScope, type PsrVarianceReason } from "./types";

/** Canonical PS&R fields M26 reconciles against, mapped from each MAC's column header variants. */
export interface PsrColumnDictionary {
  readonly mbi: readonly string[];
  readonly paidAmount: readonly string[];
  readonly inpatientDays: readonly string[];
}

/** Per-MAC header aliases (the "two layout variants currently in circulation", §5.1.5). Lower-cased match. */
export const PSR_COLUMN_DICTIONARY: Record<MacRegion, PsrColumnDictionary> = {
  ngs: { mbi: ["mbi", "hic", "hicn"], paidAmount: ["paid amount", "payments", "total paid"], inpatientDays: ["inpatient days", "gip+irc days", "ipu days"] },
  cgs: { mbi: ["mbi", "hic"], paidAmount: ["paid amount", "reimbursement"], inpatientDays: ["inpatient days", "ip days"] },
  palmetto: { mbi: ["mbi", "hicn"], paidAmount: ["paid amount", "payments"], inpatientDays: ["inpatient days"] },
  wps: { mbi: ["mbi", "hic"], paidAmount: ["paid amount", "total payments"], inpatientDays: ["inpatient days"] },
  noridian: { mbi: ["mbi", "hicn"], paidAmount: ["paid amount", "payments"], inpatientDays: ["inpatient days"] },
  first_coast: { mbi: ["mbi", "hic"], paidAmount: ["paid amount"], inpatientDays: ["inpatient days"] },
  novitas: { mbi: ["mbi", "hicn"], paidAmount: ["paid amount", "payments"], inpatientDays: ["inpatient days"] },
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
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
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
  const lines = normalize(text).split("\n").filter((l) => l.trim().length > 0);
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
      inpatientDays: ipIdx >= 0 ? Math.round(Number((fields[ipIdx] ?? "0").replace(/[^\d.-]/g, "")) || 0) : 0,
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
export function classifyVariance(m26Cents: number | null, psrCents: number | null): PsrVarianceReason {
  if (m26Cents == null && psrCents != null) return "mbi_mismatch"; // PS&R has a beneficiary we don't
  if (psrCents == null && m26Cents != null) return "timing"; // we have a beneficiary PS&R hasn't posted yet
  return "unknown";
}

/**
 * Diff M26 ledger beneficiaries against parsed PS&R rows by normalized MBI. Emits one beneficiary-scope
 * variance line per MBI present on either side, plus an agency-aggregate line. `aboveThreshold` marks the
 * lines that land on the reconciliation queue (variance ≥ the per-tenant threshold, default $50).
 */
export function reconcilePsr(
  ledger: readonly LedgerBeneficiary[],
  psr: readonly PsrParsedRow[],
  thresholdCents: number = DEFAULT_PSR_VARIANCE_THRESHOLD_CENTS,
): PsrVarianceLine[] {
  const byMbiLedger = new Map(ledger.map((b) => [b.mbiNormalized, b]));
  const byMbiPsr = new Map(psr.map((r) => [r.mbi, r]));
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
