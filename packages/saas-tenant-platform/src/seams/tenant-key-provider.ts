// @wardenx/saas-tenant-platform — the `TenantKeyProvider` seam (M34 §4.6, D5).
//
// THE CRITICAL D5 SEAM. M1's envelope-encryption helper imports THIS interface to obtain a tenant's
// active DEK — so the contract is defined HERE and M1 implements it (the dependency direction runs
// M1 → M34's published interface, never M34 → M1's helper). M34's key-ring service registers the real
// implementation at boot; validateSeams() in M1's bootstrap REFUSES to start the server if no
// implementation is registered by `server.listen()`, and the M1 envelope helper raises
// `TenantKeyProviderUnregistered` on any call if boot validation was bypassed.
//
// DEKs never leave this seam unwrapped at rest: `dekForOrg` unwraps the DEK from the KEK on each call
// (M1 caches per-request within a `withOrgContext` scope). A destroyed key ring is the cryptographic
// shred — `dekForOrg` raises rather than returning a key, so PHI ciphertext becomes permanently
// unreadable the instant the ring is destroyed (M34 §3.3 tenant-key-destruction-log).

/** The lifecycle state of a tenant's key ring (§4.6). `destroyed` is the cryptographic-shred terminal
 *  state — the DEK is gone and the tenant's PHI ciphertext is permanently unreadable. */
export type TenantKeyRingState = "absent" | "active" | "destroyed";

/** An unwrapped DEK for one org at a given version. The `key` buffer is live key material — it is
 *  never logged, never persisted unwrapped, and held only within a `withOrgContext` request scope. */
export interface TenantDek {
  readonly version: string;
  readonly key: Buffer;
}

/**
 * The boot-registered tenant-key provider (§4.6, D5) M1's envelope helper imports. The real
 * implementation lives in M34's key-ring service (later phase); until it lands the M1 registry holds
 * the fail-closed deny-stub and validateSeams() refuses to boot without a real registration.
 */
export interface TenantKeyProvider {
  /**
   * Returns the active DEK for the org. The DEK is unwrapped from the KEK on each call (M1 caches
   * per-request within a `withOrgContext` scope). Raises `TenantKeyDestroyed` if `destroyed_at IS NOT
   * NULL`; raises `TenantKeyMissing` if no key-ring row exists.
   */
  dekForOrg(orgId: string): Promise<TenantDek>;

  /**
   * Returns a prior DEK for decrypt-only use during rotation windows. Used by background
   * re-encryption workers, never by hot paths.
   */
  dekForOrgVersion(orgId: string, version: string): Promise<TenantDek>;

  /**
   * Returns whether the key ring exists and is not destroyed. Used as a precondition by job runners
   * (provision worker, shred worker).
   */
  keyRingState(orgId: string): Promise<TenantKeyRingState>;
}
