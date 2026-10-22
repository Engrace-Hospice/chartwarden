// apps/backend/src/modules/36-messaging/attachments/attachment-service-db.ts — WP 1.5 "Attachments via M22".
//
// The lifecycle, and the one rule that holds it together: NOTHING is delivered unless `scan_state = 'clean'`.
//
//   authorize  caller may send in the channel -> row (pending, not completed) + a checksum-enforced presigned PUT
//   complete   uploader only; the object must have landed with the declared size/type/sha256 -> `completed_at`
//   scan       pending -> clean | quarantined (final, enforced by a DB trigger). A scanner that cannot answer leaves
//              the row pending; there is no auto-clean anywhere in this file.
//   bind       a send names attachment ids; they must be the author's own, completed, unbound, same channel, not
//              quarantined. A pending one is accepted but invisible to every reader but its uploader.
//   access     a CURRENT member who can view the channel, clean, message not deleted -> one `attachment_access_event`
//              and a signed URL that lives 120 s. Every refusal is the same 404 a random id gets.
//
// Retention warning: any FUTURE hard delete of a message or channel (a retention job) MUST destroy the attachment
// objects first - the composite FK cascades and removes the `message_attachment` rows (the only pointers to the bytes)
// without touching the object store, which would orphan PHI in the tenant bucket. Mirror the eraser / orphan reaper.
//
// Everything runs under `withOrgContext` (RLS on app.org_id is the backstop); org and actor always come from the
// server-side request context. The service never logs a URL, a file name or an object key.
import { createHash, randomUUID } from "node:crypto";
import { type AuditExecutor, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import type { MessageAttachmentView } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  DegradedError,
  NotFoundError,
  RateLimitedError,
} from "@chartwarden/types";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  activeLiveHolds,
  isMessageHeldNow,
  messageHeldByAnyPredicate,
} from "../jobs/retention-hold-sql";
import { type HintOutboxPort, publishMessageHint } from "../message-hint-events";
import { hasImageMetadata } from "./attachment-metadata";
import {
  ATTACHMENT_ACCESS_TTL_SECONDS,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  type AttachmentQuota,
  DEFAULT_USER_REQUESTS_PER_MINUTE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_INLINE_SCANS_PER_ORG,
  MAX_INLINE_SCANS_PER_PROCESS,
  MAX_INLINE_SCAN_ATTEMPTS,
  MAX_OPEN_UPLOADS_PER_USER,
  MAX_ORG_SCAN_FAILURES_PER_TICK,
  MAX_QUARANTINED_UPLOADS_PER_USER,
  OBJECT_MISSING_MIN_OBSERVATIONS,
  OBJECT_MISSING_MIN_SPAN_MS,
  ORPHAN_UPLOAD_GRACE_MS,
  QUARANTINED_UPLOAD_WINDOW_MS,
  REAP_DESTROY_DEADLINE_MS,
  SCAN_RETRY_BASE_MS,
  SCAN_RETRY_MAX_EXPONENT,
  SCAN_RETRY_MAX_MS,
  SCAN_ROW_DEADLINE_MS,
  SCAN_UNAVAILABLE_ATTEMPTS,
  STORAGE_INSPECT_DEADLINE_MS,
  UNBOUND_UPLOAD_BIND_MAX_AGE_MS,
  UNBOUND_UPLOAD_REAP_AGE_MS,
  attachmentObjectKey,
  attachmentQuotaFromEnv,
  attachmentRetentionMsFromEnv,
  eraseLockName,
  isScanExpired,
  validateAuthorizeInput,
} from "./attachment-policy";
import type { AttachmentStoragePort, ScanPort } from "./attachment-ports";
import {
  ABORT_SETTLE_GRACE_MS,
  type InlineScanGate,
  ScanFailure,
  type ScanFailureKind,
  createFixedWindowCounter,
  createInlineScanGate,
  runWithDeadline,
  throwIfAborted,
} from "./attachment-scan-gate";

const ATT = schema.messageAttachments;
const AE = schema.attachmentAccessEvents;
const CH = schema.channels;
const MSG = schema.messages;
const EB = schema.messagingEraseBlocks;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export type AttachmentAvailability = "uploading" | "scanning" | "available" | "blocked";

export interface AttachmentStatus {
  readonly attachmentId: string;
  readonly channelId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly scanState: "pending" | "clean" | "quarantined";
  /**
   * uploading: not completed yet. scanning: awaiting a verdict. available: clean. blocked: quarantined, or scan expired
   * (pending > 24 h with no verdict; still `pending` underneath, never deliverable, and a later real verdict settles it).
   */
  readonly availability: AttachmentAvailability;
  /** True once a send bound it to a message. */
  readonly attached: boolean;
}

export interface AuthorizedUpload {
  readonly attachmentId: string;
  readonly upload: {
    readonly method: "PUT";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
  readonly status: AttachmentStatus;
}

export interface AttachmentAccess {
  readonly url: string;
  readonly expiresAt: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface ScanRunResult {
  readonly clean: number;
  readonly quarantined: number;
  /** Rows the scanner could not answer for; they stay pending and are retried by the next tick. */
  readonly deferred: number;
  /** Of `deferred`: scanner transport failures (clamd connect/timeout/bad reply). Charged to the failing org only. */
  readonly scannerFailures: number;
  /** Of `deferred`: the tenant's own side failed (its bucket 5xx/unreachable, or the database). Charged to that org only. */
  readonly storeFailures: number;
  /**
   * Rows this sweep failed on that have now failed SCAN_UNAVAILABLE_ATTEMPTS times or more: the operator signal "the scan
   * pipeline has been unable to judge this file for a long time". Derived, not a state: the rows stay `pending`
   * (never clean, never quarantined) and keep being retried at the slow backoff cadence.
   */
  readonly scanUnavailable: number;
}

export interface ReapRunResult {
  /** Rows whose object was destroyed and which were then deleted. */
  readonly reaped: number;
  /** Rows kept because their object could not be destroyed; the next tick retries them. */
  readonly failed: number;
  /**
   * Retained objects skipped by the pre-destroy hold re-check (ADR-0086); retried once the hold is released. Rows already excluded at
   * candidate-read time because their message is held are not counted.
   */
  readonly skippedLegalHold: number;
}

export interface AttachmentServiceDeps {
  readonly db: DbClient;
  readonly storage: AttachmentStoragePort;
  /** Absent => nothing is ever scanned and nothing ever becomes deliverable (fail closed). */
  readonly scanner?: ScanPort | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  /** The channel_visibility rule: a CURRENT member with Part 2 / care-team gating (the route service's own). */
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** Try one scan right after `complete` (default true). The sweep worker is the retry path either way. */
  readonly scanOnComplete?: boolean;
  readonly now?: () => Date;
  readonly onScanError?: (context: { attachmentId: string }, error: unknown) => void;
  /** Called (alert-worthy) when a sweep failure leaves a row at/over SCAN_UNAVAILABLE_ATTEMPTS failed attempts. */
  readonly onScanUnavailable?: (context: { attachmentId: string; attempts: number }) => void;
  /** Total stored-bytes quotas enforced at authorize. Default: `attachmentQuotaFromEnv(process.env)`. */
  readonly quota?: AttachmentQuota;
  /** Test override of the storage-call deadlines (complete's inspect, the reaper's destroy). Default per-call constants. */
  readonly storageDeadlineMs?: number;
  /** After a deadline aborts a port call, how long to wait for it to really stop before giving up on it. Default 5 s. */
  readonly abortGraceMs?: number;
  /**
   * The credential that may DELETE `message_attachment` rows (`chartwarden_destruction`; the app role has no DELETE grant).
   * Absent => the orphan reaper is a no-op and abandoned uploads accumulate (bytes and rows) until it is bound.
   */
  readonly reaperDb?: DbClient | undefined;
  readonly onReapError?: (context: { attachmentId: string }, error: unknown) => void;
  /** Retention of a quarantined / deleted-message file's object before the reaper destroys it. Default: MESSAGING_ATTACHMENT_RETENTION_DAYS (7). */
  readonly retentionMs?: number;
  /** Per-user requests per minute for authorize and complete (default 60). A 429 `RATE_LIMITED` past it. */
  readonly userRequestsPerMinute?: number;
  /** Per-scan wall-clock bound (read + scanner). Default SCAN_ROW_DEADLINE_MS. */
  readonly scanDeadlineMs?: number;
  /** Bound on concurrent inline scans. Default: one gate shared by every service in the process. */
  readonly inlineScanGate?: InlineScanGate;
}

export interface AttachmentService {
  authorize(
    orgId: string,
    input: {
      userId: string;
      channelId: string;
      fileName: string;
      contentType: string;
      byteSize: number;
      sha256Hex: string;
    },
  ): Promise<AuthorizedUpload>;
  complete(
    orgId: string,
    input: { userId: string; attachmentId: string },
  ): Promise<AttachmentStatus>;
  status(orgId: string, input: { userId: string; attachmentId: string }): Promise<AttachmentStatus>;
  access(orgId: string, input: { userId: string; attachmentId: string }): Promise<AttachmentAccess>;
  /**
   * One org's sweep: scan every completed, still-pending attachment (least-recently-attempted first, bounded). Stops
   * after MAX_ORG_SCAN_FAILURES_PER_TICK failures of its own, and stops STARTING scans once `budgetMs` (the tick's
   * REMAINING shared budget, measured from this call on the service's own clock) is spent. No state is shared between
   * orgs: one tenant cannot delay another's scanning. `budgetMs` is this org's fair-share SLICE: the first due scan always
   * starts when the slice is positive (so no org with pending work is skipped), later ones only while the slice lasts;
   * 0 means the tick's time is gone. Only rows whose retry backoff has elapsed are due.
   */
  scanPendingForOrg(
    orgId: string,
    opts?: { limit?: number; budgetMs?: number },
  ): Promise<ScanRunResult>;
  /**
   * One org's orphan reap: abandoned uploads (never completed, expired past the grace) and finished uploads no message
   * ever adopted (older than 7 days) have their OBJECT destroyed first, then their row deleted. A row whose object
   * cannot be destroyed stays, so the work is retryable and no byte is left without a pointer. The same run also destroys the
   * OBJECT (the row stays, stamped `object_destroyed_at`) of a quarantined file, and of a file on a deleted message, once the
   * retention window has passed; each such destroy counts in `reaped` (or `failed`).
   */
  reapOrphansForOrg(
    orgId: string,
    opts?: { limit?: number; budgetMs?: number },
  ): Promise<ReapRunResult>;
}

const SCAN_BATCH_LIMIT = 50;
const REAP_BATCH_LIMIT = 25;
const ONE_MINUTE_MS = 60_000;
/** An open upload with less than this left is not re-signed on retry (the adapter clamps a TTL to >= 30 s). */
const MIN_REUSABLE_UPLOAD_MS = 60_000;
/** One gate for the process: the route-side service and the sweep's service are separate instances. */
const PROCESS_INLINE_SCAN_GATE = createInlineScanGate(
  MAX_INLINE_SCANS_PER_PROCESS,
  MAX_INLINE_SCANS_PER_ORG,
);

function notFound(): NotFoundError {
  return new NotFoundError("attachment");
}

function formatBytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.ceil(n / 1024 ** 2)} MiB`;
}

/**
 * Refuse while the tenant's messaging data is being erased. Takes the erase lock in SHARED mode for the rest of this
 * transaction: the eraser takes it EXCLUSIVELY to set the flag, so it waits for this transaction to commit (its row is then
 * visible to the eraser) and every later transaction sees the committed flag here. See migration 1076.
 */
async function assertNotErasing(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${eraseLockName(orgId)}, 0))`,
  );
  const [blocked] = await tx
    .select({ id: EB.organizationId })
    .from(EB)
    .where(eq(EB.organizationId, orgId))
    .limit(1);
  if (blocked) {
    throw new ChartWardenError(
      "TENANT_ERASURE_IN_PROGRESS",
      "this organization's messaging data is being erased; attachments cannot be uploaded",
      409,
    );
  }
}

function availabilityOf(
  row: { scanState: string; completedAt: Date | null; scanAttempts: number },
  nowMs: number,
): AttachmentAvailability {
  if (row.scanState === "quarantined" || isScanExpired(row, nowMs)) return "blocked";
  if (row.scanState === "clean") return "available";
  return row.completedAt ? "scanning" : "uploading";
}

type AttachmentRow = typeof ATT.$inferSelect;

function toStatus(row: AttachmentRow, nowMs: number): AttachmentStatus {
  return {
    attachmentId: row.id,
    channelId: row.channelId,
    fileName: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    scanState: row.scanState,
    availability: availabilityOf(row, nowMs),
    attached: row.messageId !== null,
  };
}

// ── send/read integration (called from the route service, inside ITS transaction) ───────────────────────────────

/**
 * Bind the attachments a send names to the message just inserted, inside the send's own transaction (so a refusal
 * rolls the message back too). Every failure is the same 422, so the response says nothing about whether an id exists,
 * belongs to someone else, or is quarantined.
 */
export async function bindAttachmentsInTx(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly channelId: string;
    readonly authorUserId: string;
    readonly messageId: string;
    readonly attachmentIds: readonly string[];
  },
): Promise<void> {
  const ids = [...new Set(args.attachmentIds)];
  const refuse = () =>
    new ChartWardenError(
      "ATTACHMENT_NOT_BINDABLE",
      "one or more attachments cannot be attached to this message",
      422,
    );
  if (ids.length !== args.attachmentIds.length || ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw refuse();
  }
  const rows = await tx
    .select({
      id: ATT.id,
      uploadedBy: ATT.uploadedBy,
      channelId: ATT.channelId,
      messageId: ATT.messageId,
      completedAt: ATT.completedAt,
      scanState: ATT.scanState,
      createdAt: ATT.createdAt,
    })
    .from(ATT)
    .where(and(eq(ATT.organizationId, args.orgId), inArray(ATT.id, ids)))
    // A fixed lock order: two sends naming overlapping ids in different orders must not lock them in opposite orders.
    .orderBy(asc(ATT.id))
    .for("update");
  // An upload nobody sent within this age is about to be reaped (bytes destroyed): never adopt it.
  const oldestBindable = Date.now() - UNBOUND_UPLOAD_BIND_MAX_AGE_MS;
  const bindable =
    rows.length === ids.length &&
    rows.every(
      (row) =>
        row.uploadedBy === args.authorUserId &&
        row.channelId === args.channelId &&
        row.messageId === null &&
        row.completedAt !== null &&
        row.createdAt.getTime() > oldestBindable &&
        row.scanState !== "quarantined",
    );
  if (!bindable) throw refuse();
  const bound = await tx
    .update(ATT)
    .set({ messageId: args.messageId })
    .where(and(eq(ATT.organizationId, args.orgId), inArray(ATT.id, ids), isNull(ATT.messageId)))
    .returning({ id: ATT.id });
  if (bound.length !== ids.length) throw refuse();
}

/**
 * The attachments each message shows `viewerUserId`. Clean ones are `available`; a pending one appears only to the
 * user who uploaded it (as `scanning`); a quarantined one appears to no one. Callers pass only live (non-deleted)
 * message ids. The result never carries an object key, document reference or URL.
 */
export async function loadAttachmentViews(
  tx: Tx,
  args: { orgId: string; viewerUserId: string; messageIds: readonly string[]; now?: Date },
): Promise<Map<string, MessageAttachmentView[]>> {
  const nowMs = (args.now ?? new Date()).getTime();
  const views = new Map<string, MessageAttachmentView[]>();
  if (args.messageIds.length === 0) return views;
  const rows = await tx
    .select({
      id: ATT.id,
      messageId: ATT.messageId,
      filename: ATT.filename,
      mimeType: ATT.mimeType,
      byteSize: ATT.byteSize,
      scanState: ATT.scanState,
      uploadedBy: ATT.uploadedBy,
      completedAt: ATT.completedAt,
      scanAttempts: ATT.scanAttempts,
    })
    .from(ATT)
    .where(and(eq(ATT.organizationId, args.orgId), inArray(ATT.messageId, [...args.messageIds])))
    .orderBy(asc(ATT.createdAt), asc(ATT.id));
  for (const row of rows) {
    if (!row.messageId) continue;
    const availability =
      row.scanState === "clean"
        ? "available"
        : row.scanState === "pending" &&
            row.uploadedBy === args.viewerUserId &&
            !isScanExpired(row, nowMs)
          ? "scanning"
          : null;
    if (!availability) continue;
    const list = views.get(row.messageId) ?? [];
    list.push({
      attachmentId: row.id,
      fileName: row.filename,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      availability,
    });
    views.set(row.messageId, list);
  }
  return views;
}

/** Why this open must be refused, or null when it may proceed. Every non-null reason is audited as `denied`. */
async function denialReason(
  tx: Tx,
  orgId: string,
  userId: string,
  row: AttachmentRow,
): Promise<string | null> {
  if (row.scanState === "quarantined") return "quarantined";
  if (row.scanState !== "clean" || !row.completedAt || !row.objectKey) return "not_clean";
  if (row.objectDestroyedAt) return "object_destroyed";
  if (row.messageId === null) {
    // Not shared yet: only its uploader may preview it.
    return row.uploadedBy === userId ? null : "not_attached";
  }
  const [message] = await tx
    .select({ status: MSG.status })
    .from(MSG)
    .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, row.messageId)))
    .limit(1);
  if (!message || message.status === "deleted") return "message_deleted";
  return null;
}

// ── the service ──────────────────────────────────────────────────────────────────────────────────────────────────

export function createAttachmentService(deps: AttachmentServiceDeps): AttachmentService {
  const { db, storage } = deps;
  const now = deps.now ?? (() => new Date());
  const scanOnComplete = deps.scanOnComplete ?? true;

  const asUser = <T>(orgId: string, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: orgId, userId }, (tx) => fn(tx as unknown as Tx));

  async function loadRow(tx: Tx, orgId: string, id: string): Promise<AttachmentRow | null> {
    const [row] = await tx
      .select()
      .from(ATT)
      .where(and(eq(ATT.organizationId, orgId), eq(ATT.id, id)))
      .limit(1);
    return row ?? null;
  }

  /** The uploader's own row, on a channel they can still see; anything else is the random-id answer. */
  async function ownRowOr404(orgId: string, userId: string, id: string): Promise<AttachmentRow> {
    const row = await asUser(orgId, userId, (tx) => loadRow(tx, orgId, id));
    if (!row || row.uploadedBy !== userId) throw notFound();
    if (!(await deps.canViewChannel(orgId, userId, row.channelId))) throw notFound();
    return row;
  }

  async function settle(
    orgId: string,
    row: AttachmentRow,
    verdict: { state: "clean" } | { state: "quarantined"; signature: string },
    scannerName: string,
  ): Promise<boolean> {
    return withOrgContext(db, systemOrgContext(orgId), async (rawTx) => {
      const tx = rawTx as unknown as Tx;
      const at = now();
      const updated = await tx
        .update(ATT)
        .set({
          scanState: verdict.state,
          scannedAt: at,
          scanSignature: verdict.state === "quarantined" ? verdict.signature : null,
        })
        .where(and(eq(ATT.organizationId, orgId), eq(ATT.id, row.id), eq(ATT.scanState, "pending")))
        .returning({ messageId: ATT.messageId });
      if (updated.length === 0) return false; // someone else settled it first
      const messageId = updated[0]?.messageId ?? null;
      const quarantined = verdict.state === "quarantined";
      const payload = {
        organizationId: orgId,
        attachmentId: row.id,
        channelId: row.channelId,
        messageId,
        scanner: scannerName,
        at: at.toISOString(),
        ...(quarantined ? { signature: verdict.signature } : {}),
      };
      // A recipient holding `hiddenAttachmentCount > 0` for this message must refetch: publish the same 'edited' hint the
      // edit path uses (ids and a timestamp only, ADR-0054 A4), in this transaction. An unbound upload has no message.
      if (messageId) {
        await publishMessageHint(deps.outbox, tx, "edited", {
          orgId,
          channelId: row.channelId,
          messageId,
          at,
        });
      }
      await deps.outbox?.publish(tx, {
        eventName: quarantined ? "m36.attachment.quarantined" : "m36.attachment.cleared",
        organizationId: orgId,
        aggregateKind: "message_attachment",
        aggregateId: row.id,
        payload,
      });
      await audit(
        tx as unknown as AuditExecutor,
        {
          organizationId: orgId,
          userId: null,
          actorKind: "system",
          correlationId: randomUUID(),
        },
        {
          eventType: quarantined ? "m36.attachment.quarantined" : "m36.attachment.cleared",
          resourceKind: "message_attachment",
          resourceId: row.id,
          outcome: "success",
          severity: quarantined ? "critical" : "info",
          retentionClass: "compliance",
          context: {
            attachmentId: row.id,
            channelId: row.channelId,
            scanner: scannerName,
            ...(quarantined ? { signature: verdict.signature } : {}),
          },
        },
      );
      return true;
    });
  }

  // No circuit breaker, and nothing here is shared between orgs. A breaker keyed on "failures from >= 2 orgs" lets two
  // tenants (one hostile, one with a broken bucket) open it for everyone, and a store 404/5xx is not a scanner-health
  // signal at all. Bounds instead: the sweep's per-org failure cap, the tick's wall-clock budget (worker), rotation of the
  // starting org (worker), a hard deadline per scan, and fast-fail on connect-refused. A total clamd outage therefore
  // fails closed (rows stay pending, nothing is delivered) at a bounded cost per tick.
  const scanDeadlineMs = deps.scanDeadlineMs ?? SCAN_ROW_DEADLINE_MS;
  const abortGraceMs = deps.abortGraceMs ?? ABORT_SETTLE_GRACE_MS;
  const quota = deps.quota ?? attachmentQuotaFromEnv(process.env);
  const retentionMs = deps.retentionMs ?? attachmentRetentionMsFromEnv(process.env);
  const inlineGate = deps.inlineScanGate ?? PROCESS_INLINE_SCAN_GATE;
  const userRatePerMinute = deps.userRequestsPerMinute ?? DEFAULT_USER_REQUESTS_PER_MINUTE;
  const completeCalls = createFixedWindowCounter(ONE_MINUTE_MS);

  /** Back of the line: the sweep orders by least-recently-attempted, so a poison row cannot starve the rows behind it. */
  async function recordAttempt(orgId: string, row: AttachmentRow, error: unknown): Promise<void> {
    deps.onScanError?.({ attachmentId: row.id }, error);
    try {
      await withOrgContext(db, systemOrgContext(orgId), (tx) =>
        (tx as unknown as Tx)
          .update(ATT)
          .set({ scanAttempts: sql`${ATT.scanAttempts} + 1`, lastScanAttemptAt: now() })
          .where(
            and(eq(ATT.organizationId, orgId), eq(ATT.id, row.id), eq(ATT.scanState, "pending")),
          ),
      );
    } catch (bookkeeping) {
      deps.onScanError?.({ attachmentId: row.id }, bookkeeping);
    }
  }

  /**
   * A 404 observation: count it (atomically, with the run's first timestamp) and report the run so far. Independent of
   * `scan_attempts`, which also rises for scanner outages and for the inline claim. `attemptCounted` = the caller already
   * bumped `scan_attempts` (inline claim), so it is not bumped twice.
   */
  async function noteObjectMissing(
    orgId: string,
    row: AttachmentRow,
    attemptCounted: boolean,
  ): Promise<{ count: number; firstAt: Date } | null> {
    const at = now();
    const [updated] = await withOrgContext(db, systemOrgContext(orgId), (tx) =>
      (tx as unknown as Tx)
        .update(ATT)
        .set({
          objectMissingCount: sql`${ATT.objectMissingCount} + 1`,
          firstObjectMissingAt: sql`COALESCE(${ATT.firstObjectMissingAt}, ${at.toISOString()}::timestamptz)`,
          lastScanAttemptAt: at,
          ...(attemptCounted ? {} : { scanAttempts: sql`${ATT.scanAttempts} + 1` }),
        })
        .where(and(eq(ATT.organizationId, orgId), eq(ATT.id, row.id), eq(ATT.scanState, "pending")))
        .returning({ count: ATT.objectMissingCount, firstAt: ATT.firstObjectMissingAt }),
    );
    return updated?.firstAt ? { count: updated.count, firstAt: updated.firstAt } : null;
  }

  /** The object read fine: the run of misses (if any) is over. Throws on failure - a stale count must not finalise a file. */
  async function clearObjectMissing(orgId: string, row: AttachmentRow): Promise<void> {
    await withOrgContext(db, systemOrgContext(orgId), (tx) =>
      (tx as unknown as Tx)
        .update(ATT)
        .set({ objectMissingCount: 0, firstObjectMissingAt: null })
        .where(
          and(eq(ATT.organizationId, orgId), eq(ATT.id, row.id), eq(ATT.scanState, "pending")),
        ),
    );
  }

  /**
   * Scan one completed, pending row under a hard deadline. Returns the outcome; THROWS a `ScanFailure` (kind `store` or
   * `scanner`) when the store or scanner cannot answer - the caller charges it to this org alone. `deferred` is a per-row
   * outcome (object not found yet); it is recorded here and is not a failure of either kind.
   */
  function scanRow(
    orgId: string,
    row: AttachmentRow,
    opts: { attemptCounted: boolean },
  ): Promise<"clean" | "quarantined" | "settled" | "deferred"> {
    const scanner = deps.scanner;
    if (!scanner) return Promise.reject(new Error("no attachment scanner is bound"));
    if (!row.objectKey) return Promise.reject(new Error("completed attachment has no object key"));
    const objectKey = row.objectKey;
    let phase: ScanFailureKind = "store";
    const deadlineError = () =>
      new ScanFailure(phase, new Error("attachment scan exceeded its deadline"));
    const quarantine = async (signature: string) =>
      (await settle(orgId, row, { state: "quarantined", signature }, scanner.name))
        ? ("quarantined" as const)
        : ("settled" as const);
    const run = async (signal: AbortSignal) => {
      let bytes: Uint8Array | null;
      try {
        bytes = await storage.readBytes({
          organizationId: orgId,
          objectKey,
          maxBytes: MAX_ATTACHMENT_BYTES,
          signal,
        });
      } catch (error) {
        throw new ScanFailure("store", error);
      }
      throwIfAborted(signal); // past the deadline nothing is recorded: not a miss, not a verdict
      if (bytes === null) {
        // A 404 during a store outage/failover is not proof the object is gone: finalise only after repeated CONSECUTIVE
        // misses spanning real time (the run is reset by any successful read, and scanner outages never touch it).
        const missing = await noteObjectMissing(orgId, row, opts.attemptCounted);
        if (!missing) return "settled" as const;
        const spanMs = now().getTime() - missing.firstAt.getTime();
        if (
          missing.count >= OBJECT_MISSING_MIN_OBSERVATIONS &&
          spanMs >= OBJECT_MISSING_MIN_SPAN_MS
        ) {
          return quarantine("object-missing");
        }
        deps.onScanError?.(
          { attachmentId: row.id },
          new Error("attachment object not found (will retry)"),
        );
        return "deferred" as const;
      }
      if (row.objectMissingCount > 0) await clearObjectMissing(orgId, row);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== row.sha256Hex || bytes.length !== row.byteSize) {
        return quarantine("checksum-mismatch");
      }
      // WP 5.3: the client strips EXIF; the server cannot rewrite the (checksum-bound) object, so it fails closed.
      if (hasImageMetadata(bytes, row.mimeType)) return quarantine("image-metadata-present");
      phase = "scanner";
      let result: Awaited<ReturnType<ScanPort["scan"]>>;
      try {
        result = await scanner.scan({ bytes, mimeType: row.mimeType, signal });
      } catch (error) {
        throw new ScanFailure("scanner", error);
      }
      throwIfAborted(signal);
      if (result.verdict === "infected") return quarantine(result.signature);
      // Fail closed: only an explicit `clean` settles clean. Anything else (a new/unknown verdict from a misbehaving or
      // newer adapter) is a scanner failure: the row stays pending and is retried, never delivered.
      if (result.verdict !== "clean") {
        throw new ScanFailure("scanner", new Error("scanner returned an unrecognised verdict"));
      }
      return (await settle(orgId, row, { state: "clean" }, scanner.name))
        ? ("clean" as const)
        : ("settled" as const);
    };
    return runWithDeadline(run, scanDeadlineMs, deadlineError, abortGraceMs);
  }

  /** Destroy a row's object under the reaper deadline; never throws (callers have already decided to refuse). */
  async function destroyQuietly(orgId: string, row: AttachmentRow): Promise<void> {
    const objectKey = row.objectKey;
    if (!objectKey) return;
    try {
      await runWithDeadline(
        (signal) => storage.destroyObject({ organizationId: orgId, objectKey, signal }),
        deps.storageDeadlineMs ?? REAP_DESTROY_DEADLINE_MS,
        () => new Error("attachment destroy exceeded its deadline"),
        abortGraceMs,
      );
    } catch (error) {
      deps.onReapError?.({ attachmentId: row.id }, error);
    }
  }

  /** Atomically take one of the row's bounded inline attempts; false when it has used them all (or was settled). */
  async function claimInlineAttempt(orgId: string, row: AttachmentRow): Promise<boolean> {
    const claimed = await withOrgContext(db, systemOrgContext(orgId), (tx) =>
      (tx as unknown as Tx)
        .update(ATT)
        .set({ scanAttempts: sql`${ATT.scanAttempts} + 1`, lastScanAttemptAt: now() })
        .where(
          and(
            eq(ATT.organizationId, orgId),
            eq(ATT.id, row.id),
            eq(ATT.scanState, "pending"),
            lt(ATT.scanAttempts, MAX_INLINE_SCAN_ATTEMPTS),
          ),
        )
        .returning({ id: ATT.id }),
    );
    return claimed.length > 0;
  }

  const authorized = (
    row: AttachmentRow,
    presigned: { url: string; headers: Readonly<Record<string, string>>; expiresAt: string },
  ): AuthorizedUpload => ({
    attachmentId: row.id,
    upload: {
      method: "PUT" as const,
      url: presigned.url,
      headers: presigned.headers,
      expiresAt: presigned.expiresAt,
    },
    status: toStatus(row, now().getTime()),
  });

  return {
    async authorize(orgId, input) {
      const valid = validateAuthorizeInput({
        fileName: input.fileName,
        contentType: input.contentType,
        byteSize: input.byteSize,
        sha256Hex: input.sha256Hex,
      });
      // "can send in this channel" is the channel_visibility rule; a stranger gets the random-id answer.
      if (!(await deps.canViewChannel(orgId, input.userId, input.channelId))) {
        throw new NotFoundError("channel", input.channelId);
      }
      // Bucket creation is network IO: do it BEFORE the transaction (which holds the per-user and per-org advisory locks),
      // under a deadline, so a slow object store can never pin the quota lock. Signing the URL is local (below).
      if (storage.ensureBucket) {
        const ensureBucket = storage.ensureBucket.bind(storage);
        await runWithDeadline(
          () => ensureBucket(orgId),
          deps.storageDeadlineMs ?? STORAGE_INSPECT_DEADLINE_MS,
          () => new DegradedError("attachment-storage", "the object store did not answer in time"),
          abortGraceMs,
        );
      }
      return asUser(orgId, input.userId, async (tx) => {
        const [channel] = await tx
          .select({ isArchived: CH.isArchived })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
          .limit(1);
        if (!channel) throw new NotFoundError("channel", input.channelId);
        if (channel.isArchived) {
          throw new ChartWardenError("CHANNEL_ARCHIVED", "channel is archived", 410);
        }
        // The tenant is being erased: no new object may be created (migration 1076; holds a SHARED lock to commit).
        await assertNotErasing(tx, orgId);
        // Cap on open uploads. The advisory lock serializes one user's authorizes so two racing requests cannot both
        // slip under the cap; it is released with the transaction.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`m36-attachment-open:${input.userId}`}, 0))`,
        );
        // A retry of the SAME request (same user, channel, file, size, type, name) while its upload is still open re-signs
        // that row instead of consuming another slot / quota / rate token. A row about to expire is not reused.
        const [reusable] = await tx
          .select()
          .from(ATT)
          .where(
            and(
              eq(ATT.organizationId, orgId),
              eq(ATT.uploadedBy, input.userId),
              eq(ATT.channelId, input.channelId),
              eq(ATT.sha256Hex, valid.sha256Hex),
              eq(ATT.byteSize, valid.byteSize),
              eq(ATT.mimeType, valid.contentType),
              eq(ATT.filename, valid.fileName),
              isNull(ATT.completedAt),
              isNull(ATT.messageId),
              eq(ATT.scanState, "pending"),
              gt(ATT.uploadExpiresAt, new Date(now().getTime() + MIN_REUSABLE_UPLOAD_MS)),
            ),
          )
          .orderBy(sql`${ATT.createdAt} DESC`)
          .limit(1);
        if (reusable?.objectKey && reusable.uploadExpiresAt) {
          const presigned = await storage.presignUpload({
            organizationId: orgId,
            objectKey: reusable.objectKey,
            mimeType: reusable.mimeType,
            sha256Hex: valid.sha256Hex,
            byteSize: valid.byteSize,
            ttlSeconds: Math.floor((reusable.uploadExpiresAt.getTime() - now().getTime()) / 1000),
          });
          return authorized(reusable, presigned);
        }
        // Rate: rows this user created in the last minute (DB clock, same as created_at). Counted under the advisory lock.
        const [recent] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(ATT)
          .where(
            and(
              eq(ATT.organizationId, orgId),
              eq(ATT.uploadedBy, input.userId),
              gt(ATT.createdAt, sql`now() - interval '60 seconds'`),
            ),
          );
        if ((recent?.n ?? 0) >= userRatePerMinute) {
          throw new RateLimitedError("too many upload requests; wait a moment");
        }
        // A flagged file stops counting toward the open cap (a missing reaper credential must not lock a user out), so
        // flagged rows have their own cap over a 24 h window: an authorize -> upload EICAR -> complete loop cannot mint
        // unlimited rows, objects, CRITICAL audit rows and outbox events. Bound rows count too: a pending file can be
        // sent before the sweep quarantines it, and that must not take it out of the count.
        const [flagged] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(ATT)
          .where(
            and(
              eq(ATT.organizationId, orgId),
              eq(ATT.uploadedBy, input.userId),
              eq(ATT.scanState, "quarantined"),
              gt(ATT.createdAt, new Date(now().getTime() - QUARANTINED_UPLOAD_WINDOW_MS)),
            ),
          );
        if ((flagged?.n ?? 0) >= MAX_QUARANTINED_UPLOADS_PER_USER) {
          throw new ChartWardenError(
            "TOO_MANY_QUARANTINED_UPLOADS",
            "too many of your recent uploads were blocked by the scanner; try again later",
            429,
          );
        }
        const [open] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(ATT)
          .where(
            and(
              eq(ATT.organizationId, orgId),
              eq(ATT.uploadedBy, input.userId),
              isNull(ATT.messageId),
              // A quarantined row can never be sent, and a row older than the reap age can no longer be bound: neither
              // may lock a user out (the reaper that deletes them needs a credential that may be unbound).
              ne(ATT.scanState, "quarantined"),
              gt(ATT.createdAt, new Date(now().getTime() - UNBOUND_UPLOAD_REAP_AGE_MS)),
              or(isNotNull(ATT.completedAt), gt(ATT.uploadExpiresAt, now())),
            ),
          );
        if ((open?.n ?? 0) >= MAX_OPEN_UPLOADS_PER_USER) {
          throw new ChartWardenError(
            "TOO_MANY_OPEN_UPLOADS",
            `at most ${MAX_OPEN_UPLOADS_PER_USER} uploads may be open at once; send or wait for the others first`,
            429,
          );
        }
        // Total stored bytes (per user and per org), counted over every row that still holds or may yet receive bytes:
        // completed rows of any scan state (a quarantined object stays in the bucket until reaped/erased, a bound-but-pending
        // one is not unbound so the caps above never see it) plus unfinished uploads whose URL is still live. A row that is
        // gone (reaped, erased) is not counted, and an expired never-finished upload cannot pin quota while the reaper
        // credential is missing. The org-wide lock serializes every authorize of the tenant (a short transaction) so two
        // users cannot both fit under the org limit; it is always taken AFTER the user lock (one order, no deadlock).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`m36-attachment-quota:${orgId}`}, 0))`,
        );
        const [used] = await tx
          .select({
            org: sql<string>`COALESCE(SUM(${ATT.byteSize}), 0)::bigint`,
            mine: sql<string>`COALESCE(SUM(${ATT.byteSize}) FILTER (WHERE ${ATT.uploadedBy} = ${input.userId}), 0)::bigint`,
          })
          .from(ATT)
          .where(
            and(
              eq(ATT.organizationId, orgId),
              or(isNotNull(ATT.completedAt), gt(ATT.uploadExpiresAt, now())),
              // Bytes count until the OBJECT is destroyed (a quarantined file, or a file on a deleted message, is destroyed
              // after the retention window, see reapOrphansForOrg): deleting the message frees nothing by itself.
              isNull(ATT.objectDestroyedAt),
            ),
          );
        const quotaExceeded = (scope: "user" | "organization", limit: number) =>
          new ChartWardenError(
            "ATTACHMENT_QUOTA_EXCEEDED",
            scope === "user"
              ? `your attachment storage allowance (${formatBytes(limit)}) is full; it frees up when stored files are destroyed (after the retention period following a message delete or a block) and when unsent uploads lapse`
              : `this organization's attachment storage allowance (${formatBytes(limit)}) is full; it frees up when stored files are destroyed (after the retention period following a message delete or a block)`,
            413,
            [{ field: "scope", code: "QUOTA_SCOPE", message: scope }],
          );
        if (Number(used?.mine ?? 0) + valid.byteSize > quota.userBytes) {
          throw quotaExceeded("user", quota.userBytes);
        }
        if (Number(used?.org ?? 0) + valid.byteSize > quota.orgBytes) {
          throw quotaExceeded("organization", quota.orgBytes);
        }
        const attachmentId = randomUUID();
        const objectKey = attachmentObjectKey(input.channelId, attachmentId);
        const [row] = await tx
          .insert(ATT)
          .values({
            id: attachmentId,
            organizationId: orgId,
            channelId: input.channelId,
            uploadedBy: input.userId,
            mimeType: valid.contentType,
            byteSize: valid.byteSize,
            filename: valid.fileName,
            objectKey,
            sha256Hex: valid.sha256Hex,
            uploadExpiresAt: new Date(now().getTime() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000),
          })
          .returning();
        if (!row) throw new Error("attachment insert returned no row");
        // Sign AFTER the row exists, inside the same transaction (signing is local, no IO): if anything after this throws,
        // the row rolls back, so a live upload URL can never exist without its row.
        const presigned = await storage.presignUpload({
          organizationId: orgId,
          objectKey,
          mimeType: valid.contentType,
          sha256Hex: valid.sha256Hex,
          byteSize: valid.byteSize,
          ttlSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
        });
        return authorized(row, presigned);
      });
    },

    async complete(orgId, input) {
      if (completeCalls.hit(`${orgId}:${input.userId}`) > userRatePerMinute) {
        throw new RateLimitedError("too many upload requests; wait a moment");
      }
      const row = await ownRowOr404(orgId, input.userId, input.attachmentId);
      await asUser(orgId, input.userId, (tx) => assertNotErasing(tx, orgId));
      let current = row;
      if (!row.completedAt) {
        // After the upload URL's TTL the row stops counting toward the open cap; if it could still be completed, a user
        // could hold more than the cap of open completed rows. An expired upload is final: start a new one.
        if (!row.uploadExpiresAt || row.uploadExpiresAt.getTime() <= now().getTime()) {
          throw new ChartWardenError(
            "UPLOAD_EXPIRED",
            "the upload window has expired; start a new upload",
            410,
          );
        }
        const objectKey = row.objectKey;
        const found = objectKey
          ? await runWithDeadline(
              (signal) => storage.inspect({ organizationId: orgId, objectKey, signal }),
              deps.storageDeadlineMs ?? STORAGE_INSPECT_DEADLINE_MS,
              () =>
                new DegradedError("attachment-storage", "the object store did not answer in time"),
              abortGraceMs,
            )
          : null;
        if (!found) {
          throw new ChartWardenError(
            "ATTACHMENT_NOT_UPLOADED",
            "the file has not been uploaded",
            409,
          );
        }
        if (
          found.byteSize !== row.byteSize ||
          found.sha256Hex !== row.sha256Hex ||
          found.mimeType !== row.mimeType
        ) {
          // The bytes are not what was authorized: destroy them now (best effort; the reaper retries the row later) so a
          // wrong-size/wrong-type object never sits in the tenant bucket until the orphan window.
          await destroyQuietly(orgId, row);
          throw new ChartWardenError(
            "ATTACHMENT_UPLOAD_MISMATCH",
            "the uploaded file does not match what was authorized",
            422,
          );
        }
        current = await asUser(orgId, input.userId, async (tx) => {
          await assertNotErasing(tx, orgId);
          await tx
            .update(ATT)
            .set({ completedAt: now() })
            .where(and(eq(ATT.organizationId, orgId), eq(ATT.id, row.id), isNull(ATT.completedAt)));
          return (await loadRow(tx, orgId, row.id)) ?? row;
        });
      }
      if (scanOnComplete && deps.scanner && current.scanState === "pending") {
        // One inline attempt per call, at most MAX_INLINE_SCAN_ATTEMPTS per attachment, and at most a few in flight per
        // process/org (each reads up to 25 MB): when saturated the row simply stays pending for the sweep. Nothing here
        // is shared with any other org's scanning. The row stays pending on any failure and the sweep retries.
        const release = inlineGate.tryAcquire(orgId);
        if (release) {
          try {
            if (await claimInlineAttempt(orgId, current)) {
              await scanRow(orgId, current, { attemptCounted: true });
              current =
                (await asUser(orgId, input.userId, (tx) => loadRow(tx, orgId, row.id))) ?? current;
            }
          } catch (error) {
            deps.onScanError?.({ attachmentId: row.id }, error); // fail closed: never read a scanner error as clean
          } finally {
            release();
          }
        }
      }
      return toStatus(current, now().getTime());
    },

    async status(orgId, input) {
      return toStatus(await ownRowOr404(orgId, input.userId, input.attachmentId), now().getTime());
    },

    async access(orgId, input) {
      const row = await asUser(orgId, input.userId, (tx) => loadRow(tx, orgId, input.attachmentId));
      if (!row) throw notFound();
      // Current membership + Part 2 / care-team gating, re-evaluated now. A removed member is the random-id answer.
      if (!(await deps.canViewChannel(orgId, input.userId, row.channelId))) throw notFound();

      const denial = await asUser(orgId, input.userId, async (tx) => {
        const reason = await denialReason(tx, orgId, input.userId, row);
        if (reason) {
          await tx.insert(AE).values({
            organizationId: orgId,
            attachmentId: row.id,
            userId: input.userId,
            action: "denied",
            reason,
          });
        }
        return reason;
      });
      if (denial) throw notFound(); // committed above; identical to a random id from the caller's side

      return asUser(orgId, input.userId, async (tx) => {
        // The event and the URL are one unit: if signing fails, no event survives for a URL that never existed.
        const signed = await storage.presignDownload({
          organizationId: orgId,
          objectKey: row.objectKey as string,
          mimeType: row.mimeType,
          ttlSeconds: ATTACHMENT_ACCESS_TTL_SECONDS,
        });
        await tx.insert(AE).values({
          organizationId: orgId,
          attachmentId: row.id,
          userId: input.userId,
          action: "open",
        });
        return {
          url: signed.url,
          expiresAt: signed.expiresAt,
          fileName: row.filename,
          mimeType: row.mimeType,
          byteSize: row.byteSize,
        };
      });
    },

    async scanPendingForOrg(orgId, opts = {}) {
      const result = {
        clean: 0,
        quarantined: 0,
        deferred: 0,
        scannerFailures: 0,
        storeFailures: 0,
        scanUnavailable: 0,
      };
      const scanner = deps.scanner;
      // This org's slice of the tick's budget (the worker's fair share): once it is spent, no NEW scan starts. The first
      // due scan always starts when the slice is positive, so an org with pending work is never skipped; 0 = tick is over.
      if (!scanner || (opts.budgetMs !== undefined && opts.budgetMs <= 0)) return result;
      const budgetEndsAt =
        opts.budgetMs === undefined ? undefined : now().getTime() + opts.budgetMs;
      const outOfBudget = () => budgetEndsAt !== undefined && now().getTime() >= budgetEndsAt;
      const nowIso = now().toISOString();
      const rows = await withOrgContext(db, systemOrgContext(orgId), async (rawTx) => {
        const tx = rawTx as unknown as Tx;
        return (
          tx
            .select()
            .from(ATT)
            .where(
              and(
                eq(ATT.organizationId, orgId),
                eq(ATT.scanState, "pending"),
                sql`${ATT.completedAt} IS NOT NULL`,
                // Exponential backoff: the n-th failed attempt waits min(base * 2^(n-1), cap) before the next try, so a
                // row nobody can judge is retried at 1, 2, 4 ... 60 min and then hourly, never every minute. Never-attempted
                // rows are always due. (Clamped exponent: power(2, n) cannot overflow.)
                or(
                  isNull(ATT.lastScanAttemptAt),
                  sql`${ATT.lastScanAttemptAt} + make_interval(secs => least(
                        ${SCAN_RETRY_BASE_MS / 1000}::float8 * power(2, least(greatest(${ATT.scanAttempts}, 1) - 1, ${SCAN_RETRY_MAX_EXPONENT})),
                        ${SCAN_RETRY_MAX_MS / 1000}::float8)) <= ${nowIso}::timestamptz`,
                ),
              ),
            )
            // Least-recently-attempted first (never-attempted rows lead), then oldest.
            .orderBy(
              sql`${ATT.lastScanAttemptAt} ASC NULLS FIRST`,
              asc(ATT.completedAt),
              asc(ATT.id),
            )
            .limit(opts.limit ?? SCAN_BATCH_LIMIT)
        );
      });
      // Failures (scanner transport OR this org's own bucket/database) are charged to THIS org only: it stops after its
      // share and the next org starts. Nothing is remembered across orgs or ticks.
      let orgFailures = 0;
      let started = 0;
      for (const row of rows) {
        if (orgFailures >= MAX_ORG_SCAN_FAILURES_PER_TICK) break;
        if (started > 0 && outOfBudget()) break;
        started += 1;
        // ALWAYS try the scan first. A row past the expiry cap is not condemned by age: it is simply reported blocked
        // (`isScanExpired`) while it stays pending, and a real verdict still settles it.
        try {
          const outcome = await scanRow(orgId, row, { attemptCounted: false });
          if (outcome === "deferred") {
            result.deferred += 1; // per-row (object not found yet): neither a scanner nor a store failure
            continue;
          }
          if (outcome === "clean") result.clean += 1;
          if (outcome === "quarantined") result.quarantined += 1;
        } catch (error) {
          result.deferred += 1;
          orgFailures += 1;
          if (error instanceof ScanFailure && error.kind === "scanner") result.scannerFailures += 1;
          else result.storeFailures += 1;
          await recordAttempt(orgId, row, error);
          if (row.scanAttempts + 1 >= SCAN_UNAVAILABLE_ATTEMPTS) {
            result.scanUnavailable += 1;
            deps.onScanUnavailable?.({ attachmentId: row.id, attempts: row.scanAttempts + 1 });
          }
        }
      }
      return result;
    },

    async reapOrphansForOrg(orgId, opts = {}) {
      const result = { reaped: 0, failed: 0, skippedLegalHold: 0 };
      const reaperDb = deps.reaperDb;
      if (!reaperDb) return result;
      if (opts.budgetMs !== undefined && opts.budgetMs <= 0) return result;
      const budgetEndsAt =
        opts.budgetMs === undefined ? undefined : now().getTime() + opts.budgetMs;
      const at = now().getTime();
      // Never adopted by a message: an upload that was never completed (expired past the grace) or that sat finished and
      // unsent for a week. `bindAttachmentsInTx` refuses anything older than 6 days, so this never races a send.
      const orphan = and(
        eq(ATT.organizationId, orgId),
        isNull(ATT.messageId),
        or(
          and(
            isNull(ATT.completedAt),
            lt(ATT.uploadExpiresAt, new Date(at - ORPHAN_UPLOAD_GRACE_MS)),
          ),
          lt(ATT.createdAt, new Date(at - UNBOUND_UPLOAD_REAP_AGE_MS)),
        ),
      );
      // Short transactions only: the destroy is network IO, so it never runs inside a transaction. Random order, not
      // oldest-first: 25 permanently failing rows (a bucket that keeps refusing) would otherwise be re-selected forever
      // and starve every row behind them; a random draw gives each row a turn. ponytail: random() sorts the org's whole
      // orphan set per tick; add an indexed reap-attempt column if an org ever has tens of thousands of orphans.
      const candidates = await withOrgContext(reaperDb, systemOrgContext(orgId), (rawTx) =>
        (rawTx as unknown as Tx)
          .select({ id: ATT.id, objectKey: ATT.objectKey })
          .from(ATT)
          .where(orphan)
          .orderBy(sql`random()`)
          .limit(opts.limit ?? REAP_BATCH_LIMIT),
      );
      // Object BEFORE row, per row: a row whose object could not be destroyed is kept, so the next tick retries it.
      let attempted = 0;
      for (const row of candidates) {
        // This org's slice of the reap budget: the first destroy always runs, later ones only while the slice lasts.
        if (attempted > 0 && budgetEndsAt !== undefined && now().getTime() >= budgetEndsAt) break;
        attempted += 1;
        try {
          const objectKey = row.objectKey;
          if (objectKey) {
            await runWithDeadline(
              (signal) => storage.destroyObject({ organizationId: orgId, objectKey, signal }),
              deps.storageDeadlineMs ?? REAP_DESTROY_DEADLINE_MS,
              () => new Error("attachment destroy exceeded its deadline"),
              abortGraceMs,
            );
          }
          const gone = await withOrgContext(reaperDb, systemOrgContext(orgId), (rawTx) =>
            (rawTx as unknown as Tx)
              .delete(ATT)
              .where(and(orphan, eq(ATT.id, row.id)))
              .returning({ id: ATT.id }),
          );
          result.reaped += gone.length;
        } catch (error) {
          result.failed += 1;
          deps.onReapError?.({ attachmentId: row.id }, error);
        }
      }
      await purgeRetainedObjects(orgId, reaperDb, opts, result);
      return result;
    },
  };

  function isHeldNow(orgId: string, messageId: string): Promise<boolean> {
    return withOrgContext(db, systemOrgContext(orgId), (rawTx) =>
      isMessageHeldNow(rawTx as unknown as Tx, orgId, messageId),
    );
  }

  /**
   * Destroy the OBJECT of rows that must no longer hold bytes but whose row we keep for audit: a quarantined file, and a
   * clean file on a deleted message, once `retentionMs` has passed. Candidates are read under the app role (RLS), the
   * destroy is the same deadline-bound storage call the orphan reaper uses, and the stamp is written by the destruction
   * credential (the only role with UPDATE on `object_destroyed_at`). A failed destroy leaves the row unstamped: retried next run.
   */
  async function purgeRetainedObjects(
    orgId: string,
    reaperDb: DbClient,
    opts: { limit?: number; budgetMs?: number },
    result: { reaped: number; failed: number; skippedLegalHold: number },
  ): Promise<void> {
    const at = now();
    const cutoff = new Date(at.getTime() - retentionMs);
    const budgetEndsAt = opts.budgetMs === undefined ? undefined : at.getTime() + opts.budgetMs;
    const candidates = await withOrgContext(db, systemOrgContext(orgId), async (rawTx) => {
      const tx = rawTx as unknown as Tx;
      // ADR-0086: bytes cannot be restored, so an attachment on a message under an ACTIVE hold is never a candidate (live criteria:
      // covers messages the overlay has not materialised yet). A quarantined file is never served, so keeping it is safe.
      const holds = await activeLiveHolds(tx, orgId);
      return tx
        .select({ id: ATT.id, objectKey: ATT.objectKey, messageId: ATT.messageId })
        .from(ATT)
        .where(
          and(
            eq(ATT.organizationId, orgId),
            isNull(ATT.objectDestroyedAt),
            isNotNull(ATT.objectKey),
            sql`NOT ${messageHeldByAnyPredicate(holds, sql`${ATT.organizationId}`, sql`${ATT.messageId}`)}`,
            or(
              and(eq(ATT.scanState, "quarantined"), lt(ATT.scannedAt, cutoff)),
              sql`EXISTS (SELECT 1 FROM message m WHERE m.organization_id = ${ATT.organizationId}
                    AND m.id = ${ATT.messageId} AND m.status = 'deleted' AND m.deleted_at < ${cutoff.toISOString()}::timestamptz)`,
            ),
          ),
        )
        .orderBy(sql`random()`)
        .limit(opts.limit ?? REAP_BATCH_LIMIT);
    });
    let attempted = 0;
    for (const row of candidates) {
      if (attempted > 0 && budgetEndsAt !== undefined && now().getTime() >= budgetEndsAt) break;
      attempted += 1;
      const objectKey = row.objectKey;
      if (!objectKey) continue;
      try {
        // A hold can land after the candidates were read: look again, in a short tx that takes the shared hold lock (a concurrent
        // apply waits for it). The lock is released at commit, before destroyObject, so a hold applied after this check can still lose
        // the bytes: the residual window is up to the storage destroy deadline (REAP_DESTROY_DEADLINE_MS plus abort grace), accepted
        // as ADR-0086 known limit (g).
        if (row.messageId && (await isHeldNow(orgId, row.messageId))) {
          result.skippedLegalHold += 1;
          continue;
        }
        await runWithDeadline(
          (signal) => storage.destroyObject({ organizationId: orgId, objectKey, signal }),
          deps.storageDeadlineMs ?? REAP_DESTROY_DEADLINE_MS,
          () => new Error("attachment destroy exceeded its deadline"),
          abortGraceMs,
        );
        await withOrgContext(reaperDb, systemOrgContext(orgId), (rawTx) =>
          (rawTx as unknown as Tx)
            .update(ATT)
            .set({ objectDestroyedAt: now() })
            .where(
              and(eq(ATT.organizationId, orgId), eq(ATT.id, row.id), isNull(ATT.objectDestroyedAt)),
            ),
        );
        result.reaped += 1;
      } catch (error) {
        result.failed += 1;
        deps.onReapError?.({ attachmentId: row.id }, error);
      }
    }
  }
}
