// @chartwarden/shared/route-kit — the TypeBox string formats every route schema uses, defined once.
//
// TypeBox's `FormatRegistry` is process-global and treats an unregistered format as a hard failure. The
// definitions are registered when this module loads (so a schema built from the kit validates in any test)
// and again by `buildServer` after every module has been imported, so these strict definitions are the
// ones in force at runtime whatever a module registered on import.
import { FormatRegistry, type TString, Type } from "@sinclair/typebox";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** The first date Postgres stores: it has no year 0000 (22008), though JavaScript parses one. */
const MIN_STORABLE_DATE = "0001-01-01";

const MIN_STORABLE_INSTANT_MS = Date.parse(`${MIN_STORABLE_DATE}T00:00:00Z`);

/** A real calendar date `YYYY-MM-DD` Postgres can store (2025-02-30 and year 0000 are refused). */
function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value) || value < MIN_STORABLE_DATE) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const MAX_STORABLE_INSTANT_MS = Date.parse("9999-12-31T23:59:59.999Z");

const ISO_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})(?:[Tt ]|$)/;

/** An ISO date-time with no `Z` or offset: date, separator, `HH:MM`, optional seconds and fraction. */
const OFFSETLESS_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * `Date.parse` reads an offset-less date-time as LOCAL time, so the 0001..9999 bounds would move with the process
 * time zone. The storable range is defined in UTC, so an offset-less value is parsed as UTC (the separator is
 * normalised to `T` too: V8's legacy parser reads "0001-01-01 00:00:00" as year 2001). Any other shape parses as before.
 */
function parseInstant(value: string): number {
  const offsetless = OFFSETLESS_DATE_TIME_RE.exec(value);
  return Date.parse(offsetless ? `${offsetless[1]}T${offsetless[2]}Z` : value);
}

/**
 * A parseable instant Postgres can store. The text must start with an ISO calendar date (Date.parse also reads
 * "12/31/0000" and rolls 2026-02-30 over to March 2), the date part must be a real day at or after 0001-01-01 (the raw
 * string reaches the driver), and the instant must lie in 0001-01-01Z..9999-12-31Z (a route that does `new Date(value)`
 * serialises anything outside as year 0000 or a six-digit year).
 */
function isStorableDateTime(value: string): boolean {
  const datePart = ISO_DATE_PREFIX_RE.exec(value)?.[1];
  if (datePart === undefined || !isCalendarDate(datePart)) return false;
  const instant = parseInstant(value);
  return (
    !Number.isNaN(instant) &&
    instant >= MIN_STORABLE_INSTANT_MS &&
    instant <= MAX_STORABLE_INSTANT_MS
  );
}

/** An absolute URI with a scheme (WHATWG URL parse). */
function isUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export const ROUTE_FORMATS: Readonly<Record<string, (value: string) => boolean>> = {
  uuid: (v) => UUID_RE.test(v),
  date: isCalendarDate,
  "date-time": isStorableDateTime,
  email: (v) => EMAIL_RE.test(v),
  uri: isUri,
};

/** Register (or re-assert) every route format. Idempotent. */
export function registerRouteFormats(): void {
  for (const [name, check] of Object.entries(ROUTE_FORMATS)) FormatRegistry.Set(name, check);
}

registerRouteFormats();

/** A uuid string schema. */
export const Uuid = (): TString => Type.String({ format: "uuid" });
