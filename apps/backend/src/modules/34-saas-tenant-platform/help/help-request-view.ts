import { schema } from "@chartwarden/db";
// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-view.ts — what each side is shown of a request (pure).
//
// The view is derived from the row, its grant and the grant's session summary, as of `now`; nothing here reads a database or names
// an operator. The tenant sees "ChartWarden operations" (`PLATFORM_OPERATOR_LABEL`), never an id; the operator sees the closer's kind.
import type { GrantSessionSummary } from "@chartwarden/saas-tenant-platform";
import type {
  HelpGrantStatus,
  HelpGrantView,
  HelpRequestClosedBy,
  HelpRequestPhase,
  HelpRequestView,
  HelpSessionSummaryView,
  PlatformHelpRequestView,
} from "./help-request-contract";
import type { HelpGrantRow, HelpRequestRow, PlatformHelpRequestRow } from "./help-request-store";

/** How the tenant is told an operator ended help: the operator is never named. */
export const PLATFORM_OPERATOR_LABEL = "ChartWarden operations";

/** What the views are derived from, besides the row. */
export interface HelpViewFacts {
  readonly grant: HelpGrantRow | null;
  readonly session: GrantSessionSummary | null;
  readonly now: Date;
}

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? iso(d) : null);

export function grantStatusOf(grant: HelpGrantRow, now: Date): HelpGrantStatus {
  if (grant.revokedAt) return "revoked";
  return grant.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

/**
 * What the screens switch on: waiting for consent (open), ready to start (approved, no open session), in session (approved, a session
 * is open), ended (resolved or cancelled). An approved request whose grant has lapsed stays `ready_to_start` until the sweep resolves
 * it (within its next tick); the view's `grant.status` says so, and an operator's Start is refused `SUPPORT_GRANT_INACTIVE` meanwhile.
 */
export function phaseOf(
  row: HelpRequestRow,
  session: GrantSessionSummary | null,
): HelpRequestPhase {
  if (row.status === "open") return "waiting_for_consent";
  if (row.status === "approved") return session?.state === "open" ? "in_session" : "ready_to_start";
  return "ended";
}

function grantView(facts: HelpViewFacts): HelpGrantView | null {
  return facts.grant
    ? { expiresAt: iso(facts.grant.expiresAt), status: grantStatusOf(facts.grant, facts.now) }
    : null;
}

function sessionView(session: GrantSessionSummary): HelpSessionSummaryView {
  return {
    state: session.state,
    startedAt: iso(session.startedAt),
    expiresAt: iso(session.expiresAt),
    closedAt: isoOrNull(session.closedAt),
    closeReason: session.closeReason,
    actionCount: session.actionCount,
    lastActionAt: isoOrNull(session.lastActionAt),
  };
}

/** Who ended it, relative to the viewer: the member who did is "you", another member is "your organization". */
export function closedByOf(row: HelpRequestRow, viewerUserId: string): HelpRequestClosedBy | null {
  switch (row.closedByActorKind) {
    case "tenant":
      return row.closedByUserId === viewerUserId ? "you" : "your organization";
    case "platform_ops":
      return PLATFORM_OPERATOR_LABEL;
    case "system":
      return "system";
    default:
      return null;
  }
}

/** The request as the TENANT sees it. */
export function toTenantView(
  row: HelpRequestRow,
  facts: HelpViewFacts,
  viewerUserId: string,
): HelpRequestView {
  return {
    id: row.id,
    stepKey: row.stepKey,
    message: row.message ?? schema.TENANT_HELP_REQUEST_PURGED_MESSAGE,
    status: row.status,
    phase: phaseOf(row, facts.session),
    requestedAt: iso(row.requestedAt),
    approvedAt: isoOrNull(row.approvedAt),
    grant: grantView(facts),
    session: facts.session ? sessionView(facts.session) : null,
    closedAt: isoOrNull(row.closedAt),
    closedBy: closedByOf(row, viewerUserId),
    closeNote: row.closeNote,
  };
}

/** The request as an OPERATOR sees it (the inbox row). */
export function toPlatformView(
  row: PlatformHelpRequestRow,
  facts: HelpViewFacts,
): PlatformHelpRequestView {
  return {
    id: row.id,
    tenantAccountId: row.tenantAccountId,
    orgSlug: row.orgSlug,
    legalBusinessName: row.legalBusinessName,
    stepKey: row.stepKey,
    message: row.message ?? schema.TENANT_HELP_REQUEST_PURGED_MESSAGE,
    status: row.status,
    phase: phaseOf(row, facts.session),
    requestedAt: iso(row.requestedAt),
    requestedByMembershipId: row.requestedByMembershipId,
    approvedAt: isoOrNull(row.approvedAt),
    supportConsentGrantId: row.supportConsentGrantId,
    grant: grantView(facts),
    session: facts.session
      ? { sessionId: facts.session.sessionId, ...sessionView(facts.session) }
      : null,
    closedAt: isoOrNull(row.closedAt),
    closedByActorKind: row.closedByActorKind,
    closeNote: row.closeNote,
  };
}
