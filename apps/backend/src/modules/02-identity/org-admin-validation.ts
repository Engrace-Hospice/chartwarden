// apps/backend/src/modules/02-identity/org-admin-validation.ts — the pure input rules for the org-admin routes
// (GAP-115): organization names, provider-entity regulatory identifiers (CCN, NPI with its Luhn check digit,
// tax id, fiscal year end), service-location fields. No I/O, so the routes and their tests share one definition.
import { ValidationError } from "@chartwarden/types";

const fail = (field: string, message: string): never => {
  throw new ValidationError(message, [{ field, code: "INVALID", message }]);
};

/** CMS Certification Number: six characters, digits or capital letters. */
export const CCN_PATTERN = /^[0-9A-Z]{6}$/;
export const isValidCcn = (v: string): boolean => CCN_PATTERN.test(v);

/**
 * NPI check digit (CMS NPI standard): Luhn over the 9 leading digits prefixed with the ISO issuer
 * identifier `80840`. A mistyped NPI is caught here rather than at claim submission.
 */
export function isValidNpi(npi: string): boolean {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi}`.split("").map(Number);
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i -= 1, double = !double) {
    let d = digits[i] as number;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** US Employer Identification Number, with or without the dash. Normalized to digits only. */
export function normalizeTaxId(raw: string): string | null {
  const t = raw.trim();
  return /^\d{2}-?\d{7}$/.test(t) ? t.replace("-", "") : null;
}

/** `MMDD`, a real calendar day (a fiscal year end of 0229 is accepted: it is a valid month/day). */
export function isValidFiscalYearEnd(v: string): boolean {
  if (!/^\d{4}$/.test(v)) return false;
  const month = Number(v.slice(0, 2));
  const day = Number(v.slice(2));
  if (month < 1 || month > 12) return false;
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day >= 1 && day <= maxDay;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const US_STATE = /^[A-Z]{2}$/;
const US_POSTAL = /^\d{5}(-\d{4})?$/;

export function requireCcn(v: string): string {
  return isValidCcn(v) ? v : fail("ccn", "A CCN is 6 characters: digits or capital letters.");
}
export function requireNpi(v: string): string {
  return isValidNpi(v)
    ? v
    : fail("npi", "That NPI is not valid (10 digits with a correct check digit).");
}
export function requireFiscalYearEnd(v: string): string {
  return isValidFiscalYearEnd(v)
    ? v
    : fail("fiscalYearEnd", "fiscalYearEnd must be MMDD, a real month and day.");
}
export function requireState(v: string): string {
  return US_STATE.test(v) ? v : fail("state", "state must be a 2-letter US state code.");
}
export function requirePostalCode(v: string): string {
  return US_POSTAL.test(v) ? v : fail("postalCode", "postalCode must be 12345 or 12345-6789.");
}
export function requireTimezone(v: string): string {
  return isValidTimezone(v)
    ? v
    : fail("timezone", "timezone must be an IANA zone, e.g. America/Los_Angeles.");
}

/** Lifecycle edges a tenant administrator may take on a provider entity / location. `closed` is terminal. */
const ALLOWED_STATUS_EDGES: Record<string, readonly string[]> = {
  created: ["active", "closed"],
  active: ["suspended", "closed"],
  suspended: ["active", "closed"],
  closed: [],
};

export function assertStatusTransition(from: string, to: string): void {
  if (from === to) return;
  if (!(ALLOWED_STATUS_EDGES[from] ?? []).includes(to))
    fail("status", `a ${from} record cannot become ${to}.`);
}

/** `organization.slug`: lower-case letters, digits and hyphens, 3-40 characters. */
export function requireSlug(v: string): string {
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(v)
    ? v
    : fail("slug", "slug must be 3-40 lower-case letters, digits or hyphens.");
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s.length >= 3 ? s : `${s}-org`.replace(/^-/, "");
}
