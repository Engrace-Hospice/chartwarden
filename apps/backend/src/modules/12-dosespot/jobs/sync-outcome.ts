// apps/backend/src/modules/12-dosespot/jobs/sync-outcome.ts — what a `dosespot_sync_queue` row becomes when its vendor call (or the config
// read behind it) throws. Pure: the drain worker (`worker.ts`) applies it, the unit test pins it.
//
//   defer     the row goes back to `pending` with NO attempt spent and no sync failure recorded. The tenant's registration is not live
//             right now (deactivated, rotating its key, not yet activated: ADR-0111 D6, "queued ones wait") or the platform could not
//             read its config: neither is this row's fault, so neither may end it. Without this the rows of a tenant that merely paused
//             DoseSpot were failed for good and never re-enqueued.
//   requeue   a transient vendor failure: back to `pending`, one attempt spent. The claim backs off by attempt count (`repository.ts`)
//             and the row ends at {@link SYNC_MAX_ATTEMPTS}, so a vendor that never recovers cannot be retried every two minutes forever.
//   failed    ends the row: a rejection the same call would repeat, a bug, or the attempt budget spent.
import {
  isConfigUnavailableError,
  isDegradedError,
  isNotEnabledError,
} from "@chartwarden/dosespot";
import {
  hasDatabaseErrorInChain,
  safeErrorMessage,
} from "../../../bootstrap/redact-database-error";

/** The longest `last_error` a row keeps. */
const MAX_ERROR_CHARS = 2000;
/** What a DATABASE error's text keeps from its END: `safeErrorMessage` puts the SQLSTATE, constraint and table there, after the statement. */
const ERROR_TAIL_CHARS = 500;
const ERROR_CUT_MARKER = " ... ";
/** Where a Drizzle query error's own message starts listing its bound values (`Failed query: <statement>\nparams: <values>`). */
const PARAMS_SECTION = "\nparams:";

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Cap a failed row's text. Everything from a Drizzle-style `\\nparams:` section on is dropped FIRST, for every error: a wrapper that flattens a Drizzle
 * error into a plain message defeats the shape check in `safeErrorMessage`, and what follows that marker is the bound values (drug names, sig text).
 * A text over {@link MAX_ERROR_CHARS} is then cut. A DATABASE error (`keepTail`) keeps its head AND its tail, because it reads `Type: Failed query:
 * <whole statement> [23505 constraint table]` and a head-only cut drops exactly the part that diagnoses it once the statement is long (a multi-row
 * insert is hundreds of placeholders); its text is already redacted, so the tail is safe. Any other error keeps its head only: its last characters
 * are not diagnostics and may be anything. A cut never splits a surrogate pair (Postgres would store a lone surrogate as U+FFFD).
 */
function capErrorText(rawText: string, keepTail: boolean): string {
  const paramsAt = rawText.indexOf(PARAMS_SECTION);
  const text = paramsAt === -1 ? rawText : rawText.slice(0, paramsAt);
  if (text.length <= MAX_ERROR_CHARS) return text;
  if (!keepTail) return withoutTrailingHighSurrogate(text.slice(0, MAX_ERROR_CHARS));
  const headChars = MAX_ERROR_CHARS - ERROR_TAIL_CHARS - ERROR_CUT_MARKER.length;
  const tail = text.slice(-ERROR_TAIL_CHARS);
  const whole = isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
  return `${withoutTrailingHighSurrogate(text.slice(0, headChars))}${ERROR_CUT_MARKER}${whole}`;
}

const withoutTrailingHighSurrogate = (head: string): string =>
  isHighSurrogate(head.charCodeAt(head.length - 1)) ? head.slice(0, -1) : head;

/** The attempt budget of a row (attempts that reached the vendor and failed transiently). 8 attempts back off 1+2+4+8+16+32+60 minutes. */
export const SYNC_MAX_ATTEMPTS = 8;

export type SyncFaultOutcome =
  | { readonly kind: "defer"; readonly error: string }
  | { readonly kind: "requeue"; readonly error: string }
  | { readonly kind: "failed"; readonly error: string };

export interface SyncFaultContext {
  /** Attempts already spent on the row (`attempt_count` as claimed, before this one). */
  readonly attemptCount: number;
  /**
   * The org has a DoseSpot registration row (it started onboarding or paused it). A "not enabled" answer then means "not live YET", so the
   * row waits; for an org that never registered anything it stays what it always was: a row that cannot be served, failed.
   */
  readonly orgHasRegistration: boolean;
}

export function classifySyncFault(error: unknown, ctx: SyncFaultContext): SyncFaultOutcome {
  if (isConfigUnavailableError(error)) return { kind: "defer", error: error.customerMessage };
  if (isNotEnabledError(error)) {
    return ctx.orgHasRegistration
      ? { kind: "defer", error: error.customerMessage }
      : { kind: "failed", error: error.customerMessage };
  }
  if (isDegradedError(error)) {
    if (!error.retryable) return { kind: "failed", error: error.customerMessage };
    return ctx.attemptCount + 1 >= SYNC_MAX_ATTEMPTS
      ? {
          kind: "failed",
          error: `${error.customerMessage} (gave up after ${SYNC_MAX_ATTEMPTS} attempts)`,
        }
      : { kind: "requeue", error: error.customerMessage };
  }
  // A plain Error is deterministic and non-retryable. Its text lands in `dosespot_sync_queue.last_error`, which the write-audit trigger copies
  // into audit_event: `safeErrorMessage`, never `.message`, because a Drizzle error's message embeds the statement's bound parameters (the
  // MedHx ingest runs inside this try, so a failing medication_history_record insert would otherwise persist drug names and sig text).
  // `bare: true` redacts a database error exactly as without it, but returns a NON-database Error's `message` verbatim: that is safe only
  // because no throw in the sync/ingest path interpolates a value (an id, a name, a parameter) into its own message. A new throw there must keep to
  // that, or its text lands in this column and the audit row (sync-outcome.test.ts pins the database-error case, not a hand-written message).
  return {
    kind: "failed",
    error: capErrorText(safeErrorMessage(error, { bare: true }), hasDatabaseErrorInChain(error)),
  };
}
