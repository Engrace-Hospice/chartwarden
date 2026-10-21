// M36 WP 5.7 (ADR-0089, PROPOSED), slice S1 - restricted messaging export: a scoped export that a second person approves, built into one
// encrypted artefact with an expiring download (migration 1147). Constants and DTOs shared by the backend and the web. The numeric bounds and
// closed sets are pinned against the SQL CHECKs.

/** Tenant flag (absent = off): gates REQUESTING only; approve, reject, cancel, download and the expiry sweep never depend on it. */
export const MESSAGING_EXPORT_FLAG_KEY = "messaging.export";

export const MESSAGING_EXPORT_REQUEST_PERMISSION = "messaging.export.request";
export const MESSAGING_EXPORT_APPROVE_PERMISSION = "messaging.export.approve";
export const MESSAGING_EXPORT_DOWNLOAD_PERMISSION = "messaging.export.download";

/** Fresh step-up actions: request, approve (also reject) and download each demand their own (the web prompts for the action). */
export const MESSAGING_EXPORT_REQUEST_STEP_UP_KEY = "messaging.export.request";
export const MESSAGING_EXPORT_APPROVE_STEP_UP_KEY = "messaging.export.approve";
export const MESSAGING_EXPORT_DOWNLOAD_STEP_UP_KEY = "messaging.export.download";

/** Exactly one of a channel or a patient (CHECK `message_export_job_scope_kind` / `_scope`). */
export const MESSAGING_EXPORT_SCOPE_KINDS = ["channel", "patient"] as const;
export type MessagingExportScopeKind = (typeof MESSAGING_EXPORT_SCOPE_KINDS)[number];

/** Forward-only lifecycle (CHECK `message_export_job_status`; the guard trigger owns the transitions). */
export const MESSAGING_EXPORT_STATUSES = [
  "pending_approval",
  "approved",
  "rejected",
  "cancelled",
  "building",
  "ready",
  "failed",
  "expired",
] as const;
export type MessagingExportStatus = (typeof MESSAGING_EXPORT_STATUSES)[number];
/** The statuses that count toward the per-requester live cap. */
export const MESSAGING_EXPORT_LIVE_STATUSES = [
  "pending_approval",
  "approved",
  "building",
  "ready",
] as const;

/** Justification bounds after trimming (CHECK `message_export_job_justification`). Approver-only text. */
export const MESSAGING_EXPORT_JUSTIFICATION_MIN = 20;
export const MESSAGING_EXPORT_JUSTIFICATION_MAX = 280;
/** Approver's note on a decision (CHECK `message_export_job_decision_note_len`). */
export const MESSAGING_EXPORT_DECISION_NOTE_MAX = 1000;

/** D4: the link lives this long after the artefact is ready (CHECK `message_export_job_expiry_24h`, DATABASE clock). */
export const EXPORT_LINK_TTL_HOURS = 24;
/** Abuse bounds (D4): live jobs per requester, jobs requested in a rolling day, messages per job (over the cap = 409 EXPORT_TOO_LARGE, never truncated). */
export const EXPORT_MAX_LIVE_PER_USER = 3;
export const EXPORT_MAX_PER_DAY = 10;
export const EXPORT_MAX_MESSAGES = 50_000;
/** D5: the optional date range is at most this many days (CHECK `message_export_job_range_max`). */
export const EXPORT_MAX_RANGE_DAYS = 366;

/** The decision on a pending job is already made (or the job was cancelled): 409. */
export const EXPORT_ALREADY_DECIDED_CODE = "EXPORT_ALREADY_DECIDED";
/** The artefact is not ready to download yet (or failed / was rejected): 409. */
export const EXPORT_NOT_READY_CODE = "EXPORT_NOT_READY";
/** The link has expired: 409. */
export const EXPORT_EXPIRED_CODE = "EXPORT_EXPIRED";
/** The scope holds more than EXPORT_MAX_MESSAGES messages: 409; narrow the scope or range. */
export const EXPORT_TOO_LARGE_CODE = "EXPORT_TOO_LARGE";
/** The live or daily cap is reached: 429. */
export const EXPORT_LIMIT_CODE = "EXPORT_LIMIT";
export const MESSAGING_EXPORT_ERROR_CODES = [
  EXPORT_ALREADY_DECIDED_CODE,
  EXPORT_NOT_READY_CODE,
  EXPORT_EXPIRED_CODE,
  EXPORT_TOO_LARGE_CODE,
  EXPORT_LIMIT_CODE,
] as const;
export type MessagingExportErrorCode = (typeof MESSAGING_EXPORT_ERROR_CODES)[number];

/** D8 outbox events (PHI-free: the job id only). */
export const EXPORT_EVENT_REQUESTED = "m36.export.requested";
export const EXPORT_EVENT_APPROVED = "m36.export.approved";
export const EXPORT_EVENT_REJECTED = "m36.export.rejected";
export const EXPORT_EVENT_READY = "m36.export.ready";
export const EXPORT_EVENT_DOWNLOADED = "m36.export.downloaded";
export const EXPORT_EVENT_EXPIRED = "m36.export.expired";
export const MESSAGING_EXPORT_EVENT_NAMES = [
  EXPORT_EVENT_REQUESTED,
  EXPORT_EVENT_APPROVED,
  EXPORT_EVENT_REJECTED,
  EXPORT_EVENT_READY,
  EXPORT_EVENT_DOWNLOADED,
  EXPORT_EVENT_EXPIRED,
] as const;
export type MessagingExportEventName = (typeof MESSAGING_EXPORT_EVENT_NAMES)[number];

/** The system_locked alert rule that tells the approvers a request is waiting (raised on `m36.export.requested`). */
export const EXPORT_REQUESTED_ALERT = "m36.export.requested";

/** The artefact's format (D4): one JSON document; PDF is a later slice. */
export const MESSAGING_EXPORT_FORMAT = "json" as const;
export const MESSAGING_EXPORT_MANIFEST_VERSION = 1;

// ── DTOs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** POST /api/v1/messaging/export. Exactly one of channelId / patientId; dates are YYYY-MM-DD, both or neither, at most 366 days apart. */
export interface CreateMessagingExportRequest {
  scopeKind: MessagingExportScopeKind;
  channelId?: string;
  patientId?: string;
  dateFrom?: string;
  dateTo?: string;
  justification: string;
}

/** POST /api/v1/messaging/export/:id/approve and /reject. The note is optional, at most 1000 characters. */
export interface DecideMessagingExportRequest {
  note?: string;
}

/** The scope as fixed at request. Ids only: never a channel title or a patient name. */
export interface MessagingExportScopeDto {
  scopeKind: MessagingExportScopeKind;
  channelId: string | null;
  patientId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

/** A job in a list. No justification, no artefact key, no wrapped key. */
export interface MessagingExportJobSummaryDto {
  id: string;
  status: MessagingExportStatus;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  scope: MessagingExportScopeDto;
  decidedBy: string | null;
  decidedAt: string | null;
  readyAt: string | null;
  expiresAt: string | null;
  messageCount: number | null;
  heldExcluded: number | null;
  part2Excluded: number | null;
  downloadCount: number;
  failureCode: string | null;
}

/** A job as the requester or an approver sees it. The justification is approver- and requester-only text. */
export interface MessagingExportJobDetailDto extends MessagingExportJobSummaryDto {
  justification: string;
  decisionNote: string | null;
  buildingAt: string | null;
  artefactBytes: number | null;
  artefactSha256: string | null;
  /** True while the caller may download now: they are the requester and the job is ready and unexpired. */
  downloadable: boolean;
}

/** The manifest at the top of the JSON artefact (D3, D4, D6). Counts and ids only; excluded messages are counted, never listed. */
export interface MessagingExportManifest {
  manifestVersion: typeof MESSAGING_EXPORT_MANIFEST_VERSION;
  format: typeof MESSAGING_EXPORT_FORMAT;
  jobId: string;
  organizationId: string;
  scope: MessagingExportScopeDto;
  requestedBy: string;
  approvedBy: string;
  generatedAt: string;
  expiresAt: string;
  /** Messages in the artefact. */
  messageCount: number;
  /** Messages left out because a legal hold covers them (D3). */
  heldExcluded: number;
  /** Messages left out because they are Part 2 / care-team substance-use gated (D3). */
  part2Excluded: number;
}
