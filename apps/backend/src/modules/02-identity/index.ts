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
// M2-T10 — the `identity` data eraser (two_factor/passkey + pending invitations) + its ports.
export {
  type IdentityEraserDeps,
  type IdentityEraserSeed,
  type IdentityEraserStore,
  createIdentityEraser,
  createInMemoryIdentityEraserStore,
  registerIdentityErasers,
} from "./erasers/identity-eraser";
