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

/**
 * A parseable instant Postgres can store. Refused: a literal year before 0001 (the raw string reaches the driver)
 * and an instant before 0001-01-01Z (a route that does `new Date(value)` serialises it as year 0000 or earlier).
 */
function isStorableDateTime(value: string): boolean {
  const instant = Date.parse(value);
  return (
    !Number.isNaN(instant) &&
    instant >= MIN_STORABLE_INSTANT_MS &&
    value.slice(0, MIN_STORABLE_DATE.length) >= MIN_STORABLE_DATE
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
