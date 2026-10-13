// apps/backend/src/modules/34-saas-tenant-platform/seam-registration.ts — M34 Phase-2D seam wiring.
//
// Overwrites the bootstrap deny-stubs (apps/backend/src/index.ts `SLICE_MODULE_34_SEAM_DEPS`) with the
// REAL Drizzle-backed implementations of M34's OWN published seams, then hands them to the package's
// `bootstrapModule34({ … })` registrar (which `setX`-registers each + `registerTenantExportShard`s
// M34's own self-shard). Mirrors the M5 `registerPatientSeams` precedent: the composition root calls
// `registerM34SeamProviders(deps)` from `wireModuleSeams()`, BEFORE `validateModule34Seams()`.
//
// The four publishes bound here are read surfaces over the §3 repositories
// (`TenantAccountRepository` / `OnboardingRepository` / `SupportRepository`), each wrapping its reads in
// the injected tenancy runner so Postgres RLS scopes every statement — `runInOrgContext` (org-scoped,
// `withOrgContext`) for a single tenant's reads, `runInPlatformContext` (the separately-pooled, audited,
// RLS-bypass cross-tenant path, F03/F09) for the platform-ops scans. The MANDATORY `TenantKeyProvider`
// (D5) is bound over `TenantKeyRingRepository` + an injected KEK-unwrap port — M34's package holds NO
// KMS/KEK knowledge (no new `dependsOn` edge; M34 stays [1,2,3,4,36]), so the composition root supplies
// the real KMS adapter as a port. The forward `TenantOrgCreationProvider` (M2) + the M35 entitlement
// reader stay deny-stubs here; M2/M35 register their real providers over them when they lock.
//
// BOUNDARY: this module composes over PORTS the boot wiring binds (the org/platform tenancy runners +
// the KEK-unwrap port) — it adds no direct M1/M2/M4 import and no manifest edge. The repos run plain
// Drizzle reads; the runner owns the RLS-scoping transaction (single home for the tenant-scoping rule).
import type { DbClient } from "@wardenx/db";
import {
  OnboardingRepository,
  type RetentionExpiry,
  type SupportConsentGrant,
  SupportRepository,
  TenantAccountRepository,
  type TenantDek,
  type TenantKeyProvider,
  TenantKeyRingRepository,
  type TenantKeyRingState,
  type TenantLifecycleProvider,
  type TenantLifecycleStatus,
  type TenantOnboardingProvider,
  type TenantSupportSessionProvider,
  bootstrapModule34,
  createInMemoryM34ExportShardStore,
  createTenantExportShardForM34,
  denyStubTenantOrgCreationProvider,
} from "@wardenx/saas-tenant-platform";

// ── injected ports the composition root binds at boot ──────────────────────────────────────────────

/**
 * Run `fn` under the active tenant's `withOrgContext` (RLS scopes by `app.org_id`), handing it the
 * repository-ready transaction handle. The composition root binds this to M1's `withOrgContext` over the
 * org-pooled client + the platform-ops actor's user id (so the org-context audit attribution is correct).
 * Keeping it a port means this module never imports `@wardenx/tenancy` directly nor opens a transaction.
 */
export type RunInOrgContext = <T>(orgId: string, fn: (tx: DbClient) => Promise<T>) => Promise<T>;

/**
 * Run `fn` under `withPlatformContext` (the separately-pooled, audited, RLS-bypass cross-tenant read
 * path, F03/F09) for the platform-ops scans (retention-expiry sweep, cross-tenant grant resolution).
 * The composition root binds this to M1's `withPlatformContext` over the platform-pooled client + a
 * registered platform job id + the bypass auditor — so every cross-tenant read is audited at boot.
 */
export type RunInPlatformContext = <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;

/** Raised by the key provider when the resolved key ring is destroyed (cryptographic-shred terminal). */
export class TenantKeyDestroyed extends Error {
  constructor(orgId: string) {
    super(
      `tenant key ring for org ${orgId} is destroyed — PHI ciphertext is permanently unreadable`,
    );
    this.name = "TenantKeyDestroyed";
  }
}

/** Raised by the key provider when no key-ring row exists for the org (defense in depth — never a key). */
export class TenantKeyMissing extends Error {
  constructor(orgId: string) {
    super(`no tenant key ring for org ${orgId}`);
    this.name = "TenantKeyMissing";
  }
}

/** Raised when a prior DEK version requested for rotation-window decrypt-only does not exist. */
export class TenantKeyVersionMissing extends Error {
  constructor(orgId: string, version: string) {
    super(`tenant key ring for org ${orgId} has no DEK version ${version}`);
    this.name = "TenantKeyVersionMissing";
  }
}

/**
 * The KEK-unwrap port the `TenantKeyProvider` composes over (D5). M34's package holds NO KMS/KEK
 * knowledge, so the composition root binds this to the real KEK/KMS adapter (M1 infra — today
 * `apps/backend/src/bootstrap/tenant-kek.ts`, ADR-0045). `unwrap` takes the KEK-wrapped DEK ciphertext,
 * the KEK id that wrapped it, and the ORGANIZATION whose key ring it was read from; it returns the live
 * DEK key material — never logged, never persisted unwrapped, held only within the resolving scope.
 *
 * `organizationId` is part of the request because the adapter binds it into the AAD: a wrapped DEK is
 * openable only in the key ring it was minted for. Without it, anyone who can WRITE `tenant_key_ring`
 * (the platform credential, or a restored backup) could copy tenant B's wrapped ciphertext into tenant
 * A's row and read B's PHI through A's request path while never holding the KEK at all.
 */
export interface KekUnwrapPort {
  unwrap(input: {
    organizationId: string;
    kekWrappedCiphertext: Buffer;
    kekId: string;
  }): Promise<Buffer>;
}

/** Shape of one retained prior DEK version (the `tenant_key_ring.prior_dek_versions` jsonb element). */
interface PriorDekVersionRow {
  readonly version: string;
  readonly kekWrappedCiphertext: string; // base64
  readonly kekId: string;
}

/** The dependencies `registerM34SeamProviders` binds the real providers over (Phase 2D). */
export interface M34SeamRegistrationDeps {
  /** Org-pooled Drizzle client — the repos read through it under `runInOrgContext`. */
  readonly db: DbClient;
  /** Bound `withOrgContext` runner (RLS scopes by org); the read providers wrap every read in it. */
  readonly runInOrgContext: RunInOrgContext;
  /** Bound `withPlatformContext` runner (audited cross-tenant) for the platform-ops scans. */
  readonly runInPlatformContext: RunInPlatformContext;
  /** The KEK/KMS unwrap adapter the MANDATORY `TenantKeyProvider` (D5) composes over. */
  readonly kekUnwrap: KekUnwrapPort;
  /**
   * Run `fn` org-scoped over a credential that MAY SELECT `tenant_key_ring` — the platform login, not the
   * request path's `wardenx_app`.
   *
   * This is a separate port from {@link RunInOrgContext} on purpose. Migration 0052 §5 REVOKES SELECT on
   * `tenant_key_ring` from `wardenx_app` and surfaces only the ciphertext-free `tenant_key_ring_metadata_v`
   * view to it, so that a compromise of the request path's credential yields no key material at all — the
   * §3.10 / M34-F02 control. Reading the wrapped DEK through `runInOrgContext` therefore does not fail on
   * the KEK, it fails one step earlier with `42501 permission denied for table tenant_key_ring`, whatever
   * the KEK port is bound to. Binding this to the platform pool keeps the control intact (the tenant
   * credential still cannot read key material) while giving the provider a credential that can.
   *
   * Still ORG-scoped, not platform-scoped: resolving one tenant's DEK is not a cross-tenant read, so it
   * takes no `withPlatformContext` entry and writes no `platform.bypass_invoked` audit row — which would
   * otherwise land on every encounter finalize and every message read.
   */
  readonly runInKeyRingContext: RunInOrgContext;
  /** M34's own export-shard store (Drizzle-backed in prod; defaults to the in-memory slice store). */
  readonly exportShardStore?: Parameters<typeof createTenantExportShardForM34>[0];
}

// ── the four published-seam providers (read surfaces over the §3 repositories) ──────────────────────

/** Build the live `TenantLifecycleProvider` (§4.6) over `TenantAccountRepository` + `OnboardingRepository`. */
function buildLifecycleProvider(deps: M34SeamRegistrationDeps): TenantLifecycleProvider {
  return {
    async activeStatusForOrg(orgId: string): Promise<TenantLifecycleStatus> {
      return deps.runInOrgContext(orgId, async (tx) => {
        const account = await new TenantAccountRepository(tx).findByOrganizationId(orgId);
        // Defense in depth: an org with no tenant_account is 'unknown_org', never a silent 'active'.
        if (!account) {
          return {
            status: "unknown_org",
            planLabel: null,
            activatedAt: null,
            retentionEndsAt: null,
          };
        }
        return {
          status: account.status,
          planLabel: account.planLabel,
          activatedAt: account.activatedAt,
          retentionEndsAt: account.retentionEndsAt,
        };
      });
    },
    async firstAdminInvitationConsumed(orgId: string): Promise<boolean> {
      return deps.runInOrgContext(orgId, async (tx) => {
        const repo = new TenantAccountRepository(tx);
        const account = await repo.findByOrganizationId(orgId);
        if (!account) return false;
        const invitations = await repo.listInvitations(account.id);
        return invitations.some((i) => i.status === "consumed");
      });
    },
    async planLabelForOrg(orgId: string): Promise<string | null> {
      return deps.runInOrgContext(orgId, async (tx) => {
        const account = await new TenantAccountRepository(tx).findByOrganizationId(orgId);
        return account?.planLabel ?? null;
      });
    },
    async retentionExpiringWithin(period: { days: number }): Promise<RetentionExpiry[]> {
      // Cross-tenant platform-ops scan (M4's quarterly destruction-eligibility sweep) — withPlatformContext.
      return deps.runInPlatformContext(async (tx) => {
        const cutoff = new Date(Date.now() + period.days * 24 * 60 * 60 * 1000);
        const retained = await new TenantAccountRepository(tx).listByStatus("retained");
        return retained
          .filter((a) => a.retentionEndsAt !== null && a.retentionEndsAt <= cutoff)
          .map((a) => ({ orgId: a.organizationId, retentionEndsAt: a.retentionEndsAt as Date }));
      });
    },
  };
}

/** Build the live `TenantOnboardingProvider` (§4.6) over `OnboardingRepository`. */
function buildOnboardingProvider(deps: M34SeamRegistrationDeps): TenantOnboardingProvider {
  return {
    async currentStepForOrg(orgId) {
      return deps.runInOrgContext(orgId, async (tx) => {
        const account = await new TenantAccountRepository(tx).findByOrganizationId(orgId);
        if (!account) return null;
        const tasks = await new OnboardingRepository(tx).listTasksByTenant(account.id);
        // listTasksByTenant is ordered by canonical order; the current step is the first not-yet-terminal.
        const current = tasks.find((t) => t.status === "pending" || t.status === "in_progress");
        if (!current) return null;
        return { stepKey: current.templateKey, status: current.status };
      });
    },
    async allCanonicalTasksDoneOrSkipped(orgId) {
      return deps.runInOrgContext(orgId, async (tx) => {
        const account = await new TenantAccountRepository(tx).findByOrganizationId(orgId);
        if (!account) return false;
        const repo = new OnboardingRepository(tx);
        const [templates, tasks] = await Promise.all([
          repo.listTemplates(),
          repo.listTasksByTenant(account.id),
        ]);
        const canonicalKeys = new Set(templates.filter((t) => t.isCanonical).map((t) => t.key));
        if (canonicalKeys.size === 0) return false; // no checklist materialized yet — not done.
        const byKey = new Map(tasks.map((t) => [t.templateKey, t.status]));
        // Every canonical template must have a task that is done or skipped.
        for (const key of canonicalKeys) {
          const status = byKey.get(key);
          if (status !== "done" && status !== "skipped") return false;
        }
        return true;
      });
    },
  };
}

/** Build the live `TenantSupportSessionProvider` (§4.6) over `SupportRepository`. */
function buildSupportSessionProvider(deps: M34SeamRegistrationDeps): TenantSupportSessionProvider {
  return {
    async isActorInSupportSession(actorMembershipId, orgId) {
      return deps.runInOrgContext(orgId, async (tx) => {
        const account = await new TenantAccountRepository(tx).findByOrganizationId(orgId);
        if (!account) return false;
        const open = await new SupportRepository(tx).listOpenSessions(account.id);
        const now = new Date();
        return open.some(
          (s) =>
            s.actorMembershipId === actorMembershipId && s.expiresAt > now && s.closedAt === null,
        );
      });
    },
    async grantById(grantId): Promise<SupportConsentGrant | null> {
      // The §4.5 distinct-actor predicate resolves a grant by id; cross-tenant — withPlatformContext.
      return deps.runInPlatformContext(async (tx) => {
        const grant = await new SupportRepository(tx).findConsentGrantById(grantId);
        if (!grant) return null;
        return {
          grantorMembershipId: grant.grantorMembershipId,
          tenantAccountId: grant.tenantAccountId,
          expiresAt: grant.expiresAt,
        };
      });
    },
  };
}

/** Build the MANDATORY `TenantKeyProvider` (D5) over `TenantKeyRingRepository` + the injected KEK-unwrap port. */
export function buildKeyProvider(
  deps: Pick<M34SeamRegistrationDeps, "runInKeyRingContext" | "kekUnwrap">,
): TenantKeyProvider {
  const loadRing = (orgId: string) =>
    deps.runInKeyRingContext(orgId, (tx) =>
      new TenantKeyRingRepository(tx).findByOrganizationId(orgId),
    );
  return {
    async dekForOrg(orgId: string): Promise<TenantDek> {
      const ring = await loadRing(orgId);
      if (!ring) throw new TenantKeyMissing(orgId);
      // The destroyed-consistency CHECK guarantees ciphertext IS NULL exactly when destroyed_at IS NOT NULL.
      if (ring.destroyedAt !== null || ring.currentDekKekWrappedCiphertext === null) {
        throw new TenantKeyDestroyed(orgId);
      }
      if (ring.currentDekKekId === null) throw new TenantKeyMissing(orgId);
      const key = await deps.kekUnwrap.unwrap({
        organizationId: orgId,
        kekWrappedCiphertext: ring.currentDekKekWrappedCiphertext,
        kekId: ring.currentDekKekId,
      });
      return { version: ring.currentDekVersion, key };
    },
    async dekForOrgVersion(orgId: string, version: string): Promise<TenantDek> {
      const ring = await loadRing(orgId);
      if (!ring) throw new TenantKeyMissing(orgId);
      if (ring.destroyedAt !== null) throw new TenantKeyDestroyed(orgId);
      if (version === ring.currentDekVersion) {
        if (ring.currentDekKekWrappedCiphertext === null || ring.currentDekKekId === null) {
          throw new TenantKeyDestroyed(orgId);
        }
        const key = await deps.kekUnwrap.unwrap({
          organizationId: orgId,
          kekWrappedCiphertext: ring.currentDekKekWrappedCiphertext,
          kekId: ring.currentDekKekId,
        });
        return { version, key };
      }
      const priors = (ring.priorDekVersions ?? []) as readonly PriorDekVersionRow[];
      const prior = priors.find((p) => p.version === version);
      if (!prior) throw new TenantKeyVersionMissing(orgId, version);
      const key = await deps.kekUnwrap.unwrap({
        organizationId: orgId,
        kekWrappedCiphertext: Buffer.from(prior.kekWrappedCiphertext, "base64"),
        kekId: prior.kekId,
      });
      return { version, key };
    },
    async keyRingState(orgId: string): Promise<TenantKeyRingState> {
      const ring = await loadRing(orgId);
      if (!ring) return "absent";
      return ring.destroyedAt !== null ? "destroyed" : "active";
    },
  };
}

/**
 * Register M34's PACKAGE-OWNED seams over the bootstrap deny-stubs (Phase 2D). Builds the real
 * Drizzle-backed lifecycle / onboarding / support-session read providers + the MANDATORY D5
 * `TenantKeyProvider`, then hands them to `bootstrapModule34({ … })` (which `setX`-registers each + the
 * M34 self-shard). Call this from the composition root's `wireModuleSeams()`, BEFORE
 * `validateModule34Seams()` (which HARD-FAILS boot if the `TenantKeyProvider` is absent, D5). The
 * forward `TenantOrgCreationProvider` (M2) + the M35 entitlement reader keep their deny-stub defaults
 * until M2/M35 register the real providers.
 */
export function registerM34SeamProviders(deps: M34SeamRegistrationDeps): void {
  bootstrapModule34({
    tenantKeyProvider: buildKeyProvider(deps), // MANDATORY (D5) — validateModule34Seams() requires it.
    tenantLifecycleProvider: buildLifecycleProvider(deps),
    tenantOnboardingProvider: buildOnboardingProvider(deps),
    tenantSupportSessionProvider: buildSupportSessionProvider(deps),
    // M34's own export shard (the inverse-fan-out self-shard) over the Drizzle store (or the slice store).
    exportShard: createTenantExportShardForM34(
      deps.exportShardStore ?? createInMemoryM34ExportShardStore(),
    ),
    // The forward `TenantOrgCreationProvider` (M2 §2.5 r2 / §7.1 step 3) — registered EXPLICITLY as the
    // deny-stub so the provision worker's `ensureOrganization` port resolves `{ kind: 'unavailable' }`
    // (degrades cleanly, never fabricates an org id) until M2 locks its `createOrganization` surface and
    // registers the real provider over it. TODO(M2): bind M2's createOrganization seam here (no new M34
    // dependsOn edge — the M2 edge already exists; this is reached through the package's own registry).
    tenantOrgCreationProvider: denyStubTenantOrgCreationProvider,
  });
}
