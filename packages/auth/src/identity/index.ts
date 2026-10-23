// @chartwarden/auth · identity (M2 — Identity & Org). Owned per module-manifest.ts codePath
// `packages/auth/src/identity`. Better Auth integration lands in M2-T01 (see ./auth);
// the session-class taxonomy + lifecycle (M2-T03) in ./session-classes; the published
// cross-module seams (M2-T07) in ./session-seam + ./auditor-session.
export {
  INVITE_TOKEN_HEADER,
  createIdentityAuth,
  resolveMobileAuthOrigins,
  resolvePasskeyOrigins,
  resolveSignUpRequiresInvite,
  resolveTrustedOrigins,
  resolveWebTrustedOrigins,
  resolvePasskeyRpId,
  type IdentityAuth,
  type IdentityAuthDb,
  type IdentityAuthOptions,
  type ResetPasswordSender,
} from "./auth";
export {
  RESERVED_USERNAMES,
  USERNAME_PATTERN,
  credentialAdminPlugin,
  createIdentityCredentialAdmin,
  isAllowedUsername,
  normalizeUsername,
  type CredentialAdminCapableAuth,
  type IdentityCredentialAdmin,
  type ProvisionIdentityCredentialInput,
} from "./credential-admin";
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
  PASSKEY_REQUIRED_ROLE_KEYS,
  evaluateMfa,
  mfaRequirementFor,
  mfaSatisfied,
  resolveMfaEnforcement,
  sessionClassRequiresMfa,
  type MfaFactorState,
  type MfaRequirement,
  type MfaVerdict,
} from "./mfa-policy";
export {
  AUTH_AUDIT_EVENTS,
  buildAuthAuditEvent,
  buildPasswordResetEvent,
  type AuthAuditActor,
  type AuthAuditEvent,
  type AuthAuditEventType,
  type AuthAuditSink,
} from "./auth-audit";
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
  type StoredTotpEnrolment,
  type TotpEnrolmentStore,
  type TotpVerifier,
  type TotpVerifierOptions,
  type TotpVerifyResult,
  createDbTotpEnrolmentStore,
  createTotpStepUpVerifier,
} from "./totp-verifier";
export {
  type VendorSessionRow,
  type VendorSessionStore,
  VendorSessionBindError,
  createInMemoryVendorSessionStore,
  createVendorSessionBinder,
} from "./vendor-session-binder";
export {
  createDbSessionContextStore,
  liveDeviceAttestation,
  toSessionContextRecord,
  type DeviceAttestationRow,
  type SessionRow,
} from "./db-session-store";
export {
  type SessionContextRecord,
  type SessionContextStore,
  createSessionContextResolver,
  createInMemorySessionContextStore,
} from "./session-seam";
export {
  PortalSessionBindError,
  type PortalSessionRow,
  type PortalSessionStore,
  createPortalSessionBinder,
  createInMemoryPortalSessionStore,
} from "./portal-session-binder";
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
  RECOVERY_CODE_COUNT,
  TOTP_PERIOD_SEC,
  type NewTotpEnrolment,
  type TotpSecretOptions,
  type TotpStepResult,
  createTotpEnrolment,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchTotpStep,
  normalizeRecoveryCode,
  recoveryCodeMatches,
  totpStepStart,
} from "./auditor-second-factor";
export {
  type AuditorIssuerAuth,
  type AuditorIssuerAuthContext,
  type AuditorSessionIssuer,
  AuditorSessionIssueError,
  type IssueAuditorSessionInput,
  type IssuedAuditorSession,
  createAuditorSessionIssuer,
  signSessionCookieValue,
} from "./auditor-session-issuer";
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
  sessionExternalActorId,
  sessionEngagementId,
  sessionAuditorStage,
  AUDITOR_STAGE_ACTIVE,
  AUDITOR_STAGE_ENROLMENT,
  type AuditorSessionStage,
  sessionPinnedPatientId,
  sessionAllowsConcurrent,
  PORTAL_SESSION_CLASSES,
  VENDOR_SESSION_CLASSES,
  isPortalSessionClass,
  isVendorSessionClass,
} from "./session-classes";
export {
  SESSION_ACTIVITY_TOUCH_SEC,
  SESSION_MAX_ABSOLUTE_SEC,
  type SessionEnforceOptions,
  type SessionTimeoutEnforcer,
  type SessionTimeoutFacts,
  type SessionTimeoutState,
  createDbSessionTimeoutEnforcer,
  evaluateSessionTimeout,
  isUserStatusBlocked,
} from "./session-timeout";

// GAP-115 follow-up — the server-only session mint behind a redeemed collaborator / funeral-home link.
export {
  LINK_SESSION_CLASSES,
  type LinkSessionCapableAuth,
  type LinkSessionClass,
  type LinkSessionMintInput,
  type LinkSessionMinter,
  type MintedLinkSession,
  createLinkSessionMinter,
  linkSessionPlugin,
} from "./link-session";

export {
  type PasswordVerifier,
  type PasswordVerifierCapableAuth,
  createPasswordVerifier,
} from "./password-verifier";

export {
  type TenantOriginMatcher,
  type TenantOriginResolver,
  createTenantOriginMatcher,
} from "./tenant-origin";
