// apps/admin/src/modules/23-billing-medicare — the pure half of the platform wage-index load (M23 §4.1 #42, GAP-144).
// Turns a pasted or uploaded CMS hospice wage-index table into the body `POST /api/v1/admin/billing/wage-indexes/load`
// accepts, previews it, and maps the standard error envelope to operator copy. Wire shapes are TYPE ALIASES into the
// generated `operations` map, so a route/DTO drift is a compile error here.
//
// THE SERVER RULES THIS MIRRORS (routes/platform-admin-typebox.ts + platform-admin-service.ts):
//   • body `{ fiscalYearStarting (2000–2100), sourceReference (1–500), rows[1..7000] }`, each row
//     `{ ccn: /^[0-9A-Za-z]{6}$/, cbsaCode?: /^[0-9]{5}$/, factorDecimal: /^\d(\.\d{1,4})?$/ }` — the factor is a decimal
//     STRING, never a float. The server does NOT fetch `sourceReference` (no outbound fetch of a caller URI): the rows
//     travel in the body and the reference is the audit trail.
//   • There is NO dry run: every row is validated first (a 422 names up to 20 problems as `rows[i]` details), a
//     duplicate CCN refuses the file, then the whole file loads in ONE transaction — a bad row loads nothing.
//   • `billing.rule_config.platform_admin` + a FRESH step-up (403 STEP_UP_REQUIRED) + no AI actor + `Idempotency-Key`.
// The preview below repeats the per-row patterns so the operator fixes the file BEFORE sending it; it decides nothing.
import type { operations } from "@wardenx/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Op = operations["postApiV1AdminBillingWageindexesLoad"];

export type WageIndexLoadBody = Json<Op["requestBody"]>;
export type WageIndexLoadRow = WageIndexLoadBody["rows"][number];
export type WageIndexLoadResult = Op extends { responses: { 200: infer R } } ? Json<R> : never;

/** The route's own cap (`WAGE_INDEX_LOAD_MAX_ROWS`): CMS publishes roughly 6,000 hospice CCNs per fiscal year. */
export const WAGE_INDEX_LOAD_MAX_ROWS = 7000;
export const SOURCE_REFERENCE_MAX = 500;

const CCN = /^[0-9A-Za-z]{6}$/;
const CBSA = /^[0-9]{5}$/;
const FACTOR = /^\d(\.\d{1,4})?$/;
const LOOKS_LIKE_HEADER = /[a-z]{3,}/i;

export interface LineProblem {
  readonly line: number;
  readonly message: string;
}

export interface ParsedWageIndexTable {
  readonly rows: readonly WageIndexLoadRow[];
  /** The 1-based source line of each parsed row (index-aligned with `rows`), to map a server `rows[i]` back. */
  readonly sourceLines: readonly number[];
  readonly problems: readonly LineProblem[];
}

function cellsOf(line: string): string[] {
  const cells = /[,;\t]/.test(line) ? line.split(/[,;\t]/) : line.trim().split(/\s+/);
  return cells.map((c) => c.trim());
}

type RowVerdict = { readonly row: WageIndexLoadRow } | { readonly problem: string };

function rowOf(cells: readonly string[]): RowVerdict {
  if (cells.length < 2 || cells.length > 3)
    return { problem: "expected CCN, factor or CCN, CBSA, factor" };
  const [rawCcn = "", ...rest] = cells;
  const factor = rest.at(-1) ?? "";
  const cbsa = cells.length === 3 ? (cells[1] ?? "") : "";
  if (!CCN.test(rawCcn)) return { problem: `CCN "${rawCcn}" must be 6 letters or digits` };
  if (cbsa !== "" && !CBSA.test(cbsa)) return { problem: `CBSA "${cbsa}" must be 5 digits` };
  if (!FACTOR.test(factor))
    return {
      problem: `wage index "${factor}" must be a decimal like 1.0342 (at most four decimal places)`,
    };
  const ccn = rawCcn.toUpperCase();
  return {
    row: cbsa ? { ccn, cbsaCode: cbsa, factorDecimal: factor } : { ccn, factorDecimal: factor },
  };
}

/** PURE. Parse a pasted/uploaded table: one row per line, comma / tab / semicolon / space separated. */
export function parseWageIndexTable(text: string): ParsedWageIndexTable {
  const rows: WageIndexLoadRow[] = [];
  const sourceLines: number[] = [];
  const problems: LineProblem[] = [];
  const firstLineOf = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    const cells = cellsOf(raw);
    // A header row ("CCN, CBSA, Wage Index") is skipped only when it precedes every data row.
    const first = cells[0] ?? "";
    const isHeader =
      rows.length === 0 &&
      problems.length === 0 &&
      LOOKS_LIKE_HEADER.test(first) &&
      !CCN.test(first);
    if (isHeader) return;
    const verdict = rowOf(cells);
    if ("problem" in verdict) {
      problems.push({ line, message: verdict.problem });
      return;
    }
    const seenOn = firstLineOf.get(verdict.row.ccn);
    if (seenOn !== undefined)
      problems.push({
        line,
        message: `CCN ${verdict.row.ccn} appears more than once (first on line ${seenOn})`,
      });
    else firstLineOf.set(verdict.row.ccn, line);
    rows.push(verdict.row);
    sourceLines.push(line);
  });
  if (rows.length > WAGE_INDEX_LOAD_MAX_ROWS)
    problems.push({
      line: sourceLines[WAGE_INDEX_LOAD_MAX_ROWS] ?? lines.length,
      message: `one load takes at most ${WAGE_INDEX_LOAD_MAX_ROWS.toLocaleString("en-US")} rows; this file has ${rows.length.toLocaleString("en-US")}`,
    });
  return { rows, sourceLines, problems };
}

/** FY label by its ENDING year (the federal FY starting Oct 2025 is FY2026). */
export function fiscalYearLabel(fiscalYearStarting: number): string {
  return `FY${fiscalYearStarting + 1}`;
}

/** The federal FY starting year a date falls in (Oct–Dec belongs to the FY starting that year). */
export function fiscalYearStartingOf(date: Date): number {
  return date.getMonth() >= 9 ? date.getFullYear() : date.getFullYear() - 1;
}

export interface LoadErrorView {
  readonly title: string;
  readonly message: string;
  /** Per-row problems from a 422, mapped back to the operator's line numbers. */
  readonly details: readonly string[];
}

interface EnvelopeError {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly details?: readonly { readonly field?: unknown; readonly message?: unknown }[];
}

function envelopeOf(body: unknown): EnvelopeError {
  const error = (body as { error?: EnvelopeError } | undefined)?.error;
  return error && typeof error === "object" ? error : {};
}

function detailLine(
  detail: { readonly field?: unknown; readonly message?: unknown },
  sourceLines: readonly number[],
): string {
  const message = typeof detail.message === "string" ? detail.message : "invalid";
  const index = typeof detail.field === "string" ? /^rows\[(\d+)\]/.exec(detail.field) : null;
  const line = index ? sourceLines[Number(index[1])] : undefined;
  return line !== undefined ? `Line ${line}: ${message}` : message;
}

/** PURE. The standard error envelope (`{ error: { code, message, details? } }`) → copy the operator can act on. */
export function loadErrorView(
  status: number | null,
  body: unknown,
  sourceLines: readonly number[],
): LoadErrorView {
  const error = envelopeOf(body);
  const code = typeof error.code === "string" ? error.code : null;
  const serverMessage = typeof error.message === "string" && error.message ? error.message : null;
  if (code === "STEP_UP_REQUIRED")
    return {
      title: "Re-verify to load",
      message:
        "Loading the platform wage index needs a fresh step-up. Re-verify your identity, then load again — nothing was loaded.",
      details: [],
    };
  if (status === 403)
    return {
      title: "Not permitted",
      message:
        "Loading the platform wage index needs billing.rule_config.platform_admin, and is never done by an AI agent. Nothing was loaded.",
      details: [],
    };
  if (status === 409)
    return {
      title: "This submission key was already used",
      message:
        serverMessage ??
        "A different file was already sent with this submission. Review the table and load again.",
      details: [],
    };
  if (status === 422)
    return {
      title: "The file was refused — nothing was loaded",
      message: serverMessage ?? "The server rejected the wage-index rows.",
      details: (error.details ?? []).map((d) => detailLine(d, sourceLines)),
    };
  return {
    title: "The load did not complete",
    message: serverMessage ?? "The wage index could not be loaded. Nothing was changed; try again.",
    details: [],
  };
}
