// apps/backend/src/modules/36-messaging/jobs/integrity-jobs.ts — WP 1.9 (audit F8): the DB-bound bodies of the
// two §4.4 jobs the spec promised and nothing ran: `messaging.hash_verify` (M36-F03 body integrity, now also over
// the `message_revision` chain, ADR-0055 item 10) and `messaging.retention_scan` (M36-F10).
//
// Both are org-explicit: the caller (the BullMQ shell in ./integrity-workers.ts) enumerates active orgs and calls
// one of these per org; each opens its own `withOrgContext` (system actor) — a worker tick is not a request. All
// audit rows go through `@wardenx/audit` `audit()` and carry ids, hashes and counts only (no PHI, no body text).
//
// The retention scan PLANS; it never deletes. Physical destruction needs the messaging hold/retention ADR
// (ADR-0055 item 9) and the M4 certificate path, which is Phase 5 work. What this proves today is the rule that
// matters first: a held message is withheld from the plan.
import { randomUUID } from "node:crypto";
import { type AuditExecutor, audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import {
  type HashMismatchEvent,
  type HashVerifyRunResult,
  type HashVerifySampleRow,
  type RetentionCandidate,
  messageBodySha256,
  planRetentionDestruction,
  runHashVerify,
} from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { and, eq, lt } from "drizzle-orm";
import type { MessageBodyCipher } from "../messaging-write-core";
import {
  HASH_VERIFY_RANDOM_SAMPLE_SIZE,
  HASH_VERIFY_RECENT_OVERLAP_MS,
  HASH_VERIFY_SAMPLE_LIMIT,
  type RowMeta,
  readPreviousRun,
  sampleRows,
} from "./integrity-sampling";

export { HASH_VERIFY_SAMPLE_LIMIT };

type Db = DbClient;

/** The org's active legal-hold scope (M4's published read; bound at the composition root). */
export interface ActiveHoldScope {
  readonly orgWide: boolean;
  readonly patientIds: ReadonlySet<string>;
}

export interface M36IntegrityJobDeps {
  readonly db: Db;
  readonly cipher: MessageBodyCipher;
  readonly holdScopeForOrg: (organizationId: string) => Promise<ActiveHoldScope>;
  readonly now?: () => Date;
  readonly newRunId?: () => string;
  /** Rotation and recent-pass rows per table per run. Defaults to {@link HASH_VERIFY_SAMPLE_LIMIT}; tests inject small ones. */
  readonly sampleLimit?: number;
  /** Random-pass rows per table per run. Defaults to {@link HASH_VERIFY_RANDOM_SAMPLE_SIZE}. */
  readonly randomSampleSize?: number;
  /** How far before the previous run's start the recent pass reaches. Defaults to {@link HASH_VERIFY_RECENT_OVERLAP_MS}. */
  readonly recentOverlapMs?: number;
}

/** Candidates examined per org per weekly scan. */
export const RETENTION_SCAN_BATCH_LIMIT = 5000;

/** Years a message is retained, by channel retention class. care_related/bereavement follow ADR-0004 (7y). */
// ponytail: `operational` (announcements) is provisional until the messaging retention ADR fixes it.
export const MESSAGE_RETENTION_YEARS = { care_related: 7, bereavement: 7, operational: 1 } as const;

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

const MSG = schema.messages;
const REV = schema.messageRevisions;
const CH = schema.channels;

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
function recompute(cipher: MessageBodyCipher, orgId: string, meta: RowMeta): string | null {
  // Erased means cipher emptied AND hash = ERASED_BODY_SHA256 (the eraser sets them together); an emptied cipher with a hash left
  // behind is tampering and falls through to the mismatch sentinel.
  if (meta.cipherBytes.length === 0 && meta.storedHash === ERASED_BODY_SHA256) return null;
  try {
    return messageBodySha256(cipher.open(orgId, meta.cipherBytes));
  } catch {
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
  const previous = await readPreviousRun(deps.db, orgId);
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
        const computed = current ? recompute(deps.cipher, orgId, current) : null;
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
        ...(previous.cursorReset ? { cursorReset: previous.cursorReset } : {}),
      },
    });
    return result;
  });
}

export interface RetentionScanRunResult {
  readonly runId: string;
  readonly candidates: number;
  readonly toDestroy: number;
  readonly skippedLegalHold: number;
  /** Ids the plan would destroy; the scan itself deletes nothing. */
  readonly toDestroyMessageIds: readonly string[];
}

function windowEnd(now: Date, years: number): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

/** One org's weekly retention scan: plan only, hold-aware, recorded as one `m36.retention_scan.run` row. */
export async function runRetentionScanForOrg(
  deps: M36IntegrityJobDeps,
  orgId: string,
): Promise<RetentionScanRunResult> {
  const runId = (deps.newRunId ?? randomUUID)();
  const now = (deps.now ?? (() => new Date()))();
  const holds = await deps.holdScopeForOrg(orgId);
  return withOrgContext(deps.db, systemOrgContext(orgId), async (tx) => {
    const db = tx as unknown as Db;
    const candidates: (RetentionCandidate & { subjectId: string | null })[] = [];
    for (const [retentionClass, years] of Object.entries(MESSAGE_RETENTION_YEARS)) {
      const end = windowEnd(now, years);
      const rows = await db
        .select({ id: MSG.id, channelId: MSG.channelId, subjectId: CH.subjectId })
        .from(MSG)
        .innerJoin(CH, and(eq(CH.organizationId, MSG.organizationId), eq(CH.id, MSG.channelId)))
        .where(
          and(
            eq(MSG.organizationId, orgId),
            eq(CH.retentionClass, retentionClass as keyof typeof MESSAGE_RETENTION_YEARS),
            lt(MSG.createdAt, end),
          ),
        )
        .orderBy(MSG.createdAt, MSG.id)
        .limit(RETENTION_SCAN_BATCH_LIMIT);
      for (const r of rows) {
        candidates.push({
          messageId: r.id,
          channelId: r.channelId,
          retentionClass,
          windowEnd: end.toISOString(),
          // Conservative, like M10's read of the same scope: an org-wide hold withholds everything.
          legalHold: holds.orgWide || (r.subjectId !== null && holds.patientIds.has(r.subjectId)),
          subjectId: r.subjectId,
        });
      }
    }
    const plan = planRetentionDestruction(candidates);
    const result: RetentionScanRunResult = {
      runId,
      candidates: candidates.length,
      toDestroy: plan.toDestroy.length,
      skippedLegalHold: plan.skippedLegalHold,
      toDestroyMessageIds: plan.toDestroy.map((c) => c.messageId),
    };
    await audit(tx as unknown as AuditExecutor, jobContext(orgId, runId), {
      eventType: "m36.retention_scan.run",
      resourceKind: "message_retention_run",
      resourceId: runId,
      outcome: "success",
      context: {
        runId,
        candidates: result.candidates,
        toDestroy: result.toDestroy,
        skippedLegalHold: result.skippedLegalHold,
      },
    });
    return result;
  });
}
