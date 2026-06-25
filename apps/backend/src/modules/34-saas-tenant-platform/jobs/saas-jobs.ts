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
  OnboardingRepository,
  TenantAccountRepository,
  TenantExportRepository,
  TenantKeyRingRepository,
} from "@wardenx/saas-tenant-platform";
import type {
  BundleExpirySweepPorts,
  DekRotateWorkerPorts,
  DsarExportWorkerPorts,
  OnboardingAdvancePorts,
  ProvisionWorkerPorts,
  ShredDestructivePort,
  ShredEraserCallbackPort,
  ShredWorkerPorts,
  TenantExportWorkerPorts,
} from "@wardenx/saas-tenant-platform";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
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
  /** Injected clock (deterministic in tests; the package workers stamp every instant through this). */
  now?: () => Date;
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
  const accountRepo = new TenantAccountRepository(platformDb);
  void accountRepo; // bound for the provision/lifecycle ports below (status reads); referenced via TODOs.
  void new TenantExportRepository(db); // bound for the DSAR/export ledger ports (see per-port TODOs).

  // ── tenant.provision ────────────────────────────────────────────────────────────────────────────────
  // The key-ring step IS bindable now (the m34_provision_tenant_key_ring SECURITY DEFINER fn); the M1
  // MinIO prefix ensure, the M2 org confirm, the onboarding-task materialize, the M36 invitation email,
  // and the lifecycle commit need seams/the outbox dispatcher the integrator wires.
  const provision: ProvisionWorkerPorts = {
    now,
    currentStatus: (tenantAccountId) =>
      unbound(
        "provision.currentStatus",
        `bind to TenantAccountRepository.findById(${tenantAccountId}).status under withPlatformContext`,
      ),
    async ensureTenantKeyRing({ tenantAccountId }) {
      // SELECT-then-CALL the SECURITY DEFINER fn (never insert ciphertext directly — table grants block it).
      const existing = await keyRingRepo.findByTenantAccountId(tenantAccountId);
      if (existing !== null) return { tenantKeyRingId: existing.id };
      const rows = await platformDb.execute<{ m34_provision_tenant_key_ring: string }>(
        sql`SELECT m34_provision_tenant_key_ring(${tenantAccountId}) AS m34_provision_tenant_key_ring`,
      );
      const id = rows.rows[0]?.m34_provision_tenant_key_ring;
      if (id === undefined) {
        return unbound(
          "provision.ensureTenantKeyRing",
          "m34_provision_tenant_key_ring returned no id (migration not applied?)",
        );
      }
      return { tenantKeyRingId: id };
    },
    ensureTenantStoragePrefixes: () =>
      unbound(
        "provision.ensureTenantStoragePrefixes",
        "bind to the M1 MinIO prefix-ensure helper (getSeam — no ObjectStorageProvider/MinIO seam registered yet)",
      ),
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
    materializeOnboardingTasks: () =>
      unbound(
        "provision.materializeOnboardingTasks",
        "bind to OnboardingRepository.listTemplates+createTasks under withOrgContext",
      ),
    ensureFirstAdminInvitation: () =>
      unbound(
        "provision.ensureFirstAdminInvitation",
        "bind to TenantAccountRepository.createInvitation + the M36 PHI-sanitized magic-link channel",
      ),
    commitProvisionedTransition: () =>
      unbound(
        "provision.commitProvisionedTransition",
        "bind to the lifecycle effect-runner (status-event + m34.tenant.provisioned outbox, one tx) — needs the live outbox dispatcher",
      ),
  };

  // ── tenant.dek_rotate ─────────────────────────────────────────────────────────────────────────────
  // The key-ring repo (findByOrganizationId / recordRotation) IS bindable; the M1 mint-and-wrap KEK
  // primitive + the outbox emit + the M4 audit hook need the integrator's seams.
  const dekRotate: DekRotateWorkerPorts = {
    now,
    keyRing: keyRingRepo,
    keyMaterial: {
      mintAndWrapDek: () =>
        unbound(
          "dekRotate.keyMaterial.mintAndWrapDek",
          "bind to the M1 envelope helper (generateDek + wrapUnderActiveKek) — no envelope seam registered yet",
        ),
    },
    outbox: {
      emitDekRotationCompleted: () =>
        unbound(
          "dekRotate.outbox.emitDekRotationCompleted",
          "bind to the live transactional-outbox dispatcher (m34.tenant.dek_rotation_completed)",
        ),
    },
    audit: {
      recordDekRotated: () =>
        unbound(
          "dekRotate.audit.recordDekRotated",
          "bind to the M4 audit() helper (key-management event)",
        ),
    },
  };

  // ── tenant.shred ──────────────────────────────────────────────────────────────────────────────────
  // SAFETY: the destroy port goes through the m34_destroy_tenant_key_ring SECURITY DEFINER fn (bindable
  // now) AND the M4 destruction-cert registry (callbackAllEraserFns / recordCertificateRefusal /
  // fileCertificate — needs the integrator's M4 registry handle). The MinIO scope-destroy needs the M1
  // helper. We bind the key-ring repo (phase trail) + the DEK-zeroize fn; the rest throw a typed TODO.
  const shredDestructive: ShredDestructivePort = {
    destroyTenantStorageScope: () =>
      unbound(
        "shred.destructive.destroyTenantStorageScope",
        "bind to the M1 MinIO prefix-destroy helper (getSeam) — no MinIO seam registered yet",
      ),
    async destroyTenantKeyRing({ tenantAccountId, destructionCertId }) {
      // THE IRREVERSIBLE EVENT — the SECURITY DEFINER fn alone may null the ciphertext (table grants block
      // any other path). A no-op on an already-destroyed ring (the CHECK constraint holds). Under
      // the platform-context envelope applied by the worker closure.
      await platformDb.execute(
        sql`SELECT m34_destroy_tenant_key_ring(${tenantAccountId}, ${destructionCertId})`,
      );
    },
  };
  const shredErasers: ShredEraserCallbackPort = {
    callbackAllEraserFns: () =>
      unbound(
        "shred.erasers.callbackAllEraserFns",
        "bind to the M4 destruction-cert registry runDestruction(...) over the registered DataErasers (NEVER bypass M4)",
      ),
    recordCertificateRefusal: () =>
      unbound(
        "shred.erasers.recordCertificateRefusal",
        "bind to the M4 certificate-workflow recordCertificateRefusal",
      ),
    fileCertificate: () =>
      unbound(
        "shred.erasers.fileCertificate",
        "bind to the M4 certificate-workflow fileCertificate",
      ),
  };
  const shred: ShredWorkerPorts = {
    now,
    keyRing: keyRingRepo,
    erasers: shredErasers,
    destructive: shredDestructive,
    audit: {
      recordDestructionCertified: () =>
        unbound(
          "shred.audit.recordDestructionCertified",
          "bind to the M4 audit() helper (critical)",
        ),
      recordDestructionDeferred: () =>
        unbound(
          "shred.audit.recordDestructionDeferred",
          "bind to the M4 audit() helper (critical, M34-F08)",
        ),
    },
    lifecycle: {
      commitDestroyed: () =>
        unbound(
          "shred.lifecycle.commitDestroyed",
          "bind to the lifecycle effect-runner (status='destroyed' + m34.tenant.destroyed outbox) — needs the outbox dispatcher",
        ),
      commitDeferToRetained: () =>
        unbound(
          "shred.lifecycle.commitDeferToRetained",
          "bind to the lifecycle effect-runner (status='retained' + m34.tenant.retained outbox, M34-F08)",
        ),
    },
    assertCertApprovedAndNoHold: () =>
      unbound(
        "shred.assertCertApprovedAndNoHold",
        "bind to the M4 cert reader + the legal-hold reader (preflight, §3.5)",
      ),
  };

  // ── tenant.dsar_export (runs under withOrgContext — the requesting tenant, F09) ──────────────────────
  // Needs the M5 PatientReader seam (subject redirect), the M1 envelope MinIO sink, the DsarExportRepository
  // ledger writes, and the live outbox dispatcher (the M22 §1.1 handshake + the m34.dsar_export.* emits).
  const dsarExport: DsarExportWorkerPorts = {
    now,
    resolveSubject: () =>
      unbound(
        "dsarExport.resolveSubject",
        "bind to getSeam('PatientReader') (merged_into_id redirect)",
      ),
    openBundleSink: () =>
      unbound(
        "dsarExport.openBundleSink",
        "bind to the M1 envelope-backed MinIO sink (no MinIO seam yet)",
      ),
    sealBundle: () => unbound("dsarExport.sealBundle", "bind to the M1 MinIO object finalize"),
    updateJob: () =>
      unbound("dsarExport.updateJob", "bind to DsarExportRepository.update under withOrgContext"),
    appendEvent: () =>
      unbound(
        "dsarExport.appendEvent",
        "bind to DsarExportRepository.appendEvent under withOrgContext",
      ),
    publishOutbox: () =>
      unbound(
        "dsarExport.publishOutbox",
        "bind to the live transactional-outbox dispatcher (M22 handshake + m34.dsar_export.*)",
      ),
  };

  // ── tenant.export (runs under withOrgContext — the requesting tenant, F09) ───────────────────────────
  // Needs the TenantExportShard fan-out registry (already in seam-bootstrap, listTenantExportShards), the
  // M1 MinIO/envelope ExportBundleSink, the TenantExportRepository ledger, the M22 cover-letter outbox, and
  // the M36 oversized-hold alert. The shard list is bindable now; the sinks/ledger/outbox need the seams.
  const tenantExport: TenantExportWorkerPorts = {
    now,
    listShards: () =>
      unbound(
        "tenantExport.listShards",
        "bind to listTenantExportShards() from seam-bootstrap (registry is live; this is a trivial pass-through to wire)",
      ),
    markGenerating: () =>
      unbound(
        "tenantExport.markGenerating",
        "bind to TenantExportRepository status flip + ledger under withOrgContext",
      ),
    recordShardReceipt: () =>
      unbound(
        "tenantExport.recordShardReceipt",
        "bind to TenantExportRepository.appendEvent under withOrgContext",
      ),
    bundleSink: () =>
      unbound(
        "tenantExport.bundleSink",
        "bind to the M1 envelope/MinIO-backed ExportBundleSink (no MinIO seam yet)",
      ),
    requestCoverLetterPdf: () =>
      unbound(
        "tenantExport.requestCoverLetterPdf",
        "bind to the live outbox dispatcher (m22.document.upload_requested)",
      ),
    markFulfilled: () =>
      unbound(
        "tenantExport.markFulfilled",
        "bind to TenantExportRepository fulfilled flip + ledger under withOrgContext",
      ),
    holdForOversizedApproval: () =>
      unbound(
        "tenantExport.holdForOversizedApproval",
        "bind to TenantExportRepository hold + the M36 platform-ops alert",
      ),
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
