// apps/backend/src/modules/05-patient/identifiers/ssn.ts — GAP-010: the ONE definition of what an SSN is
// to M5 (comparison form, structural validity, display tail).
//
// Pure functions, no I/O. The input is PHI: nothing here logs it, and a rejection names the FIELD and a
// CODE only — never the value — so a 422 body or a stack trace cannot become a second copy of the SSN.
import { ValidationError } from "@wardenx/types";

const SSN_DIGITS = 9;
const TAIL_DIGITS = 4;
/** Area numbers the SSA never issues. 900-999 is deliberately NOT here (ITIN-holding patients; design D3). */
const UNISSUED_AREAS: ReadonlySet<string> = new Set(["000", "666"]);

/** The nine-digit comparison form of an SSN ("123-45-6789" and "123456789" agree), or null if it is not nine digits. */
export function normalizeSsn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === SSN_DIGITS ? digits : null;
}

/** True for a nine-digit string that is structurally possible (area not 000/666, group not 00, serial not 0000). */
export function isStructurallyPossibleSsn(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  return (
    !UNISSUED_AREAS.has(digits.slice(0, 3)) &&
    digits.slice(3, 5) !== "00" &&
    digits.slice(5) !== "0000"
  );
}

/**
 * Normalize and validate an SSN supplied by a caller. Returns the nine digits; throws a 422
 * `SSN_INVALID` that does NOT echo the input.
 */
export function requireValidSsn(raw: string, field = "ssn"): string {
  const digits = normalizeSsn(raw);
  if (digits === null || !isStructurallyPossibleSsn(digits)) {
    throw new ValidationError("ssn is not a valid social security number", [
      { field, code: "SSN_INVALID", message: "ssn is not a valid social security number" },
    ]);
  }
  return digits;
}

/** The display tail kept in the clear (`value_last4`) for an identifier value. */
export function lastFour(value: string): string {
  return value.slice(-TAIL_DIGITS);
}
