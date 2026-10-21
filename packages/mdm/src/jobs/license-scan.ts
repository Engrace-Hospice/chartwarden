// @chartwarden/mdm — the pure §4.3 `mdm.license_expiration_scan` planner (GAP-173, spec §4.3 / §4.4 `mdm.license_expiring`).
//
// Same 90 / 30 / 0-day ladder as the BAA scan (the helpers are shared so the two can never disagree on a window
// boundary), over the Phase-1 MANUAL license entries (`mdm_license_record`, D6). Pure: no clock, no I/O. The
// plan carries the spec'd payload shape `{ physicianId, state, daysUntilExpiry }` (§4.4) plus a stable
// `(record, window)` correlation id the M36 AlertEmitter dedups on, so the daily scan raises each window once.
import { type BaaExpirySeverity, type BaaExpiryWindow, daysUntil, windowFor } from "./baa-scan";

/** The minimal `mdm_license_record` projection the scan needs. `expiresOn` is ISO `yyyy-mm-dd`. */
export interface LicenseScanRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly entityKind: string;
  readonly canonicalId: string;
  readonly licenseState: string;
  readonly expiresOn: string;
}

export interface LicenseExpiryAlertPlan {
  readonly organizationId: string;
  readonly licenseRecordId: string;
  readonly entityKind: string;
  readonly canonicalId: string;
  readonly licenseState: string;
  readonly window: BaaExpiryWindow;
  readonly daysUntilExpiry: number;
  readonly expiresOn: string;
  readonly severity: BaaExpirySeverity;
  readonly correlationId: string;
}

const SEVERITY: Readonly<Record<BaaExpiryWindow, BaaExpirySeverity>> = {
  expired: "critical",
  "30_days": "warn",
  "90_days": "info",
};

/** Plan the license alerts due for `records` on `today` — one per record, at its most urgent reached window. */
export function planLicenseExpiryAlerts(
  records: readonly LicenseScanRecord[],
  today: string,
): readonly LicenseExpiryAlertPlan[] {
  const plans: LicenseExpiryAlertPlan[] = [];
  for (const r of records) {
    const daysUntilExpiry = daysUntil(r.expiresOn, today);
    const window = windowFor(daysUntilExpiry);
    if (window === null) continue;
    plans.push({
      organizationId: r.organizationId,
      licenseRecordId: r.id,
      entityKind: r.entityKind,
      canonicalId: r.canonicalId,
      licenseState: r.licenseState,
      window,
      daysUntilExpiry,
      expiresOn: r.expiresOn,
      severity: SEVERITY[window],
      correlationId: `m40-license-expiring:${r.id}:${window}`,
    });
  }
  return plans;
}
