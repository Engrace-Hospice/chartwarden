// @wardenx/auth · rbac (M3 — Authorization). Owned per module-manifest.ts codePath
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
  createDbEffectivePermissionStore,
  registerDbEffectivePermissionResolver,
} from "./drizzle-store";
