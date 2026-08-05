// @wardenx/saas-tenant-platform · services — the `tenant.shred` job handler (M34 §3.5 / §7.2, M34).
//
// The IRREVERSIBLE four-phase cryptographic shred of a `destruction_pending` tenant (§3.5 / §7.2 step 5).
// This is the terminal `destruction_pending → destroyed` lifecycle effect (§2.5 r8): once Phase 3 runs the
// tenant's PHI is gone forever — even a backup restore of the ciphertext is cryptographically inaccessible
// because the wrapping KEK has no DEK left to decrypt (the "cryptographic shred" property, §7.2 step 6).
//
// The four phases, in the §3.5 authoritative order:
//   Phase 1 — every M4-registered module `eraseFn` is fired through M4's destruction-cert callback registry
//             (M34 does NOT bypass M4 — it calls back the registered erasers, §ER "Depends on M4" / D6). Each
//             returns an erased receipt OR a refusal outcome `refused_part_two_retention` (M4 D8): a 42 CFR
//             Part 2 record under a retention obligation the DEK is the only key for. The §3.5 marker is
//             `module_erasers_complete`.
//   ┌ ERASER-REFUSAL GATE (M34-F08 / ADR-0014 / ARCH-251) — BETWEEN Phase 1 and the irreversible Phase 3.
//   │ If ANY eraseFn refused, the worker ABORTS before DEK destruction: it records the refused-row counts on
//   │ the destruction certificate, writes a `dek_destruction_aborted_part_two_retention` log row, re-defers
//   │ the tenant `destruction_pending → retained` (reason `part_two_retention`), emits a critical
//   │ `data.destruction_deferred` audit event, and RETURNS. The DEK SURVIVES (it is the only key that can
//   └ decrypt the retained Part 2 ciphertext); `tenant.shred_eligibility_check` re-fires when retention lapses.
//   Phase 2 — the per-tenant MinIO scope is destroyed via M1's helper (reached only when no eraser refused).
//             The §3.5 marker is `minio_scope_destroyed`.
//   Phase 3 — the DEK is destroyed: the `m34_destroy_tenant_key_ring` SECURITY DEFINER fn nulls
//             `current_dek_kek_wrapped_ciphertext` + clears `prior_dek_versions`. THE IRREVERSIBLE EVENT.
//             The §3.5 marker is `deks_zeroized`. No other code path may null the ciphertext (table grants).
//   Phase 4 — the M4 destruction certificate is finalized with destruction timestamps, the tenant_account is
//             transitioned to `destroyed`, the critical `data.destruction_certified` audit event is written,
//             and the `m34.tenant.destroyed` outbox event is emitted (→ the `tenant.shred_executed` M36 alert,
//             §4.8). The §3.5 marker is `certificate_filed`.
//
// IDEMPOTENCY (§7.2 step 7 — "re-runnable; per-phase receipts resume from the last completed phase"): every
// phase is GUARDED by its own `tenant_key_destruction_log` marker. Before performing a phase the handler reads
// the phase trail (`keyRing.listDestructionLog`) and SKIPS any phase whose marker is already present — a
// completed phase re-runs as a no-op. The irreversible Phase 3 NEVER re-creates destroyed key material: if
// `deks_zeroized` (or a destroyed key ring) is already present it is skipped; the SECURITY DEFINER fn is itself
// a no-op on an already-destroyed ring (the `(destroyed_at IS NOT NULL) = (ciphertext IS NULL)` CHECK holds).
// The refusal abort (`dek_destruction_aborted_part_two_retention`) is also a terminal marker: a replay after a
// refusal re-checks the receipts and re-defers idempotently rather than ever reaching DEK destruction.
//
// PATTERN (the M34 `runTenantProvision` / `handleDekRotate` precedent, this very directory): PURE orchestration
// over an injected ports interface — no BullMQ, no Drizzle, no MinIO, no clock, no direct cross-module import.
// The app composition root binds the production adapters at boot. CROSS-MODULE ACCESS GOES THROUGH PORTS the
// boot wiring binds to a seam / the M4 destruction-cert registry / the M1 helpers (mirroring how 2A's
// abac-predicates reached M5 via `getSeam("CaseloadProvider")`) — this package adds NO direct M1/M2/M4 import
// and NO new manifest `dependsOn` edge (M34 stays `[1,2,3,4,36]`). The `TenantKeyRingRepository` IS used —
// through a port too, so the service layer owns the `withPlatformContext` (M1 @wardenx/tenancy) scoping and the
// single transaction the route/effect-runner commits the §2.5 r8 transition in.
import type { TenantKeyRingRepository } from "../repositories/tenant-key-ring";

/** The §3.5 cryptographic-shred phase markers, in execution order. Each is written to
 *  `tenant_key_destruction_log.destructionPhase` exactly once; its presence is the idempotency guard the
 *  handler reads before (re-)running the phase. `dek_destruction_aborted_part_two_retention` is the terminal
 *  refusal marker that replaces Phases 2–4 when an eraseFn refused (M34-F08). */
export const SHRED_PHASES = {
  /** Phase 1 done — every module eraseFn fired (receipts on the log row). */
  erasersComplete: "module_erasers_complete",
  /** The M34-F08 refusal abort — an eraseFn returned `refused_part_two_retention`; the DEK survives. */
  refusalAborted: "dek_destruction_aborted_part_two_retention",
  /** Phase 2 done — the per-tenant MinIO scope was destroyed (M1 helper). */
  minioDestroyed: "minio_scope_destroyed",
  /** Phase 3 done — the DEK was zeroized (the irreversible cryptographic shred). */
  deksZeroized: "deks_zeroized",
  /** Phase 4 done — the M4 certificate was filed + the tenant transitioned to `destroyed`. */
  certificateFiled: "certificate_filed",
} as const;

/** One §3.5 destruction-phase marker value. */
export type ShredPhaseMarker = (typeof SHRED_PHASES)[keyof typeof SHRED_PHASES];

/**
 * One module's eraseFn receipt from the Phase-1 M4 callback fan-out. Mirrors the §3.5 receipt shape: an
 * `erased` outcome carries the row count + a sha256 receipt; a `refused_part_two_retention` outcome (M4 D8)
 * carries the refused-row count so the deferral is auditable on the destruction certificate (M34-F08).
 */
export type EraserReceipt =
  | {
      readonly module: string;
      readonly outcome: "erased";
      /** Rows erased by this module's eraseFn (the destruction-certificate tally). */
      readonly erasedRows: number;
      /** The eraseFn's sha256 receipt over what it erased (the §7.2 surveyor chain). */
      readonly sha256?: string;
    }
  | {
      readonly module: string;
      /** M4 D8 — a 42 CFR Part 2 record under a retention obligation; the DEK is its only key. */
      readonly outcome: "refused_part_two_retention";
      /** Rows this module refused to erase (surfaced on the aborted certificate, M34-F08). */
      readonly refusedRows: number;
    };

/** A per-module refused-row count surfaced on the (aborted) destruction certificate + the re-defer (M34-F08). */
export interface RefusedRowsByModule {
  readonly module: string;
  readonly refusedRows: number;
}

/** The MinIO scope-destruction receipt (Phase 2, §3.5) — what the M1 helper reported it removed. */
export interface MinioDestroyReceipt {
  /** The per-tenant prefix the helper destroyed (`tenants/<orgId>/`). */
  readonly prefix: string;
  /** How many objects were removed (the destruction-certificate tally; 0 on a re-run/empty scope). */
  readonly objectsDeleted: number;
}

// ── cross-module ports (bound at boot to a seam / the M4 destruction-cert registry / M1 helpers) ──────────

/**
 * Phase 1 — the M4 destruction-cert callback fan-out. M34 does NOT own the eraser registry (it lives in M1's
 * composition root, `apps/backend/src/bootstrap/erasers/registry.ts`); M34 reaches it through this port the boot
 * wiring binds, exactly as a seam consumer would — no direct import, no new `dependsOn` edge.
 *
 * TODO(integrator — M4 destruction-cert registry): bind `callbackAllEraserFns` at the M34 shred-worker wiring
 * site to M4's `runDestruction(...)` over the registered `DataEraser`s for the tenant's data classes (the
 * `saas_tenant_platform_class` eraseFn — M34's OWN eraser registered via `registerEraser` per D6 — is one of
 * them). The adapter maps each `DataEraser.erase()` result / M4 `eraseAuditRows` outcome onto an
 * {@link EraserReceipt}; a `refused_part_two_retention` from M4's eraser becomes the refusal receipt here.
 * `recordCertificateRefusal` + `fileCertificate` are M4 certificate-workflow calls (§3.5 excerpt
 * `m4RecordCertificateRefusal` / `m4FileCertificate`). The `saas_tenant_platform_class` eraseFn itself is NOT
 * built in this task — it is the eraser-phase deliverable (see seam-bootstrap's TODO).
 */
export interface ShredEraserCallbackPort {
  /** Fire every M4-registered module `eraseFn` for the tenant under the approved certificate; return each
   *  module's receipt (erased or refused). Idempotent on M4's side: re-firing a completed eraseFn re-erases
   *  nothing (its rows are already gone) and reports a zero/again receipt. */
  callbackAllEraserFns(input: {
    orgId: string;
    destructionCertId: string;
  }): Promise<readonly EraserReceipt[]>;
  /** Record the refused-row counts on the (now-aborted) destruction certificate so the deferral is auditable
   *  (M34-F08). Bound to M4's certificate-workflow `recordCertificateRefusal`. */
  recordCertificateRefusal(input: {
    destructionCertId: string;
    reason: "part_two_retention";
    refusedRowsByModule: readonly RefusedRowsByModule[];
  }): Promise<void>;
  /** Finalize the M4 destruction certificate with the destruction timestamps (Phase 4, §3.5). Bound to M4's
   *  certificate-workflow `fileCertificate`. */
  fileCertificate(input: {
    destructionCertId: string;
    dekDestroyedAt: Date;
  }): Promise<void>;
}

/**
 * Phase 2 + Phase 3 — the M1-owned destructive primitives (the per-tenant MinIO helper + the
 * `m34_destroy_tenant_key_ring` SECURITY DEFINER fn). M34 holds no MinIO client code beyond what M1 provides
 * (§ER), and the DEK-zeroing fn runs as `tenant_platform_writer` (M1-owned role); both are reached through this
 * port the boot wiring binds — no direct M1 import, no new `dependsOn` edge.
 *
 * TODO(integrator — M1 MinIO helper + the SECURITY DEFINER fn): bind `destroyTenantStorageScope` to M1's MinIO
 * prefix-destroy helper for `tenants/<orgId>/`, and `destroyTenantKeyRing` to a
 * `db.execute(sql`SELECT m34_destroy_tenant_key_ring(${tenantAccountId}, ${destructionCertId})`)` run under
 * `withPlatformContext` (the fn is the ONLY code that may null the ciphertext + clear prior versions; the table
 * grants block any other path). The migration that ships the SECURITY DEFINER fn is M34-owned (the
 * `m34_provision_tenant_key_ring` precedent); this port only invokes it.
 */
export interface ShredDestructivePort {
  /** Phase 2: destroy the per-tenant MinIO scope (`tenants/<orgId>/`). Idempotent — a re-run over an
   *  already-empty scope reports `objectsDeleted: 0`. */
  destroyTenantStorageScope(input: { orgId: string }): Promise<MinioDestroyReceipt>;
  /** Phase 3 (IRREVERSIBLE): invoke `m34_destroy_tenant_key_ring(tenant_account_id, destruction_cert_id)` —
   *  the SECURITY DEFINER fn nulls `current_dek_kek_wrapped_ciphertext` + clears `prior_dek_versions`. A no-op
   *  on an already-destroyed ring (the CHECK constraint holds), so a Phase-3 replay never resurrects a key. */
  destroyTenantKeyRing(input: {
    tenantAccountId: string;
    destructionCertId: string;
    actorMembershipId: string;
  }): Promise<void>;
}

/** The §164.528 critical-audit hook (the M4 `audit()` helper, importable foundation). The shred worker writes
 *  the two §3.5 critical events: `data.destruction_certified` (Phase 4, the signed cert is an audit artifact)
 *  and `data.destruction_deferred` (the M34-F08 refusal abort). Both at `severity=critical`. */
export interface ShredAuditPort {
  /** Phase 4 — the destruction certificate was filed; record it at `severity=critical` (§3.5 step 6). */
  recordDestructionCertified(entry: {
    orgId: string;
    actorMembershipId: string;
    destructionCertId: string;
  }): Promise<void>;
  /** Refusal abort — an eraseFn refused; record the critical deferral with the refused-row counts (M34-F08). */
  recordDestructionDeferred(entry: {
    orgId: string;
    actorMembershipId: string;
    destructionCertId: string;
    refusedRowsByModule: readonly RefusedRowsByModule[];
  }): Promise<void>;
}

/** Applies the terminal §2.5 r8 lifecycle transition in the tenant_account's optimistic-locked tx (the
 *  effect-runner the route/worker layer owns, same as the provision worker's `commitProvisionedTransition`).
 *  ONE of the two branches runs, never both: `commitDestroyed` for the success path (Phase 4 → `destroyed` +
 *  `m34.tenant.destroyed` outbox), `commitDeferToRetained` for the M34-F08 refusal abort (→ `retained` +
 *  `m34.tenant.retained` outbox + the shred-eligibility re-schedule). */
export interface ShredLifecyclePort {
  /** Phase 4 — append the status-event, stamp `status='destroyed'` + `destroyed_at`, record the
   *  `destruction_certificate_id` on the key ring, and PUBLISH `m34.tenant.destroyed` in the SAME transaction
   *  (§2.6 outbox semantics; → the `tenant.shred_executed` M36 alert). Bound over the lifecycle service's
   *  `shred` effect-runner; the pure `transitionTenant("destruction_pending", {type:"shred",…})` is computed
   *  here so the illegal-from-state + actor guards run before the tx touches IO. */
  commitDestroyed(input: {
    tenantAccountId: string;
    orgId: string;
    actorMembershipId: string;
    transitionReason: string;
    destructionCertId: string;
    destroyedAt: Date;
  }): Promise<void>;
  /** Refusal abort — the M34-F08 `destruction_pending → retained` re-defer: append the status-event, stamp
   *  `status='retained'`, re-arm the shred-eligibility check, and PUBLISH `m34.tenant.retained` in the same tx.
   *  Bound over the lifecycle service's `deferForPartTwoRetention` effect-runner. The DEK is NOT destroyed. */
  commitDeferToRetained(input: {
    tenantAccountId: string;
    orgId: string;
    actorMembershipId: string;
    transitionReason: string;
    destructionCertId: string;
    refusedRowsByModule: readonly RefusedRowsByModule[];
  }): Promise<void>;
}

/** The ports the §3.5 four-phase shred worker composes over (key-ring repo + M4 eraser registry + M1
 *  destructive primitives + audit + lifecycle effect-runner + clock). Every fact/effect is injected — the
 *  handler is pure orchestration, deterministic + unit-assertable (the `runTenantProvision` ports shape). */
export interface ShredWorkerPorts {
  /** Injected clock — stamps the DEK destruction / certificate-filing instant deterministically (§3.5). */
  now(): Date;
  /** The `tenant_key_ring` data port (2A). The worker reads the ring + the destruction-phase trail and
   *  APPENDS phase-marker log rows; it NEVER nulls ciphertext (the SECURITY DEFINER fn alone does, via
   *  {@link ShredDestructivePort.destroyTenantKeyRing}). */
  readonly keyRing: Pick<
    TenantKeyRingRepository,
    "findByTenantAccountId" | "listDestructionLog" | "appendDestructionLog"
  >;
  /** Phase 1 + the certificate-workflow calls (M4 destruction-cert registry — injected, no direct import). */
  readonly erasers: ShredEraserCallbackPort;
  /** Phase 2 + Phase 3 (M1 MinIO helper + the SECURITY DEFINER DEK-destroy fn — injected). */
  readonly destructive: ShredDestructivePort;
  /** The two critical §3.5 audit events (M4 `audit()` helper). */
  readonly audit: ShredAuditPort;
  /** The terminal §2.5 r8 lifecycle transition (destroyed / refusal-defer), committed in one tx. */
  readonly lifecycle: ShredLifecyclePort;
  /** Preflight asserts the certificate is approved + no legal hold references the org (§3.5 excerpt
   *  `assertDestructionCertApproved` / `assertNoLegalHold`). Bound to the M4 cert reader + legal-hold reader. */
  assertCertApprovedAndNoHold(input: {
    tenantAccountId: string;
    orgId: string;
    destructionCertId: string;
    actorMembershipId: string;
  }): Promise<void>;
}

/** The `tenant.shred` job payload (§7.2 step 4 — keyed on `tenant_account_id` for idempotent replay, §2.6).
 *  Every field is resolved by the `POST /api/v1/platform/tenants/:orgId/shred` route (passkey-recent-2min
 *  step-up + the approved certificate id) before the job is enqueued; the worker performs no PHI read. */
export interface ShredJob {
  readonly tenantAccountId: string;
  readonly orgId: string;
  /** The M4 destruction certificate id (approved at the route, §7.2 step 4). */
  readonly destructionCertId: string;
  /** The platform-ops actor that invoked the shred (step-up satisfied at the route) — for the audit rows. */
  readonly actorMembershipId: string;
  /** A non-empty transition reason for the terminal lifecycle event (§2.4.1 — no status change without one). */
  readonly transitionReason: string;
}

/** What the shred handler reports (the §7.2 surveyor summary; assertable in unit tests). */
export interface ShredResult {
  /** `destroyed` — the four phases completed (DEK gone). `deferred_part_two_retention` — an eraseFn refused, so
   *  the worker aborted before Phase 3 and re-deferred the tenant to `retained` (the DEK survives, M34-F08). */
  readonly outcome: "destroyed" | "deferred_part_two_retention";
  readonly tenantAccountId: string;
  readonly orgId: string;
  /** The per-module Phase-1 receipts (erased + any refusals) — the destruction-certificate itemized record. */
  readonly eraserReceipts: readonly EraserReceipt[];
  /** The refused-row counts when `outcome='deferred_part_two_retention'` (empty otherwise). */
  readonly refusedRowsByModule: readonly RefusedRowsByModule[];
  /** The phase markers this run NEWLY wrote (empty when every phase was an idempotent replay no-op). */
  readonly phasesRun: readonly ShredPhaseMarker[];
}

/** Raised when no `tenant_key_ring` row exists for the tenant — provisioning never ran, or the wrong tenant id
 *  reached the shred worker. A shred with no key ring is a hard upstream error, not an idempotent no-op. */
export class ShredKeyRingMissing extends Error {
  constructor(tenantAccountId: string) {
    super(
      `tenant_key_ring not found for tenant_account ${tenantAccountId} — cannot shred a tenant that was never provisioned`,
    );
    this.name = "ShredKeyRingMissing";
  }
}

/**
 * Run one `tenant.shred` job (§3.5 / §7.2 step 5) — the IRREVERSIBLE four-phase cryptographic shred. Single
 * concurrency, idempotent on `tenant_account_id` (§7.2 step 7): each phase is guarded by its own
 * `tenant_key_destruction_log` marker, so a crash / replay resumes from the last completed phase and a
 * completed phase re-runs as a no-op. NEVER re-creates destroyed key material — Phase 3 is skipped once
 * `deks_zeroized` (or a destroyed ring) is present.
 *
 * Order (the §3.5 authoritative sequence):
 *   preflight — assert the certificate is approved + no legal hold references the org,
 *   Phase 1   — fire every M4-registered module eraseFn; log `module_erasers_complete` with the receipts,
 *   gate      — if ANY eraseFn refused (`refused_part_two_retention`, M4 D8): record the refusal on the cert,
 *               log `dek_destruction_aborted_part_two_retention`, re-defer the tenant to `retained`, write the
 *               critical `data.destruction_deferred` audit event, and RETURN (the DEK survives — M34-F08),
 *   Phase 2   — destroy the per-tenant MinIO scope; log `minio_scope_destroyed`,
 *   Phase 3   — destroy the DEK via the SECURITY DEFINER fn (the irreversible event); log `deks_zeroized`,
 *   Phase 4   — file the M4 certificate, transition the tenant to `destroyed` + emit `m34.tenant.destroyed`,
 *               write the critical `data.destruction_certified` audit event; log `certificate_filed`.
 *
 * @throws {ShredKeyRingMissing} no key ring for the tenant (a hard upstream error, not a replay no-op).
 */
export async function runTenantShred(job: ShredJob, ports: ShredWorkerPorts): Promise<ShredResult> {
  if (job.transitionReason.trim().length === 0) {
    throw new Error(
      "a non-empty transition reason is required for the tenant.shred transition (§2.4.1)",
    );
  }

  // Resolve the key ring + its phase trail up front: the ring id parents every log row, and the trail is the
  // idempotency oracle every phase consults (a marker present ⇒ that phase already completed, skip it).
  const ring = await ports.keyRing.findByTenantAccountId(job.tenantAccountId);
  if (ring === null) throw new ShredKeyRingMissing(job.tenantAccountId);

  const log = await ports.keyRing.listDestructionLog(ring.id, job.destructionCertId);
  const done = new Set<string>(log.map((row) => row.destructionPhase));
  const phasesRun: ShredPhaseMarker[] = [];

  /** Append a phase marker + remember it for the result, and treat it as completed for the rest of this run. */
  const markPhase = async (
    phase: ShredPhaseMarker,
    receipts: readonly unknown[] = [],
  ): Promise<void> => {
    await ports.keyRing.appendDestructionLog({
      organizationId: ring.organizationId,
      tenantKeyRingId: ring.id,
      destructionCertificateId: job.destructionCertId,
      destructionPhase: phase,
      perModuleEraserReceipts: receipts as never,
    });
    done.add(phase);
    phasesRun.push(phase);
  };

  // GUARD: if a prior run already aborted on a Part 2 refusal, this is a terminal deferred state. Re-defer is
  // idempotent (the lifecycle is already `retained`); never fall through to DEK destruction on a replay.
  if (done.has(SHRED_PHASES.refusalAborted) && !done.has(SHRED_PHASES.deksZeroized)) {
    const refused = priorRefusals(log);
    return {
      outcome: "deferred_part_two_retention",
      tenantAccountId: job.tenantAccountId,
      orgId: job.orgId,
      eraserReceipts: priorEraserReceipts(log),
      refusedRowsByModule: refused,
      phasesRun,
    };
  }

  // A fully filed certificate is the terminal idempotency state. The certificate is now `executed` and the
  // tenant is `destroyed`, so re-running the approval/eligibility preflight would incorrectly reject a valid
  // delivery replay. Return the durable phase receipts without touching erasers, storage, or key material.
  if (done.has(SHRED_PHASES.certificateFiled) && done.has(SHRED_PHASES.deksZeroized)) {
    return {
      outcome: "destroyed",
      tenantAccountId: job.tenantAccountId,
      orgId: job.orgId,
      eraserReceipts: priorEraserReceipts(log),
      refusedRowsByModule: [],
      phasesRun,
    };
  }

  // Preflight (§3.5 excerpt) — the certificate must be approved and no legal hold may reference the org. Cheap
  // + safe to re-run every attempt (read-only); it never advances a phase.
  await ports.assertCertApprovedAndNoHold({
    tenantAccountId: job.tenantAccountId,
    orgId: job.orgId,
    destructionCertId: job.destructionCertId,
    actorMembershipId: job.actorMembershipId,
  });

  // ── Phase 1: fire every M4-registered module eraseFn through the destruction-cert callback registry ──────
  // Skipped on replay once `module_erasers_complete` is present; the receipts are recovered from that log row
  // so the refusal gate + the result stay deterministic across a resume.
  let eraserReceipts: readonly EraserReceipt[];
  if (done.has(SHRED_PHASES.erasersComplete)) {
    eraserReceipts = priorEraserReceipts(log);
  } else {
    eraserReceipts = await ports.erasers.callbackAllEraserFns({
      orgId: job.orgId,
      destructionCertId: job.destructionCertId,
    });
    await markPhase(SHRED_PHASES.erasersComplete, eraserReceipts);
  }

  // ── Eraser-refusal gate (M34-F08 / ADR-0014 / ARCH-251) — BETWEEN Phase 1 and the irreversible Phase 3 ───
  // If ANY eraseFn refused, the DEK must NOT be destroyed (it is the only key for the retained Part 2
  // ciphertext). Record the refusal on the cert, log the abort marker, re-defer to `retained`, write the
  // critical deferral audit event, and RETURN. The whole branch is idempotent (markers guard each step).
  const refusals = eraserReceipts.filter(
    (r): r is Extract<EraserReceipt, { outcome: "refused_part_two_retention" }> =>
      r.outcome === "refused_part_two_retention",
  );
  if (refusals.length > 0) {
    const refusedRowsByModule: RefusedRowsByModule[] = refusals.map((r) => ({
      module: r.module,
      refusedRows: r.refusedRows,
    }));

    if (!done.has(SHRED_PHASES.refusalAborted)) {
      // Surface the refused-row counts on the (now-aborted) destruction certificate.
      await ports.erasers.recordCertificateRefusal({
        destructionCertId: job.destructionCertId,
        reason: "part_two_retention",
        refusedRowsByModule,
      });
      await markPhase(SHRED_PHASES.refusalAborted, refusedRowsByModule);
      // Re-defer the tenant `destruction_pending → retained` (the DEK survives) + re-arm the eligibility check.
      await ports.lifecycle.commitDeferToRetained({
        tenantAccountId: job.tenantAccountId,
        orgId: job.orgId,
        actorMembershipId: job.actorMembershipId,
        transitionReason: job.transitionReason,
        destructionCertId: job.destructionCertId,
        refusedRowsByModule,
      });
      // The critical `data.destruction_deferred` audit event (M34-F08).
      await ports.audit.recordDestructionDeferred({
        orgId: job.orgId,
        actorMembershipId: job.actorMembershipId,
        destructionCertId: job.destructionCertId,
        refusedRowsByModule,
      });
    }

    return {
      outcome: "deferred_part_two_retention",
      tenantAccountId: job.tenantAccountId,
      orgId: job.orgId,
      eraserReceipts,
      refusedRowsByModule,
      phasesRun,
    };
  }

  // No refusal — the DEK destruction path is permitted (the §2.2 binding rule: reaching here means every
  // eraseFn returned a non-refusal outcome, so the `shred` event — not `deferForPartTwoRetention` — applies).

  // ── Phase 2: destroy the per-tenant MinIO scope (M1 helper) ─────────────────────────────────────────────
  if (!done.has(SHRED_PHASES.minioDestroyed)) {
    const minioReceipt = await ports.destructive.destroyTenantStorageScope({ orgId: job.orgId });
    await markPhase(SHRED_PHASES.minioDestroyed, [minioReceipt]);
  }

  // ── Phase 3: destroy the DEK (SECURITY DEFINER fn) — THE IRREVERSIBLE EVENT ──────────────────────────────
  // Skipped on replay once `deks_zeroized` is present (or the ring is already destroyed); the fn is itself a
  // no-op on a destroyed ring, so this never re-creates / re-destroys key material — it is one-way.
  if (!done.has(SHRED_PHASES.deksZeroized)) {
    await ports.destructive.destroyTenantKeyRing({
      tenantAccountId: job.tenantAccountId,
      destructionCertId: job.destructionCertId,
      actorMembershipId: job.actorMembershipId,
    });
    await markPhase(SHRED_PHASES.deksZeroized);
  }

  // ── Phase 4: file the M4 certificate + transition to `destroyed` + critical audit + `m34.tenant.destroyed` ─
  // Even if Phase 4 failed on a prior attempt, the data is already destroyed (Phase 3 is irreversible); the
  // Phase-4 retry just files the certificate + transitions the status (§7.2 step 7).
  if (!done.has(SHRED_PHASES.certificateFiled)) {
    const destroyedAt = ports.now();
    await ports.erasers.fileCertificate({
      destructionCertId: job.destructionCertId,
      dekDestroyedAt: destroyedAt,
    });
    await ports.lifecycle.commitDestroyed({
      tenantAccountId: job.tenantAccountId,
      orgId: job.orgId,
      actorMembershipId: job.actorMembershipId,
      transitionReason: job.transitionReason,
      destructionCertId: job.destructionCertId,
      destroyedAt,
    });
    // The critical `data.destruction_certified` audit event — the signed certificate is itself an artifact.
    await ports.audit.recordDestructionCertified({
      orgId: job.orgId,
      actorMembershipId: job.actorMembershipId,
      destructionCertId: job.destructionCertId,
    });
    await markPhase(SHRED_PHASES.certificateFiled);
  }

  return {
    outcome: "destroyed",
    tenantAccountId: job.tenantAccountId,
    orgId: job.orgId,
    eraserReceipts,
    refusedRowsByModule: [],
    phasesRun,
  };
}

/** Recover the Phase-1 eraser receipts from the `module_erasers_complete` log row (a resume after that phase
 *  committed). Returns `[]` if the row carries no recognizable receipts (a defensive fallback on a resume). */
function priorEraserReceipts(
  log: readonly { destructionPhase: string; perModuleEraserReceipts: unknown }[],
): readonly EraserReceipt[] {
  const row = log.find((r) => r.destructionPhase === SHRED_PHASES.erasersComplete);
  const receipts = row?.perModuleEraserReceipts;
  return Array.isArray(receipts) ? (receipts as EraserReceipt[]) : [];
}

/** Recover the refused-row counts from the `dek_destruction_aborted_part_two_retention` log row (a resume
 *  after a prior run already aborted on a refusal). Returns `[]` if the row is absent / malformed. */
function priorRefusals(
  log: readonly { destructionPhase: string; perModuleEraserReceipts: unknown }[],
): readonly RefusedRowsByModule[] {
  const row = log.find((r) => r.destructionPhase === SHRED_PHASES.refusalAborted);
  const refused = row?.perModuleEraserReceipts;
  return Array.isArray(refused) ? (refused as RefusedRowsByModule[]) : [];
}
