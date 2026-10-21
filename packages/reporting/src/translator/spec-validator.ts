import type { schema } from "@chartwarden/db";
// @chartwarden/reporting — translator step 1: SEMANTIC validation of a ReportDefinitionSpec against its
// base catalog (M33 §2.3, D4).
//
// The TypeBox schema (`schemas/report-definition-spec.ts`) already proved the spec is well-SHAPED
// (≤8 dimensions, 1–16 measures, ≤24 typed filters, rowLimit 1–10000). This layer proves it is
// well-FORMED *against the platform-shipped base*: every dimension/measure key exists in the base's
// catalog, every filter comparator is legal for its dimension's data type, and rowLimit ≤ the base's
// max. It throws the exact §2.3 machine-readable codes. This is a SEPARATE enforcement layer from the
// translator's column whitelisting (`sql-translator.ts`) — §2.3 is "is the spec answerable by this
// base?"; the whitelist is "can ONLY catalog columns ever reach SQL?".
//
// This file is the translator leaf: it owns the domain-error class, the comparator-by-type table, and
// the SQL-identifier guard that the filter/scope/sql steps reuse — so there is no sibling import cycle.
import { ChartWardenError } from "@chartwarden/types";

// ── Domain error catalog (§2.3) ──────────────────────────────────────────────────────────────────

/**
 * The §2.3 domain-validation failure codes (plus the translator-internal SORT guard). Each maps to the
 * canonical HTTP status the M1 error handler renders. `*_NOT_IN_BASE` / `*_MISMATCH` are 422 (the spec
 * is unanswerable by the chosen base); `BASE_NOT_ACTIVE` is 409 (the base exists but is not in a state
 * a tenant may bind); `ROW_LIMIT_EXCEEDED` is 422.
 */
export const TRANSLATOR_ERROR_STATUS = {
  BASE_NOT_ACTIVE: 409,
  DIMENSION_NOT_IN_BASE: 422,
  MEASURE_NOT_IN_BASE: 422,
  FILTER_TYPE_MISMATCH: 422,
  ROW_LIMIT_EXCEEDED: 422,
  // Translator-internal guards (not in the §2.3 client table, but the same fail-closed posture):
  SORT_KEY_NOT_IN_OUTPUT: 422,
  UNSAFE_IDENTIFIER: 500, // a catalog/MV identifier that is not a safe SQL identifier — platform bug
  COLUMN_NOT_WHITELISTED: 500, // an identifier reached SQL that is not in the catalog — translator bug
} as const;

export type TranslatorErrorCode = keyof typeof TRANSLATOR_ERROR_STATUS;

/** A report-builder translation failure carrying one of the §2.3 codes. */
export class ReportTranslatorError extends ChartWardenError {
  constructor(
    code: TranslatorErrorCode,
    message: string,
    details?: { field?: string; code: string; message: string }[],
  ) {
    super(code, message, TRANSLATOR_ERROR_STATUS[code], details);
    this.name = "ReportTranslatorError";
  }
}

// ── Data-type ↔ comparator legality (§2.3 FILTER_TYPE_MISMATCH) ───────────────────────────────────

type DataType = schema.DimensionCatalog["dataType"];
type Comparator = schema.FilterComparator;

/**
 * The legal comparator set per dimension data type. `between` is range-only (date/number); `in`/`not_in`
 * are membership-only (enumerable types — string/uuid/number; never date/boolean). `is_null`/`is_not_null`
 * are universal. Ordering comparators (lt/le/gt/ge) apply only to ordered types (number/date). A filter
 * whose comparator is absent from its dimension's row is rejected with `FILTER_TYPE_MISMATCH`.
 */
export const COMPARATORS_BY_TYPE: Readonly<Record<DataType, ReadonlySet<Comparator>>> = {
  string: new Set<Comparator>(["eq", "ne", "in", "not_in", "is_null", "is_not_null"]),
  uuid: new Set<Comparator>(["eq", "ne", "in", "not_in", "is_null", "is_not_null"]),
  boolean: new Set<Comparator>(["eq", "ne", "is_null", "is_not_null"]),
  number: new Set<Comparator>([
    "eq",
    "ne",
    "lt",
    "le",
    "gt",
    "ge",
    "in",
    "not_in",
    "between",
    "is_null",
    "is_not_null",
  ]),
  date: new Set<Comparator>([
    "eq",
    "ne",
    "lt",
    "le",
    "gt",
    "ge",
    "between",
    "is_null",
    "is_not_null",
  ]),
};

// ── SQL-identifier guard (the whitelist's last mile) ──────────────────────────────────────────────

/**
 * A safe SQL identifier: lower-snake, alpha-leading. Catalog keys, MV keys, and tenant-supplied column
 * ALIASES are all asserted against this before they are ever spliced into a SQL string. Because the
 * translator NEVER interpolates a tenant VALUE (those bind as `$n`), the only strings that reach the SQL
 * text are identifiers, and every one passes through `quoteIdent`.
 */
export const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Asserts `raw` is a safe identifier and returns it double-quoted. Throws `UNSAFE_IDENTIFIER` otherwise. */
export function quoteIdent(raw: string): string {
  if (!IDENT_RE.test(raw)) {
    throw new ReportTranslatorError(
      "UNSAFE_IDENTIFIER",
      `Identifier is not a safe SQL identifier: ${JSON.stringify(raw)}`,
    );
  }
  return `"${raw}"`;
}

// ── The translator's view of a resolved base (decoupled from Drizzle row types) ───────────────────

/**
 * Everything the translator needs about a platform-shipped base + its MV, projected from
 * `report_base_catalog` JOIN `materialized_view_metadata`. Kept as a plain interface (not the Drizzle
 * row) so the pipeline is pure + unit-testable: callers project the rows; the translator never reads DB.
 */
export interface TranslatorBaseCatalog {
  readonly baseKey: string;
  readonly status: schema.ReportBaseCatalog["status"];
  readonly mvKey: string;
  /** Schema the MV lives in (`materialized_view_metadata.schema_name`, default `report_mv`). */
  readonly mvSchemaName: string;
  /** MV lifecycle: `registered` means the upstream producer is absent → forward-seam deny-stub. */
  readonly mvStatus: schema.MaterializedViewMetadata["status"];
  readonly dimensions: readonly schema.DimensionCatalog[];
  readonly measures: readonly schema.MeasureCatalog[];
  readonly maxRowLimit: number;
  readonly drilldownUrlTemplate?: string | null;
  /**
   * The MV column carrying the authoring/owning membership, for `self`/`team` scope narrowing (D8).
   * `null`/absent = this base is an org-grain aggregate with no member column, so a narrowing scope
   * DENIES rather than reading the whole org (F-059). Never tenant input — `report_base_catalog`.
   */
  readonly scopeMembershipColumn?: string | null;
  /** The MV column carrying the location, for `location` scope narrowing. Same `null` rule as above. */
  readonly scopeLocationColumn?: string | null;
}

/** The normalized outcome of semantic validation, consumed by the SQL step. */
export interface ValidatedSpec {
  /** rowLimit after applying the §4.2 default (1000) — already proven ≤ base.maxRowLimit. */
  readonly effectiveRowLimit: number;
}

// ── value-shape checks (the §2.3 FILTER_TYPE_MISMATCH value half) ─────────────────────────────────

function isScalarOfType(value: unknown, type: DataType): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    // date/uuid are carried as ISO / canonical strings on the wire.
    case "string":
    case "date":
    case "uuid":
      return typeof value === "string";
  }
}

function isArrayOfType(value: unknown, type: DataType): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((v) => isScalarOfType(v, type));
}

/**
 * Validates the `value` half of a filter against its comparator + dimension type. The comparator itself
 * was already proven legal for the type by `COMPARATORS_BY_TYPE`; this proves the value's SHAPE matches
 * the comparator's arity (scalar / array / 2-tuple / none).
 */
function filterValueMatches(filter: schema.ReportFilter, type: DataType): boolean {
  switch (filter.comparator) {
    case "is_null":
    case "is_not_null":
      return filter.value === undefined;
    case "in":
    case "not_in":
      return isArrayOfType(filter.value, type);
    case "between": {
      const v = filter.value;
      return (
        Array.isArray(v) &&
        v.length === 2 &&
        isScalarOfType(v[0], type) &&
        isScalarOfType(v[1], type)
      );
    }
    default:
      // eq/ne/lt/le/gt/ge — a single scalar of the dimension's type.
      return isScalarOfType(filter.value, type);
  }
}

// ── The validator ─────────────────────────────────────────────────────────────────────────────────

/**
 * Validates `spec` against the resolved `base` catalog, throwing the exact §2.3 codes on the first
 * violation:
 *  - `BASE_NOT_ACTIVE`        — base.status !== 'active'
 *  - `DIMENSION_NOT_IN_BASE`  — a spec/filter dimensionKey absent from base.dimensions[]
 *  - `MEASURE_NOT_IN_BASE`    — a measureKey absent from base.measures[]
 *  - `FILTER_TYPE_MISMATCH`   — a filter comparator/value illegal for the dimension's data type
 *  - `ROW_LIMIT_EXCEEDED`     — effective rowLimit > base.maxRowLimit
 *
 * Returns the normalized effective rowLimit for the SQL step. Pure — no DB access, no side effects.
 */
export function validateSpecAgainstBase(
  spec: schema.ReportDefinitionSpec,
  base: TranslatorBaseCatalog,
): ValidatedSpec {
  // 1. The base must be active (§2.3).
  if (base.status !== "active") {
    throw new ReportTranslatorError(
      "BASE_NOT_ACTIVE",
      `Report base "${base.baseKey}" is not active (status=${base.status}).`,
    );
  }

  const dimByKey = new Map(base.dimensions.map((d) => [d.dimensionKey, d]));
  const measureKeys = new Set(base.measures.map((m) => m.measureKey));

  // 2. Every selected dimension must exist in the base catalog (§2.3).
  for (const ref of spec.dimensions) {
    if (!dimByKey.has(ref.dimensionKey)) {
      throw new ReportTranslatorError(
        "DIMENSION_NOT_IN_BASE",
        `Dimension "${ref.dimensionKey}" is not in base "${base.baseKey}".`,
        [{ field: "dimensions", code: "DIMENSION_NOT_IN_BASE", message: ref.dimensionKey }],
      );
    }
  }

  // 3. Every selected measure must exist in the base catalog (§2.3).
  for (const ref of spec.measures) {
    if (!measureKeys.has(ref.measureKey)) {
      throw new ReportTranslatorError(
        "MEASURE_NOT_IN_BASE",
        `Measure "${ref.measureKey}" is not in base "${base.baseKey}".`,
        [{ field: "measures", code: "MEASURE_NOT_IN_BASE", message: ref.measureKey }],
      );
    }
  }

  // 4. Every filter's dimension must exist, AND its comparator+value must be legal for the type (§2.3).
  for (const filter of spec.filters) {
    const dim = dimByKey.get(filter.dimensionKey);
    if (!dim) {
      throw new ReportTranslatorError(
        "DIMENSION_NOT_IN_BASE",
        `Filter dimension "${filter.dimensionKey}" is not in base "${base.baseKey}".`,
        [{ field: "filters", code: "DIMENSION_NOT_IN_BASE", message: filter.dimensionKey }],
      );
    }
    const legal = COMPARATORS_BY_TYPE[dim.dataType];
    if (!legal.has(filter.comparator) || !filterValueMatches(filter, dim.dataType)) {
      throw new ReportTranslatorError(
        "FILTER_TYPE_MISMATCH",
        `Comparator "${filter.comparator}" with the given value is not valid for ${dim.dataType} dimension "${filter.dimensionKey}".`,
        [{ field: "filters", code: "FILTER_TYPE_MISMATCH", message: filter.dimensionKey }],
      );
    }
  }

  // 5. rowLimit (defaulted to §4.2's 1000) must be ≤ the base's max (§2.3).
  const effectiveRowLimit = spec.rowLimit ?? 1000;
  if (effectiveRowLimit > base.maxRowLimit) {
    throw new ReportTranslatorError(
      "ROW_LIMIT_EXCEEDED",
      `rowLimit ${effectiveRowLimit} exceeds base "${base.baseKey}" max ${base.maxRowLimit}.`,
      [{ field: "rowLimit", code: "ROW_LIMIT_EXCEEDED", message: String(effectiveRowLimit) }],
    );
  }

  return { effectiveRowLimit };
}
