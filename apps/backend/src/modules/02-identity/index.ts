// apps/backend/src/modules/02-identity — Module 2 (Identity & Org) backend surface. Owned
// per module-manifest.ts codePath `apps/backend/src/modules/02-identity`.
//
// M2-T05 lands the step-up primitive (M2 spec §4.4): the step-up route (initiate + verify),
// the login-MFA step-up initializer, the tighten-only policy resolver Module 3's
// `step_up_recent` predicate consumes, and the supporting ports + slice adapters. M2-T06
// adds the `/api/v1/*` identity route inventory. M2-T07 (./seams) registers M2's published
// cross-module seams (SessionContextResolver + AuditorSessionMinter, §4.7) into the M1 registry.
export {
  type IdentitySeamDeps,
  registerIdentitySeams,
} from "./seams";
export {
  type ResolvedStepUpPolicy,
  type SessionStepUpState,
  type StepUpDecision,
  type StepUpOverride,
  type StepUpOverrideReader,
  createInMemoryStepUpOverrideReader,
  resolveStepUpPolicy,
  stepUpSatisfies,
  tightenStepUpPolicy,
} from "./policy/step-up-resolver";
export {
  STEP_UP_AUDIT_EVENTS,
  type StepUpSource,
  auditStepUpCompleted,
  auditStepUpFailed,
  auditStepUpLockout,
} from "./audit/step-up-audit";
export {
  type AuthenticatedSession,
  type MfaEnrollmentReader,
  type MfaVerifier,
  type SessionResolver,
  type SessionStepUpWriter,
  type StepUpChallenge,
  type StepUpChallengeStore,
  type StepUpQualifyingFactor,
  type StepUpRouteDeps,
  createCodeVerifier,
  createFixedSessionResolver,
  createInMemoryAuditExecutor,
  createInMemoryMfaEnrollment,
  createInMemorySessionStepUpWriter,
  createInMemoryStepUpChallengeStore,
} from "./step-up-ports";
export { registerSessionStepUpRoutes } from "./routes/session-step-up";
export {
  type LoginMfaCompletedContext,
  type LoginMfaCompletedDeps,
  onLoginMfaCompleted,
} from "./hooks/login-mfa-completed";
// M2-T06 — the WardenX `/api/v1/*` identity route inventory + its injected ports.
export {
  type Actor,
  type ActorResolver,
  type CollaboratorLinkStore,
  type CollaboratorScope,
  type IdentityRouteDeps,
  type InvitationDetail,
  type InvitationStore,
  LinkError,
  type MembershipRecord,
  type MembershipRepository,
  type MembershipStatus,
  type MembershipView,
  type OrgBinding,
  type SessionWriter,
  type UserDirectory,
  createContextActorResolver,
  createFixedActorResolver,
  createInMemoryCollaboratorLinkStore,
  createInMemoryInvitationStore,
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
  createInMemoryUserDirectory,
} from "./identity-ports";
export {
  IDENTITY_AUDIT_EVENTS,
  auditCollaboratorInvited,
  auditCollaboratorSessionStarted,
  auditInvitationRescinded,
  auditMembershipAccepted,
  auditMembershipRevoked,
  auditMembershipStatusChanged,
  auditUserDeactivated,
  auditUserInvited,
} from "./audit/identity-audit";
export { registerIdentityRoutes } from "./routes/identity-routes";
export { createDbMembershipRepository } from "./membership-repository";

import type { DbClient } from "@wardenx/db";
import type { AdminMembershipReader } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import {
  type IdentityRouteDeps,
  createInMemoryCollaboratorLinkStore as _collabStore,
  createContextActorResolver as _ctxActor,
} from "./identity-ports";
import {
  createDbInvitationStore as _dbInvitations,
  createDbUserDirectory as _dbUserDirectory,
} from "./identity-stores-db";
import { createDbMembershipRepository as _dbMemberships } from "./membership-repository";
import { registerIdentityRoutes as _registerIdentityRoutes } from "./routes/identity-routes";
import { createDbSessionWriter as _dbSessionWriter } from "./session-writer-db";

/**
 * Mount the M2 identity REST routes on a server (composition root, via buildServer's
 * registerModuleRoutes hook, when a DB client is present).
 *
 * Everything here is now DB-backed except the external-collaborator link store — see below. Four of
 * these deps used to be process-local `Map`s ON THE PRODUCTION MOUNT, which meant an invitation minted
 * on one replica did not exist on another, a §7.5 offboard "disabled" credentials in a Map, and every
 * identity/step-up AUDIT EVENT — the trail an intrusion investigation starts from — was written to
 * memory and died with the process.
 *
 * `audit: db` is correct rather than a shortcut: `AuditExecutor` is structurally just
 * `insert(table).values(row)` (packages/audit/src/audit.ts), which the Drizzle client satisfies, and
 * `audit()` is documented as "the only sanctioned path to audit_event". Migration 0119 is what makes
 * it actually work — `wardenx_app` held the INSERT grant but no INSERT POLICY, so under production RLS
 * every application-level audit write was refused with "new row violates row-level security policy".
 *
 * ⚠ STILL IN MEMORY: `collaborators`. The external-collaborator magic-link store mints a one-time,
 * 30-minute token per patient — and there is NO TABLE for it. M2 owns exactly four tables (two_factor,
 * passkey, organization_invitation, tenant_step_up_policy_override); the `session` row for an
 * `external_collaborator` is what the token eventually PRODUCES, not where the pending token lives.
 * Making this durable needs a new M2-owned table (token hash, patient scope, inviter, TTL, consumed-at)
 * plus its RLS + audit trigger, which is a schema change, not a wiring change. Left explicit rather
 * than bound to something that would look durable and not be.
 */
export function mountIdentityRoutes(
  app: FastifyInstance,
  db: DbClient,
  admin: AdminMembershipReader,
): void {
  const deps: IdentityRouteDeps = {
    actors: _ctxActor(),
    memberships: _dbMemberships(db, admin),
    sessions: _dbSessionWriter(db),
    invitations: _dbInvitations(db),
    collaborators: _collabStore().store, // no table exists — see the header
    users: _dbUserDirectory(db),
    audit: db,
  };
  _registerIdentityRoutes(app, deps);
}
// M2-T10 — the `identity` data eraser (two_factor/passkey + pending invitations) + its ports.
export {
  type IdentityEraserDeps,
  type IdentityEraserSeed,
  type IdentityEraserStore,
  createIdentityEraser,
  createInMemoryIdentityEraserStore,
  registerIdentityErasers,
} from "./erasers/identity-eraser";
