// @chartwarden/supplies — §2 pure-data policy constants (M21-T01 domain layout).
//
// Every timing window, threshold and tenant-tightening bound M21 measures against, declared once here
// rather than re-derived in each service, worker and route. PURE DATA — no IO, no clock reads; every
// helper takes the instant it should reason from.

/**
 * §2.2 — the caregiver-confirmation grace after `delivered`. If nobody confirms within the window the row
 * auto-transitions to `received_confirmed` with `receivedConfirmedActor='system_auto_confirm'`.
 *
 * FAIL DIRECTION: this one fails OPEN — a supply nobody confirmed still reached the patient, and holding
 * the request open forever would bury the real exceptions under stale rows. The distinguishing actor value
 * is what keeps the auto-confirm honest; every read surface must render it differently from a human "yes".
 */
export const RECEIVED_CONFIRM_AUTO_WINDOW_HOURS = 72 as const;

/** §2.10 — a request sitting in `ordered` past this window emits the vendor-confirmation-overdue advisory.
 *  Tenant-tightenable (a tenant may want 12h); never loosenable past the platform ceiling. */
export const VENDOR_CONFIRMATION_WINDOW_HOURS_DEFAULT = 24 as const;
export const VENDOR_CONFIRMATION_WINDOW_HOURS_CEILING = 72 as const;

/** §2.6 — the default return window from `return_required_at`. Tenant may tighten, never loosen. */
export const RETURN_WINDOW_HOURS_DEFAULT = 72 as const;

/** §2.6 — the two escalation boundaries on an unreturned kit, measured from `return_required_at`.
 *  `overdue` is still a retrieval in progress; `unreturnable` is a disposition requiring an attested
 *  reason and, for any controlled line, an assumption-of-loss discrepancy. */
export const RETURN_OVERDUE_DAYS = 30 as const;
export const RETURN_UNRETURNABLE_DAYS_DEFAULT = 90 as const;

/**
 * §2.10 / §3.1.9 — a controlled substance may not be dispatched with an expiration inside this window.
 * The default is 30 days; a tenant may tighten upward but the SQL CHECK pins the floor at 14, so a tenant
 * policy below `..._FLOOR_DAYS` is a configuration error rather than a stricter rule.
 */
export const CONTROLLED_EXPIRATION_MIN_DAYS_DEFAULT = 30 as const;
export const CONTROLLED_EXPIRATION_MIN_DAYS_FLOOR = 14 as const;

/**
 * D8 — the controlled-substance discrepancy threshold. A non-controlled line can be short by any amount
 * without flagging: gloves get used. A CII–CV line short by 5% or more is survey-investigable.
 */
export const CONTROLLED_DISCREPANCY_THRESHOLD_PCT = 0.05 as const;

/** D3 — the default replenishment threshold on a kit medication line (25% remaining). */
export const REPLENISHMENT_THRESHOLD_PCT_DEFAULT = 0.25 as const;

/**
 * D3 — the tenant-tightening bounds on a platform-floor medication's quantity, as multiples of the floor.
 * A tenant may stock between half and double the floor quantity. Below the minimum the kit stops being a
 * comfort kit; above the ceiling the agency is stockpiling a controlled substance in a private residence.
 * The ceiling moves only platform-side, by controlled migration — never per tenant.
 */
export const TEMPLATE_QUANTITY_TENANT_MIN_MULTIPLE = 0.5 as const;
export const TEMPLATE_QUANTITY_TENANT_MAX_MULTIPLE = 2 as const;

/** §2.1 — the per-request content bounds the per-kind TypeBox enforces. */
export const KIT_CONTENT_MIN_ITEMS = 1 as const;
export const KIT_CONTENT_MAX_ITEMS = 16 as const;

/** §2.1 / D13 — the length ceiling on the denylist-scrubbed free-text fields. */
export const FREE_TEXT_MAX_LENGTH = 500 as const;

/** §2.2 — the statuses from which nothing further can happen. `cancellation_pending` is deliberately NOT
 *  here: the vendor has not answered yet, so the row's real state is still the pre-cancellation one. */
export const SUPPLY_REQUEST_TERMINAL_STATUSES = ["completed", "cancelled"] as const;

/** §2.2 — the kit-only branch. A DME bed is picked up through the rental-discontinue path, not a return. */
export const KIT_REQUEST_KINDS = ["comfort_kit_deploy", "comfort_kit_replenish"] as const;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Whole hours elapsed between two instants; negative when `later` precedes `earlier`. */
export function hoursBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_HOUR);
}

/** Whole days elapsed between two instants; negative when `later` precedes `earlier`. */
export function daysBetween(earlier: Date, later: Date): number {
  return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

/** §2.6 — `return_due_at` from the M13 event instant plus the tenant's (possibly tightened) window. */
export function returnDueAt(
  returnRequiredAt: Date,
  windowHours: number = RETURN_WINDOW_HOURS_DEFAULT,
): Date {
  return new Date(returnRequiredAt.getTime() + windowHours * MS_PER_HOUR);
}

/** §2.6 — which escalation, if any, an unreconciled return has reached at `asOf`. */
export function returnEscalationAt(
  returnRequiredAt: Date,
  asOf: Date,
  unreturnableDays: number = RETURN_UNRETURNABLE_DAYS_DEFAULT,
): "none" | "overdue_30d" | "unreturnable_90d" {
  const days = daysBetween(returnRequiredAt, asOf);
  if (days >= unreturnableDays) return "unreturnable_90d";
  if (days >= RETURN_OVERDUE_DAYS) return "overdue_30d";
  return "none";
}

/** §2.2 — has the caregiver-confirmation grace expired for a row that reached `delivered` at this instant? */
export function isReceivedConfirmAutoDue(deliveredAt: Date, asOf: Date): boolean {
  return hoursBetween(deliveredAt, asOf) >= RECEIVED_CONFIRM_AUTO_WINDOW_HOURS;
}

/**
 * §3.1.9 — may a controlled-substance line with this expiration be dispatched today?
 *
 * `minDays` is the tenant's policy. A tenant value BELOW the SQL floor is not honoured as a looser rule —
 * the floor is applied instead, so a mis-configured tenant gets the platform's protection rather than a
 * dispatch the database would then refuse.
 */
export function isControlledExpirationAcceptable(
  expirationDate: Date,
  dispatchDate: Date,
  minDays: number = CONTROLLED_EXPIRATION_MIN_DAYS_DEFAULT,
): boolean {
  const effectiveMinDays = Math.max(minDays, CONTROLLED_EXPIRATION_MIN_DAYS_FLOOR);
  return daysBetween(dispatchDate, expirationDate) >= effectiveMinDays;
}

/** §2.10 — the vendor-confirmation advisory, measured from `ordered_at`. */
export function isVendorConfirmationOverdue(
  orderedAt: Date,
  asOf: Date,
  windowHours: number = VENDOR_CONFIRMATION_WINDOW_HOURS_DEFAULT,
): boolean {
  const effective = Math.min(windowHours, VENDOR_CONFIRMATION_WINDOW_HOURS_CEILING);
  return hoursBetween(orderedAt, asOf) >= effective;
}
