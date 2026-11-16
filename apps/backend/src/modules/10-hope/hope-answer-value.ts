// apps/backend/src/modules/10-hope/hope-answer-value.ts — what a HOPE answer value must look like for an item: the SAME
// validator the answer engine applies to a clinician's own answer and the SFV completion applies to J2052/J2053.
// Split out of `hope-answer-service.ts` (re-exported there, so existing importers keep working).
import type { schema } from "@chartwarden/db";
import { ValidationError } from "@chartwarden/types";
import { isRealCalendarDate } from "./hope-calendar-date";
import { isCmsSkipBlankOption } from "./hope-spec-registry";

type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
type OptionRow = typeof schema.hopeSpecItemOptions.$inferSelect;

export class HopeInvalidAnswerValueError extends ValidationError {
  constructor(itemCode: string, message: string) {
    super("Invalid HOPE answer value", [
      { field: itemCode, code: "HOPE_INVALID_ANSWER_VALUE", message },
    ]);
    this.name = "HopeInvalidAnswerValueError";
  }
}

const DATE_TYPE_HINTS = ["date", "dt", "dte"];
const NUMERIC_TYPE_HINTS = ["int", "num", "dec", "numeric", "integer", "decimal"];
const DATE_FORMAT_PLACEHOLDERS = new Set(["YYYYMMDD", "YYYYMM", "YYYY"]);
const SKIP_CARET_MESSAGE = "CMS ^ is represented as skipped + null, not as a normal answer value";

function isDateCode(item: SpecItemRow): boolean {
  const type = item.cmsItemTypeCode.toLowerCase();
  return DATE_TYPE_HINTS.some((hint) => type.includes(hint));
}

const invalid = (item: SpecItemRow, message: string): HopeInvalidAnswerValueError =>
  new HopeInvalidAnswerValueError(item.itemCode, message);

/**
 * A date answer for `itemCode`: `YYYYMMDD` / `YYYY-MM-DD` that is a REAL calendar date (returned dashed), or a CMS
 * placeholder. Exported for the in-memory backend, which has no spec rows to hand `normalizeHopeAnswerValue`.
 */
export function normalizeDateText(itemCode: string, inputValue: unknown): string {
  const refuse = (message: string) => new HopeInvalidAnswerValueError(itemCode, message);
  if (typeof inputValue !== "string") throw refuse("date values must be YYYY-MM-DD");
  if (DATE_FORMAT_PLACEHOLDERS.has(inputValue)) return inputValue;
  const dashed = /^\d{8}$/.test(inputValue)
    ? `${inputValue.slice(0, 4)}-${inputValue.slice(4, 6)}-${inputValue.slice(6, 8)}`
    : inputValue;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dashed)) throw refuse("date values must be YYYY-MM-DD");
  const year = Number(dashed.slice(0, 4));
  const month = Number(dashed.slice(5, 7));
  const day = Number(dashed.slice(8, 10));
  if (!isRealCalendarDate(year, month, day))
    throw refuse("date values must be real calendar dates");
  return dashed;
}

/** A free-text item (`Text` option): a string within the item's fixed record length, never the skip caret. */
function normalizeText(
  item: SpecItemRow,
  options: readonly OptionRow[],
  inputValue: unknown,
): string {
  if (typeof inputValue !== "string") throw invalid(item, "text HOPE values must be strings");
  if (inputValue === "^" && isCmsSkipBlankOption(options)) throw invalid(item, SKIP_CARET_MESSAGE);
  if (item.fixedRecordLength && inputValue.length > item.fixedRecordLength) {
    throw invalid(item, `text values must not exceed ${item.fixedRecordLength} characters`);
  }
  return inputValue;
}

/** A coded item: one of the item's CMS option codes, never the skip caret. */
function normalizeCoded(
  item: SpecItemRow,
  options: readonly OptionRow[],
  inputValue: unknown,
): string {
  if (typeof inputValue !== "string") throw invalid(item, "coded HOPE values must be strings");
  if (inputValue === "^" && isCmsSkipBlankOption(options)) throw invalid(item, SKIP_CARET_MESSAGE);
  if (!options.some((option) => option.valueCode === inputValue)) {
    // The item code, never the value: this envelope is cached by the idempotency layer for 24 hours, and a clinician
    // who pastes a note into a coded field would otherwise have it (possibly PHI) echoed into the body and the cache.
    throw invalid(item, `the value is not an allowed CMS value for ${item.itemCode}`);
  }
  return inputValue;
}

/** An item with no option set: a finite number for a numeric type, otherwise any scalar. */
function normalizeScalar(item: SpecItemRow, inputValue: unknown): unknown {
  const type = item.cmsItemTypeCode.toLowerCase();
  if (NUMERIC_TYPE_HINTS.some((hint) => type.includes(hint))) {
    if (typeof inputValue !== "number" || !Number.isFinite(inputValue)) {
      throw invalid(item, "numeric values must be finite numbers");
    }
    return inputValue;
  }
  if (
    typeof inputValue !== "string" &&
    typeof inputValue !== "number" &&
    typeof inputValue !== "boolean"
  ) {
    throw invalid(item, "HOPE answers must be scalar values");
  }
  return inputValue;
}

export function normalizeHopeAnswerValue(input: {
  readonly item: SpecItemRow;
  readonly options: readonly OptionRow[];
  readonly inputValue: unknown;
}): unknown {
  const { item, options, inputValue } = input;
  if (inputValue == null) throw invalid(item, "answered values cannot be null");
  if (options.some((option) => option.valueCode === "YYYYMMDD") || isDateCode(item)) {
    return normalizeDateText(item.itemCode, inputValue);
  }
  if (options.some((option) => option.valueCode === "Text")) {
    return normalizeText(item, options, inputValue);
  }
  if (options.length > 0) return normalizeCoded(item, options, inputValue);
  return normalizeScalar(item, inputValue);
}
