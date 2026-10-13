// @wardenx/portal — presentation-format helpers shared across the §5.1 portal screens.
// PURE (no React, no DOM): imported by both the screen components and the registry unit test, so it
// must stay renderer-free.
import type { StatusTone } from "@wardenx/ui";

/** snake_case / kebab enum → human words. Portal is lay-language (M38); enums never reach the caregiver raw. */
export function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** ISO instant → a plain date. A visit/medication's operative dates are dates; the wall-clock time is noise. */
export function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

/** ISO instant → a short local date+time for upcoming visits ("2026-08-04 14:30"). */
export function stamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

/** Format an ISO instant in browser-local time unless an authoritative timezone is supplied. */
export function formatPortalInstant(
  iso: string | null | undefined,
  options: { locale?: string; timeZone?: string } = {},
): string | null {
  if (!iso || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(options.locale ?? "en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: options.timeZone,
    }).format(instant);
  } catch {
    return null;
  }
}

export function formatPortalVisitDate(
  iso: string | null | undefined,
  options: { locale?: string; timeZone?: string } = {},
): string | null {
  if (!iso || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(options.locale ?? "en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: options.timeZone,
    }).format(instant);
  } catch {
    return null;
  }
}

export function formatPortalVisitTime(
  iso: string | null | undefined,
  options: { locale?: string; timeZone?: string } = {},
): string | null {
  if (!iso || /^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(options.locale ?? "en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: options.timeZone,
    }).format(instant);
  } catch {
    return null;
  }
}

/**
 * Map a lifecycle/status token → a Lantern StatusPill tone. The portal never shows a raw enum, so an
 * unknown token falls back to neutral rather than leaking the wire value with alarming styling.
 */
export function statusTone(status: string): StatusTone {
  const s = status.toLowerCase();
  if (/(active|completed|connected|delivered|approved|signed|accepted)/.test(s)) return "success";
  if (/(pending|scheduled|submitted|in_progress|waiting|requested)/.test(s)) return "progress";
  if (/(due|soon|expiring|attention)/.test(s)) return "warning";
  if (/(failed|denied|rejected|revoked|expired|cancelled|canceled)/.test(s)) return "error";
  return "neutral";
}

/**
 * A caregiver-facing message for a failed portal read. We never surface HTTP internals or PHI-verbose
 * error bodies (architecture §G): a 403/404 both read as "not available to you", the rest as a soft retry.
 */
export function readError(status: number | undefined): string {
  if (status === 401) return "Your session has ended. Please sign in again.";
  if (status === 403 || status === 404) return "This information is not available on your account.";
  return "We could not load this right now. Please try again in a moment.";
}
