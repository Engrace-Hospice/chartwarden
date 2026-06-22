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
  createInMemoryInvitationStore as _inviteStore,
  createInMemorySessionWriter as _sessionWriter,
  createInMemoryUserDirectory as _userDir,
} from "./identity-ports";
import { createDbMembershipRepository as _dbMemberships } from "./membership-repository";
import { registerIdentityRoutes as _registerIdentityRoutes } from "./routes/identity-routes";
import { createInMemoryAuditExecutor as _inMemAudit } from "./step-up-ports";

/**
 * Mount the M2 identity REST routes on a server (composition root, via buildServer's
 * registerModuleRoutes hook, when a DB client is present). The member roster + lifecycle run on the
 * REAL Drizzle MembershipRepository (isAdmin via the injected M3 admin reader); the actor resolves from
 * the authenticated request.context. The remaining deps (sessions / invitations / collaborators / user
 * directory / audit sink) are still in-memory and are replaced by Drizzle stores in follow-ups —
 * progressive wiring of the backend surface.
 */
export function mountIdentityRoutes(
  app: FastifyInstance,
  db: DbClient,
  admin: AdminMembershipReader,
): void {
  const deps: IdentityRouteDeps = {
    actors: _ctxActor(),
    memberships: _dbMemberships(db, admin),
    sessions: _sessionWriter().writer,
    invitations: _inviteStore().store,
    collaborators: _collabStore().store,
    users: _userDir().directory,
    audit: _inMemAudit().executor,
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
