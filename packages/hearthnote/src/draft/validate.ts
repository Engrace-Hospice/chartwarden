// packages/hearthnote/src/draft/validate.ts — boundary checks for the draft compiler's inputs.
//
// The compiler fails fast on a malformed field instead of drafting around it: a wrong date or a NaN in a
// clinical sentence is worse than a draft that refuses to build. Every check is a pure function.

/** A malformed input to `compileDraft` (a caller bug, not a clinical state). */
export class DraftInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftInputError";
  }
}

// A zone is mandatory: `Date.parse` reads a zone-less string in the host's local time, which would make
// the as-of comparison depend on the machine.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Milliseconds since the epoch for an ISO-8601 instant with a zone. */
export function instantMs(value: unknown, field: string): number {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    throw new DraftInputError(`${field} must be an ISO-8601 instant with a zone`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new DraftInputError(`${field} is not a valid instant`);
  return ms;
}

/** Whether a `YYYY-MM-DD` string is a real calendar day: it must round-trip through a UTC date (2026-02-30 and 2026-13-45 do not). */
function isCalendarDay(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

/** A `YYYY-MM-DD` date string that is a real calendar day, returned as given. */
export function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || !isCalendarDay(value)) {
    throw new DraftInputError(`${field} must be a YYYY-MM-DD date`);
  }
  return value;
}

export function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DraftInputError(`${field} must be a finite number`);
  }
  return value;
}

/** A decimal as a number or a numeric string, returned as text. */
export function decimalText(value: unknown, field: string): string {
  if (typeof value === "number") return String(finiteNumber(value, field));
  if (typeof value === "string" && DECIMAL.test(value)) return value;
  throw new DraftInputError(`${field} must be a decimal number`);
}

/** A decimal greater than zero (a weight), as the text the sentence shows and as a number for the comparison. */
export function positiveDecimal(
  value: unknown,
  field: string,
): { readonly text: string; readonly amount: number } {
  const text = decimalText(value, field);
  const amount = Number(text);
  if (!(amount > 0)) throw new DraftInputError(`${field} must be greater than zero`);
  return { text, amount };
}

/** A whole number of at least 1 (a benefit period's number). */
export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new DraftInputError(`${field} must be a whole number of at least 1`);
  }
  return value;
}

/** The units a weight can be drafted in. Nothing is converted between them. */
export const WEIGHT_UNITS = ["kg", "lb"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
export function isWeightUnit(unit: unknown): unit is WeightUnit {
  return typeof unit === "string" && (WEIGHT_UNITS as readonly string[]).includes(unit);
}

/** The relationship words M5 records on a patient-caregiver link (`patient_caregiver.relationship`); each has a word in the draft. */
export const CAREGIVER_RELATIONSHIPS = [
  "spouse",
  "child",
  "parent",
  "sibling",
  "other_family",
  "friend",
  "guardian",
  "paid_caregiver",
] as const;
export type CaregiverRelationship = (typeof CAREGIVER_RELATIONSHIPS)[number];
export function isCaregiverRelationship(value: unknown): value is CaregiverRelationship {
  return (
    typeof value === "string" && (CAREGIVER_RELATIONSHIPS as readonly string[]).includes(value)
  );
}

/** A value the word table holds; a key it does not (or an inherited one such as "constructor") is a malformed input. */
export function tableValue<T>(table: Readonly<Record<string, T>>, key: unknown, field: string): T {
  if (typeof key !== "string" || !Object.hasOwn(table, key)) {
    throw new DraftInputError(`${field} is not a recognised value`);
  }
  return table[key] as T;
}

/** Whole days from one real `YYYY-MM-DD` date to another (negative when `to` is earlier). Validate both with `isoDate` first. */
export function daysBetween(from: string, to: string): number {
  const utc = (day: string): number => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, date);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Non-empty text after trimming and dropping trailing periods, so a phrase never ends "..". */
export function sentenceText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim().replace(/[.\s]+$/u, "") : "";
  if (text.length === 0) throw new DraftInputError(`${field} must not be blank`);
  return text;
}

export function nonBlank(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) throw new DraftInputError(`${field} must not be blank`);
  return text;
}
