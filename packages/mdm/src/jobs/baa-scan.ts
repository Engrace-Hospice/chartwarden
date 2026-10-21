// @chartwarden/mdm — the pure §4.3 `mdm.baa_expiration_scan` planner (GAP-173, spec §4.3 / §7.7).
//
// Decides, for a tenant's BAA rows and a calendar date, which 90 / 30 / 0-day expiration alerts are due. Pure:
// no clock, no I/O — the worker reads the rows and injects `today`. Idempotency is the CALLER's: every plan
// carries a stable `correlationId` per (record, window), and the M36 AlertEmitter dedups on `(org,
// correlationId)`, so the daily scan re-planning the same window every day raises it exactly once.
//
// Only `executed` BAAs with an `expires_on` are scannable: a `pending`/`n_a` row has no expiry to warn about
// and an already-`expired` status is the gate's job (the §7.7 disclosure denial), not an alert.

/** The §4.3 alert windows, most urgent first. */
export type BaaExpiryWindow = "expired" | "30_days" | "90_days";

export type BaaExpirySeverity = "info" | "warn" | "critical";

/** The minimal `mdm_baa_record` projection the scan needs. `expiresOn` is ISO `yyyy-mm-dd`. */
export interface BaaScanRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly entityKind: string;
  readonly canonicalId: string;
  readonly baaStatus: "executed" | "pending" | "n_a";
  readonly expiresOn: string | null;
}

export interface BaaExpiryAlertPlan {
  readonly organizationId: string;
  readonly baaRecordId: string;
  readonly entityKind: string;
  readonly canonicalId: string;
  readonly window: BaaExpiryWindow;
  readonly daysRemaining: number;
  readonly expiresOn: string;
  readonly severity: BaaExpirySeverity;
  /** Stable per (record, window) — the dedupe key the alert emitter keys on. */
  readonly correlationId: string;
}

const MS_PER_DAY = 86_400_000;

/** The widest window the scan looks ahead — callers use it to bound their SELECT. */
export const BAA_SCAN_LOOKAHEAD_DAYS = 90;

const SEVERITY: Readonly<Record<BaaExpiryWindow, BaaExpirySeverity>> = {
  expired: "critical",
  "30_days": "warn",
  "90_days": "info",
};

/** Whole days from `today` to `expiresOn` (negative once past). Both are UTC calendar dates. */
export function daysUntil(expiresOn: string, today: string): number {
  const to = Date.parse(`${expiresOn}T00:00:00Z`);
  const from = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(to) || Number.isNaN(from)) {
    throw new Error(`MDM_BAA_SCAN_BAD_DATE: expiresOn=${expiresOn} today=${today}`);
  }
  return Math.round((to - from) / MS_PER_DAY);
}

/** The most urgent window a record has reached, or `null` when it is still more than 90 days out. */
export function windowFor(daysRemaining: number): BaaExpiryWindow | null {
  if (daysRemaining <= 0) return "expired";
  if (daysRemaining <= 30) return "30_days";
  if (daysRemaining <= BAA_SCAN_LOOKAHEAD_DAYS) return "90_days";
  return null;
}

/** Plan the alerts due for `records` on `today` — one per record, at its most urgent reached window. */
export function planBaaExpiryAlerts(
  records: readonly BaaScanRecord[],
  today: string,
): readonly BaaExpiryAlertPlan[] {
  const plans: BaaExpiryAlertPlan[] = [];
  for (const r of records) {
    if (r.baaStatus !== "executed" || r.expiresOn === null) continue;
    const daysRemaining = daysUntil(r.expiresOn, today);
    const window = windowFor(daysRemaining);
    if (window === null) continue;
    plans.push({
      organizationId: r.organizationId,
      baaRecordId: r.id,
      entityKind: r.entityKind,
      canonicalId: r.canonicalId,
      window,
      daysRemaining,
      expiresOn: r.expiresOn,
      severity: SEVERITY[window],
      correlationId: `m40-baa-expiring:${r.id}:${window}`,
    });
  }
  return plans;
}
