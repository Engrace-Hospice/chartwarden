// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-grants-memory.ts — a fake `SupportGrantOperations`.
//
// What the in-memory slice and the service's unit tests hand the help service in place of piece 7S's real bundle (which lives in
// packages/saas-tenant-platform and runs on the database): it keeps its grants and sessions in the same `MemoryHelpState` the
// memory store reads, applies the one rule the contract names (`issueAssistGrant` needs org_admin or compliance_officer) and
// models the revoke cascade (close the grant's sessions, then end the linked request through the port it is handed).
import { randomUUID } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import type {
  GrantSessionSummary,
  SupportGrantOperations,
  SupportSessionServiceDeps,
} from "@chartwarden/saas-tenant-platform";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { MemoryHelpState } from "./help-request-store-memory";

const MS_PER_HOUR = 3_600_000;
/** The grant table's own ceiling: a grant never outlives 72 hours. */
const MAX_GRANT_HOURS = 72;
const GRANTOR_ROLES: ReadonlySet<string> = new Set(["org_admin", "compliance_officer"]);

export interface MemorySupportGrantOperations extends SupportGrantOperations {
  /** The session summaries by grant id: a test puts one here to model an operator who started a session. */
  readonly sessions: Map<string, GrantSessionSummary>;
  /** The grant ids the cascade was asked to revoke, in order. */
  readonly revoked: string[];
  /** Whether the revoke cascade ends the linked request through the port (7S's does); false models a bundle that leaves it to the caller. */
  callLinkedPort: boolean;
}

export function createMemorySupportGrantOperations(
  state: MemoryHelpState,
): MemorySupportGrantOperations {
  const sessions = new Map<string, GrantSessionSummary>();
  const revoked: string[] = [];
  const ops: MemorySupportGrantOperations = {
    sessions,
    revoked,
    callLinkedPort: true,
    depsFor: () => ({}) as SupportSessionServiceDeps,
    async issueAssistGrant(_deps, input) {
      if (!input.grantorRoles.some((role) => GRANTOR_ROLES.has(role))) {
        throw new ChartWardenError(
          "SUPPORT_GRANT_SCOPE_NOT_ALLOWED",
          "only an organization administrator or the compliance officer can issue this grant",
          403,
        );
      }
      const grantId = randomUUID();
      const expiresAt = new Date(
        state.now().getTime() + Math.min(input.hours, MAX_GRANT_HOURS) * MS_PER_HOUR,
      );
      state.grants.set(grantId, { id: grantId, expiresAt, revokedAt: null });
      return { grantId, expiresAt };
    },
    async revokeGrantAndCloseSessions(deps, input) {
      const grant = state.grants.get(input.grantId);
      if (!grant) throw new NotFoundError("support consent grant", input.grantId);
      const at = state.now();
      revoked.push(input.grantId);
      state.grants.set(input.grantId, { ...grant, revokedAt: grant.revokedAt ?? at });
      const closedSessionIds: string[] = [];
      const session = sessions.get(input.grantId);
      if (session && session.state === "open") {
        sessions.set(input.grantId, {
          ...session,
          state: "closed",
          closedAt: at,
          closeReason: "grant_revoked",
        });
        closedSessionIds.push(session.sessionId);
      }
      if (ops.callLinkedPort) {
        await deps.linkedHelpRequests?.resolveForRevokedGrant({
          grantId: input.grantId,
          organizationId: input.organizationId,
          source: input.source,
          closedByUserId: null,
          note: null,
        });
      }
      return { closedSessionIds };
    },
    async sessionSummaryForGrant(_tx: DbClient, grantId) {
      return sessions.get(grantId) ?? null;
    },
  };
  return ops;
}
