// apps/backend/src/modules/36-messaging/jobs/integrity-jobs.ts — WP 1.9 (audit F8): the DB-bound bodies of the
// two §4.4 jobs the spec promised and nothing ran: `messaging.hash_verify` (M36-F03 body integrity, now also over
// the `message_revision` chain, ADR-0055 item 10) and `messaging.retention_scan` (M36-F10).
//
// Both are org-explicit: the caller (the BullMQ shell in ./integrity-workers.ts) enumerates active orgs and calls
// one of these per org; each opens its own `withOrgContext` (system actor) — a worker tick is not a request. All
// audit rows go through `@chartwarden/audit` `audit()` and carry ids, hashes and counts only (no PHI, no body text).
//
// The retention scan PLANS; it never deletes. Physical destruction needs the messaging hold/retention ADR
// (ADR-0055 item 9) and the M4 certificate path, which is Phase 5 work. What this proves today is the rule that
// matters first: a held message is withheld from the plan.
import { randomUUID } from "node:crypto";
import { type AuditExecutor, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import {
  type HashMismatchEvent,
  type HashVerifyRunResult,
  type HashVerifySampleRow,
  messageBodySha256,
  runHashVerify,
} from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { BodyKeyUnavailableError } from "../body-key-ring";
import type { MessageBodyCipher } from "../messaging-write-core";
import { countLegacyBodiesInTx } from "./body-backfill";
import {
  HASH_VERIFY_RANDOM_SAMPLE_SIZE,
  HASH_VERIFY_RECENT_OVERLAP_MS,
  HASH_VERIFY_SAMPLE_LIMIT,
  type RowMeta,
  readPreviousRun,
  sampleRows,
} from "./integrity-sampling";
import type { MessageHoldPort } from "./retention-hold-sql";

export {
  MESSAGE_RETENTION_YEARS,
  RETENTION_SCAN_BATCH_LIMIT,
  type RetentionScanRunResult,
  runRetentionScanForOrg,
} from "./retention-scan";

export { HASH_VERIFY_SAMPLE_LIMIT };

type Db = DbClient;

export interface M36IntegrityJobDeps {
  readonly db: Db;
  readonly cipher: MessageBodyCipher;
  /** M4's message-hold seam (active holds + pending certificates), bound at the composition root. */
  readonly messageHolds: MessageHoldPort;
  /** WP 5.6: the tenant flag `messaging.retention_attachment_destruction` (absent = off); see RetentionScanDeps. */
  readonly attachmentObjectsEnabled?: (organizationId: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
  /** Rotation and recent-pass rows per table per run. Defaults to {@link HASH_VERIFY_SAMPLE_LIMIT}; tests inject small ones. */
  readonly sampleLimit?: number;
  /** Random-pass rows per table per run. Defaults to {@link HASH_VERIFY_RANDOM_SAMPLE_SIZE}. */
  readonly randomSampleSize?: number;
  /** How far before the previous run's start the recent pass reaches. Defaults to {@link HASH_VERIFY_RECENT_OVERLAP_MS}. */
  readonly recentOverlapMs?: number;
}

/** What the audit row for a failed GCM/auth decode records as the "computed" hash (never body text). */
export const DECRYPT_FAILED = "decrypt-failed";

/**
 * Consecutive DECRYPT_FAILED rows (counted per table: heads, then revisions) after which per-row mismatch rows stop
 * and ONE summary row is written instead: a whole-org key misconfiguration would otherwise write thousands of
 * critical rows. The summary lists the first {@link SUPPRESSED_ID_RECORD_LIMIT} suppressed resource ids.
 */
export const SYSTEMIC_DECRYPT_FAILURE_THRESHOLD = 20;
/** Suppressed resource ids kept (ids only) in the systemic-failure summary row. */
export const SUPPRESSED_ID_RECORD_LIMIT = 50;

/**
 * The hash the §7.8 eraser leaves on a shredded head beside its emptied cipher. `message_sha256_shape` requires a
 * 64-hex value, so the earlier empty-string sentinel made the eraser's UPDATE fail on a real database.
 */
export const ERASED_BODY_SHA256 = "0".repeat(64);

function jobContext(organizationId: string, runId: string) {
  return {
    organizationId,
    userId: null,
    actorKind: "system" as const,
    correlationId: runId,
  };
}

/**
 * Recompute the plaintext SHA-256 of a stored cipher. An erased tenant (cipher emptied by the §7.8 eraser) is
 * `null` (skipped, not a mismatch). A cipher that no longer authenticates under the tenant DEK is tampered or
 * corrupt, so it is reported as a mismatch against a sentinel rather than skipped.
 */
async function recompute(
  cipher: MessageBodyCipher,
  orgId: string,
  meta: RowMeta,
): Promise<string | null> {
  // Erased means cipher emptied AND hash = ERASED_BODY_SHA256 (the eraser sets them together); an emptied cipher with a hash left
  // behind is tampering and falls through to the mismatch sentinel.
  if (meta.cipherBytes.length === 0 && meta.storedHash === ERASED_BODY_SHA256) return null;
  try {
    return messageBodySha256(await cipher.open(orgId, meta.cipherBytes));
  } catch (err) {
    // A key outage is not tampering: fail the run (retried, DLQ alert) instead of writing critical mismatch rows.
    // A DESTROYED ring is the M34 crypto-shred (authorised by a destruction certificate): the body is permanently
    // unreadable by design, so it is skipped like an erased tenant (never retried forever, never a mismatch).
    if (err instanceof BodyKeyUnavailableError) {
      if (err.destroyed) return null;
      throw err;
    }
    return DECRYPT_FAILED;
  }
}

/**
 * One org's nightly integrity run: verify the rotation page, the recently created rows and a random page of message
 * heads and revisions (see ./integrity-sampling.ts), record every mismatch
 * (`m36.integrity.hash_mismatch`, severity critical) and one `m36.hash_verify.run` summary row. The caller fails
 * the job when `mismatched > 0` so BullMQ's failed set and the DLQ alert fire (same posture as M4 integrity_sample).
 */
export async function runHashVerifyForOrg(
  deps: M36IntegrityJobDeps,
  orgId: string,
): Promise<HashVerifyRunResult> {
  const runId = (deps.newRunId ?? randomUUID)();
  const detectedAt = (deps.now ?? (() => new Date()))().toISOString();
  const previous = await readPreviousRun(deps.db, orgId, new Date(detectedAt));
  return withOrgContext(deps.db, systemOrgContext(orgId), async (tx) => {
    const ctx = jobContext(orgId, runId);
    const exec = tx as unknown as AuditExecutor;
    const sampled = await sampleRows(tx as unknown as Db, orgId, previous, {
      limit: deps.sampleLimit ?? HASH_VERIFY_SAMPLE_LIMIT,
      randomSize: deps.randomSampleSize ?? HASH_VERIFY_RANDOM_SAMPLE_SIZE,
      recentOverlapMs: deps.recentOverlapMs ?? HASH_VERIFY_RECENT_OVERLAP_MS,
    });
    const { rows, meta } = sampled;
    // runHashVerify emits a mismatch immediately after recomputing the same row, so the row just recomputed
    // is the one the event is about.
    let current: RowMeta | undefined;
    let consecutiveDecryptFailures = 0;
    let streakKind: RowMeta["resourceKind"] | undefined;
    let suppressedMismatches = 0;
    const suppressedIds: string[] = [];
    const result = await runHashVerify(runId, detectedAt, rows, {
      async recomputeHash(row) {
        current = meta.get(row);
        // The streak is per table: a failing head run must not silence the first revision's own mismatch row.
        if (current && current.resourceKind !== streakKind) {
          streakKind = current.resourceKind;
          consecutiveDecryptFailures = 0;
        }
        const computed = current ? await recompute(deps.cipher, orgId, current) : null;
        // An erased skip (null) neither extends nor breaks the streak; any decrypt that worked resets it.
        if (computed === DECRYPT_FAILED) consecutiveDecryptFailures += 1;
        else if (computed !== null) consecutiveDecryptFailures = 0;
        return computed;
      },
      async emitMismatch(event: HashMismatchEvent) {
        if (
          event.computedHash === DECRYPT_FAILED &&
          consecutiveDecryptFailures > SYSTEMIC_DECRYPT_FAILURE_THRESHOLD
        ) {
          suppressedMismatches += 1; // still counted in `mismatched`, so the tick still fails
          if (current && suppressedIds.length < SUPPRESSED_ID_RECORD_LIMIT) {
            suppressedIds.push(current.resourceId);
          }
          return;
        }
        await audit(exec, ctx, {
          eventType: "m36.integrity.hash_mismatch",
          resourceKind: current?.resourceKind ?? "message",
          resourceId: current?.resourceId ?? event.messageId,
          outcome: "failure",
          severity: "critical",
          context: {
            runId,
            messageId: event.messageId,
            channelId: event.channelId,
            storedHash: event.storedHash,
            computedHash: event.computedHash,
            detectedAt: event.detectedAt,
            ...(current?.revisionNo !== undefined ? { revisionNo: current.revisionNo } : {}),
          },
        });
      },
    });
    if (suppressedMismatches > 0) {
      await audit(exec, ctx, {
        eventType: "m36.integrity.systemic_decrypt_failure",
        resourceKind: "message_integrity_run",
        resourceId: runId,
        outcome: "failure",
        severity: "critical",
        context: {
          runId,
          organizationId: orgId,
          threshold: SYSTEMIC_DECRYPT_FAILURE_THRESHOLD,
          suppressedMismatches,
          firstSuppressedResourceId: suppressedIds[0] ?? null,
          suppressedResourceIds: suppressedIds,
          detectedAt,
        },
      });
    }
    // WP 2.13: how many rows still sit on the legacy envelope (the standing signal that the P1 backfill is not done).
    const legacyBodies = await countLegacyBodiesInTx(tx, orgId);
    await audit(exec, ctx, {
      eventType: "m36.hash_verify.run",
      resourceKind: "message_integrity_run",
      resourceId: runId,
      outcome: result.mismatched > 0 ? "failure" : "success",
      severity: result.mismatched > 0 ? "critical" : "info",
      context: {
        ...result,
        cursorEnd: sampled.cursorEnd,
        passCounts: sampled.passCounts,
        recentSince: sampled.recentSince,
        recentOverflow: sampled.recentOverflow,
        legacyBodies,
        ...(previous.cursorReset ? { cursorReset: previous.cursorReset } : {}),
        ...(previous.ignoredNonSystemRuns > 0
          ? { ignoredNonSystemRuns: previous.ignoredNonSystemRuns }
          : {}),
      },
    });
    return result;
  });
}
