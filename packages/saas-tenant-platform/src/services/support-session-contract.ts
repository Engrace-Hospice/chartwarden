// @chartwarden/saas-tenant-platform · services — the support-session CONTRACT slice 7 builds against (types only).
//
// Frozen by the wave-0 contract builder so two pieces can be built in parallel without reading each other's code:
//   * 7S (support-session repair) IMPLEMENTS these in this package (`support-session-service.ts` and its repository) and
//     binds them in the backend composition root;
//   * 7B (help requests, `apps/backend/.../34-saas-tenant-platform/help/`) CALLS them through the
//     {@link SupportGrantOperations} bundle it is handed, so its unit tests inject fakes and never import 7S's bodies.
// It lives HERE, not in the backend module, because the backend imports this package and never the other way round (M34's
// `codePaths` hold both, the package depends only on `@chartwarden/db`): a contract in `apps/backend/.../help/` could not be
// implemented by 7S without a package -> app import, which `architecture/.dependency-cruiser.cjs` forbids.
//
// No bodies, no values: a type here that gains a body belongs to its owner piece. Dates are `Date` (the package's own
// services return `Date`; the backend views convert to ISO strings).
import type { DbClient } from "@chartwarden/db";
import type {
  SupportSessionCloseReason,
  SupportSessionServiceDeps,
} from "./support-session-service";

/**
 * The only grant scope an onboarding help request creates: `assist`, NON-PHI by construction. A session on it can never be
 * elevated (`SUPPORT_SESSION_NON_PHI` 403) and it is issued by the org_admin OR the compliance officer
 * (`SUPPORT_GRANT_SCOPE_NOT_ALLOWED` 403 for any other actor). The existing scopes keep the existing service rule.
 */
export type AssistGrantScope = "assist";

/** Who ended a grant. The values are `tenant_help_request.closed_by_actor_kind` (CHECK `tenant|platform_ops|system`). */
export type GrantRevocationSource = "tenant" | "platform_ops" | "system";

// ── issueAssistGrant ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface IssueAssistGrantInput {
  /** The tenant's organization (`support_consent_grant.organization_id`). */
  readonly organizationId: string;
  readonly tenantAccountId: string;
  /** The approving member (becomes `grantor_membership_id`). */
  readonly grantorMembershipId: string;
  /** The role keys the grantor holds in this organization; the service refuses unless `org_admin` or `compliance_officer` is among them. */
  readonly grantorRoles: readonly string[];
  /** Whole hours, 1 to 24; the service clamps (a grant never outlives the 72 h table CHECK). */
  readonly hours: number;
  /** `grant_reason`, e.g. `help request <id>`: ids only, never the member's message. */
  readonly reason: string;
}

export interface IssueAssistGrantResult {
  readonly grantId: string;
  readonly expiresAt: Date;
}

/**
 * Create the `assist` consent grant, emit `m34.support_consent_grant.issued` and alert the operators, all inside the caller's
 * transaction (`deps` is bound to it). 403 `SUPPORT_GRANT_SCOPE_NOT_ALLOWED` for a grantor holding neither role.
 */
export type IssueAssistGrantFn = (
  deps: SupportSessionServiceDeps,
  input: IssueAssistGrantInput,
) => Promise<IssueAssistGrantResult>;

// ── revokeGrantAndCloseSessions ──────────────────────────────────────────────────────────────────────────────────────

export interface RevokeGrantAndCloseSessionsInput {
  readonly grantId: string;
  readonly organizationId: string;
  /** The revoking membership: a tenant member's, or the platform operator's on a Resolve; null for the system (expiry sweep). */
  readonly revokedByMembershipId: string | null;
  /** `revocation_reason`: ids and codes only. */
  readonly reason: string;
  readonly source: GrantRevocationSource;
}

export interface RevokeGrantAndCloseSessionsResult {
  /** Every session the revoke closed (`close_reason = grant_revoked`), in close order. Empty when none was open. */
  readonly closedSessionIds: readonly string[];
}

/**
 * The port through which the revoke cascade ends the help request linked to the grant (`tenant_help_request.
 * support_consent_grant_id`). 7B implements it over its own table, in the SAME transaction as the revoke, so 7S never touches
 * that table. A grant with no request, or a request already ended, is a no-op returning null.
 */
export interface LinkedHelpRequestPort {
  resolveForRevokedGrant(input: {
    readonly grantId: string;
    readonly organizationId: string;
    readonly source: GrantRevocationSource;
    readonly closedByUserId: string | null;
    /** The operator's tenant-visible note on a Resolve; null otherwise. */
    readonly note: string | null;
  }): Promise<{ readonly helpRequestId: string } | null>;
}

export type RevokeGrantDeps = SupportSessionServiceDeps & {
  /** Absent where no help request exists (the generic grant routes before 7B is wired): the cascade then closes sessions only. */
  readonly linkedHelpRequests?: LinkedHelpRequestPort;
};

/**
 * Revoke the grant (idempotent: a grant already revoked answers the sessions it closed before), close every open session on
 * it with a `session.close` ledger row + outbox `m34.support_session.expired` (closeReason `grant_revoked`) + the grantor alert,
 * emit `m34.support_consent_grant.revoked`, and resolve the linked help request. A LATER start on the grant is
 * `SUPPORT_GRANT_INACTIVE` 409.
 */
export type RevokeGrantAndCloseSessionsFn = (
  deps: RevokeGrantDeps,
  input: RevokeGrantAndCloseSessionsInput,
) => Promise<RevokeGrantAndCloseSessionsResult>;

// ── sessionSummaryForGrant ───────────────────────────────────────────────────────────────────────────────────────────

/** `open` until closed or past its expiry, `expired` once past it but not yet swept, `closed` once closed (see `closeReason`). */
export type SupportSessionState = "open" | "expired" | "closed";

/**
 * The one session of a grant the help screens summarise: the OPEN one if there is one, else the most recently started. Never the
 * operator's id or name (the tenant is shown "ChartWarden operations"; the platform view adds `sessionId` itself).
 */
export interface GrantSessionSummary {
  readonly sessionId: string;
  readonly state: SupportSessionState;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly closedAt: Date | null;
  readonly closeReason: SupportSessionCloseReason | null;
  /** The `ops.write` ledger rows of that session (a start / close / elevate row is not an action). */
  readonly actionCount: number;
  /** The newest `ops.write` row's time, null when there is none. */
  readonly lastActionAt: Date | null;
}

/** Read the summary inside the caller's transaction (RLS scopes it on the tenant lane); null when the grant has no session yet. */
export type SessionSummaryForGrantFn = (
  tx: DbClient,
  grantId: string,
) => Promise<GrantSessionSummary | null>;

// ── the bundle 7B is handed ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * What 7S binds once at boot and hands to 7B: the three operations plus `depsFor`, which builds the per-transaction
 * {@link SupportSessionServiceDeps} (tx-bound repository + the audit / outbox / alert ports bound to that transaction + the
 * clock) the first two take. 7B never builds a repository or a port itself.
 */
export interface SupportGrantOperations {
  readonly depsFor: (tx: DbClient) => SupportSessionServiceDeps;
  readonly issueAssistGrant: IssueAssistGrantFn;
  readonly revokeGrantAndCloseSessions: RevokeGrantAndCloseSessionsFn;
  readonly sessionSummaryForGrant: SessionSummaryForGrantFn;
}
