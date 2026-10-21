// @chartwarden/messaging — messaging job processors (M36-T08, spec §4.4 / §4.4.1 / §8.1.2).
//
// The pure, infra-free logic the distinctive §4.4 workers run, each a function over injected ports —
// the same pattern as the M4 audit jobs and the M38 terminology jobs: unit-tested against in-memory
// ports (./ports), with the production Drizzle/Valkey/vendor adapters bound to the identical port
// shapes at the app boot. The send_* / fan_out queues are orchestration over vendor adapters that do
// not exist in Phase-0 infra — those are catalogued in ./queues and wired when M1 supplies the
// Valkey connection + Twilio/Postmark/web-push adapters; this file owns the logic that is pure and
// security-load-bearing:
//
//   • hash_verify     → M36-F03 message-body integrity (§8.1.2): decrypt+rehash a sample, emit
//                       `m36.integrity.hash_mismatch` on divergence, and produce the per-run summary.
//   • retention_scan  → M36-F10: legal-hold messages are filtered out BEFORE any destruction is
//                       scheduled — a hold must never be silently shredded by the rolling scan.
//   • DLQ landing     → OPS-035: every job exhausting its retries is recorded as `m36.dlq_job`
//                       (no silent drain); the raw job payload is HASHED, never stored verbatim.
//
// No clock/RNG/I/O here — timestamps + the runId are passed in, so a run's effects are assertable.

import { createHash } from "node:crypto";

// --- hash_verify (messaging.hash_verify, §4.4 / §8.1.2 / M36-F03 / ARCH-206 / ARCH-240) --------

/** One sampled message the integrity scan examines (the row whose `body_sha256` is being checked). */
export interface HashVerifySampleRow {
  readonly messageId: string;
  readonly channelId: string;
  readonly organizationId: string;
  /** The `body_sha256` stored at write time (hex SHA-256 of the pre-encryption plaintext). */
  readonly storedHash: string;
  /** A legal hold pins the row — the rolling scan defers it (verified on hold release, not here). */
  readonly legalHold: boolean;
}

/** The `m36.integrity.hash_mismatch` audit payload (§8.1.2) — emitted on divergence; paged to ops. */
export interface HashMismatchEvent {
  readonly messageId: string;
  readonly channelId: string;
  readonly organizationId: string;
  readonly storedHash: string;
  readonly computedHash: string;
  readonly detectedAt: string;
}

/** Ports the hash-verify processor binds (Drizzle read of `body_cipher` + tenant-DEK decrypt + audit). */
export interface HashVerifyPorts {
  /**
   * Recompute the SHA-256 of the decrypted plaintext for `row`, or `null` when the tenant DEK is
   * gone (offboarded tenant) — a destroyed-DEK decode is SKIPPED, never counted as a mismatch
   * (§4.4.1). Production decrypts `body_cipher` under the tenant DEK and hashes; tests stub it.
   */
  recomputeHash(row: HashVerifySampleRow): Promise<string | null>;
  /** Emit `m36.integrity.hash_mismatch` (compliance-class) — divergence is paged to ops (§8.1.2). */
  emitMismatch(event: HashMismatchEvent): Promise<void>;
}

/** The `m36.hash_verify.run` summary (§8.1.2). `scanned` partitions into the four disjoint counts. */
export interface HashVerifyRunResult {
  readonly runId: string;
  readonly detectedAt: string;
  readonly scanned: number;
  readonly matched: number;
  readonly mismatched: number;
  readonly skippedDeletedTenant: number;
  readonly skippedLegalHold: number;
}

/**
 * Verify a sample of message bodies against their stored `body_sha256` (§8.1.2 / M36-F03). For each
 * row: a legal hold defers it (`skippedLegalHold`); a destroyed tenant DEK skips it
 * (`skippedDeletedTenant`); otherwise the plaintext is rehashed and compared — a mismatch emits
 * `m36.integrity.hash_mismatch` and is counted. `scanned` is the sample size and equals
 * matched + mismatched + skippedDeletedTenant + skippedLegalHold (a checkable invariant).
 */
export async function runHashVerify(
  runId: string,
  detectedAt: string,
  rows: readonly HashVerifySampleRow[],
  ports: HashVerifyPorts,
): Promise<HashVerifyRunResult> {
  let matched = 0;
  let mismatched = 0;
  let skippedDeletedTenant = 0;
  let skippedLegalHold = 0;

  for (const row of rows) {
    if (row.legalHold) {
      skippedLegalHold += 1;
      continue;
    }
    const computedHash = await ports.recomputeHash(row);
    if (computedHash === null) {
      skippedDeletedTenant += 1;
      continue;
    }
    if (computedHash === row.storedHash) {
      matched += 1;
    } else {
      mismatched += 1;
      await ports.emitMismatch({
        messageId: row.messageId,
        channelId: row.channelId,
        organizationId: row.organizationId,
        storedHash: row.storedHash,
        computedHash,
        detectedAt,
      });
    }
  }

  return {
    runId,
    detectedAt,
    scanned: rows.length,
    matched,
    mismatched,
    skippedDeletedTenant,
    skippedLegalHold,
  };
}

// --- retention_scan (messaging.retention_scan, §4.4 / M36-F10) --------------------------------

/** A message/channel the retention scan considers for destruction once past its class window. */
export interface RetentionCandidate {
  readonly messageId: string;
  readonly channelId: string;
  readonly retentionClass: string;
  /** The class window end (ISO) — the scan is idempotent on (channelId, retentionClass, windowEnd). */
  readonly windowEnd: string;
  /** A legal hold pins the row — it must NOT be scheduled for destruction (M36-F10). */
  readonly legalHold: boolean;
}

/** What the retention planner decided: rows to destroy vs the legal-hold rows it withheld. */
export interface RetentionScanPlan {
  readonly toDestroy: readonly RetentionCandidate[];
  readonly skippedLegalHold: number;
}

/**
 * Partition retention candidates into the rows to schedule for destruction (via M4 D4 certificates,
 * created by the wiring layer) and the legal-hold rows withheld (§4.4 / M36-F10). Pure: a legal hold
 * is checked BEFORE any destruction is planned, so a held message can never be silently shredded by
 * the rolling scan.
 */
export function planRetentionDestruction(
  candidates: readonly RetentionCandidate[],
): RetentionScanPlan {
  const toDestroy = candidates.filter((c) => !c.legalHold);
  return { toDestroy, skippedLegalHold: candidates.length - toDestroy.length };
}

// --- DLQ landing (any messaging.*.dlq, §4.4.1 / OPS-035) --------------------------------------

/** A job that exhausted its retries and landed in a DLQ (the input to the OPS-035 audit record). */
export interface DlqLanding {
  readonly queue: string;
  readonly jobId: string;
  /** The job payload — HASHED for the audit record, never stored verbatim (may carry PHI ids). */
  readonly jobData: unknown;
  readonly failedAt: string;
  readonly finalError: string;
}

/** The `m36.dlq_job` audit payload (§8.1.2). `disposition` is filled in when ops later clears it. */
export interface DlqAuditRecord {
  readonly queue: string;
  readonly jobId: string;
  readonly jobDataHash: string;
  readonly failedAt: string;
  readonly finalError: string;
  /** `pending` until ops documents a disposition (retry / drop / escalate) — OPS-035 no silent drain. */
  readonly disposition: "pending";
}

/**
 * Build the `m36.dlq_job` audit record for a DLQ landing (§4.4.1 / OPS-035). The raw `jobData` is
 * SHA-256 hashed (so a poisonous/PHI-bearing payload is never persisted in the audit log) and the
 * record opens with `disposition: 'pending'` — a dead-letter job is a signal that MUST be reviewed
 * and dispositioned before it is cleared (no silent drain). Pure.
 */
export function buildDlqAuditRecord(landing: DlqLanding): DlqAuditRecord {
  const jobDataHash = createHash("sha256")
    .update(JSON.stringify(landing.jobData ?? null))
    .digest("hex");
  return {
    queue: landing.queue,
    jobId: landing.jobId,
    jobDataHash,
    failedAt: landing.failedAt,
    finalError: landing.finalError,
    disposition: "pending",
  };
}
