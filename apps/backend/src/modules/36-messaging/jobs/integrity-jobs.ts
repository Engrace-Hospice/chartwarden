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
import { type AuditExecutor, audit, createDbAuditQuery } from "@wardenx/audit";
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
import { type SQL, and, eq, lt, sql } from "drizzle-orm";
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
  /** Rows verified per table per org per run. Defaults to {@link HASH_VERIFY_SAMPLE_LIMIT}; tests inject a small one. */
  readonly sampleLimit?: number;
}

/**
 * Rows verified per table per org per night. Selection is a guaranteed rotation, not a random sample: each run
 * continues in (created_at, id) order after the previous run's cursor and wraps to the start, so every row is
 * verified once per ceil(rows / limit) runs. The cursor lives in the previous `m36.hash_verify.run` audit row.
 */
// ponytail: rows created or edited since the last run are NOT verified out of turn (an unbounded read on a busy
// org, and an edit adds a revision at the tail anyway); a tampered row is found within one rotation. Add a
// "created_at > last run" pass if sub-rotation latency for new rows is required.
export const HASH_VERIFY_SAMPLE_LIMIT = 5000;
/** Candidates examined per org per weekly scan. */
export const RETENTION_SCAN_BATCH_LIMIT = 5000;

/** Years a message is retained, by channel retention class. care_related/bereavement follow ADR-0004 (7y). */
// ponytail: `operational` (announcements) is provisional until the messaging retention ADR fixes it.
export const MESSAGE_RETENTION_YEARS = { care_related: 7, bereavement: 7, operational: 1 } as const;

/** What the audit row for a failed GCM/auth decode records as the "computed" hash (never body text). */
export const DECRYPT_FAILED = "decrypt-failed";

/**
 * Consecutive DECRYPT_FAILED rows in one run after which per-row mismatch rows stop and ONE summary row is written
 * instead: a whole-org key misconfiguration would otherwise write up to 2 * HASH_VERIFY_SAMPLE_LIMIT critical rows.
 */
export const SYSTEMIC_DECRYPT_FAILURE_THRESHOLD = 20;

/**
 * The hash the §7.8 eraser leaves on a shredded head beside its emptied cipher. `message_sha256_shape` requires a
 * 64-hex value, so the earlier empty-string sentinel made the eraser's UPDATE fail on a real database.
 */
export const ERASED_BODY_SHA256 = "0".repeat(64);

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
  // Erased means cipher emptied AND hash = ERASED_BODY_SHA256 (the eraser sets them together); an emptied cipher with a hash left
  // behind is tampering and falls through to the mismatch sentinel.
  if (meta.cipherBytes.length === 0 && meta.storedHash === ERASED_BODY_SHA256) return null;
  try {
    return messageBodySha256(cipher.open(orgId, meta.cipherBytes));
  } catch {
    return DECRYPT_FAILED;
  }
}

/** Position in one table's (created_at, id) order; `createdAt` is Postgres' own text form (keeps microseconds). */
export interface RotationCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** Where the next run resumes, per table; `null` = start from the beginning. */
export interface RotationCursors {
  readonly heads: RotationCursor | null;
  readonly revisions: RotationCursor | null;
}

const FROM_START: RotationCursors = { heads: null, revisions: null };

function parseCursor(raw: unknown): RotationCursor | null {
  if (!raw || typeof raw !== "object") return null;
  const { createdAt, id } = raw as Record<string, unknown>;
  return typeof createdAt === "string" && typeof id === "string" ? { createdAt, id } : null;
}

/**
 * The previous run's end cursors, read from its `m36.hash_verify.run` audit row through the audit query helper (a
 * plain org-scoped SELECT as `wardenx_app`; reads write no audit row). A missing or malformed row restarts the
 * rotation, which is safe: it only re-verifies rows.
 */
async function readPreviousCursors(db: Db, orgId: string): Promise<RotationCursors> {
  const page = await createDbAuditQuery(db).searchEvents(orgId, {
    eventType: "m36.hash_verify.run",
    limit: 1,
  });
  const end = page.items[0]?.context.cursorEnd;
  if (!end || typeof end !== "object") return FROM_START;
  const { heads, revisions } = end as Record<string, unknown>;
  return { heads: parseCursor(heads), revisions: parseCursor(revisions) };
}

/** Keep `limit` rows; when the lookahead row proved more exist, resume after the last kept one, else wrap. */
function pageOf<T extends { readonly id: string; readonly createdAtText: string }>(
  fetched: readonly T[],
  limit: number,
): { page: readonly T[]; end: RotationCursor | null } {
  if (fetched.length <= limit) return { page: fetched, end: null };
  const page = fetched.slice(0, limit);
  const last = page[page.length - 1] as T;
  return { page, end: { createdAt: last.createdAtText, id: last.id } };
}

function pastCursor(createdAt: SQL, id: SQL, cursor: RotationCursor | null): SQL | undefined {
  return cursor
    ? sql`(${createdAt}, ${id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
    : undefined;
}

/** The next page of heads and revisions for one org (inside its RLS context) and where it ended. */
async function sampleRows(
  tx: Parameters<Parameters<typeof withOrgContext>[2]>[0],
  orgId: string,
  limit: number,
  from: RotationCursors,
): Promise<{
  rows: HashVerifySampleRow[];
  meta: WeakMap<HashVerifySampleRow, RowMeta>;
  cursorEnd: RotationCursors;
}> {
  const db = tx as unknown as Db;
  const fetchedHeads = await db
    .select({
      id: MSG.id,
      createdAtText: sql<string>`${MSG.createdAt}::text`,
      channelId: MSG.channelId,
      bodyCipher: MSG.bodyCipher,
      bodySha256: MSG.bodySha256,
    })
    .from(MSG)
    .where(
      and(
        eq(MSG.organizationId, orgId),
        pastCursor(sql`${MSG.createdAt}`, sql`${MSG.id}`, from.heads),
      ),
    )
    .orderBy(MSG.createdAt, MSG.id)
    .limit(limit + 1);
  const fetchedRevisions = await db
    .select({
      id: REV.id,
      createdAtText: sql<string>`${REV.createdAt}::text`,
      messageId: REV.messageId,
      revisionNo: REV.revisionNo,
      channelId: MSG.channelId,
      bodyCipher: REV.bodyCipher,
      bodySha256: REV.bodySha256,
    })
    .from(REV)
    .innerJoin(MSG, and(eq(MSG.organizationId, REV.organizationId), eq(MSG.id, REV.messageId)))
    .where(
      and(
        eq(REV.organizationId, orgId),
        pastCursor(sql`${REV.createdAt}`, sql`${REV.id}`, from.revisions),
      ),
    )
    .orderBy(REV.createdAt, REV.id)
    .limit(limit + 1);
  const heads = pageOf(fetchedHeads, limit);
  const revisions = pageOf(fetchedRevisions, limit);

  const meta = new WeakMap<HashVerifySampleRow, RowMeta>();
  const rows: HashVerifySampleRow[] = [];
  // Integrity is checked for held rows too: a hold blocks destruction, it never excuses tampering.
  for (const h of heads.page) {
    const row: HashVerifySampleRow = {
      messageId: h.id,
      channelId: h.channelId,
      organizationId: orgId,
      storedHash: h.bodySha256,
      legalHold: false,
    };
    meta.set(row, {
      cipherBytes: h.bodyCipher,
      storedHash: h.bodySha256,
      resourceKind: "message",
      resourceId: h.id,
    });
    rows.push(row);
  }
  for (const r of revisions.page) {
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
  return { rows, meta, cursorEnd: { heads: heads.end, revisions: revisions.end } };
}

/**
 * One org's nightly integrity run: verify the next rotation page of message heads and revisions, record every mismatch
 * (`m36.integrity.hash_mismatch`, severity critical) and one `m36.hash_verify.run` summary row. The caller fails
 * the job when `mismatched > 0` so BullMQ's failed set and the DLQ alert fire (same posture as M4 integrity_sample).
 */
export async function runHashVerifyForOrg(
  deps: M36IntegrityJobDeps,
  orgId: string,
): Promise<HashVerifyRunResult> {
  const runId = (deps.newRunId ?? randomUUID)();
  const detectedAt = (deps.now ?? (() => new Date()))().toISOString();
  const from = await readPreviousCursors(deps.db, orgId);
  return withOrgContext(deps.db, systemOrgContext(orgId), async (tx) => {
    const ctx = jobContext(orgId, runId);
    const exec = tx as unknown as AuditExecutor;
    const { rows, meta, cursorEnd } = await sampleRows(
      tx,
      orgId,
      deps.sampleLimit ?? HASH_VERIFY_SAMPLE_LIMIT,
      from,
    );
    // runHashVerify emits a mismatch immediately after recomputing the same row, so the row just recomputed
    // is the one the event is about.
    let current: RowMeta | undefined;
    let consecutiveDecryptFailures = 0;
    let suppressedMismatches = 0;
    let firstSuppressed: RowMeta | undefined;
    const result = await runHashVerify(runId, detectedAt, rows, {
      async recomputeHash(row) {
        current = meta.get(row);
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
          firstSuppressed ??= current;
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
          firstSuppressedResourceId: firstSuppressed?.resourceId ?? null,
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
      context: { ...result, cursorEnd },
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
