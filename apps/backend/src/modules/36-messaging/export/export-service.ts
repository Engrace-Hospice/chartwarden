// M36 WP 5.7 (ADR-0089, PROPOSED) - the restricted messaging export, REQUEST / DECIDE / READ side behind /api/v1/messaging/export: request a
// scoped export, a SECOND person approves or rejects it, the requester cancels or reads it and (only while it is ready and unexpired) downloads
// it. The artefact builder and the expiry sweep own approved -> building -> ready | failed -> expired.
//
//   - Every write runs in one tenant transaction with its outbox event (m36.export.*); with no outbox nothing is written (fail closed).
//     Instants come from the DATABASE clock.
//   - A refusal to open a job says nothing about WHY (flag off, no permission, excluded role category, unknown channel, a patient with no
//     channel): the same 404 a random id gets. Anything else would be an existence oracle for a patient's conversations.
//   - The justification and a decision note are approver/requester-only text: never in an event, an alert, a log or a list.
//   - A download is recorded BEFORE any byte is handed out: if the trail row cannot be written the caller gets no bytes.
import {
  ChartWardenError,
  type CreateMessagingExportRequest,
  type DecideMessagingExportRequest,
  EXPORT_ALREADY_DECIDED_CODE,
  EXPORT_EXPIRED_CODE,
  EXPORT_LIMIT_CODE,
  EXPORT_MAX_LIVE_PER_USER,
  EXPORT_MAX_PER_DAY,
  EXPORT_MAX_RANGE_DAYS,
  EXPORT_NOT_READY_CODE,
  ForbiddenError,
  MESSAGING_EXPORT_APPROVE_PERMISSION,
  MESSAGING_EXPORT_DECISION_NOTE_MAX,
  MESSAGING_EXPORT_DOWNLOAD_PERMISSION,
  MESSAGING_EXPORT_FLAG_KEY,
  MESSAGING_EXPORT_JUSTIFICATION_MAX,
  MESSAGING_EXPORT_JUSTIFICATION_MIN,
  MESSAGING_EXPORT_REQUEST_PERMISSION,
  MESSAGING_EXPORT_SCOPE_KINDS,
  type MessagingExportJobDetailDto,
  type MessagingExportJobSummaryDto,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";
import { cacheFlagRead } from "../presence/binding";
import { publishExportEvent } from "./export-events";
import type { ExportArtefactReader, ExportFlagReader, ExportPermissionCheck } from "./export-ports";
import type { ExportActor, ExportJobRow, ExportStore, NewExportJob } from "./export-store";

export interface ExportServiceDeps {
  readonly store: ExportStore;
  /** Required: every write announces itself on the outbox in the same transaction. Absent => every write throws (nothing is written). */
  readonly outbox?: HintOutboxPort | undefined;
  /** The M1 flag reader for `messaging.export`. Absent => requesting is off. */
  readonly flags?: ExportFlagReader | undefined;
  /** Rechecked at request, decision and download. Absent => nobody holds anything (fail closed). */
  readonly holds?: ExportPermissionCheck | undefined;
  /** The builder side's reader. Absent => a download is refused with 503 before anything is recorded. */
  readonly artefactReader?: ExportArtefactReader | undefined;
}

export interface ExportDownload {
  readonly jobId: string;
  readonly filename: string;
  readonly bytes: Buffer;
}

export interface ExportService {
  isEnabled(orgId: string): Promise<boolean>;
  create(
    actor: ExportActor,
    body: CreateMessagingExportRequest,
  ): Promise<MessagingExportJobDetailDto>;
  decide(
    actor: ExportActor,
    jobId: string,
    decision: "approve" | "reject",
    body: DecideMessagingExportRequest,
  ): Promise<MessagingExportJobDetailDto>;
  cancel(actor: ExportActor, jobId: string): Promise<MessagingExportJobDetailDto>;
  listMine(actor: ExportActor): Promise<MessagingExportJobSummaryDto[]>;
  listPending(actor: ExportActor): Promise<MessagingExportJobSummaryDto[]>;
  /** The requester, or an approver (`canApprove`); anyone else gets the same 404 as an unknown id. */
  get(
    actor: ExportActor,
    jobId: string,
    opts: { readonly canApprove: boolean },
  ): Promise<MessagingExportJobDetailDto>;
  download(actor: ExportActor, jobId: string): Promise<ExportDownload>;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

/** The one 404 every refusal to open a job gets. */
const neutralScopeNotFound = (): NotFoundError => new NotFoundError("export scope");
const jobNotFound = (id: string): NotFoundError => new NotFoundError("export", id);

function dayNumber(value: string, field: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (
    !DATE_RE.test(value) ||
    Number.isNaN(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== value
  ) {
    invalid(field, "a date as YYYY-MM-DD");
  }
  return ms / DAY_MS;
}

function validateCreate(body: CreateMessagingExportRequest): NewExportJob {
  if (!(MESSAGING_EXPORT_SCOPE_KINDS as readonly string[]).includes(body.scopeKind)) {
    invalid("scopeKind", "choose channel or patient");
  }
  const channelId = body.channelId ?? null;
  const patientId = body.patientId ?? null;
  const matches =
    body.scopeKind === "channel"
      ? channelId !== null && patientId === null
      : patientId !== null && channelId === null;
  if (!matches)
    invalid("scopeKind", "give exactly one of channelId or patientId, matching scopeKind");
  const justification = (body.justification ?? "").trim();
  if (
    justification.length < MESSAGING_EXPORT_JUSTIFICATION_MIN ||
    justification.length > MESSAGING_EXPORT_JUSTIFICATION_MAX
  ) {
    invalid(
      "justification",
      `a justification of ${MESSAGING_EXPORT_JUSTIFICATION_MIN} to ${MESSAGING_EXPORT_JUSTIFICATION_MAX} characters is required`,
    );
  }
  const dateFrom = body.dateFrom ?? null;
  const dateTo = body.dateTo ?? null;
  if ((dateFrom === null) !== (dateTo === null)) invalid("dateFrom", "give both dates or neither");
  if (dateFrom !== null && dateTo !== null) {
    const span = dayNumber(dateTo, "dateTo") - dayNumber(dateFrom, "dateFrom");
    if (span < 0) invalid("dateTo", "the end date is before the start date");
    if (span > EXPORT_MAX_RANGE_DAYS) {
      invalid("dateTo", `a range of at most ${EXPORT_MAX_RANGE_DAYS} days`);
    }
  }
  return { scopeKind: body.scopeKind, channelId, patientId, dateFrom, dateTo, justification };
}

/** The error text of a thrown driver/ORM error and its causes, for constraint-name matching. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor instanceof Error; depth += 1) {
    parts.push(cursor.message);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toSummary(row: ExportJobRow): MessagingExportJobSummaryDto {
  return {
    id: row.id,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedByName: row.requestedByName?.trim() || null,
    requestedAt: row.requestedAt.toISOString(),
    scope: {
      scopeKind: row.scopeKind,
      channelId: row.channelId,
      patientId: row.patientId,
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
    },
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    readyAt: iso(row.readyAt),
    expiresAt: iso(row.expiresAt),
    messageCount: row.messageCount,
    heldExcluded: row.heldExcluded,
    part2Excluded: row.part2Excluded,
    downloadCount: row.downloadCount,
    failureCode: row.failureCode,
  };
}

const isDownloadable = (row: ExportJobRow, userId: string): boolean =>
  row.requestedBy === userId &&
  row.status === "ready" &&
  row.expiresAt !== null &&
  row.expiresAt.getTime() > row.dbNow.getTime();

function toDetail(row: ExportJobRow, userId: string): MessagingExportJobDetailDto {
  return {
    ...toSummary(row),
    justification: row.justification,
    decisionNote: row.decisionNote,
    buildingAt: iso(row.buildingAt),
    artefactBytes: row.artefactBytes,
    artefactSha256: row.artefactSha256,
    downloadable: isDownloadable(row, userId),
  };
}

function alreadyDecided(): ChartWardenError {
  return new ChartWardenError(
    EXPORT_ALREADY_DECIDED_CODE,
    "this export has already been decided or cancelled",
    409,
  );
}

export function createExportService(deps: ExportServiceDeps): ExportService {
  const { store } = deps;
  const isEnabled = cacheFlagRead(async (organizationId) =>
    deps.flags
      ? (await deps.flags.forOrg(organizationId))[MESSAGING_EXPORT_FLAG_KEY] === true
      : false,
  );
  const holds = async (a: ExportActor, key: string): Promise<boolean> =>
    deps.holds ? deps.holds(a.organizationId, a.userId, key) : false;
  const requireOutbox = (): HintOutboxPort => {
    // The approvers' alert and the builder ride on the outbox: without it a job would exist unannounced. Fail closed.
    if (!deps.outbox) throw new Error("messaging export requires the transactional outbox");
    return deps.outbox;
  };

  return {
    isEnabled,

    async create(actor, body) {
      const outbox = requireOutbox();
      const { organizationId: orgId, userId } = actor;
      // Every refusal below is the same 404; the flag and the permission come before the body is even looked at.
      if (!(await isEnabled(orgId)) || !(await holds(actor, MESSAGING_EXPORT_REQUEST_PERMISSION))) {
        throw neutralScopeNotFound();
      }
      const input = validateCreate(body);
      return store.run(actor, async (tx) => {
        if (!(await tx.eligible(userId)) || !(await tx.scopeExists(input))) {
          throw neutralScopeNotFound();
        }
        await tx.lockRequester(userId);
        const counts = await tx.counts(userId);
        if (counts.live >= EXPORT_MAX_LIVE_PER_USER || counts.day >= EXPORT_MAX_PER_DAY) {
          throw new ChartWardenError(
            EXPORT_LIMIT_CODE,
            "too many export requests; wait for the open ones to finish",
            429,
          );
        }
        const job = await tx.insertJob(userId, input);
        await publishExportEvent(outbox, tx.raw, {
          kind: "requested",
          orgId,
          jobId: job.id,
          requestedBy: userId,
          at: job.requestedAt,
        });
        return toDetail(job, userId);
      });
    },

    async decide(actor, jobId, decision, body) {
      const outbox = requireOutbox();
      const { organizationId: orgId, userId } = actor;
      const note = body.note?.trim() ? body.note.trim() : null;
      if (note !== null && note.length > MESSAGING_EXPORT_DECISION_NOTE_MAX) {
        invalid("note", `a note of at most ${MESSAGING_EXPORT_DECISION_NOTE_MAX} characters`);
      }
      if (!(await holds(actor, MESSAGING_EXPORT_APPROVE_PERMISSION))) {
        throw new ForbiddenError(`requires permission '${MESSAGING_EXPORT_APPROVE_PERMISSION}'`);
      }
      return store.run(actor, async (tx) => {
        // Same active-user and role-category rule as the request: a decider who was deactivated or moved to an excluded category since holding the key is refused.
        if (!(await tx.eligible(userId))) {
          throw new ForbiddenError("this account may not decide exports");
        }
        const current = await tx.getJob(jobId);
        if (!current) throw jobNotFound(jobId);
        // Two people: never one's own request (the table CHECK refuses it too).
        if (current.requestedBy === userId) {
          throw new ForbiddenError("the person who requested an export cannot decide it");
        }
        if (current.status !== "pending_approval") throw alreadyDecided();
        let done: ExportJobRow | null;
        try {
          done = await tx.decide(
            jobId,
            decision === "approve" ? "approved" : "rejected",
            userId,
            note,
          );
        } catch (error) {
          if (errorText(error).includes("message_export_job_two_people")) {
            throw new ForbiddenError("the person who requested an export cannot decide it");
          }
          throw error;
        }
        if (!done) throw alreadyDecided();
        await publishExportEvent(outbox, tx.raw, {
          kind: decision === "approve" ? "approved" : "rejected",
          orgId,
          jobId,
          requestedBy: done.requestedBy,
          decidedBy: userId,
          at: done.decidedAt ?? done.dbNow,
        });
        return toDetail(done, userId);
      });
    },

    async cancel(actor, jobId) {
      const { userId } = actor;
      return store.run(actor, async (tx) => {
        const current = await tx.getJob(jobId);
        // Someone else's job is the 404 an unknown id gets.
        if (!current || current.requestedBy !== userId) throw jobNotFound(jobId);
        if (current.status !== "pending_approval") throw alreadyDecided();
        const done = await tx.cancel(jobId, userId);
        if (!done) throw alreadyDecided();
        return toDetail(done, userId);
      });
    },

    async listMine(actor) {
      const rows = await store.run(actor, (tx) => tx.listMine(actor.userId));
      return rows.map(toSummary);
    },

    async listPending(actor) {
      if (!(await holds(actor, MESSAGING_EXPORT_APPROVE_PERMISSION))) {
        throw new ForbiddenError(`requires permission '${MESSAGING_EXPORT_APPROVE_PERMISSION}'`);
      }
      const rows = await store.run(actor, (tx) => tx.listPending(actor.userId));
      return rows.map(toSummary);
    },

    async get(actor, jobId, opts) {
      const row = await store.run(actor, (tx) => tx.getJob(jobId));
      if (!row || (row.requestedBy !== actor.userId && !opts.canApprove)) throw jobNotFound(jobId);
      return toDetail(row, actor.userId);
    },

    async download(actor, jobId) {
      const outbox = requireOutbox();
      const reader = deps.artefactReader;
      if (!reader) {
        throw new ChartWardenError("EXPORT_UNAVAILABLE", "export download is not available", 503);
      }
      const { organizationId: orgId, userId } = actor;
      const job = await store.run(actor, (tx) => tx.getJob(jobId));
      // Only the requester ever downloads; anyone else (an approver included) gets the 404 an unknown id gets.
      if (!job || job.requestedBy !== userId) throw jobNotFound(jobId);
      // An account no longer active or now in an excluded category gets the same 404, so a removed requester cannot take a ready artefact.
      if (!(await store.run(actor, (tx) => tx.eligible(userId)))) throw jobNotFound(jobId);
      if (!(await holds(actor, MESSAGING_EXPORT_DOWNLOAD_PERMISSION))) {
        throw new ForbiddenError(`requires permission '${MESSAGING_EXPORT_DOWNLOAD_PERMISSION}'`);
      }
      assertReady(job);
      if (
        !job.artefactKey ||
        !job.wrappedDek ||
        !job.artefactSha256 ||
        job.artefactBytes === null
      ) {
        throw new ChartWardenError(EXPORT_NOT_READY_CODE, "the export is not ready", 409);
      }
      const bytes = Buffer.from(
        await reader({
          jobId,
          organizationId: orgId,
          artefactKey: job.artefactKey,
          wrappedDek: job.wrappedDek,
          artefactSha256: job.artefactSha256,
          artefactBytes: job.artefactBytes,
        }),
      );
      // The trail first: the guard re-judges "ready and unexpired NOW" on the database clock, so a link that expired while the artefact was
      // being read is refused here, and a failed trail insert means no bytes leave.
      try {
        await store.run(actor, async (tx) => {
          const at = await tx.recordDownload(jobId, userId, bytes.length);
          await publishExportEvent(outbox, tx.raw, {
            kind: "downloaded",
            orgId,
            jobId,
            downloadedBy: userId,
            at,
          });
        });
      } catch (error) {
        if (errorText(error).includes("message_export_download_job")) {
          throw new ChartWardenError(
            EXPORT_EXPIRED_CODE,
            "this export is no longer available",
            409,
          );
        }
        throw error;
      }
      return { jobId, filename: `messaging-export-${jobId}.json`, bytes };
    },
  };
}

/** ready AND `expires_at > now()` on the database clock; the status alone is not enough (the sweep runs hourly). */
function assertReady(job: ExportJobRow): void {
  if (job.status === "expired") {
    throw new ChartWardenError(EXPORT_EXPIRED_CODE, "this export has expired", 409);
  }
  if (job.status !== "ready") {
    throw new ChartWardenError(EXPORT_NOT_READY_CODE, "the export is not ready", 409);
  }
  if (!job.expiresAt || job.expiresAt.getTime() <= job.dbNow.getTime()) {
    throw new ChartWardenError(EXPORT_EXPIRED_CODE, "this export has expired", 409);
  }
}
