// apps/backend/src/modules/36-messaging/attachments/attachment-policy.ts — WP 1.5: what a chat attachment may be, and
// the opaque storage key it lives under. Pure; no I/O.
import { WardenXError } from "@wardenx/types";

/** 25 MB: the M22 verified-upload ceiling is 25 MiB; messaging stays under it (and under the 1075 CHECK). */
export const MAX_ATTACHMENT_BYTES = 25_000_000;
/** How long the presigned PUT stays valid (the S3 adapter clamps to 30..900 s). */
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 600;
/** How long a presigned GET stays valid. Short on purpose: access is re-authorized on every open. */
export const ATTACHMENT_ACCESS_TTL_SECONDS = 120;
/** A message carries at most this many attachments (matches the send schema's maxItems). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** The M22 document types plus plain text. Executables, archives, scripts and HTML are not on it. */
export const ATTACHMENT_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  DOCX,
  "text/plain",
]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface AuthorizeInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

/** At most this many uploads a user may have open (unbound and either unfinished-but-unexpired or finished) at once. */
export const MAX_OPEN_UPLOADS_PER_USER = 20;
/** A reaped incomplete upload must have been expired for this long (a slow client may still be finishing its PUT). */
export const ORPHAN_UPLOAD_GRACE_MS = 15 * 60 * 1000;
/** A finished upload that no message adopted within this age can no longer be sent... */
export const UNBOUND_UPLOAD_BIND_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
/** ...and is destroyed (bytes and row) once it is this old. Bind stops a day earlier so the reaper never races a send. */
export const UNBOUND_UPLOAD_REAP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A completed attachment the scanner has attempted but could not judge within this age is reported as `blocked`
 * ("scan expired"). It stays `pending` in the database - NEVER quarantined by age, because "the scanner was down" is not a
 * verdict (an outage > 24 h must not condemn legitimate files unscanned) - so the sweep keeps retrying (at most hourly
 * once expired) and a real verdict still settles it. It is never deliverable while pending.
 */
export const MAX_PENDING_SCAN_AGE_MS = 24 * 60 * 60 * 1000;
/** An expired-pending row is retried by the sweep at most this often. */
export const EXPIRED_SCAN_RETRY_INTERVAL_MS = 60 * 60 * 1000;
/** `complete` makes at most this many inline scan attempts per attachment (counted in `scan_attempts`). */
export const MAX_INLINE_SCAN_ATTEMPTS = 3;
/**
 * An object a scan could not find becomes a final `object-missing` quarantine only after this many CONSECUTIVE 404
 * observations (`object_missing_count`, reset by any successful read) spanning at least this long
 * (`first_object_missing_at`). Scanner outages never count: they do not touch these columns.
 */
export const OBJECT_MISSING_MIN_OBSERVATIONS = 3;
export const OBJECT_MISSING_MIN_SPAN_MS = 15 * 60 * 1000;
/**
 * There is NO cross-org circuit breaker (a shared breaker lets two tenants' failures stall a third's scanning). Instead:
 * one org's sweep stops after this many failures (scanner transport OR its own bucket) per tick...
 */
export const MAX_ORG_SCAN_FAILURES_PER_TICK = 2;
/** ...the whole sweep stops STARTING scans after this much wall time (the cron period is 60 s)... */
export const SCAN_TICK_BUDGET_MS = 35_000;
/** ...and one scan (read + scanner) is abandoned after this long, so a tick ends within budget + deadline < 60 s. */
export const SCAN_ROW_DEADLINE_MS = 20_000;
/** Inline (`complete`) scans in flight: per process, and per org. Over either, the row is left pending for the sweep. */
export const MAX_INLINE_SCANS_PER_PROCESS = 4;
export const MAX_INLINE_SCANS_PER_ORG = 2;
/** A user may have at most this many QUARANTINED unbound uploads created in the last 24 h (EICAR-loop brake). */
export const MAX_QUARANTINED_UPLOADS_PER_USER = 20;
export const QUARANTINED_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Per-user request rate for authorize (counted from rows created) and complete, per rolling minute. */
export const DEFAULT_USER_REQUESTS_PER_MINUTE = 60;

/** Pending, attempted and older than the cap: not deliverable and shown as blocked, but still awaiting a real verdict. */
export function isScanExpired(
  row: { scanState: string; completedAt: Date | null; scanAttempts: number },
  nowMs: number,
): boolean {
  return (
    row.scanState === "pending" &&
    row.completedAt !== null &&
    row.scanAttempts > 0 &&
    nowMs - row.completedAt.getTime() > MAX_PENDING_SCAN_AGE_MS
  );
}

/** Unicode bidirectional controls: they let a name spoof its own extension ("invoice‮fdp.exe"), so they are removed. */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;

/** A file name is display text only (the object key never contains it): no path parts, no control or bidi characters. */
export function sanitizeFileName(raw: string): string {
  const name = raw.normalize("NFC").replace(BIDI_CONTROLS, "").trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  const bad = /[\u0000-\u001f\u007f/\\]/.test(name);
  if (name.length < 1 || name.length > 255 || bad || /^\.+$/.test(name)) {
    throw new WardenXError("VALIDATION_FAILED", "fileName is not a valid file name", 422);
  }
  return name;
}

/** Validate an authorize request at the trust boundary; returns the normalised copy. */
export function validateAuthorizeInput(input: AuthorizeInput): AuthorizeInput {
  if (!ATTACHMENT_MIME_ALLOWLIST.has(input.contentType)) {
    throw new WardenXError("UNSUPPORTED_MEDIA_TYPE", "attachment content type is not allowed", 415);
  }
  if (
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize < 1 ||
    input.byteSize > MAX_ATTACHMENT_BYTES
  ) {
    throw new WardenXError(
      "UPLOAD_SIZE_INVALID",
      `attachment byteSize must be between 1 and ${MAX_ATTACHMENT_BYTES}`,
      422,
    );
  }
  if (!SHA256_HEX.test(input.sha256Hex)) {
    throw new WardenXError("VALIDATION_FAILED", "sha256Hex must be lowercase SHA-256 hex", 422);
  }
  return { ...input, fileName: sanitizeFileName(input.fileName) };
}

/** Opaque, PHI-free object key (M22 D11 posture): ids only, never the file name. */
export function attachmentObjectKey(channelId: string, attachmentId: string): string {
  return `messaging/${channelId}/${attachmentId}`;
}
