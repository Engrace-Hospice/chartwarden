// apps/web/src/modules/10-hope — defensive parser for a pasted CMS Final Validation Report (iQIES has no API,
// so a user pastes the report). Accepts JSON (`[...]` or `{results:[...]}`), or delimited lines (CSV / TSV /
// pipe) with an optional header naming assessmentId, status, code, itemCode, message. Input is untrusted:
// size- and row-limited, never evaluated; rows it cannot understand are reported, not guessed at. The server
// remains the authority on matching and validation.

export type CmsItemOutcome = "accepted" | "accepted_with_warnings" | "rejected";

export interface ParsedCmsRow {
  readonly assessmentId: string;
  readonly status: CmsItemOutcome;
  readonly code: string;
  readonly itemCode: string;
  readonly message: string;
}

export interface ParsedCmsReport {
  readonly rows: readonly ParsedCmsRow[];
  readonly errors: readonly string[];
}

export const MAX_REPORT_CHARS = 200_000;
export const MAX_REPORT_ROWS = 2_000;
const MAX_CODE = 64;
const MAX_MESSAGE = 1_000;

/** Polarity-safe: a negated acceptance ("not accepted") is a rejection, and "0 errors" is not an error.
 * Anything unrecognised is null (the row is reported, never guessed). Mirrors the server's classifyStatusText. */
export function normalizeOutcome(raw: unknown): CmsItemOutcome | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, " ") // enum tokens (accepted_with_warnings): `_` is a word char, so \b would not split them
    .replace(/\b(no|zero|0)\s+(errors?|warnings?|failures?)\b/g, " ");
  if (s.trim() === "") return null;
  if (
    /\b(not|non|never)[\s-]*(accepted|pass(ed|ing)?|successful|ok)\b|\bun(accepted|successful)\b/.test(
      s,
    )
  )
    return "rejected";
  if (/\b(reject(ed)?|fail(ed|ure)?|fatal|errors?)\b/.test(s)) return "rejected";
  if (/\bwarn(ing|ings)?\b/.test(s)) return "accepted_with_warnings";
  if (/\b(accepted|pass(ed)?|success(ful)?|ok)\b/.test(s)) return "accepted";
  return null;
}

const text = (v: unknown, max: number): string =>
  typeof v === "string" || typeof v === "number" ? String(v).trim().slice(0, max) : "";

function fromRecord(raw: Record<string, unknown>, label: string): ParsedCmsRow | string {
  // Keys are matched case- and separator-insensitively (assessment_id, Assessment ID, assessmentId).
  const rec = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k.toLowerCase().replace(/[\s_-]+/g, ""), v]),
  );
  const pick = (...keys: string[]): unknown => keys.map((k) => rec[k]).find((v) => v != null);
  const assessmentId = text(pick("assessmentid", "assessment"), 64);
  if (!assessmentId) return `${label}: missing assessment id`;
  const status = normalizeOutcome(pick("status", "result", "outcome"));
  if (!status) return `${label}: unrecognised status`;
  return {
    assessmentId,
    status,
    code: text(pick("code", "errorcode"), MAX_CODE),
    itemCode: text(pick("itemcode", "item"), MAX_CODE),
    message: text(pick("message", "description", "text"), MAX_MESSAGE),
  };
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

const POSITIONAL = ["assessmentId", "status", "code", "message"];

/** Split on newlines that are OUTSIDE double quotes, so a quoted cell may span lines. */
function splitRecords(input: string): { records: string[]; unterminated: boolean } {
  const records: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') quoted = !quoted; // an escaped "" toggles twice, which nets out
    if (!quoted && ch === "\n") {
      records.push(cur.replace(/\r$/, ""));
      cur = "";
    } else cur += ch;
  }
  // An open quote at EOF means the tail is one unterminated cell: drop it and let the caller report it.
  if (!quoted) records.push(cur.replace(/\r$/, ""));
  return { records: records.filter((r) => r.trim() !== ""), unterminated: quoted };
}

/** Most frequent of tab / pipe / comma in the first record, ignoring quoted text (comma wins ties and zero). */
function sniffDelimiter(first: string): string {
  const counts: Record<string, number> = { "\t": 0, "|": 0, ",": 0 };
  let quoted = false;
  for (const ch of first) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  return (["\t", "|"] as const).reduce(
    (best, d) => ((counts[d] ?? 0) > (counts[best] ?? 0) ? d : best),
    ",",
  );
}

const norm = (h: string): string => h.toLowerCase().replace(/[\s_-]+/g, "");

/** A header row names BOTH an assessment-id column and a status-like column; a data line whose message merely
 * mentions "assessment" is not one (it is then parsed as data, so it can never be silently dropped). */
function isHeader(cells: readonly string[]): boolean {
  const keys = cells.map(norm);
  return (
    keys.some((k) => k === "assessmentid" || k === "assessment") &&
    keys.some((k) => k === "status" || k === "result" || k === "outcome")
  );
}

function parseDelimited(input: string): ParsedCmsReport {
  const { records: lines, unterminated } = splitRecords(input);
  const first = lines[0] ?? "";
  const delimiter = sniffDelimiter(first);
  const firstCells = splitLine(first, delimiter);
  const hasHeader = isHeader(firstCells);
  const header = hasHeader ? firstCells.map((h) => h.replace(/[\s-]+/g, "").trim()) : POSITIONAL;
  const start = hasHeader ? 1 : 0;
  const rows: ParsedCmsRow[] = [];
  const errors: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i] as string, delimiter);
    const rec: Record<string, unknown> = {};
    header.forEach((h, idx) => {
      rec[h] = cells[idx];
    });
    const parsed = fromRecord(rec, `Data row ${i - start + 1}`);
    if (typeof parsed === "string") errors.push(parsed);
    else rows.push(parsed);
  }
  if (unterminated)
    errors.push(
      `Unterminated quote after data row ${Math.max(lines.length - start, 0)}; remaining lines were not parsed.`,
    );
  return { rows, errors };
}

function parseJson(input: string): ParsedCmsReport {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return { rows: [], errors: ["The report is not valid JSON."] };
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { results?: unknown }).results)
      ? (value as { results: unknown[] }).results
      : null;
  if (!list) return { rows: [], errors: ["Expected a JSON array or an object with `results`."] };
  const rows: ParsedCmsRow[] = [];
  const errors: string[] = [];
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`Entry ${i + 1}: not an object`);
      return;
    }
    const parsed = fromRecord(entry as Record<string, unknown>, `Entry ${i + 1}`);
    if (typeof parsed === "string") errors.push(parsed);
    else rows.push(parsed);
  });
  return { rows, errors };
}

export function parseCmsReport(input: string): ParsedCmsReport {
  const trimmed = input.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return { rows: [], errors: ["Nothing to import."] };
  if (trimmed.length > MAX_REPORT_CHARS)
    return {
      rows: [],
      errors: [`The report is too large (limit ${MAX_REPORT_CHARS} characters).`],
    };
  const result = /^[[{]/.test(trimmed) ? parseJson(trimmed) : parseDelimited(trimmed);
  if (result.rows.length > MAX_REPORT_ROWS)
    return { rows: [], errors: [`Too many rows (limit ${MAX_REPORT_ROWS}).`] };
  return result;
}
