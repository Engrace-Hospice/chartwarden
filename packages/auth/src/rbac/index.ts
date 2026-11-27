// @chartwarden/auth · rbac (M3 — Authorization). Owned per module-manifest.ts codePath
// `packages/auth/src/rbac`. The Authorization Contract's RBAC surface — `requireSession`,
// `requireRole`, `requirePermission` + the §2.2 pipeline composer (M3-T05) — ships in
// ./require-role; the cached effective-permission resolver it consumes (M3-T06) is
// ./resolve over the ./cache port.
export {
  type EffectivePermissionResolver,
  type GuardHandler,
  type GuardRequest,
  type PermissionKeyInput,
  composeGuards,
  requirePermission,
  requireRole,
  requireSession,
  resetEffectivePermissionResolver,
  resolveActorPermissions,
  setEffectivePermissionResolver,
} from "./require-role";
// `superadmin` supersedes the two full-catalog admin roles: its permissions come from the code catalog, not stored rows.
export { effectivePermissionKeys, platformPermissionKeysIn } from "./superadmin-permissions";
// M3-T06 — the cached effective-permission resolver (the real seam M3-T05 deny-stubbed).
export {
  type Clock,
  type EffectivePermissionCache,
  type InMemoryCacheOptions,
  createInMemoryEffectivePermissionCache,
  effectivePermissionCacheKey,
} from "./cache";
export {
  type EffectivePermissionResolverOptions,
  type EffectivePermissionStore,
  type RbacEngineHandle,
  type ResolvedPermissions,
  type RoleGrant,
  createEffectivePermissionResolver,
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetRbacEngine,
  resolveEffectivePermissions,
} from "./resolve";
export {
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbEffectivePermissionStore,
  createDbPermissionHolderReader,
  registerDbEffectivePermissionResolver,
} from "./drizzle-store";
// CW-AC-22 — platform authority withheld from a request that came from outside the console allowlist.
export {
  PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE,
  carriesPlatformAuthority,
  platformAuthorityStrippedFor,
  stripPlatformAuthority,
} from "./platform-authority-strip";
// M31 / M2 — permissions held by SESSION CLASS (portal, funeral-home), not by membership.
export {
  SESSION_CLASS_PERMISSIONS,
  sessionClassPermissions,
  withSessionClassPermissions,
} from "./session-class-permissions";
