// @chartwarden/saas-tenant-platform · services — the consent-grant side of support sessions (slice 7, piece 7S).
//
// Three things the support-session service (./support-session-service.ts) does not own:
//   * WHO MAY ISSUE WHICH SCOPE. The existing scopes (`organization_scoped`, `patient_scoped`) keep the rule they always had
//     (the `support_consent_grant.issue` permission, the route's step-up) and gain one guard: an organization that is not
//     active (created, suspended, closed: it is confined to onboarding) may issue ONLY the non-PHI `assist` scope. `assist` may
//     be issued only by an actor holding the `org_admin` OR the `compliance_officer` role key. This file does NOT say PHI
//     scopes are officer-only: they are not.
//   * THE REVOKE CASCADE. Revoking a grant ends every session open on it (ledger `session.close`, critical audit, outbox
//     `m34.support_session.expired` with closeReason `grant_revoked`, the grantor alert), marks the grant revoked, emits
//     `m34.support_consent_grant.revoked` and lets the help request linked to the grant resolve itself through a port
//     (`LinkedHelpRequestPort`, piece 7B's). Route adapters resolve that collaborator after the security transaction commits. A LATER start on the grant is
//     `SUPPORT_GRANT_INACTIVE` 409 (the start reads the grant under a SHARE lock; this revoke's UPDATE is the other half of it).
//   * THE HELP SCREENS' SESSION SUMMARY: the one session of a grant a screen shows, with no operator identity in it.
//
// The three operations the help requests (7B) call are bundled by `createSupportGrantOperations` for the composition root.
import type { DbClient } from "@chartwarden/db";
import { ValidationError } from "@chartwarden/types";
import { SupportRepository } from "../repositories/support";
import type {
  GrantSessionSummary,
  IssueAssistGrantFn,
  IssueAssistGrantResult,
  RevokeGrantAndCloseSessionsFn,
  RevokeGrantAndCloseSessionsResult,
  SessionSummaryForGrantFn,
  SupportGrantOperations,
  SupportSessionState,
} from "./support-session-contract";
import {
  type PendingGrantorAlert,
  SUPPORT_ASSIST_SCOPE,
  type SupportSessionCloseReason,
  type SupportSessionServiceDeps,
  endSupportSession,
  require_,
} from "./support-session-service";

/** The three scopes a consent grant can carry. `assist` is non-PHI by construction. */
export type SupportGrantScope =
  | "organization_scoped"
  | "patient_scoped"
  | typeof SUPPORT_ASSIST_SCOPE;

/** The tenant role keys that may issue the non-PHI `assist` scope. */
export const SUPPORT_ASSIST_GRANTOR_ROLES: readonly string[] = ["org_admin", "compliance_officer"];

/** An `assist` grant lasts one to twenty-four whole hours (a help session is one working day at most). */
export const ASSIST_GRANT_MIN_HOURS = 1;
export const ASSIST_GRANT_MAX_HOURS = 24;
/** The table CHECK (`support_grant_expires_check`): no grant outlives 72 hours. */
export const SUPPORT_GRANT_MAX_HOURS = 72;

const MS_PER_HOUR = 3_600_000;

/**
 * The scope rule, in one place. Throws `SUPPORT_GRANT_SCOPE_NOT_ALLOWED` (403) when:
 *   - the scope is `assist` and the grantor holds neither the `org_admin` nor the `compliance_officer` role key; or
 *   - the scope is a PHI-bearing one and the organization is not active (a confined organization may issue only `assist`).
 * Nothing here narrows who may issue the existing scopes in an ACTIVE organization.
 */
export function assertGrantorMayIssueScope(input: {
  readonly scope: SupportGrantScope;
  readonly grantorRoles: readonly string[];
  readonly organizationActive: boolean;
}): void {
  if (input.scope === SUPPORT_ASSIST_SCOPE) {
    require_(
      input.grantorRoles.some((role) => SUPPORT_ASSIST_GRANTOR_ROLES.includes(role)),
      "SUPPORT_GRANT_SCOPE_NOT_ALLOWED",
      "the assist scope may be issued only by an organization administrator or the compliance officer",
    );
    return;
  }
  require_(
    input.organizationActive,
    "SUPPORT_GRANT_SCOPE_NOT_ALLOWED",
    "an organization that is not active may issue only the assist scope",
  );
}

// ── issue ────────────────────────────────────────────────────────────────────────────────────────────────

/** What a caller supplies to issue a consent grant of any scope (the route binds these off the verified request). */
export interface IssueSupportConsentGrantInput {
  readonly organizationId: string;
  readonly tenantAccountId: string;
  readonly grantorMembershipId: string;
  /** The role keys the grantor holds in this organization (the request's roles). */
  readonly grantorRoles: readonly string[];
  readonly scope: SupportGrantScope;
  /** The in-scope patients: required for `patient_scoped`, forbidden otherwise (the table CHECK, answered 422 instead of a 500). */
  readonly patientIdsInScope: readonly string[] | null;
  /** Requested duration in hours; `assist` is whole hours clamped to 1..24, the others are capped at 72. */
  readonly hours: number;
  /** `grant_reason`: ids and codes for an `assist` grant (`help request <id>`), the officer's own words otherwise. */
  readonly reason: string;
  /** Whether the organization is `active` (read by the caller in the same transaction). */
  readonly organizationActive: boolean;
  /** The help request this grant answers, when it answers one (carried on the outbox event only). */
  readonly helpRequestId?: string | null;
}

function expiryHours(scope: SupportGrantScope, requested: number): number {
  if (scope === SUPPORT_ASSIST_SCOPE) {
    return Math.min(
      ASSIST_GRANT_MAX_HOURS,
      Math.max(ASSIST_GRANT_MIN_HOURS, Math.floor(requested)),
    );
  }
  return Math.min(requested, SUPPORT_GRANT_MAX_HOURS);
}

/**
 * Issue a consent grant: the scope rule, row and `m34.support_consent_grant.issued` event share the caller's transaction.
 * The returned after-commit hook emits the operator alert only once that transaction succeeds.
 */
export async function issueSupportConsentGrant(
  deps: SupportSessionServiceDeps,
  input: IssueSupportConsentGrantInput,
) {
  assertGrantorMayIssueScope(input);
  const hasPatients = input.patientIdsInScope !== null && input.patientIdsInScope.length > 0;
  if ((input.scope === "patient_scoped") !== hasPatients) {
    throw new ValidationError(
      "patientIdsInScope is required for patient_scoped grants and forbidden for the others",
      [
        {
          field: "patientIdsInScope",
          code: "PATIENT_SCOPE_MISMATCH",
          message: "required for patient_scoped, forbidden otherwise",
        },
      ],
    );
  }
  if (
    hasPatients &&
    !(await deps.patients.allBelongToOrganization(
      input.organizationId,
      input.patientIdsInScope ?? [],
    ))
  ) {
    throw new ValidationError("every patientIdsInScope entry must belong to this organization", [
      {
        field: "patientIdsInScope",
        code: "PATIENT_SCOPE_TENANT_MISMATCH",
        message: "one or more patients do not belong to this organization",
      },
    ]);
  }

  const now = deps.now();
  const expiresAt = new Date(now.getTime() + expiryHours(input.scope, input.hours) * MS_PER_HOUR);
  const grant = await deps.repo.createConsentGrant({
    organizationId: input.organizationId,
    tenantAccountId: input.tenantAccountId,
    scope: input.scope,
    patientIdsInScope: hasPatients ? [...(input.patientIdsInScope ?? [])] : null,
    grantReason: input.reason,
    grantorMembershipId: input.grantorMembershipId,
    issuedAt: now,
    expiresAt,
  });

  await deps.outbox.publish(
    "m34.support_consent_grant.issued",
    {
      grantId: grant.id,
      tenantAccountId: grant.tenantAccountId,
      scope: grant.scope,
      expiresAt: grant.expiresAt.toISOString(),
      helpRequestId: input.helpRequestId ?? null,
    },
    input.organizationId,
  );
  // The operators learn that consent now exists; nothing in the alert names the grantor or the patients in scope. The caller
  // invokes this only after commit, because the alert emitter owns a separate transaction.
  const pendingAlert: PendingGrantorAlert = {
    alertKey: "m34.support_consent_grant.issued",
    organizationId: input.organizationId,
    tenantAccountId: grant.tenantAccountId,
    grantorMembershipId: input.grantorMembershipId,
    context: { grantId: grant.id, scope: grant.scope, expiresAt: grant.expiresAt.toISOString() },
  };
  return { ...grant, afterCommit: () => deps.alerts.emitAlert(pendingAlert) };
}

/** The contract's `issueAssistGrant`: an `assist` grant, whole hours 1..24, by an org_admin or compliance_officer. */
export const issueAssistGrant: IssueAssistGrantFn = async (
  deps,
  input,
): Promise<IssueAssistGrantResult> => {
  const grant = await issueSupportConsentGrant(deps, {
    organizationId: input.organizationId,
    tenantAccountId: input.tenantAccountId,
    grantorMembershipId: input.grantorMembershipId,
    grantorRoles: input.grantorRoles,
    scope: SUPPORT_ASSIST_SCOPE,
    patientIdsInScope: null,
    hours: input.hours,
    reason: input.reason,
    // An assist grant is the one scope a confined organization may issue, so its status is not an input.
    organizationActive: false,
    helpRequestId: input.helpRequestId ?? null,
  });
  return { grantId: grant.id, expiresAt: grant.expiresAt, afterCommit: grant.afterCommit };
};

// ── revoke + cascade ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The contract's `revokeGrantAndCloseSessions`. Order matters: the grant is marked revoked FIRST (so a start that has not yet
 * read it is refused), then every session still open on it is closed (a session a concurrent start inserted before that point
 * is visible to this read, because the start's SHARE lock made this UPDATE wait for it), then the events, the linked help
 * request, and last the alerts (an alert is sent outside the transaction, so it goes after every write that could still fail).
 * Idempotent: a grant already revoked keeps its first revoke's actor, time and reason, writes no second
 * `m34.support_consent_grant.revoked`, closes any straggler session and answers every session it closed (before or now).
 */
export const revokeGrantAndCloseSessions: RevokeGrantAndCloseSessionsFn = async (
  deps,
  input,
): Promise<RevokeGrantAndCloseSessionsResult> => {
  const grant = await deps.repo.findConsentGrantById(input.grantId);
  require_(
    grant !== null && grant.organizationId === input.organizationId,
    "SUPPORT_GRANT_NOT_FOUND",
    "support_consent_grant not found",
  );

  const now = deps.now();
  const revoked = await deps.repo.markConsentGrantRevoked(grant.id, {
    revokedAt: now,
    revokedByMembershipId: input.revokedByMembershipId,
    revocationReason: input.reason,
  });
  const firstRevoke = revoked !== null;

  const open = await deps.repo.listOpenSessionsByGrant(grant.id);
  const closedNow: string[] = [];
  const alerts: PendingGrantorAlert[] = [];
  for (const session of open) {
    const alert = await endSupportSession(deps, {
      sessionId: session.id,
      organizationId: grant.organizationId,
      supportConsentGrantId: grant.id,
      tenantAccountId: grant.tenantAccountId,
      grantorMembershipId: grant.grantorMembershipId,
      sessionActorMembershipId: session.actorMembershipId,
      closedByMembershipId: session.actorMembershipId,
      reason: "grant_revoked",
      now,
      auditContext: { revokedBy: input.source },
    });
    if (alert === null) continue;
    closedNow.push(session.id);
    alerts.push(alert);
  }
  const closedBefore = firstRevoke
    ? []
    : await deps.repo.listSessionIdsClosedAs(grant.id, "grant_revoked");
  const closedSessionIds = [...closedBefore.filter((id) => !closedNow.includes(id)), ...closedNow];

  if (firstRevoke) {
    await deps.outbox.publish(
      "m34.support_consent_grant.revoked",
      {
        grantId: grant.id,
        tenantAccountId: grant.tenantAccountId,
        revokedAt: now.toISOString(),
        closedSessionCount: closedSessionIds.length,
      },
      grant.organizationId,
    );
  }

  // The request linked to this grant ends with it (a no-op for a grant with no request or a request already ended).
  await deps.linkedHelpRequests?.resolveForRevokedGrant({
    grantId: grant.id,
    organizationId: grant.organizationId,
    source: input.source,
    closedByUserId: input.closedByUserId ?? null,
    note: null,
  });

  return {
    closedSessionIds,
    ...(alerts.length > 0
      ? {
          afterCommit: async () => {
            for (const alert of alerts) await deps.alerts.emitAlert(alert);
          },
        }
      : {}),
  };
};

// ── the help screens' summary ────────────────────────────────────────────────────────────────────────────

/**
 * The contract's `sessionSummaryForGrant`: the open session of the grant if there is one, else the most recently started;
 * null when it has none. `state` is `expired` once past `expires_at` but not yet swept. Carries no operator id or name.
 */
export async function summarizeSessionForGrant(
  tx: DbClient,
  grantId: string,
  now: Date,
): Promise<GrantSessionSummary | null> {
  const repo = new SupportRepository(tx);
  const session = await repo.findSummarySessionByGrant(grantId);
  if (session === null) return null;
  const stats = (await repo.opsWriteStats([session.id])).get(session.id);
  const state: SupportSessionState =
    session.closedAt !== null
      ? "closed"
      : session.expiresAt.getTime() <= now.getTime()
        ? "expired"
        : "open";
  return {
    sessionId: session.id,
    state,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    closedAt: session.closedAt,
    closeReason: session.closeReason as SupportSessionCloseReason | null,
    actionCount: stats?.count ?? 0,
    lastActionAt: stats?.lastAt ?? null,
  };
}

// ── the bundle the composition root binds once and hands to the tenant routes and to piece 7B ────────────

/**
 * Bind the three operations to the per-transaction dependency builder. `depsFor(tx)` builds the tx-bound repository, the
 * audit / outbox / alert ports and the clock; `now` is the clock the summary judges `expired` by.
 */
export function createSupportGrantOperations(input: {
  readonly depsFor: (tx: DbClient) => SupportSessionServiceDeps;
  readonly now: () => Date;
}): SupportGrantOperations {
  const sessionSummaryForGrant: SessionSummaryForGrantFn = (tx, grantId) =>
    summarizeSessionForGrant(tx, grantId, input.now());
  return {
    depsFor: input.depsFor,
    issueAssistGrant,
    revokeGrantAndCloseSessions,
    sessionSummaryForGrant,
  };
}
