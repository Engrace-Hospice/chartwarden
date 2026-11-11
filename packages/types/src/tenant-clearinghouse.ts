// @chartwarden/types — the tenant's clearinghouse choice (M23, ADR-0053 amendment 2026-11-06).
//
// Each tenant chooses how its claims leave ChartWarden: `stedi` or `claimmd` (ChartWarden transmits, with the tenant's own
// vendor credential) or `outside` (the tenant bills outside ChartWarden). The choice is a fact other modules read through
// the `TenantClearinghouseReader` seam (owner M23): the claims-billing gate (bootstrap) decides new-work entitlement from
// it, and M35's pricing reads it to apply "outside => no billing percentage". Leaf types only: no secret, no config blob.

/** The vendors a tenant may choose. `outside` = the tenant bills outside ChartWarden (nothing is transmitted for it). */
export const TENANT_CLEARINGHOUSE_VENDORS = ["stedi", "claimmd", "outside"] as const;
export type TenantClearinghouseVendor = (typeof TENANT_CLEARINGHOUSE_VENDORS)[number];

/** The vendors ChartWarden transmits through for a tenant (everything but `outside`). */
export const TRANSMITTING_CLEARINGHOUSE_VENDORS = ["stedi", "claimmd"] as const;
export type TransmittingClearinghouseVendor = (typeof TRANSMITTING_CLEARINGHOUSE_VENDORS)[number];

/**
 * Where a config is in its life: `draft` (saved, nothing is sent), `verified` (the vendor connection was tested, or the
 * operator attested it with evidence), `active` (in use: claims and eligibility work is allowed). `outside` is always `active`.
 */
export const TENANT_CLEARINGHOUSE_STATUSES = ["draft", "verified", "active"] as const;
export type TenantClearinghouseStatus = (typeof TENANT_CLEARINGHOUSE_STATUSES)[number];

/** `test` reaches only the vendor's test mode; `production` reaches real payers. Null for `outside`. */
export type TenantClearinghouseMode = "test" | "production";

/**
 * What the organization has chosen. `source`: `tenant` = its own config row; `platform_env` = no row, but an operator named
 * the organization in `CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS` so the platform's own vendor binding serves it (the demo
 * tenant); `none` = nothing chosen (vendor, status and mode are null).
 */
export interface TenantClearinghouseChoice {
  /** `direct_mac` / `in_memory` appear only with `source: "platform_env"` (the platform's own binding serves the org). */
  readonly vendor: TenantClearinghouseVendor | "direct_mac" | "in_memory" | null;
  readonly status: TenantClearinghouseStatus | null;
  readonly mode: TenantClearinghouseMode | null;
  readonly source: "tenant" | "platform_env" | "none";
  /**
   * True when a platform operator revoked the vendor BAA this configuration rests on (a revoked config is never active): the
   * claims-billing gate then says so (`clearinghouse_baa_revoked`) instead of "not active yet". Absent = false.
   */
  readonly baaRevoked?: boolean;
}

/** The "nothing chosen" answer. */
export const NO_CLEARINGHOUSE_CHOICE: TenantClearinghouseChoice = Object.freeze({
  vendor: null,
  status: null,
  mode: null,
  source: "none",
});

/** True when ChartWarden transmits this organization's claims: a vendor other than `outside`, in `active` status. */
export function transmitsThroughChartWarden(choice: TenantClearinghouseChoice): boolean {
  return choice.status === "active" && choice.vendor !== null && choice.vendor !== "outside";
}

/**
 * The seam (owner M23): what an organization chose. Read on the tenant pool under the organization's own RLS scope;
 * no cache (the claims-billing gate memoises per request). Throws when the read fails; a new-work caller fails CLOSED.
 * Slice 2 (pricing) reads it to apply "`outside` => no billing percentage".
 */
export interface TenantClearinghouseReader {
  choiceForOrg(organizationId: string): Promise<TenantClearinghouseChoice>;
}

/**
 * How long after an organization's latest production submission a platform operator may not release its earlier clearinghouse
 * credentials (migration 1435): late acknowledgments and remittances for those claims may still arrive on the vendor account. The
 * server refuses with 409 CLEARINGHOUSE_RESPONSES_PENDING; the console says the same number.
 */
export const CLEARINGHOUSE_RELEASE_QUIET_DAYS = 90;

/**
 * The held-work alerts of an organization whose clearinghouse is not live: M23's per-queue hold and M41's shared crons. Each is
 * raised at most once per window (below) per its own key; M36's dedupe key for them (`cronAlertCorrelationId`) carries the window,
 * severity and queue, so a repeat inside a window is absorbed and a re-alert after it is not. Literals here because M23, M41 and M36
 * cannot import each other.
 */
export const CLEARINGHOUSE_HOLD_ALERT_CODES = {
  m23: "m23.clearinghouse.unbound_hold",
  m41: "m41.clearinghouse.unbound_with_work",
} as const;

/** One held-work alert per key per window: the work is re-tried every few minutes and must not page every time. */
export const CLEARINGHOUSE_HOLD_ALERT_WINDOW_MS = 6 * 60 * 60_000;
