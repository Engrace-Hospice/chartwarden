// @chartwarden/ui core — what an operator is told when a platform write is refused (ADR-0032 error envelope).
//
// Every refusal the console meets has one meaning and one next step. `describeOpsError` reads the standard envelope
// `{ error: { code, message, correlationId, details: [{ field, code, message }] } }` plus the HTTP status and answers with a KIND the
// screen switches on:
//   step-up       403 STEP_UP_REQUIRED          -> offer Re-verify (the typed form is stashed, never an automatic redirect)
//   precondition  428                           -> an If-Match pin is missing; `current` carries the record's current recordedAt when given
//   conflict      412 / a stale-pin 409         -> the record changed under the operator; re-read, show what it now says, ask again
//   refused       any other coded 409           -> the server REFUSED the change on its merits (an account in use, work still queued):
//                                                  show its sentence and keep the form, nothing was stale
//   locked        409 ONBOARDING_STEP_OUT_OF_ORDER -> `blockedBy` names the earlier step to finish
//   rate-limited  429 (the API's own, or a proxy's bare page) -> wait, then try again; `retryAfterSeconds` when the response says
//   validation    400 / 422                     -> `fieldErrors` maps each detail to its field
//   not-found / forbidden / unavailable / network, and unknown for the rest
// Nothing is retried on the operator's behalf: a pinned write that was refused must be confirmed again against what was re-read.
import { envelopeErrorMessage } from "../error-message";
import { isInFlightDuplicate, isKeyStuck } from "./idempotency-key";

export type OpsFailureKind =
  | "step-up"
  | "precondition"
  | "conflict"
  | "refused"
  | "locked"
  | "rate-limited"
  | "validation"
  | "not-found"
  | "forbidden"
  | "unavailable"
  | "network"
  | "unknown";

export interface OpsErrorDetail {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface OpsFailure {
  readonly kind: OpsFailureKind;
  readonly code: string | null;
  readonly status: number | null;
  readonly message: string;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly details: readonly OpsErrorDetail[];
  /** The record's current state when the server says so (`details` entry `currentRecordedAt`), else null. */
  readonly current: { readonly recordedAt: string } | null;
  /** The earlier wizard step that must be settled first (ONBOARDING_STEP_OUT_OF_ORDER), else null. */
  readonly blockedBy: string | null;
  readonly correlationId: string | null;
  /** The wait a 429 asked for (its `Retry-After` in seconds), when the response carried a usable one. */
  readonly retryAfterSeconds?: number | null;
}

export type OpsErrorCopy = Readonly<Record<string, string>>;

/** The part of a fetch Response this reads: its status and, for a 429, its headers. */
export interface ResponseLike {
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
}

/** Backward-compatible name used by existing operator-write call sites. */
export type ErrorResponse = ResponseLike;

interface Envelope {
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly details: readonly OpsErrorDetail[];
}

const GENERIC: Readonly<Record<OpsFailureKind, string>> = {
  "step-up": "Your sign-in is not recent enough for this action. Re-verify, then come back to it.",
  precondition: "This action needs the record as you last read it. Reload it and try again.",
  conflict: "This changed since you opened it. Reload, review what it says now, and try again.",
  refused: "That was refused. Nothing was changed.",
  locked: "An earlier step is not finished yet.",
  "rate-limited": "Too many attempts. Wait a minute, then try again.",
  validation: "Some details need attention.",
  "not-found": "That could not be found.",
  forbidden: "You do not have access to do that.",
  unavailable: "The service is unavailable right now. Try again in a moment.",
  network: "Could not reach the server. Check your connection and try again.",
  unknown: "That did not work. Try again, and quote the reference below if it keeps happening.",
};

const STEP_UP_CODE = "STEP_UP_REQUIRED";
const OUT_OF_ORDER_CODE = "ONBOARDING_STEP_OUT_OF_ORDER";
const CURRENT_RECORDED_AT = "currentRecordedAt";
/**
 * The 409 codes that mean "the record moved since you read it" (a pinned write lost a race), as opposed to a 409 that refuses the change on
 * its merits (CLEARINGHOUSE_ACCOUNT_IN_USE, CLEARINGHOUSE_VENDOR_LOCKED, ...). A stale If-Match on the clearinghouse and BAA routes is a
 * 412 VERSION_CONFLICT (a missing one is a 428); these are the routes that pin with a 409 instead. STALE_VERSION is the route kit's
 * stale write (every route that checks an integer If-Match through the kit, e.g. the MAC credential save).
 */
const STALE_PIN_409_CODES: ReadonlySet<string> = new Set([
  "ONBOARDING_TASK_CHANGED",
  "PRICING_PLAN_CHANGED",
  "NOTICE_FILING_RECORD_CHANGED",
  // The withdrawn record is already gone (someone else withdrew it): the pinned record changed under the operator.
  "NOTICE_NOT_FILED_EXTERNALLY",
  "CLEARINGHOUSE_BAA_CHANGED",
  "CLEARINGHOUSE_CHANGED_DURING_VERIFY",
  "TENANT_STATUS_CHANGED",
  "STALE_VERSION",
]);
/**
 * The server's own sentence for an in-flight duplicate is an implementation detail ("Idempotency-Key request is still being processed").
 * The operator's situation: an earlier try of this same change is still being saved, and re-sending it now would not help.
 */
const IN_FLIGHT_COPY =
  "That change is still being saved. Wait a moment, then check the record before trying again.";
/**
 * The server's sentence for a stuck key tells a client how to treat an Idempotency-Key, which is not the operator's question: did my change
 * save? The key is already spent, nothing is retried for them, and the next step is to look at the record before trying again.
 */
const KEY_STUCK_COPY =
  "We could not confirm whether that change was saved. Check the record before trying again.";
/** A 413 with no envelope is a proxy (nginx's body cap) refusing before the app saw the request; it gets a code the caller's copy can name. */
const PAYLOAD_TOO_LARGE_CODE = "PAYLOAD_TOO_LARGE";
/** The API's own 429 code; a 429 with no envelope (nginx's per-address limit sends an HTML page) is given the same one. */
const RATE_LIMITED_CODE = "RATE_LIMITED";

/** `Retry-After` as whole seconds (the delta form every limiter here sends); anything else is not used. */
function retryAfterOf(response: ResponseLike | null | undefined): number | null {
  const raw = response?.headers?.get("retry-after") ?? response?.headers?.get("Retry-After");
  if (raw === null || raw === undefined || !/^\d{1,6}$/.test(raw.trim())) return null;
  const seconds = Number(raw.trim());
  return seconds > 0 && seconds <= 3600 ? seconds : null;
}

const waitWords = (seconds: number): string =>
  seconds <= 90 ? `${seconds} seconds` : `about ${Math.ceil(seconds / 60)} minutes`;

function envelopeOf(error: unknown): Envelope {
  const body = (error as { error?: unknown } | null | undefined)?.error;
  if (body === null || typeof body !== "object") {
    return { code: null, correlationId: null, details: [] };
  }
  const e = body as { code?: unknown; correlationId?: unknown; details?: unknown };
  const details = Array.isArray(e.details)
    ? e.details.flatMap((d): OpsErrorDetail[] => {
        const entry = d as { field?: unknown; code?: unknown; message?: unknown };
        return typeof entry.field === "string" && typeof entry.message === "string"
          ? [
              {
                field: entry.field,
                code: typeof entry.code === "string" ? entry.code : "",
                message: entry.message,
              },
            ]
          : [];
      })
    : [];
  return {
    code: typeof e.code === "string" ? e.code : null,
    correlationId: typeof e.correlationId === "string" ? e.correlationId : null,
    details,
  };
}

function kindOf(status: number | null, code: string | null): OpsFailureKind {
  if (status === null) return "network";
  if (status === 403 && code === STEP_UP_CODE) return "step-up";
  if (status === 429) return "rate-limited";
  if (status === 428) return "precondition";
  if (code === OUT_OF_ORDER_CODE) return "locked";
  if (status === 412) return "conflict";
  // A 409 with no code (a proxy, an old server) cannot be told from a stale pin: re-reading is the safe answer.
  if (status === 409)
    return code === null || STALE_PIN_409_CODES.has(code) ? "conflict" : "refused";
  if (status === 400 || status === 422) return "validation";
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "forbidden";
  if (status >= 500) return "unavailable";
  return "unknown";
}

/**
 * `copy` maps a server code to the operator's own sentence and wins over the server's. Without one the server's sentence is used
 * (the envelope never carries record content), except for authorization-class codes, whose policy text is withheld.
 */
export function describeOpsError(
  error: unknown,
  response: ResponseLike | null | undefined,
  copy: OpsErrorCopy = {},
): OpsFailure {
  const status = response?.status ?? null;
  const envelope = envelopeOf(error);
  const { correlationId, details } = envelope;
  const code =
    envelope.code ??
    (status === 413 ? PAYLOAD_TOO_LARGE_CODE : status === 429 ? RATE_LIMITED_CODE : null);
  const kind = kindOf(status, code);
  const retryAfterSeconds = kind === "rate-limited" ? retryAfterOf(response) : null;
  const recordedAt = details.find((d) => d.field === CURRENT_RECORDED_AT)?.message;
  const fieldErrors: Record<string, string> = {};
  if (kind === "validation") {
    for (const d of details) fieldErrors[d.field] = d.message;
  }
  return {
    kind,
    code,
    status,
    message:
      // A limiter's own sentence ("rate limit exceeded") says nothing to do: a 429 gets the wait the response named, else the caller's copy,
      // else the kit's words.
      kind === "rate-limited"
        ? retryAfterSeconds !== null
          ? `Too many attempts. Wait ${waitWords(retryAfterSeconds)}, then try again.`
          : ((code !== null ? copy[code] : undefined) ?? GENERIC[kind])
        : ((code !== null ? copy[code] : undefined) ??
          (status !== null && isKeyStuck(status, error) ? KEY_STUCK_COPY : undefined) ??
          (status !== null && isInFlightDuplicate(status, error) ? IN_FLIGHT_COPY : undefined) ??
          envelopeErrorMessage(error) ??
          GENERIC[kind]),
    fieldErrors,
    details,
    current: recordedAt ? { recordedAt } : null,
    blockedBy:
      kind === "locked" ? (details.find((d) => d.field === "templateKey")?.code ?? null) : null,
    correlationId,
    ...(kind === "rate-limited" ? { retryAfterSeconds } : {}),
  };
}

/**
 * A refusal that is about an input the screen renders: the form stays open and each message is read beside its field, so the notice is
 * not repeated. `renders` says which fields this screen actually shows (default: any): a refusal that names only fields the screen does
 * not render (the server's `(root)` for an unknown shape) is NOT about an input, and its notice must show.
 */
export function isAboutAnInput(
  failure: Pick<OpsFailure, "kind" | "fieldErrors">,
  renders: (field: string) => boolean = () => true,
): boolean {
  return failure.kind === "validation" && Object.keys(failure.fieldErrors).some(renders);
}
