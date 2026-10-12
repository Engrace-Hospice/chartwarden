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
import { and, eq, lt, sql } from "drizzle-orm";
import type { MessageBodyCipher } from "../messaging-write-core";

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
}

/** Rows verified per table per org per night; random order so repeated runs cover the whole table over time. */
// ponytail: random sample, not a cursor; add a (last_verified_at) cursor if full coverage per cycle is required.
export const HASH_VERIFY_SAMPLE_LIMIT = 5000;
/** Candidates examined per org per weekly scan. */
export const RETENTION_SCAN_BATCH_LIMIT = 5000;

/** Years a message is retained, by channel retention class. care_related/bereavement follow ADR-0004 (7y). */
// ponytail: `operational` (announcements) is provisional until the messaging retention ADR fixes it.
export const MESSAGE_RETENTION_YEARS = { care_related: 7, bereavement: 7, operational: 1 } as const;

/** What the audit row for a failed GCM/auth decode records as the "computed" hash (never body text). */
export const DECRYPT_FAILED = "decrypt-failed";

const MSG = schema.messages;
const REV = schema.messageRevisions;
const CH = schema.channels;

interface RowMeta {
  readonly cipherBytes: Buffer;
  readonly storedHash: string;
  readonly resourceKind: "message" | "message_revision";
  readonly resourceId: string;
  readonly revisionNo?: number;
}

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
  // Erased means cipher AND hash both blanked (the eraser sets them together); an emptied cipher with a hash left
  // behind is tampering and falls through to the mismatch sentinel.
  if (meta.cipherBytes.length === 0 && meta.storedHash === "") return null;
  try {
    return messageBodySha256(cipher.open(orgId, meta.cipherBytes));
  } catch {
    return DECRYPT_FAILED;
  }
}

/** Sample heads and revisions for one org, inside the org's RLS context. */
async function sampleRows(
  tx: Parameters<Parameters<typeof withOrgContext>[2]>[0],
  orgId: string,
  limit: number,
): Promise<{ rows: HashVerifySampleRow[]; meta: WeakMap<HashVerifySampleRow, RowMeta> }> {
  const db = tx as unknown as Db;
  const heads = await db
    .select({
      id: MSG.id,
      channelId: MSG.channelId,
      bodyCipher: MSG.bodyCipher,
      bodySha256: MSG.bodySha256,
    })
    .from(MSG)
    .where(eq(MSG.organizationId, orgId))
    .orderBy(sql`random()`)
    .limit(limit);
  const revisions = await db
    .select({
      id: REV.id,
      messageId: REV.messageId,
      revisionNo: REV.revisionNo,
      channelId: MSG.channelId,
      bodyCipher: REV.bodyCipher,
      bodySha256: REV.bodySha256,
    })
    .from(REV)
    .innerJoin(MSG, and(eq(MSG.organizationId, REV.organizationId), eq(MSG.id, REV.messageId)))
    .where(eq(REV.organizationId, orgId))
    .orderBy(sql`random()`)
    .limit(limit);

  const meta = new WeakMap<HashVerifySampleRow, RowMeta>();
  const rows: HashVerifySampleRow[] = [];
  // Integrity is checked for held rows too: a hold blocks destruction, it never excuses tampering.
  for (const h of heads) {
    const row: HashVerifySampleRow = {
      messageId: h.id,
      channelId: h.channelId,
      organizationId: orgId,
      storedHash: h.bodySha256,
      legalHold: false,
    };
    meta.set(row, { cipherBytes: h.bodyCipher, storedHash: h.bodySha256, resourceKind: "message", resourceId: h.id });
    rows.push(row);
  }
  for (const r of revisions) {
    const row: HashVerifySampleRow = {
      messageId: r.messageId,
      channelId: r.channelId,
      organizationId: orgId,
      storedHash: r.bodySha256,
      legalHold: false,
    };
    meta.set(row, {
      cipherBytes: r.bodyCipher,
      storedHash: r.bodySha256,
      resourceKind: "message_revision",
      resourceId: r.id,
      revisionNo: r.revisionNo,
    });
    rows.push(row);
  }
  return { rows, meta };
}

/**
 * One org's nightly integrity run: verify a sample of message heads and revisions, record every mismatch
 * (`m36.integrity.hash_mismatch`, severity critical) and one `m36.hash_verify.run` summary row. The caller fails
 * the job when `mismatched > 0` so BullMQ's failed set and the DLQ alert fire (same posture as M4 integrity_sample).
 */
export async function runHashVerifyForOrg(
  deps: M36IntegrityJobDeps,
  orgId: string,
): Promise<HashVerifyRunResult> {
  const runId = (deps.newRunId ?? randomUUID)();
  const detectedAt = (deps.now ?? (() => new Date()))().toISOString();
  return withOrgContext(deps.db, systemOrgContext(orgId), async (tx) => {
    const ctx = jobContext(orgId, runId);
    const exec = tx as unknown as AuditExecutor;
    const { rows, meta } = await sampleRows(tx, orgId, HASH_VERIFY_SAMPLE_LIMIT);
    // runHashVerify emits a mismatch immediately after recomputing the same row, so the row just recomputed
    // is the one the event is about.
    let current: RowMeta | undefined;
    const result = await runHashVerify(runId, detectedAt, rows, {
      async recomputeHash(row) {
        current = meta.get(row);
        return current ? recompute(deps.cipher, orgId, current) : null;
      },
      async emitMismatch(event: HashMismatchEvent) {
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
    await audit(exec, ctx, {
      eventType: "m36.hash_verify.run",
      resourceKind: "message_integrity_run",
      resourceId: runId,
      outcome: result.mismatched > 0 ? "failure" : "success",
      severity: result.mismatched > 0 ? "critical" : "info",
      context: { ...result },
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
