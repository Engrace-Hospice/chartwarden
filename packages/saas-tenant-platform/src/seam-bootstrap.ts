// @wardenx/saas-tenant-platform — boot-time seam registration + the M34 seam registry (M34 §4.6).
//
// M34's seams are PACKAGE-OWNED, not M1-registry seams: the critical D5 contract (`TenantKeyProvider`)
// is imported by M1's envelope helper FROM this package (dependency runs M1 → M34's interface), so the
// registry that holds the live implementation must live HERE, where the interface is defined — M1
// cannot host a slot for a seam whose interface it imports. This file is that registry plus the boot
// hook every M34 implementation registers through, mirroring the M1 backend seam-registry shape
// (`apps/backend/src/bootstrap/seams/registry.ts`): a single Map, `setX` registrars, typed `getX`
// resolvers, and a `validateSeams()` boot gate that REFUSES to start when a mandatory seam is missing.
//
// The five seams M34 PUBLISHES (lifecycle / key / onboarding / support-session / export-shard) + the
// one it CONSUMES from M35 (subscription entitlements, deny-stub today, D15) are all registered here.
// Per spec §4.6: `validateSeams()` throws if `setTenantKeyProvider` was not called by the time
// `server.listen()` is reached, and M1's envelope helper raises `TenantKeyProviderUnregistered` on any
// call if boot validation was bypassed. The other four publishes apply a fail-closed deny-stub default
// when a real impl is absent (present-but-denies, never fail-open); only `TenantKeyProvider` hard-fails
// boot, because PHI ciphertext is unreadable — and must stay so — until the real key provider is live.
import type {
  TenantExportShard,
  TenantKeyProvider,
  TenantLifecycleProvider,
  TenantOnboardingProvider,
  TenantOrgCreationProvider,
  TenantSubscriptionEntitlementReader,
  TenantSupportSessionProvider,
} from "./seams";
import {
  denyStubTenantOrgCreationProvider,
  denyStubTenantSubscriptionEntitlementReader,
} from "./seams";
import {
  createInMemoryM34ExportShardStore,
  createTenantExportShardForM34,
} from "./tenant-export-shard";

/** Raised when a mandatory M34 seam was not registered by the time `validateSeams()` runs at boot. */
export class M34SeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "M34SeamError";
  }
}

/** Raised by `getTenantKeyProvider()` (and M1's envelope helper) if the key provider is resolved
 *  before any registration — the fail-closed signal that boot validation was bypassed (D5). */
export class TenantKeyProviderUnregistered extends M34SeamError {
  constructor() {
    super(
      "TenantKeyProvider was resolved before M34 registered it — refusing to hand out a key (D5 fail-closed)",
    );
    this.name = "TenantKeyProviderUnregistered";
  }
}

// ── the registry (single home for the live M34 seam implementations) ───────────────────────────────
let tenantLifecycleProvider: TenantLifecycleProvider | undefined;
let tenantKeyProvider: TenantKeyProvider | undefined;
let tenantOnboardingProvider: TenantOnboardingProvider | undefined;
let tenantSupportSessionProvider: TenantSupportSessionProvider | undefined;
let tenantSubscriptionEntitlementReader: TenantSubscriptionEntitlementReader =
  denyStubTenantSubscriptionEntitlementReader;
let tenantOrgCreationProvider: TenantOrgCreationProvider = denyStubTenantOrgCreationProvider;
const tenantExportShards = new Map<string, TenantExportShard>();

// ── registrars (a producer module / M34 boot calls these; mirror the M1 `registerSeam` shape) ──────

/** Register the live `TenantLifecycleProvider` (the lifecycle service's read surface). */
export function setTenantLifecycleProvider(impl: TenantLifecycleProvider): void {
  tenantLifecycleProvider = impl;
}

/** Register the live `TenantKeyProvider` (D5). MANDATORY — `validateSeams()` throws without it.
 *  M1's envelope helper imports the interface; this registers the runtime that backs it. */
export function setTenantKeyProvider(impl: TenantKeyProvider): void {
  tenantKeyProvider = impl;
}

/** Register the live `TenantOnboardingProvider` (the onboarding read surface). */
export function setTenantOnboardingProvider(impl: TenantOnboardingProvider): void {
  tenantOnboardingProvider = impl;
}

/** Register the live `TenantSupportSessionProvider` (the break-glass read surface). */
export function setTenantSupportSessionProvider(impl: TenantSupportSessionProvider): void {
  tenantSupportSessionProvider = impl;
}

/** Register M35's real `TenantSubscriptionEntitlementReader` over the D15 deny-stub (when M35 locks). */
export function setTenantSubscriptionEntitlementReader(
  impl: TenantSubscriptionEntitlementReader,
): void {
  tenantSubscriptionEntitlementReader = impl;
}

/** Register M2's real `TenantOrgCreationProvider` over the deny-stub (when M2's createOrganization locks).
 *  The provision worker's `ensureOrganization` port binds over this; the deny-stub stays until M2 ships. */
export function setTenantOrgCreationProvider(impl: TenantOrgCreationProvider): void {
  tenantOrgCreationProvider = impl;
}

/** Register a module's `TenantExportShard` keyed by its `moduleKey` (the fan-out registry M34's
 *  export worker iterates at job time). M34 registers its own shard through this too. */
export function registerTenantExportShard(shard: TenantExportShard): void {
  tenantExportShards.set(shard.moduleKey, shard);
}

// ── typed resolvers (consumers resolve the live impl; mirror the M1 `getSeam` shape) ───────────────

/** Resolve the live `TenantLifecycleProvider`. Throws if M34 never registered it (fail-closed). */
export function getTenantLifecycleProvider(): TenantLifecycleProvider {
  if (!tenantLifecycleProvider) throw new M34SeamError("TenantLifecycleProvider not registered");
  return tenantLifecycleProvider;
}

/** Resolve the live `TenantKeyProvider` (D5). Throws {@link TenantKeyProviderUnregistered} if absent —
 *  this is the signal M1's envelope helper surfaces when boot validation was bypassed. */
export function getTenantKeyProvider(): TenantKeyProvider {
  if (!tenantKeyProvider) throw new TenantKeyProviderUnregistered();
  return tenantKeyProvider;
}

/** Resolve the live `TenantOnboardingProvider`. Throws if M34 never registered it (fail-closed). */
export function getTenantOnboardingProvider(): TenantOnboardingProvider {
  if (!tenantOnboardingProvider) throw new M34SeamError("TenantOnboardingProvider not registered");
  return tenantOnboardingProvider;
}

/** Resolve the live `TenantSupportSessionProvider`. Throws if M34 never registered it (fail-closed). */
export function getTenantSupportSessionProvider(): TenantSupportSessionProvider {
  if (!tenantSupportSessionProvider)
    throw new M34SeamError("TenantSupportSessionProvider not registered");
  return tenantSupportSessionProvider;
}

/** Resolve the `TenantSubscriptionEntitlementReader` — the D15 deny-stub until M35 registers the real
 *  reader (never throws; the deny-stub answers `{ kind: 'unavailable' }`). */
export function getTenantSubscriptionEntitlementReader(): TenantSubscriptionEntitlementReader {
  return tenantSubscriptionEntitlementReader;
}

/** Resolve the `TenantOrgCreationProvider` — the deny-stub until M2 registers the real provider (never
 *  throws; the deny-stub answers `{ kind: 'unavailable' }` and the provision worker degrades cleanly). */
export function getTenantOrgCreationProvider(): TenantOrgCreationProvider {
  return tenantOrgCreationProvider;
}

/** Resolve one module's `TenantExportShard` by key, or `undefined` if no module registered it. */
export function getTenantExportShard(moduleKey: string): TenantExportShard | undefined {
  return tenantExportShards.get(moduleKey);
}

/** The full set of registered export shards (the export/DSAR worker iterates this at job time). */
export function listTenantExportShards(): readonly TenantExportShard[] {
  return [...tenantExportShards.values()];
}

/**
 * The dependencies M34's boot wiring injects (the real Drizzle-backed implementations land with the
 * lifecycle/key/onboarding/support services in later phases). Each is optional: where a real impl is
 * not yet available, {@link bootstrapModule34} leaves the published seam fail-closed (a deny-stub /
 * unregistered-throw) — EXCEPT `tenantKeyProvider`, which is MANDATORY (D5) and must be supplied for
 * `validateSeams()` to pass. The export-shard store defaults to the in-memory slice store.
 */
export interface BootstrapModule34Deps {
  readonly tenantLifecycleProvider?: TenantLifecycleProvider;
  /** MANDATORY (D5) — M1's envelope helper resolves this; boot refuses without it. */
  readonly tenantKeyProvider: TenantKeyProvider;
  readonly tenantOnboardingProvider?: TenantOnboardingProvider;
  readonly tenantSupportSessionProvider?: TenantSupportSessionProvider;
  /** M35's real entitlement reader, when M35 has locked (else the D15 deny-stub stays in place). */
  readonly tenantSubscriptionEntitlementReader?: TenantSubscriptionEntitlementReader;
  /** M2's real org-creation provider, when M2's createOrganization surface has locked (else deny-stub). */
  readonly tenantOrgCreationProvider?: TenantOrgCreationProvider;
  /** M34's own export-shard store (Drizzle-backed in prod; in-memory slice store by default). */
  readonly exportShard?: TenantExportShard;
}

/**
 * Register all M34-owned seams + the M35 deny-stub + M34's own `TenantExportShard` at boot, mirroring
 * the spec §4.6 `bootstrapModule34()` shape. Run from the composition root inside the boot gate, BEFORE
 * `validateSeams()`. The onboarding outbox/document-backref consumers (DSAR / tenant-export PDF
 * back-ref, §3.8 / consumers/m22-document-backref) attach in a later phase — their registration hook is
 * stubbed here with a typed TODO so the wiring site stays explicit.
 */
export function bootstrapModule34(deps: BootstrapModule34Deps): void {
  setTenantKeyProvider(deps.tenantKeyProvider); // M1 envelope helper imports this — MANDATORY (D5)
  if (deps.tenantLifecycleProvider) setTenantLifecycleProvider(deps.tenantLifecycleProvider);
  if (deps.tenantOnboardingProvider) setTenantOnboardingProvider(deps.tenantOnboardingProvider);
  if (deps.tenantSupportSessionProvider)
    setTenantSupportSessionProvider(deps.tenantSupportSessionProvider);
  if (deps.tenantSubscriptionEntitlementReader)
    setTenantSubscriptionEntitlementReader(deps.tenantSubscriptionEntitlementReader);
  if (deps.tenantOrgCreationProvider) setTenantOrgCreationProvider(deps.tenantOrgCreationProvider);

  // M34's own export shard (the inverse-fan-out self-registration every PHI module also performs).
  const exportShard =
    deps.exportShard ?? createTenantExportShardForM34(createInMemoryM34ExportShardStore());
  registerTenantExportShard(exportShard);

  // TODO(Phase 2D — onboarding/document-backref consumers): register the §3.8 DSAR + tenant-export
  // `consumers/m22-document-backref` outbox consumer (wires the rendered `document_id` back onto
  // `dsar_export_job.bundle_document_id` per the M22 §1.1 handshake) and the onboarding-step outbox
  // consumers once the consumer-dispatch binding lands. No-op today; the wiring site is explicit here.

  // The `saas_tenant_platform_class` eraseFn is NOT registered here, and deliberately so. It lands
  // through the composition root's `registerSaasTenantPlatformErasers(...)` hook
  // (`apps/backend/src/modules/34-saas-tenant-platform/erasers/saas-tenant-platform-eraser.ts`), the
  // same INJECTED-registerEraser shape every other module uses — this package cannot import M1's
  // bootstrap registry, and the eraser needs the PLATFORM credential its cross-tenant deletes run on,
  // which only the composition root holds. A TODO here claimed for a while that the eraseFn "is not
  // built yet"; it was, and #105 was filed off this comment rather than off the wiring.
}

/**
 * Boot gate (spec §4.6): refuse to start the server unless the MANDATORY `TenantKeyProvider` (D5) was
 * registered. Run after {@link bootstrapModule34} and before `server.listen()`. The other four
 * publishes are allowed to be absent in a partial boot (they fail-closed on call via their typed
 * resolvers); only the key provider hard-fails, because every encrypted-column read/write across the
 * platform depends on it and a missing key provider must stop the boot, not silently fail open.
 */
export function validateSeams(): void {
  if (!tenantKeyProvider) {
    throw new M34SeamError(
      "validateSeams: M34 TenantKeyProvider not registered (setTenantKeyProvider) — refusing to start (D5)",
    );
  }
}

/** Test-only: clear the M34 seam registry between cases (mirrors `__resetSeamsForTest`). */
export function __resetModule34SeamsForTest(): void {
  tenantLifecycleProvider = undefined;
  tenantKeyProvider = undefined;
  tenantOnboardingProvider = undefined;
  tenantSupportSessionProvider = undefined;
  tenantSubscriptionEntitlementReader = denyStubTenantSubscriptionEntitlementReader;
  tenantOrgCreationProvider = denyStubTenantOrgCreationProvider;
  tenantExportShards.clear();
}
