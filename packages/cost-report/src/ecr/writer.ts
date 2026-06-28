// @wardenx/cost-report — M27 ECR fixed-field WRITER (D11, §1.1 / §2.4). Turns the 21 worksheets' frozen
// `data` payloads (the `worksheet_snapshot` jsonb materialized at submit) into the CMS-1984-14 ECR text
// file: a report-level header record, one addressed data record per worksheet leaf value, and a record-
// count trailer. The walk is fully deterministic — object keys are visited in lexicographic order and
// arrays in index order at every depth — so the same logical snapshot always produces byte-identical ECR
// text (the precondition the snapshot content-hash and the byte-conformance tests rely on).
//
// TODO(CMS-fixture): the mapping from a worksheet leaf to its TRUE CMS line/column address requires the
// CMS-1984-14 ECR specification. Until that fixture lands, leaves are addressed by their deterministic
// in-worksheet ordinal (line = 1..n, column = 1) and the dollars-vs-count typing is inferred from the
// field name (`*Cents` ⇒ dollars). This is internally consistent and round-trips; only the line/column
// numbers and value typing are provisional, and replacing them is a localized edit to this file.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. No PHI — aggregate
// financial / statistical values only (D18).
import { WORKSHEET_CODES, type WorksheetCode } from "../contracts";
import {
  type EcrDataRecord,
  type EcrHeaderRecord,
  type EcrRecord,
  type EcrValue,
  ECR_SPEC_VERSION,
  recordsToText,
} from "./records";

/** The per-code worksheet `data` map carried in a snapshot's `worksheet_snapshot` jsonb. */
export type SnapshotWorksheets = Partial<Record<WorksheetCode, unknown>>;

/** Report-level identity stamped into the ECR header record. */
export interface EcrHeaderContext {
  providerCcn: string;
  /** ISO `YYYY-MM-DD`. */
  fiscalYearStartDate: string;
  /** ISO `YYYY-MM-DD`. */
  fiscalYearEndDate: string;
  ecrSpecVersion?: string;
}

/** A single resolved leaf of a worksheet's `data` tree: its dotted path and primitive value. */
export interface WorksheetLeaf {
  path: string[];
  value: unknown;
}

/**
 * Recursively flatten a worksheet `data` value into an ordered list of primitive leaves. Object keys are
 * sorted lexicographically at every depth and arrays keep index order, so the leaf sequence is fully
 * deterministic. A `null`/`undefined` is emitted as a `null` leaf; an empty object/array yields no leaves.
 */
export function flattenWorksheetLeaves(value: unknown, path: string[] = []): WorksheetLeaf[] {
  if (value === null || value === undefined) return [{ path, value: null }];

  if (Array.isArray(value)) {
    const out: WorksheetLeaf[] = [];
    value.forEach((element, index) => {
      out.push(...flattenWorksheetLeaves(element, [...path, String(index)]));
    });
    return out;
  }

  if (typeof value === "object") {
    const out: WorksheetLeaf[] = [];
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      out.push(...flattenWorksheetLeaves(record[key], [...path, key]));
    }
    return out;
  }

  return [{ path, value }];
}

/**
 * Classify a leaf into a typed ECR value. A boolean renders as `Y`/`N` alpha; a string is alpha; an
 * integer whose field name ends in `Cents` is monetary (dollars-and-cents); any other finite number is a
 * non-monetary count (patient days, visits, paid hours). A `null` leaf renders as empty alpha.
 * TODO(CMS-fixture): replace the `*Cents` name heuristic with the spec's position-driven value typing.
 */
export function leafToEcrValue(leaf: WorksheetLeaf): EcrValue {
  const lastSegment = leaf.path[leaf.path.length - 1] ?? "";
  const value = leaf.value;

  if (value === null) return { kind: "alpha", text: "" };
  if (typeof value === "boolean") return { kind: "alpha", text: value ? "Y" : "N" };
  if (typeof value === "string") return { kind: "alpha", text: value };
  if (typeof value === "number") {
    if (Number.isInteger(value) && /cents$/i.test(lastSegment)) {
      return { kind: "money", cents: value };
    }
    return { kind: "count", count: value };
  }
  return { kind: "alpha", text: String(value) };
}

/** Build the addressed data records for one worksheet's `data` payload. */
export function worksheetToDataRecords(code: WorksheetCode, data: unknown): EcrDataRecord[] {
  return flattenWorksheetLeaves(data).map((leaf, index) => ({
    recordKind: "data",
    worksheetCode: code,
    lineNumber: index + 1,
    columnNumber: 1,
    value: leafToEcrValue(leaf),
  }));
}

/**
 * The report-level header record. When no context is supplied (e.g. an early development snapshot whose
 * provider identity has not been threaded through), the fields render blank — never fabricated.
 * TODO(CMS-fixture): the header record's true field set (CCN, NPI, MAC, vendor code, ECR version) follows
 * the CMS-1984-14 ECR header layout.
 */
export function buildHeaderRecord(header?: EcrHeaderContext): EcrHeaderRecord {
  return {
    recordKind: "header",
    providerCcn: header?.providerCcn ?? "",
    fiscalYearStartDate: header?.fiscalYearStartDate ?? "",
    fiscalYearEndDate: header?.fiscalYearEndDate ?? "",
    ecrSpecVersion: header?.ecrSpecVersion ?? ECR_SPEC_VERSION,
  };
}

/**
 * Produce the full fixed-field ECR text from the 21 worksheets' snapshot data. Worksheets are emitted in
 * the canonical `WORKSHEET_CODES` order; a worksheet absent from the snapshot contributes no records (it
 * was never populated). The trailer's `recordCount` is the number of header + data records preceding it.
 */
export function writeEcr(snapshotWorksheets: SnapshotWorksheets, header?: EcrHeaderContext): string {
  const records: EcrRecord[] = [buildHeaderRecord(header)];

  for (const code of WORKSHEET_CODES) {
    const data = snapshotWorksheets[code];
    if (data === undefined) continue;
    records.push(...worksheetToDataRecords(code, data));
  }

  records.push({ recordKind: "trailer", recordCount: records.length });
  return recordsToText(records);
}
