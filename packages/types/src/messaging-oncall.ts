// M36 WP 4.12 (ADR-0080) - the read-only on-call "who is covering now" directory. It answers a question; it never addresses anyone
// (role-based SEND is a separate, undecided change, ADR-0080). Names and roles only: no patient data, no contact details.

/** Tenant flag (ops flag, tenant row wins, absent = off). Off is the uniform 404. */
export const ONCALL_DIRECTORY_FLAG_KEY = "messaging.oncall_directory";

/** The roles the directory may be asked about. Closed on purpose: the role is a query input, so it is never an arbitrary string. */
export const ONCALL_DIRECTORY_ROLES = ["rn", "physician"] as const;
export type OnCallDirectoryRole = (typeof ONCALL_DIRECTORY_ROLES)[number];

/** How many tiers one answer walks (primary, then backups). The router's own ceiling is higher; a directory shows the first few. */
export const ONCALL_DIRECTORY_MAX_TIERS = 4;

/**
 *  - covered              tier 1 has someone covering now.
 *  - coverage_gap         the ladder has tier 1 and nobody covers it now (never silent: the screen says so).
 *  - roster_not_connected no M19 router is bound (the deny-stub answered): coverage is UNKNOWN, not empty.
 *  - not_configured       M19 has no ladder for this role in this organisation.
 */
export const ONCALL_DIRECTORY_STATUSES = [
  "covered",
  "coverage_gap",
  "roster_not_connected",
  "not_configured",
] as const;
export type OnCallDirectoryStatus = (typeof ONCALL_DIRECTORY_STATUSES)[number];

export type OnCallTierState = "covering" | "coverage_gap";

export interface OnCallTierDto {
  readonly tier: number;
  readonly state: OnCallTierState;
  /** Display names of who covers this tier now (empty on a gap). A user the name lookup cannot find is `null`, never an id. */
  readonly people: readonly (string | null)[];
  /** Strict ISO instant when the covering shift ends, only when the roster supplied one; otherwise null (never guessed). */
  readonly shift_ends_at: string | null;
  /** IANA zone the roster evaluated this tier in. Render times in THIS zone, never the viewer's or the server's. */
  readonly time_zone: string;
}

export interface OnCallCoverageDto {
  readonly role: OnCallDirectoryRole;
  readonly as_of: string;
  readonly status: OnCallDirectoryStatus;
  readonly tiers: readonly OnCallTierDto[];
}
