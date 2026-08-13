import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { audit } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
// apps/backend/src/modules/34-saas-tenant-platform/jobs/saas-jobs.ts — M34 Phase 2D LIVE BullMQ wiring
// for the §4.3 jobs. The thin, infra-touching adapter that turns the @wardenx/saas-tenant-platform pure
// workers (catalog in ./index.ts) into running BullMQ `Worker`s + the four cron-schedule `Queue`s. All job
// LOGIC lives in the package (unit-tested against in-memory ports); this module only constructs
// `Worker`/`Queue` over a Valkey connection and BINDS each worker's PORTS to real adapters — repos under
// withOrgContext/withPlatformContext, the M1 SECURITY DEFINER key-ring fns via `db.execute`, the M4
// destruction-cert registry / M1 MinIO seam / M22 outbox handshake / M36 alert engine via the injected
// dep bag. Mirrors apps/backend/src/modules/04-audit/jobs/audit-jobs.ts EXACTLY (the worker-construction
// template: `new Worker(queue, processor, { connection })` + `new Queue(...)`; injected connection; the
// caller owns lifecycle/close). Nothing here is invoked at import — constructing a Worker is what opens the
// Valkey connection, and that happens only inside these functions (never in tests / at module load).
//
// IMPORTANT (per the Phase-2D split): this file BUILDS the adapters + the workers; it does NOT mount them
// into the app. The Integration agent calls `registerM34Workers` / `scheduleM34Jobs` from the composition
// root once the Valkey connection + the missing M1 infra seams (MinIO/envelope, the platform-DB pool, the
// live outbox dispatcher, the programmatic M36 alert router) are available. Until then the bindable ports
// are bound and the genuinely-missing ones carry a typed TODO + a fail-closed throw (never a silent no-op).
//
// SAFETY INVARIANTS (M34-F08 / F09 / §3.5):
//   • the shred DESTROY port goes through the `m34_destroy_tenant_key_ring` SECURITY DEFINER fn (never a
//     direct ciphertext null) AND through the M4 destruction-cert registry (no bypass) — both are PORTS
//     this file binds; it never short-circuits either.
//   • the DSAR / tenant-export / onboarding / bundle-sweep workers run under the REQUESTING tenant's
//     `withOrgContext` (F09) — the per-job scope is read from {@link M34_QUEUE_SCOPE}; this file wraps the
//     port-binding + the worker call in that envelope, never a platform bypass for an org-scoped job.
import {
  DsarExportRepository,
  OnboardingRepository,
  TenantAccountRepository,
  TenantExportRepository,
  TenantKeyRingRepository,
  transitionTenant,
} from "@wardenx/saas-tenant-platform";
import type {
  BundleExpirySweepPorts,
  DekRotateWorkerPorts,
  DsarDocumentUploadRequest,
  DsarExportJobInput,
  DsarExportWorkerPorts,
  OnboardingAdvancePorts,
  ProvisionWorkerPorts,
  ShredDestructivePort,
  ShredEraserCallbackPort,
  ShredWorkerPorts,
  TenantExportJobBody,
  TenantExportWorkerPorts,
} from "@wardenx/saas-tenant-platform";
import { listTenantExportShards } from "@wardenx/saas-tenant-platform";
import { type PlatformBypassAuditor, withOrgContext, withPlatformContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import { createTenantShredEraserCallback } from "../shred-eraser-adapter";
import { assertM34ShredPreflight } from "../shred-preflight";
import { createTenantExportBundleSink } from "../tenant-export-bundle-sink";
import {
  M34_JOB_SCHEDULES,
  M34_QUEUES,
  type OnboardingAdvanceJob,
  bundleExpirySweepProcessor,
  dekRotateProcessor,
  dsarExportProcessor,
  onboardingAdvanceProcessor,
  provisionProcessor,
  shredProcessor,
  tenantExportProcessor,
} from "./index";

// ── the dep bag the composition root injects (the bindable infra + the still-missing seams) ────────────

/**
 * The dependencies the live M34 worker wiring binds the §2B worker ports over. The Integration agent
 * supplies these at the composition root. Each maps onto the SAME interfaces the package workers already
 * take — this file's job is to BIND them (it never rewrites a worker).
 *
 * The shapes typed here are the ones already available in the repo today (the Drizzle client, the Valkey
 * connection). The cross-module infra a worker also needs (the M1 MinIO/envelope helper, the M4
 * destruction-cert callback registry, the live outbox dispatcher, the programmatic M36 alert router, the
 * separately-pooled platform DB) does NOT have a stable accessor yet — those are optional here and, where
 * absent, the corresponding port throws a typed `M34WorkerPortUnbound` rather than silently no-op'ing.
 */
export interface M34WorkerDeps {
  /** The Valkey/Redis connection the `Worker`/`Queue` open over (injected, same as M4-T11 audit-jobs). */
  readonly connection: ConnectionOptions;
  /** The org-scoped Drizzle client the repos run under (wrapped per-job in withOrgContext, F09). */
  readonly db: DbClient;
  /**
   * The separately-pooled, RLS-bypass platform DB client for the platform-scoped jobs (provision /
   * dek-rotate / shred / the platform sweeps). TODO(integrator): pass M1's platform pool here; until it is
   * available the platform jobs use `db` (which is fine in a single-pool dev boot but is NOT the audited
   * cross-tenant pool the spec mandates — F03/F09). Left optional so a dev boot wires without it.
   */
  readonly platformDb?: DbClient;
  /** Complete provision capability. Omit any part and `tenant.provision` remains disabled. */
  readonly provision?: {
    readonly auditBypass: PlatformBypassAuditor<DbClient>;
    readonly keyMaterial: {
      mintAndWrapDek(input: { readonly organizationId: string }): Promise<{
        readonly wrappedCiphertextB64: string;
        readonly kekId: string;
      }>;
    };
    readonly storage: {
      ensureTenantPrefixes(input: {
        readonly organizationId: string;
        readonly prefixes: readonly string[];
      }): Promise<{ readonly prefixesEnsured: readonly string[] }>;
    };
    readonly invitation: {
      send(input: {
        readonly to: string;
        readonly inviteeFullName: string;
        readonly invitationUrl: string;
        readonly expiresAt: Date;
      }): Promise<void>;
      readonly acceptBaseUrl: string;
    };
    readonly outbox: {
      publish(
        tx: DbClient,
        input: {
          readonly eventName: string;
          readonly organizationId: string;
          readonly aggregateKind: string;
          readonly aggregateId: string;
          readonly payload: Record<string, unknown>;
        },
      ): Promise<void>;
    };
  };
  /** Complete key-lifecycle capability. Omit it and rotation/shred remain capability-disabled. */
  readonly keyLifecycle?: {
    readonly auditBypass: PlatformBypassAuditor<DbClient>;
    readonly keyMaterial: NonNullable<M34WorkerDeps["provision"]>["keyMaterial"];
    readonly storage: {
      destroyTenantScope(input: {
        readonly organizationId: string;
      }): Promise<{ readonly prefix: string; readonly objectsDeleted: number }>;
    };
    readonly outbox: NonNullable<M34WorkerDeps["provision"]>["outbox"];
    destroyTenantKeyRing(input: {
      readonly tenantAccountId: string;
      readonly destructionCertId: string;
      readonly actorMembershipId: string;
    }): Promise<void>;
    readonly destructionWorkflow: {
      authorizationFacts(
        tx: DbClient,
        input: {
          readonly orgId: string;
          readonly destructionCertId: string;
          readonly actorMembershipId: string;
        },
      ): Promise<{
        readonly certificate: {
          readonly organizationId: string;
          readonly status: string;
          readonly method: string;
          readonly approvedBy: string | null;
        } | null;
        readonly activeLegalHold: boolean;
        readonly actorUserId: string | null;
      }>;
      recordCertificateRefusal(
        tx: DbClient,
        input: Parameters<ShredEraserCallbackPort["recordCertificateRefusal"]>[0],
      ): Promise<void>;
      fileCertificate(
        tx: DbClient,
        input: Parameters<ShredEraserCallbackPort["fileCertificate"]>[0],
      ): Promise<void>;
    };
    readonly shredSubjects: {
      patientIds(tx: DbClient, orgId: string): Promise<readonly string[]>;
      soleTenantUserIds(tx: DbClient, orgId: string): Promise<readonly string[]>;
    };
  };
  /** Injected clock (deterministic in tests; the package workers stamp every instant through this). */
  now?: () => Date;
  /** GAP-048: the DSAR-export worker's object-store + render capability. Omit and `tenant.dsar_export`
   *  stays capability-disabled on `sealBundle`/`renderBundleDocument`/`publishOutbox` (never a silent
   *  no-op — each throws `M34WorkerPortUnbound` naming exactly what's missing). The composition root
   *  adapts M22's real `ObjectStorePort`/`DocumentRenderer` seam so M34's own module folder never imports
   *  M22 directly (module-boundary discipline, ADR-0005 D1 — this dep bag is the seam-equivalent glue). */
  readonly dsarExport?: {
    readonly objectStore: {
      putObject(args: {
        readonly organizationId: string;
        readonly objectKey: string;
        readonly bytes: Uint8Array;
      }): Promise<{ readonly sha256Hex: string }>;
    };
    readonly render: {
      render(args: DsarDocumentUploadRequest): Promise<{ readonly documentId: string }>;
    };
    readonly outbox: NonNullable<M34WorkerDeps["provision"]>["outbox"];
  };
  /**
   * Complete tenant-export capability (GAP-094, the `tenant.export` sibling of `dsarExport` above — SAME
   * shape, minus an outbox port: the cover-letter render binds directly, never through the dead
   * `m22.document.upload_requested` event). Omit and `tenant.export` stays unconstructed (no Worker at
   * all, same posture as every other optional dep bag here).
   */
  readonly tenantExport?: {
    readonly objectStore: {
      putObject(args: {
        readonly organizationId: string;
        readonly objectKey: string;
        readonly bytes: Uint8Array;
      }): Promise<{ readonly sha256Hex: string }>;
    };
    readonly render: {
      /** `aggregateId` is the tenant-export job id — the M22 `DocumentRenderer`'s required back-ref
       *  identity (`RenderPayloadCore.aggregateId`), mirroring `DsarDocumentUploadRequest.aggregateId`. */
      render(args: {
        readonly organizationId: string;
        readonly aggregateId: string;
        readonly bundleSha256: string;
      }): Promise<{ readonly documentId: string }>;
    };
  };
}

/** Raised when a worker port could not be bound to a real adapter (the missing-infra fail-closed signal).
 *  Surfacing it (vs a silent no-op) keeps a half-wired worker from running an irreversible effect blind. */
export class M34WorkerPortUnbound extends Error {
  constructor(port: string, reason: string) {
    super(`M34 worker port '${port}' is not bound to a real adapter: ${reason}`);
    this.name = "M34WorkerPortUnbound";
  }
}

const unbound = (port: string, reason: string): never => {
  throw new M34WorkerPortUnbound(port, reason);
};

// ── the per-queue port bundles (bind what we can; throw-on-call for the genuinely-missing infra) ────────

/**
 * Build every §2B worker's port bundle from {@link M34WorkerDeps}. Pure assembly — no `Worker`/`Queue`
 * here, so the binding is unit-inspectable. The BINDABLE ports (the repos + the SECURITY DEFINER key-ring
 * fns, reached through `db.execute(sql\`SELECT …\`)`) are wired to real adapters; the still-missing
 * cross-module infra ports carry a typed `M34WorkerPortUnbound` throw + a TODO naming the integrator's seam.
 *
 * NB: the per-job tenancy envelope (withOrgContext for the org-scoped jobs / withPlatformContext for the
 * platform jobs, {@link M34_QUEUE_SCOPE}) is applied by the WORKER closure below — the repos issue plain
 * Drizzle inside whichever transaction the envelope opens. Here we hand the repos the base client; the
 * envelope is the worker's job (mechanism-vs-policy: the worker owns the RLS envelope, F09).
 */
export function buildM34WorkerPorts(deps: M34WorkerDeps): {
  provision: ProvisionWorkerPorts;
  dekRotate: DekRotateWorkerPorts;
  shred: ShredWorkerPorts;
  dsarExport: DsarExportWorkerPorts;
  tenantExport: TenantExportWorkerPorts;
  onboardingAdvance: OnboardingAdvancePorts;
  bundleExpirySweep: BundleExpirySweepPorts;
} {
  const now = deps.now ?? (() => new Date());
  const db = deps.db;
  const platformDb = deps.platformDb ?? deps.db;

  const keyRingRepo = new TenantKeyRingRepository(platformDb);
  const tenantExportRepo = new TenantExportRepository(db);

  const inProvisionPlatform = <T>(reason: string, fn: (tx: DbClient) => Promise<T>): Promise<T> => {
    if (!deps.provision) {
      return Promise.reject(
        new M34WorkerPortUnbound("provision", "the complete provision capability was not supplied"),
      );
    }
    // Provisioning touches only M34 control-plane rows, each resolved from the job's tenant account;
    // its persisted organization_id = the trusted organization in the provision command. No clinical
    // or patient table is read through this platform-bypass helper.
    return withPlatformContext(
      platformDb,
      { jobId: "m34.platform_ops", reason, crossTenant: true },
      deps.provision.auditBypass,
      fn,
    );
  };

  const inProvisionOrg = <T>(
    organizationId: string,
    fn: (tx: DbClient) => Promise<T>,
  ): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as unknown as DbClient));

  const requireKeyLifecycle = (): NonNullable<M34WorkerDeps["keyLifecycle"]> => {
    if (!deps.keyLifecycle) {
      return unbound(
        "keyLifecycle",
        "audit, KMS, object-storage destruction, and outbox adapters are all required",
      );
    }
    return deps.keyLifecycle;
  };

  // ── tenant.provision ────────────────────────────────────────────────────────────────────────────────
  // The key-ring step IS bindable now (the m34_provision_tenant_key_ring SECURITY DEFINER fn); the M1
  // MinIO prefix ensure, the M2 org confirm, the onboarding-task materialize, the M36 invitation email,
  // and the lifecycle commit need seams/the outbox dispatcher the integrator wires.
  const provision: ProvisionWorkerPorts = {
    now,
    currentStatus: (tenantAccountId) =>
      inProvisionPlatform(
        "m34 tenant provision status",
        async (tx) =>
          (await new TenantAccountRepository(tx).findById(tenantAccountId))?.status ?? null,
      ),
    async ensureTenantKeyRing({ tenantAccountId, organizationId }) {
      return inProvisionPlatform("m34 tenant provision key ring", async (tx) => {
        const repo = new TenantKeyRingRepository(tx);
        const existing = await repo.findByTenantAccountId(tenantAccountId);
        if (existing !== null) return { tenantKeyRingId: existing.id };
        if (!deps.provision) return unbound("provision.keyMaterial", "capability missing");
        const wrapped = await deps.provision.keyMaterial.mintAndWrapDek({ organizationId });
        await tx.execute(
          sql`SELECT set_config('app.dek_kek_wrapped_ciphertext_b64', ${wrapped.wrappedCiphertextB64}, true), set_config('app.dek_kek_id', ${wrapped.kekId}, true)`,
        );
        const rows = await tx.execute<{ m34_provision_tenant_key_ring: string }>(
          sql`SELECT m34_provision_tenant_key_ring(${tenantAccountId}) AS m34_provision_tenant_key_ring`,
        );
        const id = rows.rows[0]?.m34_provision_tenant_key_ring;
        if (!id)
          return unbound("provision.ensureTenantKeyRing", "key-ring function returned no id");
        return { tenantKeyRingId: id };
      });
    },
    ensureTenantStoragePrefixes: (input) => {
      if (!deps.provision)
        return Promise.reject(new M34WorkerPortUnbound("provision.storage", "capability missing"));
      return deps.provision.storage.ensureTenantPrefixes(input);
    },
    // M34 §7.1 step 3 — BOUND to M2's TenantOrgCreationProvider seam (M2 registers the real Drizzle-backed
    // provider at init; the registry's deny-stub returns `unavailable` until then). Idempotent confirm in
    // Phase 1 (org pre-created by the route); the create branch backs Phase-3 self-serve. Fails closed
    // (throws) on `unavailable` — provision never proceeds without a real org id.
    ensureOrganization: async (input) => {
      const result = await getSeam("TenantOrgCreationProvider").createOrganizationForTenant(input);
      if (result.kind === "available") return { organizationId: result.organizationId };
      throw new M34WorkerPortUnbound(
        "provision.ensureOrganization",
        `M2 TenantOrgCreationProvider resolved '${result.reason}' — M2 has not registered the real provider yet`,
      );
    },
    materializeOnboardingTasks: ({ tenantAccountId, organizationId }) =>
      inProvisionOrg(organizationId, async (tx) => {
        const repo = new OnboardingRepository(tx);
        const [templates, existing] = await Promise.all([
          repo.listTemplates(),
          repo.listTasksByTenant(tenantAccountId),
        ]);
        const existingKeys = new Set(existing.map((task) => task.templateKey));
        const rows = templates
          .filter((template) => !existingKeys.has(template.key))
          .map((template) => ({
            organizationId,
            tenantAccountId,
            templateKey: template.key,
            status: "pending" as const,
            dueAt: new Date(
              now().getTime() + template.defaultDueDaysAfterProvisioning * 86_400_000,
            ),
          }));
        return { materialized: (await repo.createTasks(rows)).length };
      }),
    ensureFirstAdminInvitation: (input) =>
      inProvisionPlatform("m34 tenant provision first-admin invitation", async (tx) => {
        if (!deps.provision) return unbound("provision.invitation", "capability missing");
        const repo = new TenantAccountRepository(tx);
        const existing = (await repo.listInvitations(input.tenantAccountId)).find(
          (invite) =>
            invite.status === "pending" &&
            invite.expiresAt > now() &&
            invite.inviteeEmail.toLowerCase() === input.inviteeEmail.toLowerCase(),
        );
        if (existing) return { invitationId: existing.id };

        const rawToken = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");
        const invitationUrl = `${deps.provision.invitation.acceptBaseUrl.replace(/\/$/, "")}/${rawToken}`;
        await deps.provision.invitation.send({
          to: input.inviteeEmail,
          inviteeFullName: input.inviteeFullName,
          invitationUrl,
          expiresAt: input.expiresAt,
        });
        const created = await repo.createInvitation({
          organizationId: input.organizationId,
          tenantAccountId: input.tenantAccountId,
          inviteeEmail: input.inviteeEmail,
          inviteeFullName: input.inviteeFullName,
          tokenHash,
          inviterMembershipId: input.inviterMembershipId,
          expiresAt: input.expiresAt,
        });
        return { invitationId: created.id };
      }),
    commitProvisionedTransition: (input) =>
      inProvisionPlatform("m34 tenant provision commit", async (tx) => {
        if (!deps.provision) return unbound("provision.outbox", "capability missing");
        const repo = new TenantAccountRepository(tx);
        const account = await repo.findById(input.tenantAccountId);
        if (!account) throw new Error(`tenant_account ${input.tenantAccountId} not found`);
        if (account.status === "onboarding") return;
        if (account.status !== "provisioning") {
          throw new Error(
            `tenant_account ${input.tenantAccountId} cannot provision from ${account.status}`,
          );
        }
        await repo.updateStatus(account.id, { status: "onboarding", provisionedAt: now() });
        await repo.appendStatusEvent({
          tenantAccountId: account.id,
          organizationId: account.organizationId,
          fromStatus: "provisioning",
          toStatus: "onboarding",
          transitionReason: input.transitionReason,
          actorMembershipId: input.actorMembershipId,
          actorKind: "platform_ops",
          sideEffectsRecorded: { outbox: "m34.tenant.provisioned" },
        });
        await deps.provision.outbox.publish(tx, {
          eventName: "m34.tenant.provisioned",
          organizationId: account.organizationId,
          aggregateKind: "tenant_account",
          aggregateId: account.id,
          payload: { ...input.provisionedEvent },
        });
      }),
  };

  // ── tenant.dek_rotate ─────────────────────────────────────────────────────────────────────────────
  // The key-ring repo (findByOrganizationId / recordRotation) IS bindable; the M1 mint-and-wrap KEK
  // primitive + the outbox emit + the M4 audit hook need the integrator's seams.
  const dekRotate: DekRotateWorkerPorts = {
    now,
    keyRing: keyRingRepo,
    keyMaterial: {
      async mintAndWrapDek(orgId) {
        const wrapped = await requireKeyLifecycle().keyMaterial.mintAndWrapDek({
          organizationId: orgId,
        });
        return {
          kekWrappedCiphertext: Buffer.from(wrapped.wrappedCiphertextB64, "base64"),
          kekId: wrapped.kekId,
        };
      },
    },
    outbox: {
      emitDekRotationCompleted: (payload) =>
        requireKeyLifecycle().outbox.publish(platformDb, {
          eventName: "m34.tenant.dek_rotation_completed",
          organizationId: payload.orgId,
          aggregateKind: "tenant_account",
          aggregateId: payload.tenantAccountId,
          payload: { ...payload },
        }),
    },
    audit: {
      recordDekRotated: (entry) =>
        audit(
          platformDb,
          {
            organizationId: entry.orgId,
            userId: null,
            actorKind: "system",
            actorRole: "platform_ops",
            correlationId: randomUUID(),
          },
          {
            eventType: "tenant.dek_rotated",
            resourceKind: "tenant_key_ring",
            outcome: "success",
            severity: "critical",
            context: {
              actorMembershipId: entry.actorMembershipId,
              fromVersion: entry.fromVersion,
              toVersion: entry.toVersion,
            },
          },
        ),
    },
  };

  // ── tenant.shred ──────────────────────────────────────────────────────────────────────────────────
  // SAFETY: the destroy port goes through the m34_destroy_tenant_key_ring SECURITY DEFINER fn (bindable
  // now) AND the M4 destruction-cert registry (callbackAllEraserFns / recordCertificateRefusal /
  // fileCertificate — needs the integrator's M4 registry handle). The MinIO scope-destroy needs the M1
  // helper. We bind the key-ring repo (phase trail) + the DEK-zeroize fn; the rest throw a typed TODO.
  const shredDestructive: ShredDestructivePort = {
    async destroyTenantStorageScope({ orgId }) {
      const receipt = await requireKeyLifecycle().storage.destroyTenantScope({
        organizationId: orgId,
      });
      return { prefix: receipt.prefix, objectsDeleted: receipt.objectsDeleted };
    },
    async destroyTenantKeyRing({ tenantAccountId, destructionCertId, actorMembershipId }) {
      // THE IRREVERSIBLE EVENT — the SECURITY DEFINER fn alone may null the ciphertext (table grants block
      // any other path). Commit this boundary on the base platform pool, independently of the outer
      // certificate/lifecycle transaction: after Phase 3 succeeds, a later Phase-4 crash must never roll the
      // DEK back into existence. A replay calls the same-certificate idempotent function and resumes filing.
      await requireKeyLifecycle().destroyTenantKeyRing({
        tenantAccountId,
        destructionCertId,
        actorMembershipId,
      });
    },
  };
  const callback = createTenantShredEraserCallback({
    subjects: {
      patientIds: (orgId) => requireKeyLifecycle().shredSubjects.patientIds(platformDb, orgId),
      soleTenantUserIds: (orgId) =>
        requireKeyLifecycle().shredSubjects.soleTenantUserIds(platformDb, orgId),
    },
  });
  const shredErasers: ShredEraserCallbackPort = {
    callbackAllEraserFns: callback.callbackAllEraserFns,
    recordCertificateRefusal: (input) =>
      requireKeyLifecycle().destructionWorkflow.recordCertificateRefusal(platformDb, input),
    fileCertificate: (input) =>
      requireKeyLifecycle().destructionWorkflow.fileCertificate(platformDb, input),
  };
  const shred: ShredWorkerPorts = {
    now,
    keyRing: keyRingRepo,
    erasers: shredErasers,
    destructive: shredDestructive,
    audit: {
      recordDestructionCertified: (entry) =>
        audit(
          platformDb,
          {
            organizationId: entry.orgId,
            userId: null,
            actorKind: "system",
            actorRole: "platform_ops",
            correlationId: randomUUID(),
          },
          {
            eventType: "data.destruction_certified",
            resourceKind: "destruction_certificate",
            resourceId: entry.destructionCertId,
            outcome: "success",
            severity: "critical",
            context: { actorMembershipId: entry.actorMembershipId },
          },
        ),
      recordDestructionDeferred: (entry) =>
        audit(
          platformDb,
          {
            organizationId: entry.orgId,
            userId: null,
            actorKind: "system",
            actorRole: "platform_ops",
            correlationId: randomUUID(),
          },
          {
            eventType: "data.destruction_deferred",
            resourceKind: "destruction_certificate",
            resourceId: entry.destructionCertId,
            outcome: "success",
            severity: "critical",
            context: {
              actorMembershipId: entry.actorMembershipId,
              refusedRowsByModule: [...entry.refusedRowsByModule],
            },
          },
        ),
    },
    lifecycle: {
      async commitDestroyed(input) {
        const repo = new TenantAccountRepository(platformDb);
        const account = await repo.findById(input.tenantAccountId);
        if (!account || account.organizationId !== input.orgId) {
          throw new Error(`tenant_account ${input.tenantAccountId} not found for shred commit`);
        }
        if (account.status === "destroyed") return;
        const transition = transitionTenant(account.status, {
          type: "shred",
          actorKind: "system_automated",
          transitionReason: input.transitionReason,
          isShredWorker: true,
        });
        await repo.updateStatus(account.id, {
          status: transition.to,
          destroyedAt: input.destroyedAt,
        });
        await repo.appendStatusEvent({
          organizationId: input.orgId,
          tenantAccountId: account.id,
          fromStatus: account.status,
          toStatus: transition.to,
          transitionReason: input.transitionReason,
          actorMembershipId: input.actorMembershipId,
          actorKind: "system_automated",
          sideEffectsRecorded: { outbox: "m34.tenant.destroyed" },
        });
        await requireKeyLifecycle().outbox.publish(platformDb, {
          eventName: "m34.tenant.destroyed",
          organizationId: input.orgId,
          aggregateKind: "tenant_account",
          aggregateId: account.id,
          payload: {
            tenantAccountId: account.id,
            orgId: input.orgId,
            destructionCertId: input.destructionCertId,
            destroyedAt: input.destroyedAt.toISOString(),
          },
        });
      },
      async commitDeferToRetained(input) {
        const repo = new TenantAccountRepository(platformDb);
        const account = await repo.findById(input.tenantAccountId);
        if (!account || account.organizationId !== input.orgId) {
          throw new Error(`tenant_account ${input.tenantAccountId} not found for shred deferral`);
        }
        if (account.status === "retained") return;
        const transition = transitionTenant(account.status, {
          type: "deferForPartTwoRetention",
          actorKind: "system_automated",
          transitionReason: input.transitionReason,
          eraserRefusedPartTwo: true,
        });
        await repo.updateStatus(account.id, { status: transition.to });
        await repo.appendStatusEvent({
          organizationId: input.orgId,
          tenantAccountId: account.id,
          fromStatus: account.status,
          toStatus: transition.to,
          transitionReason: input.transitionReason,
          actorMembershipId: input.actorMembershipId,
          actorKind: "system_automated",
          sideEffectsRecorded: {
            eraserRefusedPartTwo: true,
            destructionCertId: input.destructionCertId,
            refusedRowsByModule: [...input.refusedRowsByModule],
          },
        });
      },
    },
    async assertCertApprovedAndNoHold(input) {
      const authorization = await requireKeyLifecycle().destructionWorkflow.authorizationFacts(
        platformDb,
        input,
      );
      const account = await new TenantAccountRepository(platformDb).findById(input.tenantAccountId);
      assertM34ShredPreflight(
        input.orgId,
        {
          ...authorization,
          tenantAccount: account,
        },
        now(),
      );
    },
  };

  // ── tenant.dsar_export (runs under withOrgContext — the requesting tenant, F09) ──────────────────────
  // GAP-048: fully bound. `db` here is ALREADY the job's own org-context tx by the time these run (the
  // worker closure below opens withOrgContext ONCE around the whole job and rebuilds ports over that tx,
  // the same convention `inProvisionPlatform`/`inProvisionOrg` above rely on) — so `updateJob`/`appendEvent`
  // /the object PUT issue plain Drizzle directly on `db`, no extra wrapping. `resolveSubject` and
  // `renderBundleDocument` are genuine cross-module seam calls (M5 PatientReader / M22 DocumentRenderer) —
  // each manages its own transaction internally, same accepted shape as GAP-030's CaseloadProvider seam
  // call. `openBundleSink`/`sealBundle` buffer the FHIR resources in memory and assemble a real FHIR R4
  // `Bundle` (type `collection`) at seal time — one gzip-compressed NDJSON-style PUT, not a literal
  // multi-file tar archive (no tar library in this repo; a DSAR bundle is one logical document, not a
  // multi-file archive, so gzip alone is the honest minimal format).
  let dsarBundleResources: unknown[] = [];
  const dsarExport: DsarExportWorkerPorts = {
    now,
    async resolveSubject(orgId, patientId) {
      const identity = await getSeam("PatientReader").findById({ organizationId: orgId, id: patientId });
      if (!identity) {
        return unbound(
          "dsarExport.resolveSubject",
          `patient '${patientId}' not visible in org '${orgId}'`,
        );
      }
      return { resolvedPatientId: identity.id };
    },
    async openBundleSink({ orgId, jobId }) {
      dsarBundleResources = [];
      const objectKey = `tenants/${orgId}/exports/dsar/${jobId}.ndjson.gz`;
      return {
        sink: {
          async write(resource: unknown) {
            dsarBundleResources.push(resource);
          },
        },
        objectKey,
      };
    },
    async sealBundle({ orgId, objectKey }) {
      if (!deps.dsarExport?.objectStore) {
        return unbound(
          "dsarExport.sealBundle",
          "bind the composition-root M22 ObjectStorePort adapter (dsarExport.objectStore)",
        );
      }
      const bundle = {
        resourceType: "Bundle",
        type: "collection",
        entry: dsarBundleResources.map((resource) => ({ resource })),
      };
      const bytes = gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"));
      await deps.dsarExport.objectStore.putObject({ organizationId: orgId, objectKey, bytes });
      return { sizeBytes: bytes.byteLength };
    },
    async updateJob(jobId, patch) {
      await new DsarExportRepository(db).update(jobId, patch);
    },
    async appendEvent(args) {
      await new DsarExportRepository(db).appendEvent({
        organizationId: args.orgId,
        dsarExportJobId: args.jobId,
        eventKind: args.eventKind,
        fromStatus: args.fromStatus ?? null,
        toStatus: args.toStatus ?? null,
        occurredAt: now(),
        shardReceipt: args.shardReceipt ?? null,
      });
    },
    async renderBundleDocument(args) {
      if (!deps.dsarExport?.render) {
        return unbound(
          "dsarExport.renderBundleDocument",
          "bind the composition-root M22 DocumentRenderer adapter (dsarExport.render)",
        );
      }
      return deps.dsarExport.render.render(args);
    },
    async publishOutbox(event, payload) {
      if (!deps.dsarExport?.outbox) {
        return unbound(
          "dsarExport.publishOutbox",
          "bind the live m34 transactional-outbox dispatcher (dsarExport.outbox)",
        );
      }
      await deps.dsarExport.outbox.publish(db, {
        eventName: event,
        organizationId: (payload.orgId as string | undefined) ?? "",
        aggregateKind: "dsar_export_job",
        aggregateId: (payload.jobId as string | undefined) ?? "",
        payload,
      });
    },
  };

  // ── tenant.export (runs under withOrgContext — the requesting tenant, F09) ───────────────────────────
  // GAP-094: fully bound, mirroring GAP-048's dsarExport shape above. `listShards` is the live
  // seam-bootstrap fan-out registry — a plain function (not a `getSeam` call; the registry lives in the
  // SAME process, no seam indirection needed). `bundleSink` writes a REAL ustar tar.gz (no tar dependency
  // in this repo — see ../tenant-export-tar.ts) and PUTs it as one object through the injected M1
  // objectStore, mirroring GAP-048's single-PUT pattern over a real multi-file archive instead of a single
  // logical document. `requestCoverLetterPdf` calls the M22 DocumentRenderer directly (GAP-048's
  // precedent), never the dead `m22.document.upload_requested` outbox event an earlier design considered.
  //
  // `markGenerating`/`recordShardReceipt`/`markFulfilled`/`holdForOversizedApproval` take no `orgId` in
  // their own signatures (the package's pure `TenantExportWorkerPorts` — unlike `DsarExportWorkerPorts`,
  // which threads `orgId` through every call). `runTenantExportJob` always calls `markGenerating(jobId)`
  // FIRST, before any other port, so `tenantExportOrgId` is captured there and reused by the later calls
  // in the SAME job (ports are rebuilt fresh per job by the worker closure below — see `dsarBundleResources`
  // above for the identical one-job-per-`buildM34WorkerPorts`-call precedent this relies on).
  let tenantExportOrgId: string | undefined;
  const requireTenantExportOrgId = (): string =>
    tenantExportOrgId ??
    unbound("tenantExport", "markGenerating must run before any other tenantExport port call");
  const tenantExport: TenantExportWorkerPorts = {
    now,
    listShards: () => listTenantExportShards(),
    async markGenerating(jobId): Promise<void> {
      const job = await tenantExportRepo.findById(jobId);
      if (!job) throw new Error(`tenant_export_job ${jobId} not found`);
      tenantExportOrgId = job.organizationId;
      await tenantExportRepo.update(jobId, { status: "generating" });
      await tenantExportRepo.appendEvent({
        organizationId: job.organizationId,
        tenantExportJobId: jobId,
        eventKind: "generating",
        occurredAt: now(),
      });
    },
    async recordShardReceipt({ jobId, moduleKey, receipt }): Promise<void> {
      await tenantExportRepo.appendEvent({
        organizationId: requireTenantExportOrgId(),
        tenantExportJobId: jobId,
        eventKind: "shard_receipt",
        moduleKey,
        shardReceipt: receipt,
        occurredAt: now(),
      });
    },
    bundleSink() {
      if (!deps.tenantExport?.objectStore) {
        return unbound(
          "tenantExport.bundleSink",
          "bind the composition-root M1 S3 objectStore adapter (tenantExport.objectStore)",
        );
      }
      const { objectStore } = deps.tenantExport;
      return createTenantExportBundleSink({
        putObject: (args) => objectStore.putObject(args),
        nowSeconds: () => Math.floor(now().getTime() / 1000),
      });
    },
    async requestCoverLetterPdf({ jobId, orgId, bundleSha256 }): Promise<{ documentId: string }> {
      if (!deps.tenantExport?.render) {
        return unbound(
          "tenantExport.requestCoverLetterPdf",
          "bind the composition-root M22 DocumentRenderer adapter (tenantExport.render)",
        );
      }
      return deps.tenantExport.render.render({ organizationId: orgId, aggregateId: jobId, bundleSha256 });
    },
    async markFulfilled(input): Promise<void> {
      await tenantExportRepo.update(input.jobId, {
        status: "fulfilled",
        fulfilledAt: now(),
        bundleMinioObjectKey: input.bundleMinioObjectKey,
        bundleSha256: input.bundleSha256,
        bundleSizeBytes: input.bundleSizeBytes,
        bundleModuleInventory: input.bundleModuleInventory,
        bundlePresignedUrlExpiresAt: input.bundlePresignedUrlExpiresAt,
      });
      await tenantExportRepo.appendEvent({
        organizationId: requireTenantExportOrgId(),
        tenantExportJobId: input.jobId,
        eventKind: "fulfilled",
        shardReceipt: { bundleSha256: input.bundleSha256, bundleSizeBytes: input.bundleSizeBytes },
        occurredAt: now(),
      });
    },
    // SEC-052 — records the hold; deliberately does NOT flip status to 'fulfilled'. The tenant-scoped
    // download route (service-drizzle.ts `tenantExportDownloadUrl`) already 409s any job whose status
    // isn't 'fulfilled', so the hold is enforced by omission — no new status/column needed. The M36
    // platform-ops alert this port's own doc comment names, and the platform-scoped `approve-oversized`
    // release route that would ever un-hold a bundle, do not exist yet (the route is documented in
    // typebox.ts's `ApproveOversizedExportRequest` but never registered) — tracked as a follow-up gap,
    // not built here (GAP-094 is scoped to the worker; SEC-052 release is a separate platform-ops surface).
    async holdForOversizedApproval(input): Promise<void> {
      await tenantExportRepo.appendEvent({
        organizationId: requireTenantExportOrgId(),
        tenantExportJobId: input.jobId,
        eventKind: "oversized_hold",
        shardReceipt: {
          bundleMinioObjectKey: input.bundleMinioObjectKey,
          bundleSha256: input.bundleSha256,
          bundleSizeBytes: input.bundleSizeBytes,
          recordCount: input.recordCount,
        },
        occurredAt: now(),
      });
    },
  };

  // ── tenant.onboarding_advance (runs under withOrgContext — onboarding_task is org-scoped, §3.10) ──────
  // The OnboardingRepository IS bindable; gatherContext (M2/M27/M40 reads via seams), the outbox publish,
  // the M36 alert router, and the lifecycle activate hook need the integrator's seams/dispatcher.
  const onboardingAdvance: OnboardingAdvancePorts = {
    // BOUND: the M34-owned onboarding data port over the org-scoped Drizzle client (`onboarding_task` is
    // org-scoped, §3.10). The worker closure applies the per-job withOrgContext envelope (F09); this repo
    // issues plain Drizzle inside whichever transaction the envelope opens. The remaining onboarding ports
    // (gatherContext / publishOutbox / routeAlert / activateTenant) stay fail-closed thunks until their
    // cross-module seams + the live outbox dispatcher land — the onboarding worker only throws once it runs
    // a job, never at construction (so the host boots with the queue connection enabled).
    repo: new OnboardingRepository(db),
    now,
    gatherContext: () =>
      unbound(
        "onboardingAdvance.gatherContext",
        "bind the M2/M27/M12/M40 context reads through seams/outbox projections",
      ),
    publishOutbox: () =>
      unbound(
        "onboardingAdvance.publishOutbox",
        "bind to the live outbox dispatcher (m34.tenant.onboarding_*)",
      ),
    routeAlert: () =>
      unbound("onboardingAdvance.routeAlert", "bind to the M36 alert router (§4.8)"),
    activateTenant: () =>
      unbound(
        "onboardingAdvance.activateTenant",
        "bind to the lifecycle-transition activate effect-runner (re-checks BAA guards §2.4.12)",
      ),
  };

  // ── tenant.bundle_expiry_sweep (runs under withOrgContext per org, §3.7 F09) ─────────────────────────
  // The DSAR + tenant-export repo `listByPresignedExpiry` + the row-clear/ledger ARE bindable; the MinIO
  // object delete needs the M1 ObjectStorageProvider seam.
  const bundleExpirySweep: BundleExpirySweepPorts = {
    now,
    listExpiringBundles: () =>
      unbound(
        "bundleExpirySweep.listExpiringBundles",
        "bind to DsarExportRepository.listByPresignedExpiry + TenantExportRepository.listByPresignedExpiry (tagged by kind)",
      ),
    deleteBundleObject: () =>
      unbound(
        "bundleExpirySweep.deleteBundleObject",
        "bind to getSeam('ObjectStorageProvider').delete (no MinIO seam yet)",
      ),
    clearBundleArtifact: () =>
      unbound(
        "bundleExpirySweep.clearBundleArtifact",
        "bind to the DSAR/tenant-export repo update(null artifact)",
      ),
    recordReapEvent: () =>
      unbound(
        "bundleExpirySweep.recordReapEvent",
        "bind to the DSAR/tenant-export repo appendEvent('bundle_expired_reaped')",
      ),
  };

  return {
    provision,
    dekRotate,
    shred,
    dsarExport,
    tenantExport,
    onboardingAdvance,
    bundleExpirySweep,
  };
}

// ── live worker construction (the M4-T11 audit-jobs.ts template) ───────────────────────────────────────

/**
 * Construct one BullMQ `Worker` per §4.3 COMMAND queue (provision / dek_rotate / shred / dsar_export /
 * export / onboarding_advance) + the bundle-expiry sweep, each driving the matching pure processor with
 * the bound ports. Returns the workers so the composition root can `close()` them on shutdown — the caller
 * owns the lifecycle; nothing here runs at import (constructing a Worker opens the Valkey connection, which
 * must happen only in production wiring, never in tests).
 *
 * The per-job tenancy envelope (withOrgContext / withPlatformContext per {@link M34_QUEUE_SCOPE}) is the
 * SEPARATE integration concern: the ports built above expect to be invoked inside that envelope, so the
 * integrator either wraps the processor body or threads a per-job scoped DB handle. This function constructs
 * the worker shells; binding the envelope + supplying the still-missing infra seams is the integrator's
 * remaining step (the typed throws above name each missing seam).
 *
 * The baa_expiry_sweep, support_session_close_sweep, and dsar_sla_escalation_sweep workers are NOT
 * constructed here — their processors take additional per-run inputs (the BAA sweep ports, the
 * support-session deps + expired-candidate list, the DSAR-SLA candidate set) the integrator assembles; they
 * are scheduled (the `Queue` repeatables) by {@link scheduleM34Jobs} and their `Worker`s land with those
 * deps. See the TODO at the foot of this file.
 */
export function registerM34Workers(deps: M34WorkerDeps): Worker[] {
  const ports = buildM34WorkerPorts(deps);
  const { connection } = deps;
  const mk = <D, R>(
    queue: string,
    processor: (data: D) => Promise<R>,
    concurrency: number,
  ): Worker =>
    new Worker(queue, async (job) => processor(job.data as D), { connection, concurrency });

  return [
    mk(M34_QUEUES.provision, provisionProcessor(ports.provision), 1),
    mk(M34_QUEUES.dekRotate, dekRotateProcessor(ports.dekRotate), 2),
    mk(M34_QUEUES.shred, shredProcessor(ports.shred), 1),
    mk(M34_QUEUES.dsarExport, dsarExportProcessor(ports.dsarExport), 4),
    mk(M34_QUEUES.export, tenantExportProcessor(ports.tenantExport), 2),
    mk(
      M34_QUEUES.onboardingAdvance,
      onboardingAdvanceProcessor(ports.onboardingAdvance) as (
        data: OnboardingAdvanceJob,
      ) => Promise<unknown>,
      4,
    ),
    mk(M34_QUEUES.bundleExpirySweep, bundleExpirySweepProcessor(ports.bundleExpirySweep), 1),
  ];
}

/** Construct only the launch-critical provision worker; unrelated M34 capabilities stay disabled. */
export function registerM34ProvisionWorker(deps: M34WorkerDeps): Worker {
  if (!deps.provision) {
    throw new M34WorkerPortUnbound(
      "provision",
      "audit, KMS, storage, invitation delivery, and outbox adapters are all required",
    );
  }
  const ports = buildM34WorkerPorts(deps).provision;
  return new Worker(M34_QUEUES.provision, async (job) => provisionProcessor(ports)(job.data), {
    connection: deps.connection,
    concurrency: 1,
  });
}

/** Construct the production DEK-rotation worker inside one audited platform transaction per job. */
export function registerM34DekRotateWorker(deps: M34WorkerDeps): Worker {
  if (!deps.platformDb || !deps.keyLifecycle) {
    throw new M34WorkerPortUnbound(
      "dekRotate",
      "the platform DB plus audit, KMS, and outbox adapters are required",
    );
  }
  return new Worker(
    M34_QUEUES.dekRotate,
    async (job) =>
      withPlatformContext(
        deps.platformDb as DbClient,
        { jobId: "m34.platform_ops", reason: "m34 tenant DEK rotation", crossTenant: true },
        deps.keyLifecycle?.auditBypass as PlatformBypassAuditor<DbClient>,
        async (tx) =>
          dekRotateProcessor(
            buildM34WorkerPorts({ ...deps, platformDb: tx as unknown as DbClient }).dekRotate,
          )(job.data),
      ),
    { connection: deps.connection, concurrency: 2 },
  );
}

/** Construct the single-concurrency irreversible shred worker under the audited platform credential. */
export function registerM34ShredWorker(deps: M34WorkerDeps): Worker {
  if (!deps.platformDb || !deps.keyLifecycle) {
    throw new M34WorkerPortUnbound(
      "shred",
      "the platform DB plus audit, eraser, storage, KMS, and outbox adapters are required",
    );
  }
  return new Worker(
    M34_QUEUES.shred,
    async (job) =>
      withPlatformContext(
        deps.platformDb as DbClient,
        { jobId: "m34.platform_ops", reason: "m34 certified tenant shred", crossTenant: true },
        deps.keyLifecycle?.auditBypass as PlatformBypassAuditor<DbClient>,
        async (tx) =>
          shredProcessor(
            buildM34WorkerPorts({ ...deps, platformDb: tx as unknown as DbClient }).shred,
          )(job.data),
      ),
    { connection: deps.connection, concurrency: 1 },
  );
}

/** `withOrgContext`'s audit-actor sentinel for the DSAR worker (a system-driven run, not a user action) —
 *  the M4 write-audit trigger NULLIFs an empty `userId`, mirroring M30's `M30_WORKER_SYSTEM_USER_ID`. */
const M34_DSAR_WORKER_SYSTEM_USER_ID = "";

/**
 * Construct the production DSAR-export worker (GAP-048). Org-scoped (§7.3 F09 — `M34_QUEUE_SCOPE.
 * dsarExport === "org"`, never a platform bypass): opens ONE `withOrgContext(deps.db, {organizationId:
 * job.data.orgId, ...}, tx => ...)` per job and rebuilds the port bag over that tx (`buildM34WorkerPorts
 * ({...deps, db: tx})`), mirroring `registerM34DekRotateWorker`/`registerM34ShredWorker`'s per-job
 * envelope shape but with the tenant's own RLS context instead of the platform-bypass credential. The
 * job payload IS the full `DsarExportJobInput` (`{jobId, orgId, tenantAccountId, patientId}` — the route
 * enqueues this shape, not a bare `jobId`, precisely so `orgId` is known before `withOrgContext` can open).
 */
export function registerM34DsarExportWorker(deps: M34WorkerDeps): Worker {
  if (!deps.dsarExport) {
    throw new M34WorkerPortUnbound(
      "dsarExport",
      "the object-store, DocumentRenderer, and outbox adapters are all required",
    );
  }
  return new Worker(
    M34_QUEUES.dsarExport,
    async (job) => {
      const data = job.data as DsarExportJobInput;
      return withOrgContext(
        deps.db,
        { organizationId: data.orgId, userId: M34_DSAR_WORKER_SYSTEM_USER_ID },
        (tx) =>
          dsarExportProcessor(buildM34WorkerPorts({ ...deps, db: tx as unknown as DbClient }).dsarExport)(
            data,
          ),
      );
    },
    { connection: deps.connection, concurrency: 4 },
  );
}

/**
 * Construct the production tenant-export worker (GAP-094 — the `tenant.export` sibling of
 * `registerM34DsarExportWorker` above; SAME shape). Org-scoped (§7.6 F09 — `M34_QUEUE_SCOPE.export ===
 * "org"`, never a platform bypass): opens ONE `withOrgContext(deps.db, {organizationId: job.data.orgId,
 * ...}, tx => ...)` per job and rebuilds the port bag over that tx. The job payload is `TenantExportJobBody`
 * (`{jobId, orgId}`) — the tenant route's `requestTenantExport` enqueues both fields (fixed alongside this,
 * GAP-094: it previously enqueued a bare `{jobId}`, which would have left `withOrgContext` opening with an
 * undefined `organizationId` the moment this worker went live).
 */
export function registerM34TenantExportWorker(deps: M34WorkerDeps): Worker {
  if (!deps.tenantExport) {
    throw new M34WorkerPortUnbound("tenantExport", "the object-store and DocumentRenderer adapters are required");
  }
  return new Worker(
    M34_QUEUES.export,
    async (job) => {
      const data = job.data as TenantExportJobBody;
      return withOrgContext(
        deps.db,
        { organizationId: data.orgId, userId: M34_DSAR_WORKER_SYSTEM_USER_ID },
        (tx) =>
          tenantExportProcessor(
            buildM34WorkerPorts({ ...deps, db: tx as unknown as DbClient }).tenantExport,
          )(data),
      );
    },
    { connection: deps.connection, concurrency: 2 },
  );
}

/**
 * Register the four §4.3 repeatable cron schedules (bundle-expiry nightly, baa-expiry daily,
 * support-session-close every 5 min, dsar-sla-escalation daily). The six command queues are enqueued on
 * demand by their routes / outbox-subscriptions, NOT scheduled here. Returns the schedule `Queue`s so the
 * composition root can `close()` them. Mirrors `scheduleAuditJobs` (the M4-T11 repeatable-registration
 * template): one `Queue` per cron, `add('scheduled', {}, { repeat: { pattern } })`.
 */
export async function scheduleM34Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const bundleExpiry = new Queue(M34_QUEUES.bundleExpirySweep, { connection });
  const baaExpiry = new Queue(M34_QUEUES.baaExpirySweep, { connection });
  const supportClose = new Queue(M34_QUEUES.supportSessionCloseSweep, { connection });
  const dsarSla = new Queue(M34_QUEUES.dsarSlaEscalationSweep, { connection });
  await bundleExpiry.add(
    "scheduled",
    {},
    { repeat: { pattern: M34_JOB_SCHEDULES.bundleExpirySweep }, removeOnComplete: true },
  );
  await baaExpiry.add(
    "scheduled",
    {},
    { repeat: { pattern: M34_JOB_SCHEDULES.baaExpirySweep }, removeOnComplete: true },
  );
  await supportClose.add(
    "scheduled",
    {},
    { repeat: { pattern: M34_JOB_SCHEDULES.supportSessionCloseSweep }, removeOnComplete: true },
  );
  await dsarSla.add(
    "scheduled",
    {},
    { repeat: { pattern: M34_JOB_SCHEDULES.dsarSlaEscalationSweep }, removeOnComplete: true },
  );
  return [bundleExpiry, baaExpiry, supportClose, dsarSla];
}

// TODO(integrator — the still-missing infra seams the typed throws above name):
//   • the live transactional-outbox dispatcher accessor (every `publishOutbox`/`emit*` port) — no
//     bootstrap accessor exists yet; bind it and the lifecycle effect-runners light up.
//   • the M1 MinIO/envelope seam (`ObjectStorageProvider` + the envelope helper) — register it in
//     bootstrap/seams/registry.ts; the DSAR/export sinks + the provision/shred MinIO ports + the
//     bundle-sweep object delete all resolve through `getSeam`.
//   • the M4 destruction-cert callback registry handle (the shred `erasers` port) — expose
//     runDestruction/recordCertificateRefusal/fileCertificate; NEVER bypass M4.
//   • the programmatic M36 alert router (the onboarding/export/sweep `routeAlert` ports).
//   • the separately-pooled platform DB (`deps.platformDb`) + registering the M34 platform jobIds in the
//     @wardenx/tenancy PLATFORM_CONTEXT_ALLOWLIST so withPlatformContext admits them (currently empty).
//   • the baa_expiry / support_session_close / dsar_sla_escalation Workers (their processors take extra
//     per-run inputs — build them alongside `registerM34Workers` once the BAA/support-session/DSAR-SLA
//     ports are assembled). The Queues are already scheduled by `scheduleM34Jobs`.
//   • wrap each processor body (or thread a per-job scoped DB handle) in withOrgContext/withPlatformContext
//     per M34_QUEUE_SCOPE (F09) before mounting — `registerM34Workers` builds the shells, not the envelope.
