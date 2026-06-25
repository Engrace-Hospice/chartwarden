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
//     org-pooled db + the tenant queue producer + the injected clock — are all available), and the §4.3
//     queue PRODUCERS (BullMQ `Queue.add`, when a Valkey connection is configured).
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

import { type M34QueueName, M34_QUEUES } from "./jobs/index";
import type { M34WorkerDeps } from "./jobs/saas-jobs";
import type { TenantPlatformRouteService } from "./routes/platform/service";
import type { EnqueuePort as PlatformEnqueuePort } from "./routes/platform/service";
import {
  type DrizzleTenantPlatformDeps,
  type FeatureFlagAdminPort,
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
export class M34InfraPortUnbound extends Error {
  constructor(port: string, reason: string) {
    super(`M34 Phase-2D infra port '${port}' is not bound to a real adapter: ${reason}`);
    this.name = "M34InfraPortUnbound";
  }
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
}): void {
  const kekUnwrap: KekUnwrapPort = {
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
}): { service: TenantPlatformRouteService } {
  const outbox: OutboxPublishPort = {
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
  const drizzleDeps: DrizzleTenantPlatformDeps = {
    platformDb: deps.platformDb,
    enqueue: deps.enqueue,
    auditBypass: deps.auditBypass,
    outbox,
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
 * runs inside the tenant's OWN `withOrgContext` (F09 — the DSAR adapter never bypasses), so all deps here
 * are LIVE except `presign`.
 *
 * TYPED-TODO: `presign` (the M1 MinIO/S3 24h signed-download mint, SEC-052) fails closed — only the
 * fulfilled-bundle download-URL routes touch it; the common read/command path is fully live.
 */
export function buildDrizzleTenantService(deps: {
  db: DbClient;
  enqueue: TenantEnqueuePort;
}): { service: TenantRouteService } {
  const presign: PresignDownloadPort = {
    async presign() {
      throw new M34InfraPortUnbound(
        "presign",
        "bind the M1 MinIO/S3 24h signed-download mint (SEC-052) — no object-store seam accessor yet",
      );
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
}): M34WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    platformDb: deps.platformDb,
    now: () => new Date(),
  };
}
