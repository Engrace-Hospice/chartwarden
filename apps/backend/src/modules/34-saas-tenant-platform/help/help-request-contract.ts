import type {
  GrantRevocationSource,
  SupportSessionCloseReason,
  SupportSessionState,
} from "@chartwarden/saas-tenant-platform";
// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-contract.ts — the help-request service CONTRACT (types only).
//
// Frozen by the slice 7 wave-0 contract builder. The routes (`routes/tenant/help-requests.ts`, `routes/platform/help-requests.ts`)
// call this interface and nothing else; piece 7B implements it in this directory (`help/`) over the `tenant_help_request` table and
// binds it in `mountTenantPlatformRoutes(..., { help: { service } })` (`help-request-service.ts`; wired in the composition root).
//
// The response views are what the generated client types (`routes/help-request-typebox.ts` pins its schemas to them). Rules every
// implementation owes, because the routes cannot judge them (RLS cannot tell an operator from a member):
//   * tenant methods: the actor is an ACTIVE member of THIS organization on a `staff` session, is not an `ai_*` principal and is
//     not ChartWarden staff (`isPlatformStaffMember`: operators are active members of every tenant, so "is a member" alone would
//     admit them);
//   * `approve` and `close` are role-checked here: `org_admin` or `compliance_officer`; `close` also by the member who filed it;
//   * no view ever names an operator to the tenant: the label is `PLATFORM_OPERATOR_LABEL` ("ChartWarden operations");
//   * nothing here, nor any log line, error or outbox payload, carries the member's message.
import type { WriteActor } from "@chartwarden/shared/route-kit";
import type { CursorPage } from "../routes/keyset-page";

/** `tenant_help_request.status`. */
export type HelpRequestStatus = "open" | "approved" | "resolved" | "cancelled";

/**
 * What the screens switch on, derived from the status, the grant and the sessions: `waiting_for_consent` (open), `ready_to_start`
 * (approved, no open session), `in_session` (approved, a session is open), `ended` (resolved or cancelled).
 */
export type HelpRequestPhase = "waiting_for_consent" | "ready_to_start" | "in_session" | "ended";

/** The consent grant behind an approved request. */
export type HelpGrantStatus = "active" | "expired" | "revoked";

/** Who ended the request, as the tenant is told: relative to the viewer, never an id. */
export type HelpRequestClosedBy = "you" | "your organization" | "ChartWarden operations" | "system";

export interface HelpGrantView {
  readonly expiresAt: string;
  readonly status: HelpGrantStatus;
}

/** The session of the request's grant (`SessionSummaryForGrantFn`), ISO strings; null on the request while there is none. */
export interface HelpSessionSummaryView {
  readonly state: SupportSessionState;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly closedAt: string | null;
  readonly closeReason: SupportSessionCloseReason | null;
  readonly actionCount: number;
  readonly lastActionAt: string | null;
}

/** The request as the TENANT sees it. */
export interface HelpRequestView {
  readonly id: string;
  readonly stepKey: string | null;
  readonly message: string;
  readonly status: HelpRequestStatus;
  readonly phase: HelpRequestPhase;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly grant: HelpGrantView | null;
  readonly session: HelpSessionSummaryView | null;
  readonly closedAt: string | null;
  readonly closedBy: HelpRequestClosedBy | null;
  /** The operator's tenant-visible note on a Resolve. */
  readonly closeNote: string | null;
}

/** `GET /api/v1/tenant/help-requests`: the live request (open or approved) and the ended ones, newest first. */
export interface TenantHelpRequestListView {
  /** The tenant account's one live request, or null. It is NOT repeated in `items`. */
  readonly current: HelpRequestView | null;
  /** The ended (resolved or cancelled) requests, paged. */
  readonly items: readonly HelpRequestView[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** The platform row's session summary also carries the session id (the ledger link). */
export interface PlatformHelpSessionView extends HelpSessionSummaryView {
  readonly sessionId: string;
}

/** The request as an OPERATOR sees it (the inbox row). */
export interface PlatformHelpRequestView {
  readonly id: string;
  readonly tenantAccountId: string;
  /** The "Open step" link target: `/tenants/:orgSlug/onboarding/:stepKey`. */
  readonly orgSlug: string;
  readonly legalBusinessName: string;
  readonly stepKey: string | null;
  readonly message: string;
  readonly status: HelpRequestStatus;
  readonly phase: HelpRequestPhase;
  readonly requestedAt: string;
  readonly requestedByMembershipId: string;
  readonly approvedAt: string | null;
  /** What Start posts as `supportConsentGrantId`; null until approved. */
  readonly supportConsentGrantId: string | null;
  readonly grant: HelpGrantView | null;
  readonly session: PlatformHelpSessionView | null;
  readonly closedAt: string | null;
  readonly closedByActorKind: GrantRevocationSource | null;
  readonly closeNote: string | null;
}

export interface FileHelpRequestInput {
  /** The wizard step the question is about; null/absent for a general one. */
  readonly stepKey?: string;
  /** Raw (8 to 1000 characters as sent): the service trims, bounds and PHI-screens it (422 `EVIDENCE_LOOKS_LIKE_PHI`). */
  readonly message: string;
}

export interface ApproveHelpRequestInput {
  /** Whole hours 1 to 24; absent means the default of 8. */
  readonly hours?: number;
}

export interface ResolveHelpRequestInput {
  /** The tenant-visible note: 8 to 500 characters as sent; trimmed and PHI-screened by the service. */
  readonly note: string;
}

export interface PlatformHelpRequestFilter {
  readonly statuses: readonly HelpRequestStatus[];
  readonly tenantAccountId?: string;
}

/** `actor` is always the route's `writeActorOf(request)`: the organization, user and membership come from the session, never the body. */
export interface HelpRequestService {
  /** The tenant's own requests. Un-audited and pollable (every 60 s and on focus). */
  listForTenant(
    actor: WriteActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<TenantHelpRequestListView>;
  /** File one request: 409 `HELP_REQUEST_ALREADY_OPEN` while the tenant account has a live one (details carry its id). */
  file(actor: WriteActor, input: FileHelpRequestInput): Promise<HelpRequestView>;
  /** Approve = consent: creates the `assist` grant (`issueAssistGrant`) and links it; open -> approved. */
  approve(
    actor: WriteActor,
    helpRequestId: string,
    input: ApproveHelpRequestInput,
  ): Promise<HelpRequestView>;
  /** End help from the tenant: open -> cancelled, approved -> resolved (revokes the grant, closes open sessions). */
  close(actor: WriteActor, helpRequestId: string): Promise<HelpRequestView>;
  /** The operators' inbox across tenants (audited platform read). */
  listForPlatform(
    actor: WriteActor,
    filter: PlatformHelpRequestFilter,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<PlatformHelpRequestView>>;
  /** The operator ends help: closes sessions `manual`, revokes the grant, records the tenant-visible note. */
  resolve(
    actor: WriteActor,
    helpRequestId: string,
    input: ResolveHelpRequestInput,
  ): Promise<PlatformHelpRequestView>;
}
