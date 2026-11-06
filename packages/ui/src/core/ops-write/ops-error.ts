// @chartwarden/ui core — what an operator is told when a platform write is refused (ADR-0032 error envelope).
//
// Every refusal the console meets has one meaning and one next step. `describeOpsError` reads the standard envelope
// `{ error: { code, message, correlationId, details: [{ field, code, message }] } }` plus the HTTP status and answers with a KIND the
// screen switches on:
//   step-up       403 STEP_UP_REQUIRED          -> offer Re-verify (the typed form is stashed, never an automatic redirect)
//   precondition  428                           -> an If-Match pin is missing; `current` carries the record's current recordedAt when given
//   conflict      409 / 412                     -> the record changed under the operator; re-read, show what it now says, ask again
//   locked        409 ONBOARDING_STEP_OUT_OF_ORDER -> `blockedBy` names the earlier step to finish
//   validation    400 / 422                     -> `fieldErrors` maps each detail to its field
//   not-found / forbidden / unavailable / network, and unknown for the rest
// Nothing is retried on the operator's behalf: a pinned write that was refused must be confirmed again against what was re-read.
import { envelopeErrorMessage } from "../error-message";

export type OpsFailureKind =
  | "step-up"
  | "precondition"
  | "conflict"
  | "locked"
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
}

export type OpsErrorCopy = Readonly<Record<string, string>>;

interface Envelope {
  readonly code: string | null;
  readonly correlationId: string | null;
  readonly details: readonly OpsErrorDetail[];
}

const GENERIC: Readonly<Record<OpsFailureKind, string>> = {
  "step-up": "Your sign-in is not recent enough for this action. Re-verify, then come back to it.",
  precondition: "This action needs the record as you last read it. Reload it and try again.",
  conflict: "This changed since you opened it. Reload, review what it says now, and try again.",
  locked: "An earlier step is not finished yet.",
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
  if (status === 428) return "precondition";
  if (code === OUT_OF_ORDER_CODE) return "locked";
  if (status === 409 || status === 412) return "conflict";
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
  response: { readonly status: number } | null | undefined,
  copy: OpsErrorCopy = {},
): OpsFailure {
  const status = response?.status ?? null;
  const { code, correlationId, details } = envelopeOf(error);
  const kind = kindOf(status, code);
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
      (code !== null ? copy[code] : undefined) ?? envelopeErrorMessage(error) ?? GENERIC[kind],
    fieldErrors,
    details,
    current: recordedAt ? { recordedAt } : null,
    blockedBy:
      kind === "locked" ? (details.find((d) => d.field === "templateKey")?.code ?? null) : null,
    correlationId,
  };
}
