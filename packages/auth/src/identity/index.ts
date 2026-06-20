// @wardenx/auth · identity (M2 — Identity & Org). Owned per module-manifest.ts codePath
// `packages/auth/src/identity`. Better Auth integration lands in M2-T01 (see ./auth);
// the session-class taxonomy + lifecycle (M2-T03) in ./session-classes; the published
// cross-module seams (M2-T07) in ./session-seam + ./auditor-session.
export {
  createIdentityAuth,
  type IdentityAuth,
  type IdentityAuthDb,
} from "./auth";
export {
  registerIdentityAuth,
  type MountableAuth,
  type RegisterIdentityAuthOptions,
} from "./mount";
export {
  type SessionContextRecord,
  type SessionContextStore,
  createSessionContextResolver,
  createInMemorySessionContextStore,
} from "./session-seam";
export {
  type AuditorMagicLinkIssuer,
  type AuditorSessionMintInput,
  createAuditorSessionMinter,
  createInMemoryAuditorMagicLinkIssuer,
} from "./auditor-session";
export {
  SESSION_CLASSES,
  type SessionClass,
  type SessionLifecycleState,
  TERMINAL_SESSION_STATES,
  SESSION_LIFECYCLE_TRANSITIONS,
  canTransitionSession,
  type SessionScopeKind,
  type SessionConcurrency,
  type SessionClassDescriptor,
  SESSION_CLASS_DESCRIPTORS,
  sessionClassDescriptor,
  type SessionScopeFields,
  isSessionScopeValid,
  assertSessionScope,
  sessionPinnedPatientId,
  sessionAllowsConcurrent,
} from "./session-classes";
