// apps/backend/src/modules/34-saas-tenant-platform/jobs — M34 background jobs (Phase 2D, §4.3). The PURE
// catalog (queue names / params / schedules / DLQ) + the pure processor functions that wrap each §2B
// worker over its injected ports — pure data + thin closures, NO `bullmq` import (the live `Worker`/`Queue`
// construction binds at app boot in `saas-jobs.ts`, the M4-T11 `audit-jobs.ts` pattern; mirrors
// 07-care-plan/jobs/index.ts). The job LOGIC all lives in @wardenx/saas-tenant-platform (unit-tested against
// in-memory ports); this file only NAMES the queues and adapts `(job.data, ports) → worker(job, ports)`.
//
// §4.3 queues (the spec table, verbatim wire names): tenant.provision · tenant.dek_rotate · tenant.shred ·
// tenant.dsar_export · tenant.export · tenant.onboarding_advance, plus the four cron sweeps
// tenant.bundle_expiry_sweep · tenant.baa_expiry_sweep · tenant.support_session_close_sweep ·
// tenant.dsar_sla_escalation_sweep (the §2028-2030 day-20/27/30 DSAR-officer escalation).
//
// Each pure processor is the body a `Worker(queue, processor, { connection })` runs: it takes the bound
// {@link M34JobPorts} (assembled per-job by the live wiring so the run sits inside the right
// withOrgContext/withPlatformContext envelope, F09) and the job payload, and delegates to the package
// worker. No clock/RNG/DB/BullMQ here, so the catalog stays unit-assertable and import-safe.
import type {
  BundleExpirySweepPorts,
  BundleExpirySweepResult,
  DekRotateJob,
  DekRotateResult,
  DekRotateWorkerPorts,
  DsarExportJobInput,
  DsarExportRunResult,
  DsarExportWorkerPorts,
  OnboardingAdvancePorts,
  OnboardingAdvanceReport,
  ProvisionJob,
  ProvisionResult,
  ProvisionWorkerPorts,
  ShredJob,
  ShredResult,
  ShredWorkerPorts,
  TenantExportJobBody,
  TenantExportWorkerPorts,
  TenantExportWorkerResult,
} from "@wardenx/saas-tenant-platform";
import {
  handleDekRotate,
  runBundleExpirySweep,
  runDsarExportJob,
  runOnboardingAdvance,
  runTenantExportJob,
  runTenantProvision,
  runTenantShred,
} from "@wardenx/saas-tenant-platform";

// ── §4.3 queue catalog (spec-literal `tenant.*`; the scheduler binds the cron repeatables at boot) ─────

/** The §4.3 BullMQ queue names (verbatim from the spec §4.3 table). Command queues are enqueued on demand
 *  by the lifecycle-command routes / the DSAR/export POST routes; the sweep queues are cron repeatables. */
export const M34_QUEUES = {
  /** `tenant.provision` — the provisioning side-effects of `provisioning → onboarding` (§7.1, concurrency 1). */
  provision: "tenant.provision",
  /** `tenant.dek_rotate` — mint+wrap a new DEK version, append the prior, bump current (§3.5, concurrency 2). */
  dekRotate: "tenant.dek_rotate",
  /** `tenant.shred` — the IRREVERSIBLE four-phase cryptographic shred of a destruction_pending tenant (§3.5). */
  shred: "tenant.shred",
  /** `tenant.dsar_export` — the patient-scoped HIPAA §164.524 DSAR fulfilment fan-out (§7.3, concurrency 4). */
  dsarExport: "tenant.dsar_export",
  /** `tenant.export` — the org-scoped whole-tenant NDJSON archive fan-out (§7.6, concurrency 2). */
  export: "tenant.export",
  /** `tenant.onboarding_advance` — the IO-bearing consumer of the §2.3 onboarding machine (§4.8, concurrency 4). */
  onboardingAdvance: "tenant.onboarding_advance",
  /** `tenant.bundle_expiry_sweep` — the 7-day DSAR/tenant-export bundle-object reaper (D19, cron nightly). */
  bundleExpirySweep: "tenant.bundle_expiry_sweep",
  /** `tenant.baa_expiry_sweep` — the BAA renewal-radar sweep (§7.5 90/60/30/7d + expired, cron daily). */
  baaExpirySweep: "tenant.baa_expiry_sweep",
  /** `tenant.support_session_close_sweep` — close support sessions past their TTL (§7.4, cron every 5 min). */
  supportSessionCloseSweep: "tenant.support_session_close_sweep",
  /** `tenant.dsar_sla_escalation_sweep` — the §164.524 day-20/27/30 DSAR-SLA escalation (D17, cron daily). */
  dsarSlaEscalationSweep: "tenant.dsar_sla_escalation_sweep",
} as const;

export type M34QueueName = (typeof M34_QUEUES)[keyof typeof M34_QUEUES];

/** The §4.3 dead-letter queue names (OPS-035 document-before-clear; ops alerts off DLQ depth). One per queue. */
export const M34_DLQ = {
  provision: "tenant.provision.dlq",
  dekRotate: "tenant.dek_rotate.dlq",
  shred: "tenant.shred.dlq",
  dsarExport: "tenant.dsar_export.dlq",
  export: "tenant.export.dlq",
  onboardingAdvance: "tenant.onboarding_advance.dlq",
  bundleExpirySweep: "tenant.bundle_expiry_sweep.dlq",
  baaExpirySweep: "tenant.baa_expiry_sweep.dlq",
  supportSessionCloseSweep: "tenant.support_session_close_sweep.dlq",
  dsarSlaEscalationSweep: "tenant.dsar_sla_escalation_sweep.dlq",
} as const;

/** The §4.3 cron cadences (the scheduler registers these repeatables; the six command queues have none —
 *  they are enqueued on demand by routes / outbox-subscriptions, never on a schedule). */
export const M34_JOB_SCHEDULES = {
  /** Nightly bundle-object reaper (D19 — 7-day DSAR/tenant-export object TTL). */
  bundleExpirySweep: "0 3 * * *", // daily 03:00 platform-tz
  /** Daily BAA renewal radar (§7.5). */
  baaExpirySweep: "0 7 * * *", // daily 07:00 platform-tz
  /** Every-5-min support-session close sweep (§7.4 — close sessions past their 8h / grant-bounded TTL). */
  supportSessionCloseSweep: "*/5 * * * *",
  /** Daily DSAR-SLA escalation scan (D17 — day 20/27/30 → DSAR-officer / platform-ops / security-owner). */
  dsarSlaEscalationSweep: "0 8 * * *", // daily 08:00 platform-tz
} as const;

/**
 * The §4.3 BullMQ standard parameter set per queue (the §4.3 table's `Worker concurrency` column + the
 * SD-059 attempts/backoff floor), declared as pure data so the boot-time `Worker` construction consumes
 * one source of truth. `removeOnFail:false` keeps exhausted jobs for DLQ promotion (OPS-035). The command
 * queues carry the spec's concurrency exactly; the sweeps are concurrency 1 (idempotent per cron tick).
 */
export const M34_QUEUE_PARAMS = {
  provision: {
    priority: 2,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 1, // §4.3 — per tenant_account_id, single-flight (the provision idempotency oracle)
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M34_DLQ.provision,
  },
  dekRotate: {
    priority: 2,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 2, // §4.3 — per (tenant, target_version)
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M34_DLQ.dekRotate,
  },
  shred: {
    priority: 1, // the irreversible terminal effect — highest priority, single-flight
    attempts: 5,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 1, // §4.3 — per (tenant, cert); the four-phase shred is resume-from-last-marker
    removeOnComplete: { count: 500 },
    removeOnFail: false,
    dlq: M34_DLQ.shred,
  },
  dsarExport: {
    priority: 3,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 4, // §4.3 — per job_id
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M34_DLQ.dsarExport,
  },
  export: {
    priority: 4,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 2, // §4.3 — per job_id
    removeOnComplete: { count: 100 },
    removeOnFail: false,
    dlq: M34_DLQ.export,
  },
  onboardingAdvance: {
    priority: 5,
    attempts: 5,
    backoff: { type: "exponential", delay: 10_000 },
    concurrency: 4, // §4.3 — per (tenant, template)
    removeOnComplete: { count: 500 },
    removeOnFail: false,
    dlq: M34_DLQ.onboardingAdvance,
  },
  bundleExpirySweep: {
    priority: 6,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 1, // §4.3 — per (kind, date)
    removeOnComplete: { count: 50 },
    removeOnFail: false,
    dlq: M34_DLQ.bundleExpirySweep,
  },
  baaExpirySweep: {
    priority: 6,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 1, // §4.3 — per date
    removeOnComplete: { count: 50 },
    removeOnFail: false,
    dlq: M34_DLQ.baaExpirySweep,
  },
  supportSessionCloseSweep: {
    priority: 5,
    attempts: 3,
    backoff: { type: "fixed", delay: 30_000 },
    concurrency: 1, // §4.3 — per tick
    removeOnComplete: { count: 100 },
    removeOnFail: false,
    dlq: M34_DLQ.supportSessionCloseSweep,
  },
  dsarSlaEscalationSweep: {
    priority: 5,
    attempts: 3,
    backoff: { type: "fixed", delay: 60_000 },
    concurrency: 1, // per date (idempotent per tier-edge)
    removeOnComplete: { count: 50 },
    removeOnFail: false,
    dlq: M34_DLQ.dsarSlaEscalationSweep,
  },
} as const;

// ── §4.3 idempotency keys (the BullMQ jobId / Valkey SETNX keys the §4.3 table declares) ───────────────

/** `tenant.provision` jobId — per `tenant_account_id` (the SELECT-then-INSERT-IF-NOT-EXISTS replay oracle). */
export function provisionJobId(tenantAccountId: string): string {
  return `provision:${tenantAccountId}`;
}

/** `tenant.dek_rotate` jobId — per `(tenant_account_id, dek_version_target)` (the §4.3 dedup key). */
export function dekRotateJobId(input: { tenantAccountId: string; targetVersion: string }): string {
  return `dek_rotate:${input.tenantAccountId}:${input.targetVersion}`;
}

/** `tenant.shred` jobId — per `(tenant_account_id, destruction_cert_id)`. */
export function shredJobId(input: { tenantAccountId: string; destructionCertId: string }): string {
  return `shred:${input.tenantAccountId}:${input.destructionCertId}`;
}

/** `tenant.dsar_export` jobId — per `dsar_export_job_id`. */
export function dsarExportJobId(jobId: string): string {
  return `dsar_export:${jobId}`;
}

/** `tenant.export` jobId — per `tenant_export_job_id`. */
export function tenantExportJobId(jobId: string): string {
  return `tenant_export:${jobId}`;
}

/** `tenant.onboarding_advance` jobId — per `(tenant_account_id, template_key)` (§4.3). When a pass is the
 *  whole-tenant advance (no single template) the caller passes `template_key='*'`. */
export function onboardingAdvanceJobId(input: {
  tenantAccountId: string;
  templateKey: string;
}): string {
  return `onboarding_advance:${input.tenantAccountId}:${input.templateKey}`;
}

/** `tenant.bundle_expiry_sweep` jobId — per `(bundle_kind, date)`. */
export function bundleExpirySweepJobId(input: { kind: string; date: string }): string {
  return `bundle_expiry:${input.kind}:${input.date}`;
}

/** `tenant.baa_expiry_sweep` jobId — per `date`. */
export function baaExpirySweepJobId(date: string): string {
  return `baa_expiry:${date}`;
}

/** `tenant.support_session_close_sweep` jobId — per `tick_id`. */
export function supportSessionCloseSweepJobId(tickId: string): string {
  return `support_session_close:${tickId}`;
}

/** `tenant.dsar_sla_escalation_sweep` jobId — per `date`. */
export function dsarSlaEscalationSweepJobId(date: string): string {
  return `dsar_sla_escalation:${date}`;
}

// ── the per-org/platform scoping envelope the live wiring runs each processor inside ───────────────────

/**
 * The tenancy envelope a job runs inside. The live wiring resolves the scope from the job payload and
 * wraps the port-binding + the package-worker call in the matching @wardenx/tenancy context (F09):
 *   - `org`      → `withOrgContext` (orgId, …) — the DSAR/export/onboarding/bundle-sweep jobs scope to the
 *                  REQUESTING tenant's RLS (never platform bypass; the §7.3 F09 guard).
 *   - `platform` → `withPlatformContext` — the provision/dek-rotate/shred/baa-sweep/support-sweep/
 *                  dsar-sla-sweep jobs run on the separately-pooled, audited, RLS-bypass platform path.
 * This catalog only NAMES the required scope per queue ({@link M34_QUEUE_SCOPE}); the live wiring owns the
 * actual context call (mechanism), so the pure catalog stays infra-free.
 */
export type M34JobScope = "org" | "platform";

/** The required tenancy envelope per queue (the live wiring wraps each processor accordingly, F09). */
export const M34_QUEUE_SCOPE: Record<M34QueueName, M34JobScope> = {
  [M34_QUEUES.provision]: "platform",
  [M34_QUEUES.dekRotate]: "platform",
  [M34_QUEUES.shred]: "platform",
  [M34_QUEUES.dsarExport]: "org", // §7.3 F09 — the requesting tenant's withOrgContext, never bypass
  [M34_QUEUES.export]: "org", // §7.6 F09 — the requesting tenant's withOrgContext
  [M34_QUEUES.onboardingAdvance]: "org", // onboarding_task is org-scoped (§3.10)
  [M34_QUEUES.bundleExpirySweep]: "org", // §3.7 F09 — fanned out one org at a time
  [M34_QUEUES.baaExpirySweep]: "platform",
  [M34_QUEUES.supportSessionCloseSweep]: "platform",
  [M34_QUEUES.dsarSlaEscalationSweep]: "platform",
};

// ── the pure processors (thin closures over the §2B workers; the M4-T11 `descriptor.process` shape) ────

/**
 * A pure processor: the body a `Worker(queue, processor, …)` runs. It is `(jobData) => Promise<result>`
 * with the worker's ports already CLOSED OVER by the live wiring (so the run sits inside the right
 * tenancy envelope). Mirrors the M4 `auditJobDescriptors(...).process` shape — the package worker holds
 * the logic; this is the BullMQ-facing adapter that hands it the typed payload.
 */
export type M34JobProcessor<Data, Result> = (data: Data) => Promise<Result>;

/** `tenant.provision` processor — binds the provision worker over its ports. */
export function provisionProcessor(
  ports: ProvisionWorkerPorts,
): M34JobProcessor<ProvisionJob, ProvisionResult> {
  return (data) => runTenantProvision(data, ports);
}

/** `tenant.dek_rotate` processor — binds the DEK-rotate worker over its ports. */
export function dekRotateProcessor(
  ports: DekRotateWorkerPorts,
): M34JobProcessor<DekRotateJob, DekRotateResult> {
  return (data) => handleDekRotate(data, ports);
}

/** `tenant.shred` processor — binds the four-phase cryptographic-shred worker over its ports. */
export function shredProcessor(ports: ShredWorkerPorts): M34JobProcessor<ShredJob, ShredResult> {
  return (data) => runTenantShred(data, ports);
}

/** `tenant.dsar_export` processor — binds the patient-scoped DSAR fulfilment worker over its ports. */
export function dsarExportProcessor(
  ports: DsarExportWorkerPorts,
): M34JobProcessor<DsarExportJobInput, DsarExportRunResult> {
  return (data) => runDsarExportJob(data, ports);
}

/** `tenant.export` processor — binds the org-scoped whole-tenant NDJSON-archive worker over its ports. */
export function tenantExportProcessor(
  ports: TenantExportWorkerPorts,
): M34JobProcessor<TenantExportJobBody, TenantExportWorkerResult> {
  return (data) => runTenantExportJob(data, ports);
}

/** The `tenant.onboarding_advance` job payload — a single advance pass for a tenant (§4.8). */
export interface OnboardingAdvanceJob {
  readonly tenantAccountId: string;
  readonly orgId: string;
}

/** `tenant.onboarding_advance` processor — binds the onboarding-advance worker over its ports. */
export function onboardingAdvanceProcessor(
  ports: OnboardingAdvancePorts,
): M34JobProcessor<OnboardingAdvanceJob, OnboardingAdvanceReport> {
  return (data) => runOnboardingAdvance(data, ports);
}

/** The cron-sweep payloads carry only the idempotency discriminator (the work-set is read by the ports). */
export interface BundleExpirySweepJob {
  /** The org the sweep is scoped to (the scheduler fans out one org at a time, §3.7 F09). */
  readonly orgId: string;
  /** `YYYY-MM-DD` — the cron tick the jobId dedups on. */
  readonly date: string;
}

/** `tenant.bundle_expiry_sweep` processor — binds the 7-day bundle-object reaper over its ports. */
export function bundleExpirySweepProcessor(
  ports: BundleExpirySweepPorts,
): M34JobProcessor<BundleExpirySweepJob, BundleExpirySweepResult> {
  return () => runBundleExpirySweep(ports);
}

// NOTE — baa_expiry_sweep, support_session_close_sweep, and dsar_sla_escalation_sweep also have pure
// package services (`runBaaExpirySweep`, `closeExpiredSupportSessions`) / a DSAR-SLA scan, but their
// processor closures are built INLINE in `saas-jobs.ts` because they take additional per-run inputs the
// adapter assembles (the BAA sweep's ports, the support-session deps + the expired-candidate list, the
// DSAR-SLA candidate set). Keeping those in the live wiring avoids re-stating the deps here; the catalog
// owns the queue/param/schedule/idempotency truth, which is what the boot construction reads.
