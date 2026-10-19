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

// ---------------------------------------------------------------------------------------------------------------------------------
// Role-based send ("message the on-call RN"), ADR-0081 (PROPOSED). The sender names a ROLE for a patient's care-team conversation; the
// server resolves who covers tier 1 NOW through the same guarded EscalationRouter seam, the sender CONFIRMS that person, and the send is
// an ordinary urgent message to that one person with the role stored on the response request. There is no silent fallback: a gap or an
// unconnected roster is an explicit refusal that points at the agency telephone procedure, and a resolution that changed between the
// preview and the send is a 409 that makes the sender confirm again.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Tenant flag (ops flag, tenant row wins, absent = off). Off is the uniform 404. Independent of `messaging.oncall_directory`. */
export const ROLE_SEND_FLAG_KEY = "messaging.role_send";

/** May address a ROLE (a different, wider act than naming a person: it changes who is paged). Needed WITH `messaging.urgent.send`. */
export const ROLE_SEND_PERMISSION = "messaging.oncall.send";

/** The wording shown for every refusal that is not a covered role: never a guessed person (hazard H-02). */
export const ROLE_SEND_TELEPHONE_PROCEDURE =
  "Nobody is confirmed on call for this role right now. Use the agency telephone procedure; no message was sent.";

/** The `code` of the typed errors (409 for a changed resolution, 422 for no coverage, 503 when role send cannot track a response). */
export const ROLE_SEND_ERROR_CODES = {
  noCoverage: "ROLE_SEND_NO_COVERAGE",
  resolutionChanged: "ROLE_SEND_RESOLUTION_CHANGED",
  unavailable: "ROLE_SEND_UNAVAILABLE",
} as const;

export interface RoleSendPersonDto {
  /** The user a confirmed send will go to. Disclosed only to a caller who may address the role for this visible patient. */
  readonly user_id: string;
  /** Null when the name cannot be found (never an id in its place). */
  readonly display_name: string | null;
}

/** What the sender confirms: tier 1 only. `people` is non-empty only when `status` is `covered`. */
export interface RoleSendResolutionDto {
  readonly role: OnCallDirectoryRole;
  readonly as_of: string;
  readonly status: OnCallDirectoryStatus;
  readonly people: readonly RoleSendPersonDto[];
  readonly shift_ends_at: string | null;
  readonly time_zone: string | null;
}

export interface RoleSendResponse {
  readonly message_id: string;
  readonly channel_id: string;
  readonly patient_id: string;
  readonly recipient_user_id: string;
  readonly role: OnCallDirectoryRole;
  readonly created: boolean;
}
