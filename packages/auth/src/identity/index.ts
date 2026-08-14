// @wardenx/auth · identity (M2 — Identity & Org). Owned per module-manifest.ts codePath
// `packages/auth/src/identity`. Better Auth integration lands in M2-T01 (see ./auth);
// the session-class taxonomy + lifecycle (M2-T03) in ./session-classes; the published
// cross-module seams (M2-T07) in ./session-seam + ./auditor-session.
export {
  createIdentityAuth,
  type IdentityAuth,
  type IdentityAuthDb,
  type IdentityAuthOptions,
  type ResetPasswordSender,
} from "./auth";
export {
  type EmailMessage,
  type EmailTransport,
  createConsoleEmailTransport,
  createNoopEmailTransport,
} from "./email-transport";
export {
  type PasskeyCredentialStore,
  type StoredPasskey,
  type WebauthnVerifier,
  type WebauthnVerifyInput,
  createWebauthnAssertionVerifier,
  createDbPasskeyCredentialStore,
} from "./webauthn-verifier";
export {
  registerIdentityAuth,
  type MountableAuth,
  type RegisterIdentityAuthOptions,
} from "./mount";
export {
  getIdentitySession,
  type IdentitySessionSnapshot,
} from "./session-snapshot";
export { argon2idHash, argon2idVerify } from "./password-hash";
export { loadTwoFactorKey, seal, open, isSealed } from "./two-factor-crypto";
export { withTwoFactorEncryption, type EncryptableAdapter } from "./two-factor-adapter";
export {
  createDbSessionContextStore,
  toSessionContextRecord,
  type SessionRow,
} from "./db-session-store";
export {
  type SessionContextRecord,
  type SessionContextStore,
  createSessionContextResolver,
  createInMemorySessionContextStore,
} from "./session-seam";
export {
  type CredentialOutcome,
  type CredentialThrottle,
  type CredentialThrottlePolicy,
  type FailedLoginStore,
  CREDENTIAL_THROTTLE_POLICY,
  CredentialThrottleError,
  createCredentialThrottle,
  createInMemoryFailedLoginStore,
  credentialKey,
  isGuardedSignInPath,
  outcomeOfStatus,
  usernameFromBody,
} from "./credential-throttle";
export {
  type StepUpOverrideRecord,
  type StepUpOverrideStore,
  createInMemoryStepUpOverrideStore,
  tightenStepUpPolicy,
} from "./step-up-policy";
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
