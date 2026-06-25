// @wardenx/saas-tenant-platform · services — the `tenant.dek_rotate` job handler (M34 §3.5 / Pillar 3).
//
// Pillar 3 (§3.5): a tenant's DEK rotates on demand. This worker mints a NEW DEK version, re-wraps it
// under the active platform KEK, appends the OUTGOING (now-prior) DEK to `tenant_key_ring.priorDekVersions`
// so decrypt-only access to ciphertext written under the old version stays available (the
// `dekForOrgVersion(orgId, version)` seam M1's background re-encryption worker reads through), bumps
// `current_dek_version` + stamps `dek_last_rotated_at` via the key-ring repo (`recordRotation`), and emits
// `m34.tenant.dek_rotation_completed`. This is NOT the destruction path — the irreversible DEK zeroing is
// the `m34_destroy_tenant_key_ring` SECURITY DEFINER function, never this worker (it never nulls ciphertext).
//
// PATTERN (the M40 eraseFn / M40 nppes-nightly precedent): pure orchestration over an injected ports
// interface — no clock, no RNG, no I/O, no direct cross-module import here. The KEK mint/wrap primitive is
// M1-owned (the per-tenant DEK envelope helper, §ER "Depends on M1"); M34 reaches it through the
// `DekRotateKeyMaterialPort` the composition root binds (mirror of how 2A's abac-predicates reach M5 via
// `getSeam('CaseloadProvider')` rather than importing M5). M34 dependsOn stays `[1,2,3,4,36]`; no new edge.
//
// Idempotency (§4.3): the `tenant.dek_rotate` queue keys on `(tenant_account_id, dek_version_target)` with
// concurrency 2. This handler is idempotent on the target version: if the key ring is ALREADY at
// `targetVersion` (a redelivery after the `recordRotation` committed), it no-ops and reports `already_rotated`
// instead of minting a second DEK — the version label is the dedup key the queue and this handler share.
import type { schema } from "@wardenx/db";
import type { TenantKeyRingRepository } from "../repositories/tenant-key-ring";

/** One retained prior DEK version (`tenant_key_ring.priorDekVersions` element, §3.5 schema comment).
 *  `kekWrappedCiphertext` is base64 of the KEK-wrapped DEK bytes; `dekForOrgVersion` unwraps it for
 *  decrypt-only use during the re-encryption window. */
export interface PriorDekVersion {
  readonly version: string;
  /** base64 of the KEK-wrapped DEK ciphertext (jsonb cannot carry raw bytea). */
  readonly kekWrappedCiphertext: string;
  readonly kekId: string;
  /** ISO-8601 instant the version was rotated OUT (became prior). */
  readonly rotatedAt: string;
}

/** A freshly minted DEK wrapped under the active KEK — what {@link DekRotateKeyMaterialPort.mintAndWrapDek}
 *  returns. The raw DEK key material NEVER crosses this boundary unwrapped; only the KEK-wrapped ciphertext
 *  + the KEK id that wrapped it are handed back (the DEK is minted, wrapped, and zeroized inside the port). */
export interface WrappedDek {
  /** The KEK-wrapped DEK ciphertext, stored verbatim into `current_dek_kek_wrapped_ciphertext` (bytea). */
  readonly kekWrappedCiphertext: Buffer;
  /** The KEK identifier that wrapped this DEK (→ `current_dek_kek_id`; supports KEK rotation, §threat-model). */
  readonly kekId: string;
}

/**
 * The cross-module key-material port (M1-owned envelope/KEK primitive, §ER). The composition root binds the
 * real M1 implementation; M34 NEVER imports M1 directly (dependency runs M1 → M34's published TenantKeyProvider
 * interface, and this rotate port runs the inverse: M34 → an injected M1 primitive, the same shape as a seam).
 *
 * TODO(integrator — M1 envelope helper): M1 must implement + inject this port at the M34 worker-wiring site.
 * `mintAndWrapDek` is M1's `generateDek()` + `wrapUnderActiveKek()` composed; M1 owns the HSM-backed KEK
 * (Security Hardening §8.4) and zeroizes the raw DEK after wrapping. No new manifest dependsOn edge is added.
 */
export interface DekRotateKeyMaterialPort {
  /** Mint a fresh 256-bit DEK and wrap it under the platform's active KEK. Raw DEK never leaves the port. */
  mintAndWrapDek(orgId: string): Promise<WrappedDek>;
}

/** Emits the typed `m34.*` outbox event in the SAME tenant_account transaction as the `recordRotation`
 *  write (M1 §25.5/§25.6 — "DB updated but the event never went out" is closed in one tx). The composition
 *  root binds the real outbox dispatcher; the payload is validated against the §4.9 schema on publish. */
export interface DekRotateOutboxPort {
  emitDekRotationCompleted(payload: {
    readonly tenantAccountId: string;
    readonly orgId: string;
    readonly fromVersion: string;
    readonly toVersion: string;
    readonly rotatedAt: string;
  }): Promise<void>;
}

/** The §164.528-style operational-audit hook (M4 `audit()` helper, importable foundation). DEK rotation is a
 *  key-management event recorded against the platform security owner / the requesting actor. */
export interface DekRotateAuditPort {
  recordDekRotated(entry: {
    readonly orgId: string;
    readonly actorMembershipId: string;
    readonly fromVersion: string;
    readonly toVersion: string;
  }): Promise<void>;
}

/** The ports the §3.5 rotate worker composes over (key-ring repo + M1 KEK primitive + outbox + audit + clock).
 *  Every fact/effect is injected — the handler itself is pure orchestration, deterministic + unit-assertable. */
export interface DekRotateWorkerPorts {
  /** The `tenant_key_ring` data port (2A). The worker reads the ring + calls `recordRotation` only — it never
   *  nulls ciphertext (that is the SECURITY DEFINER destruction function alone, per the repo's boundary note). */
  readonly keyRing: Pick<TenantKeyRingRepository, "findByOrganizationId" | "recordRotation">;
  /** M1-owned mint-and-wrap of the new DEK under the active KEK (injected; no direct M1 import). */
  readonly keyMaterial: DekRotateKeyMaterialPort;
  readonly outbox: DekRotateOutboxPort;
  readonly audit: DekRotateAuditPort;
  /** Injected clock — stamps `dek_last_rotated_at` + the prior-version `rotatedAt` (deterministic in tests). */
  now(): Date;
}

/** The `tenant.dek_rotate` job payload (§4.3 — keyed on `tenant_account_id + dek_version_target`). The route
 *  (`POST /api/v1/platform/tenants/:orgId/dek-rotate`, step-up, `tenant_lifecycle_platform_ops`) enqueues it. */
export interface DekRotateJob {
  readonly orgId: string;
  /** The membership effecting the rotation (platform-ops, step-up satisfied at the route) — for the audit row. */
  readonly actorMembershipId: string;
  /** The version label the job dedups on (§4.3 idempotency key). When omitted the handler derives the next
   *  label from the current ring version (`vN → v{N+1}`); when supplied it is the rotation's idempotency target. */
  readonly targetVersion?: string;
}

/** What a rotation reported. `outcome='rotated'` minted a new version; `already_rotated` was an idempotent
 *  redelivery (the ring was already at the target version — no second DEK minted). */
export interface DekRotateResult {
  readonly outcome: "rotated" | "already_rotated";
  readonly orgId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
}

/** Raised when no `tenant_key_ring` row exists for the org (provisioning never ran / wrong org). */
export class DekRotateKeyRingMissing extends Error {
  constructor(orgId: string) {
    super(
      `tenant_key_ring not found for org ${orgId} — cannot rotate a DEK that was never provisioned`,
    );
    this.name = "DekRotateKeyRingMissing";
  }
}

/** Raised when the key ring is in the cryptographic-shred terminal state (`destroyed_at IS NOT NULL`). A
 *  destroyed ring's DEK is gone — rotating it is meaningless and would resurrect a key for shredded PHI. */
export class DekRotateKeyRingDestroyed extends Error {
  constructor(orgId: string) {
    super(
      `tenant_key_ring for org ${orgId} is destroyed (cryptographic shred) — refusing to rotate`,
    );
    this.name = "DekRotateKeyRingDestroyed";
  }
}

/** Parse a `vN` monotonic version label to its ordinal; throws on a malformed label so a bad ring is loud. */
function versionOrdinal(label: string): number {
  const m = /^v(\d+)$/.exec(label);
  if (!m?.[1]) throw new Error(`malformed DEK version label '${label}' (expected 'vN')`);
  return Number.parseInt(m[1], 10);
}

/** The next monotonic label after `label` (`v1 → v2`, …). */
function nextVersionLabel(label: string): string {
  return `v${versionOrdinal(label) + 1}`;
}

/**
 * Handle one `tenant.dek_rotate` job (§3.5 / §4.3). Mints a new DEK version, re-wraps under the active KEK,
 * appends the outgoing version to `priorDekVersions` (decrypt-only access to prior versions stays available
 * via the `dekForOrgVersion` seam), bumps `current_dek_version` + stamps `dek_last_rotated_at`, and emits
 * `m34.tenant.dek_rotation_completed`. Idempotent on the target version (a redelivery after commit no-ops).
 *
 * Ordering (the §3.5 invariant): the new DEK is minted+wrapped BEFORE `recordRotation` commits, so the ring is
 * never left without a current ciphertext; the outgoing version is only appended to the prior list as part of
 * the same `recordRotation` write, so a crash either rotates fully or not at all (the repo write is the commit
 * boundary — the composition root runs this inside the tenant's `withOrgContext` optimistic-locked tx).
 *
 * @throws {DekRotateKeyRingMissing}   no ring for the org
 * @throws {DekRotateKeyRingDestroyed} the ring is in the cryptographic-shred terminal state
 */
export async function handleDekRotate(
  job: DekRotateJob,
  ports: DekRotateWorkerPorts,
): Promise<DekRotateResult> {
  const ring: schema.TenantKeyRing | null = await ports.keyRing.findByOrganizationId(job.orgId);
  if (ring === null) throw new DekRotateKeyRingMissing(job.orgId);
  if (ring.destroyedAt !== null || ring.currentDekKekWrappedCiphertext === null) {
    throw new DekRotateKeyRingDestroyed(job.orgId);
  }

  const fromVersion = ring.currentDekVersion;
  const targetVersion = job.targetVersion ?? nextVersionLabel(fromVersion);

  // Idempotency (§4.3): a redelivery after the previous run committed finds the ring already at the target.
  // No-op rather than mint a second DEK — the version label is the dedup key shared with the queue job key.
  if (fromVersion === targetVersion) {
    return { outcome: "already_rotated", orgId: job.orgId, fromVersion, toVersion: targetVersion };
  }
  // Guard a stale/out-of-order target (the queue key dedups, but defend the monotonic invariant anyway).
  if (versionOrdinal(targetVersion) <= versionOrdinal(fromVersion)) {
    throw new Error(
      `dek_rotate target '${targetVersion}' is not newer than current '${fromVersion}' for org ${job.orgId}`,
    );
  }

  const rotatedAtIso = ports.now().toISOString();

  // Mint + wrap the NEW DEK first — the ring is never left without a current ciphertext (the §3.5 invariant).
  const minted = await ports.keyMaterial.mintAndWrapDek(job.orgId);

  // Append the OUTGOING (now-prior) version so decrypt-only access to old-version ciphertext stays available
  // (the `dekForOrgVersion(orgId, version)` seam M1's re-encryption worker reads through, §4.6). The existing
  // prior list is carried forward verbatim; jsonb stores ciphertext base64 (raw bytea cannot live in jsonb).
  const existingPriors = (ring.priorDekVersions as readonly PriorDekVersion[] | null) ?? [];
  const outgoingPrior: PriorDekVersion = {
    version: fromVersion,
    kekWrappedCiphertext: ring.currentDekKekWrappedCiphertext.toString("base64"),
    kekId: ring.currentDekKekId ?? "",
    rotatedAt: rotatedAtIso,
  };
  const priorDekVersions: PriorDekVersion[] = [...existingPriors, outgoingPrior];

  // Bump current_dek_version + replace the wrapped ciphertext/KEK id + stamp dek_last_rotated_at (2A repo).
  // This is the commit boundary; it NEVER nulls ciphertext (destruction is the SECURITY DEFINER function alone).
  await ports.keyRing.recordRotation(ring.id, {
    currentDekVersion: targetVersion,
    currentDekKekWrappedCiphertext: minted.kekWrappedCiphertext,
    currentDekKekId: minted.kekId,
    priorDekVersions,
    dekLastRotatedAt: ports.now(),
  });

  // Operational audit (key-management event) + the §4.9 outbox event, both in the same tx as the write.
  await ports.audit.recordDekRotated({
    orgId: job.orgId,
    actorMembershipId: job.actorMembershipId,
    fromVersion,
    toVersion: targetVersion,
  });
  await ports.outbox.emitDekRotationCompleted({
    tenantAccountId: ring.tenantAccountId,
    orgId: job.orgId,
    fromVersion,
    toVersion: targetVersion,
    rotatedAt: rotatedAtIso,
  });

  return { outcome: "rotated", orgId: job.orgId, fromVersion, toVersion: targetVersion };
}
