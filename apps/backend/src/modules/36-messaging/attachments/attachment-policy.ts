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
/** An expired-pending row is retried by the sweep at most this often (also the backoff ceiling below). */
export const EXPIRED_SCAN_RETRY_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Retry backoff for a pending row the scanner/store could not judge: the n-th failed attempt waits
 * `min(SCAN_RETRY_BASE_MS * 2^(n-1), SCAN_RETRY_MAX_MS)` before the sweep tries it again (1, 2, 4, ... 60 min). It never gives
 * up and never decides: a verdict is final and "the scanner was down" is not one, so the row stays `pending` (never clean,
 * never quarantined) and keeps being retried at the slow cadence. This only stops the hot loop.
 */
export const SCAN_RETRY_BASE_MS = 60 * 1000;
export const SCAN_RETRY_MAX_MS = EXPIRED_SCAN_RETRY_INTERVAL_MS;
/**
 * From this many failed attempts a row is "scan-unavailable": a DERIVED operator signal (reported by the sweep as
 * `scanUnavailable` and through `onScanUnavailable`), not a stored state and not a verdict. By then the backoff is at its
 * slow cadence (attempt 7 = 64 min, capped to 60).
 */
export const SCAN_UNAVAILABLE_ATTEMPTS = 8;
/** Backoff exponent clamp, so `power(2, n)` can never overflow in SQL. */
export const SCAN_RETRY_MAX_EXPONENT = 30;
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
export const SCAN_TICK_BUDGET_MS = 20_000;
/**
 * The reap step's OWN budget, separate from the scan budget: a slow reap (hung destroy) cannot starve scanning and a slow
 * scan cannot starve the reap. Each destroy is itself bounded by REAP_DESTROY_DEADLINE_MS, so a tick ends inside the period:
 * scan 20 s + one scan overrun 20 s + reap 8 s + one destroy overrun 8 s < 60 s.
 */
export const REAP_TICK_BUDGET_MS = 8_000;
export const REAP_DESTROY_DEADLINE_MS = 8_000;
/** `complete`'s object inspect is bounded too (a hung store must not hold the request). */
export const STORAGE_INSPECT_DEADLINE_MS = 15_000;
/** The eraser bounds each object destroy (it runs in a long job, not in a request or a tick). */
export const ERASE_DESTROY_DEADLINE_MS = 60_000;
/** A presigned PUT minted before the erase flag can still land this long after its stated expiry (clock skew allowance). */
export const ERASE_UPLOAD_URL_GRACE_MS = 60 * 1000;
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

/** Total stored bytes an org / a single user may hold in attachments (non-erased rows, bound-pending included). */
export const DEFAULT_ORG_ATTACHMENT_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
export const DEFAULT_USER_ATTACHMENT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface AttachmentQuota {
  readonly orgBytes: number;
  readonly userBytes: number;
}

/** Digits only: "1e9", "1.5", "-5", "" and "abc" are typos, and a typo must not switch the quota off or on its head. */
const positiveInt = (raw: string | undefined, fallback: number): number => {
  const text = raw?.trim() ?? "";
  const n = /^\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

/** MESSAGING_ATTACHMENT_ORG_QUOTA_BYTES / MESSAGING_ATTACHMENT_USER_QUOTA_BYTES; unset or not a positive integer => default. */
export function attachmentQuotaFromEnv(env: Record<string, string | undefined>): AttachmentQuota {
  return {
    orgBytes: positiveInt(
      env.MESSAGING_ATTACHMENT_ORG_QUOTA_BYTES,
      DEFAULT_ORG_ATTACHMENT_QUOTA_BYTES,
    ),
    userBytes: positiveInt(
      env.MESSAGING_ATTACHMENT_USER_QUOTA_BYTES,
      DEFAULT_USER_ATTACHMENT_QUOTA_BYTES,
    ),
  };
}

/**
 * How long the OBJECT of a quarantined file, or of a file on a deleted message, is kept before the reaper destroys it (the
 * row stays for audit). MESSAGING_ATTACHMENT_RETENTION_DAYS; unset or not a positive integer => 7 days.
 */
export const DEFAULT_ATTACHMENT_RETENTION_DAYS = 7;
export function attachmentRetentionMsFromEnv(env: Record<string, string | undefined>): number {
  const days = positiveInt(
    env.MESSAGING_ATTACHMENT_RETENTION_DAYS,
    DEFAULT_ATTACHMENT_RETENTION_DAYS,
  );
  return days * 24 * 60 * 60 * 1000;
}

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

/** The advisory-lock name shared by authorize/complete (SHARED) and the tenant eraser (EXCLUSIVE); see migration 1076. */
export const eraseLockName = (organizationId: string): string =>
  `m36-attachment-erase:${organizationId}`;

/** Opaque, PHI-free object key (M22 D11 posture): ids only, never the file name. */
export function attachmentObjectKey(channelId: string, attachmentId: string): string {
  return `messaging/${channelId}/${attachmentId}`;
}
