// apps/backend/src/modules/34-saas-tenant-platform/wiring.ts — M34 Phase-2D LIVE composition glue.
//
// The one place the composition root (apps/backend/src/index.ts) assembles M34's real dependencies:
//   1. the §4.6 seam providers (the MANDATORY D5 `TenantKeyProvider` + lifecycle/onboarding/support
//      reads) over the real §3 repositories, bound to M1's `withOrgContext`/`withPlatformContext` runners;
//   2. the Drizzle-backed route services (platform-ops + tenant-scoped) the route plugins mount over;
//   3. the §4.3 BullMQ worker-trigger `EnqueuePort`s (the queue producers the command routes enqueue onto);
//   4. the §4.3 worker deps (the Valkey connection + the org/platform DB handles the live workers bind).
//
// BOUNDARY (M34 dependsOn [1,2,3,4,36] — no new edge): everything cross-module is reached through the
// foundation helpers M1 owns (`@wardenx/tenancy` withOrgContext/withPlatformContext, `@wardenx/db`) or a
// PORT this file binds to a typed-TODO until the owning module exposes a boot accessor. Nothing here adds
// a direct M1/M2/M4/M22/M36 import beyond those foundation helpers.
//
// WHAT IS LIVE vs TYPED-TODO (the honest seam map — see the per-port TODOs):
//   • LIVE now: the D5 key provider (over `TenantKeyRingRepository` + an injected KEK-unwrap port), the
//     lifecycle/onboarding/support read providers, the tenant-scoped Drizzle route service (its deps —
//     org-pooled db + the tenant queue producer + the injected clock — are all available), and §4.3 queue
//     producer construction. Enqueue remains capability-disabled until every mandatory worker port is live.
//   • TYPED-TODO (genuinely-missing infra accessors at the composition root — each FAILS CLOSED, never a
//     silent no-op): the M1 KEK/KMS unwrap adapter, the M4 `platform.bypass_invoked` auditor, the live
//     transactional-outbox dispatcher, the M1 `FeatureFlagAdmin` seam, the M36 alert router, and the
//     M1 MinIO presign/object-store seam. Until these land, the platform-ops route service + the worker
//     ports that need them fail closed (a 5xx / a typed throw), which is the correct posture for an
//     unaudited cross-tenant read or an unbacked irreversible effect.
import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";

import type { DbClient } from "@wardenx/db";
import {
  type PlatformBypassAuditor,
  registerPlatformJob,
  withOrgContext,
  withPlatformContext,
} from "@wardenx/tenancy";
import { DegradedError, type SignedUrlDescriptor } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";

/**
 * §11 D1 — one bucket per tenant: `tenant-{tenantId}`. GAP-048: mirrors M22's `deriveTenantBucket`
 * (`apps/backend/src/modules/22-documents/lifecycle/storage.ts`) byte-for-byte — M22's own comment calls
 * that function "the only place this string is shaped", but M34's module folder cannot import M22's
 * implementation path (module-boundary discipline, ADR-0005 D1 — only `getSeam("DocumentStorageProvider")`
 * itself, a `@wardenx/types` leaf value, is reachable). Deliberately duplicated rather than promoted to a
 * shared leaf package for one call site; if a second module needs this, promote it instead of triplicating.
 */
function m34DsarDeriveTenantBucket(organizationId: string): string {
  return `tenant-${organizationId}`;
}

import { type M34QueueName, M34_QUEUES } from "./jobs/index";
import type { M34WorkerDeps } from "./jobs/saas-jobs";
import type { TenantPlatformRouteService } from "./routes/platform/service";
import type { EnqueuePort as PlatformEnqueuePort } from "./routes/platform/service";
import {
  type DrizzleTenantPlatformDeps,
  type FeatureFlagAdminPort,
  type OrganizationProvisionPort,
  type OutboxPublishPort,
  type PlatformTx,
  createDrizzleTenantPlatformBackend,
} from "./routes/platform/service-drizzle";
import type { EnqueuePort as TenantEnqueuePort } from "./routes/tenant/service";
import type { TenantRouteService } from "./routes/tenant/service";
import {
  type DrizzleTenantRouteDeps,
  type PresignDownloadPort,
  createDrizzleTenantBackend,
} from "./routes/tenant/service-drizzle";
import {
  type KekUnwrapPort,
  type M34SeamRegistrationDeps,
  registerM34SeamProviders,
} from "./seam-registration";

/**
 * The registered platform-job id M34's platform-ops route service + its platform-scoped workers enter
 * `withPlatformContext` under. Registered on the `@wardenx/tenancy` allowlist by {@link wireM34Tenancy}
 * at boot — until then `withPlatformContext` REFUSES the caller (fail-closed; the allowlist starts empty).
 */
export const M34_PLATFORM_JOB_ID = "m34.platform_ops";

/** Raised by a still-unbound Phase-2D infra port (the fail-closed signal — never a silent no-op). */
export class M34InfraPortUnbound extends DegradedError {
  constructor(port: string, reason: string) {
    super("m34-worker-capability", `Phase-2D infra port '${port}' is not bound: ${reason}`);
    this.name = "M34InfraPortUnbound";
  }
}

/** No M34 async capability is production-ready while its required adapters remain deny-stubs. */
const READY_M34_JOB_CAPABILITIES = new Set<M34QueueName>();

/** Enable only capabilities whose complete worker dependency set has been assembled at boot. */
export function enableM34JobCapability(queue: M34QueueName): void {
  READY_M34_JOB_CAPABILITIES.add(queue);
}

export function assertM34JobCapability(queue: M34QueueName | string): void {
  if (READY_M34_JOB_CAPABILITIES.has(queue as M34QueueName)) return;
  throw new M34InfraPortUnbound(
    `job.${queue}`,
    "the worker's database, object storage, cryptography, audit, and notification ports are not fully bound",
  );
}

// ── tenancy allowlist registration (must run before any withPlatformContext entry) ────────────────────

/**
 * Register M34's platform job ids on the `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the platform-ops
 * route service + the platform-scoped workers (provision / dek-rotate / shred / the platform sweeps) may
 * enter `withPlatformContext` (the allowlist starts empty — fail-closed). Idempotent (`Set.add`).
 */
export function wireM34Tenancy(): void {
  registerPlatformJob(M34_PLATFORM_JOB_ID);
}

// ── (1) seam providers (the MANDATORY D5 key provider + the lifecycle/onboarding/support reads) ────────

/**
 * Build {@link M34SeamRegistrationDeps} over the org-pooled Drizzle client + M1's tenancy runners, then
 * register the real providers over the bootstrap deny-stubs. The org runner binds `withOrgContext`; the
 * platform runner binds `withPlatformContext` under {@link M34_PLATFORM_JOB_ID}.
 *
 * TODO(integrator — KEK/KMS): `kekUnwrap` is the ONLY genuinely-missing dep here. M34's package holds no
 * KMS knowledge (no `dependsOn` edge), so the real KEK adapter (M1 infra) binds here when it lands. Until
 * then it FAILS CLOSED on call — `validateModule34Seams()` still passes (it only requires the provider be
 * REGISTERED, not that a live key resolve succeed), so boot is clean and a PHI-key resolve denies loudly.
 */
export function registerLiveM34Seams(deps: {
  db: DbClient;
  auditBypass: PlatformBypassAuditor<PlatformTx>;
  kekUnwrap?: KekUnwrapPort;
}): void {
  const kekUnwrap: KekUnwrapPort = deps.kekUnwrap ?? {
    async unwrap() {
      throw new M34InfraPortUnbound(
        "kekUnwrap",
        "bind the M1 KEK/KMS unwrap adapter (the §3.3 per-tenant DEK wrap/unwrap) — no boot accessor yet",
      );
    },
  };
  const seamDeps: M34SeamRegistrationDeps = {
    db: deps.db,
    runInOrgContext: (orgId, fn) =>
      withOrgContext(deps.db, { organizationId: orgId, userId: M34_PLATFORM_JOB_ID }, fn),
    runInPlatformContext: (fn) =>
      withPlatformContext(
        deps.db,
        { jobId: M34_PLATFORM_JOB_ID, reason: "m34 platform-ops seam read", crossTenant: true },
        deps.auditBypass,
        fn,
      ),
    kekUnwrap,
  };
  registerM34SeamProviders(seamDeps);
}

// ── (3) the §4.3 queue producers (the EnqueuePorts the command routes enqueue onto) ───────────────────

/**
 * Build the PLATFORM `EnqueuePort` (the §4.1 platform-ops command routes call this). When a Valkey
 * connection is configured it produces onto the named BullMQ `Queue`; without one it fails closed (a
 * command route cannot silently drop a provision/shred enqueue). Returns the `Queue`s for `close()`.
 */
export function buildPlatformEnqueue(connection: ConnectionOptions | undefined): {
  enqueue: PlatformEnqueuePort;
  queues: Queue[];
} {
  if (!connection) {
    return {
      enqueue: {
        async enqueue(queue) {
          assertM34JobCapability(queue);
          throw new M34InfraPortUnbound(
            "platformEnqueue",
            `no Valkey connection configured — cannot enqueue '${queue}' (set the queue connection at boot)`,
          );
        },
      },
      queues: [],
    };
  }
  const cache = new Map<M34QueueName, Queue>();
  const queueFor = (name: M34QueueName): Queue => {
    let q = cache.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      cache.set(name, q);
    }
    return q;
  };
  const enqueue: PlatformEnqueuePort = {
    async enqueue(queue, jobKey, payload) {
      assertM34JobCapability(queue);
      if (queue === M34_QUEUES.provision) {
        return { jobId: `outbox:${jobKey}` };
      }
      const job = await queueFor(queue).add(queue, payload, {
        jobId: `${queue}:${jobKey}`,
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      });
      return { jobId: job.id ?? `${queue}:${jobKey}` };
    },
  };
  return { enqueue, queues: [...cache.values()] };
}

/**
 * Build the TENANT `EnqueuePort` (the §4.1 tenant-scoped DSAR/tenant-export command routes call this).
 * BullMQ producer when a Valkey connection is configured; fail-closed otherwise (no dropped DSAR job).
 * The tenant queue producer shares the same `Queue` cache by name, so the worker side dedups on jobId.
 */
export function buildTenantEnqueue(connection: ConnectionOptions | undefined): {
  enqueue: TenantEnqueuePort;
  queues: Queue[];
} {
  if (!connection) {
    return {
      enqueue: {
        async enqueue(queue) {
          assertM34JobCapability(queue);
          throw new M34InfraPortUnbound(
            "tenantEnqueue",
            `no Valkey connection configured — cannot enqueue '${queue}'`,
          );
        },
      },
      queues: [],
    };
  }
  const cache = new Map<string, Queue>();
  const queueFor = (name: string): Queue => {
    let q = cache.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      cache.set(name, q);
    }
    return q;
  };
  const enqueue: TenantEnqueuePort = {
    async enqueue(queue, payload) {
      assertM34JobCapability(queue);
      await queueFor(queue).add(queue, payload, {
        jobId: `${queue}:${payload.jobId}`,
        removeOnComplete: { count: 200 },
        removeOnFail: false,
      });
    },
  };
  return { enqueue, queues: [...cache.values()] };
}

// ── (2) the Drizzle-backed route services (platform-ops + tenant-scoped) ──────────────────────────────

/**
 * Build the production platform-ops `TenantPlatformRouteService` over the platform-pooled Drizzle client.
 * READ/LIST routes run live (cross-tenant reads under `withPlatformContext`); command routes run the §2.2
 * lifecycle machine + enqueue the §4.3 worker job + emit the catalog outbox — all in one platform tx.
 *
 * TYPED-TODO infra ports (each FAILS CLOSED — see the named seams): `auditBypass` (M4
 * `platform.bypass_invoked` emitter), `outbox` (the live transactional-outbox dispatcher), `featureFlags`
 * (M1's `FeatureFlagAdmin` seam), and the support-session side-effect ports (M4 audit / outbox / M36
 * alert). A fail-closed auditor means the platform-ops surface 5xxs rather than serving an UNAUDITED
 * cross-tenant read — the correct posture until M4 exposes the bypass-auditor handle.
 */
export function buildDrizzlePlatformService(deps: {
  platformDb: DbClient;
  enqueue: PlatformEnqueuePort;
  auditBypass: PlatformBypassAuditor<PlatformTx>;
  /** #107 — the live transactional-outbox publisher (callerModule-pinned 'm34'). When omitted the lifecycle
   *  outbox stays fail-closed (the §2.5 emit throws, never a silent no-op). */
  outbox?: OutboxPublishPort;
}): { service: TenantPlatformRouteService } {
  const outbox: OutboxPublishPort = deps.outbox ?? {
    async publish(_tx, input) {
      throw new M34InfraPortUnbound(
        "outbox.publish",
        `bind the live transactional-outbox dispatcher (event '${input.eventName}') — no boot accessor yet`,
      );
    },
  };
  const featureFlags: FeatureFlagAdminPort = {
    async list() {
      throw new M34InfraPortUnbound(
        "featureFlags.list",
        "bind M1's FeatureFlagAdmin seam (§4.7 / D13) — M1 owns the schema; no boot accessor yet",
      );
    },
    async upsert() {
      throw new M34InfraPortUnbound("featureFlags.upsert", "bind M1's FeatureFlagAdmin seam (D13)");
    },
    async setKillSwitch() {
      throw new M34InfraPortUnbound(
        "featureFlags.setKillSwitch",
        "bind M1's FeatureFlagAdmin seam (D13)",
      );
    },
  };
  const organizations: OrganizationProvisionPort = {
    async ensure(input) {
      const result = await getSeam("TenantOrgCreationProvider").createOrganizationForTenant(input);
      if (result.kind === "available") return { organizationId: result.organizationId };
      throw new M34InfraPortUnbound(
        "organizations.ensure",
        `M2 TenantOrgCreationProvider returned '${result.reason}'`,
      );
    },
  };
  const drizzleDeps: DrizzleTenantPlatformDeps = {
    platformDb: deps.platformDb,
    enqueue: deps.enqueue,
    auditBypass: deps.auditBypass,
    outbox,
    organizations,
    featureFlags,
    supportSessionPorts: {
      audit: {
        async emitCriticalAudit() {
          throw new M34InfraPortUnbound(
            "supportSession.audit",
            "bind the M4 critical-audit emitter (§7.4)",
          );
        },
      },
      outbox: {
        async publish() {
          throw new M34InfraPortUnbound(
            "supportSession.outbox",
            "bind the live transactional-outbox dispatcher",
          );
        },
      },
      alerts: {
        async emitAlert() {
          throw new M34InfraPortUnbound(
            "supportSession.alerts",
            "bind the M36 alert router (§7.4 grantor notification)",
          );
        },
      },
      now: () => new Date(),
    },
    platformJobId: M34_PLATFORM_JOB_ID,
  };
  return createDrizzleTenantPlatformBackend(drizzleDeps);
}

/**
 * Build the production tenant-scoped `TenantRouteService` over the org-pooled Drizzle client. EVERY method
 * runs inside the tenant's OWN `withOrgContext` (F09 — the DSAR adapter never bypasses).
 *
 * GAP-048: `presign` (the 24h signed-download mint, SEC-052) is now LIVE — bound to
 * `getSeam("DocumentStorageProvider")`, the same real MinIO/S3 SigV4 presign M22 already exercises for its
 * own document downloads (`apps/backend/src/modules/22-documents/seams/storage-provider.ts`). The SigV4
 * layer's own hard ceiling is 7 days (`MAX_PRESIGN_TTL_SECONDS`), well above the 24h SEC-052 floor, so the
 * caller's `ttlSeconds` reaches the real signer unclamped (M22's OWN `planSignedUrl` pure-planning helper
 * imposes a SEPARATE, much shorter 300s ceiling for its interactive chart-viewer use case — that ceiling is
 * a document-viewer policy, not a presign-mechanism limit, so this adapter builds its own
 * `SignedUrlDescriptor` directly rather than routing through `planSignedUrl`). `disclosure_export` is the
 * §164.528 accounting-of-disclosures access kind — the correct classification for a DSAR/tenant-export
 * bundle download, distinct from routine chart access kinds.
 */
export function buildDrizzleTenantService(deps: {
  db: DbClient;
  enqueue: TenantEnqueuePort;
}): { service: TenantRouteService } {
  const presign: PresignDownloadPort = {
    async presign(organizationId, objectKey, ttlSeconds) {
      const descriptor: SignedUrlDescriptor = {
        bucket: m34DsarDeriveTenantBucket(organizationId),
        objectKey,
        ttlSeconds,
        accessKind: "disclosure_export",
      };
      const { url, expiresAt } = await getSeam("DocumentStorageProvider").presignDownload({
        descriptor,
        organizationId,
      });
      return { url, expiresAt: new Date(expiresAt) };
    },
  };
  const drizzleDeps: DrizzleTenantRouteDeps = {
    db: deps.db,
    enqueue: deps.enqueue,
    presign,
    now: () => new Date(),
  };
  return createDrizzleTenantBackend(drizzleDeps);
}

// ── (4) the worker deps (the Valkey connection + the DB handles the live workers bind) ────────────────

/**
 * Assemble {@link M34WorkerDeps} for the live worker construction. `platformDb` is the same handle in a
 * single-pool dev boot; the integrator passes M1's separately-pooled platform credential when it lands.
 */
export function buildM34WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  platformDb?: DbClient;
  provision?: M34WorkerDeps["provision"];
  keyLifecycle?: M34WorkerDeps["keyLifecycle"];
  dsarExport?: M34WorkerDeps["dsarExport"];
  tenantExport?: M34WorkerDeps["tenantExport"];
}): M34WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    platformDb: deps.platformDb,
    provision: deps.provision,
    keyLifecycle: deps.keyLifecycle,
    dsarExport: deps.dsarExport,
    tenantExport: deps.tenantExport,
    now: () => new Date(),
  };
}
