// apps/web/src/modules/08-encounters/findings — WF09: the typed access layer for the visit findings routes of M8.
//
//   GET|PUT /api/v1/encounters/{encounterId}/adl             the ADL record; a PUT REPLACES the whole record and is idempotent
//   GET|PUT /api/v1/encounters/{encounterId}/nutrition       the nutrition record, same rules
//
// A record carries a `version` (0 when none is stored yet); a PUT sends the version the form was loaded from as `If-Match`, and a 409
// STALE_VERSION means the record changed since. A PUT is draft-only: a finalized note answers 409 NOTE_PINNED_AT_FINALIZE, a signed one
// 409 IMMUTABLE_AFTER_SIGN, and a template with no section that states the record 422 FINDING_NOT_IN_NOTE.
//   GET     /api/v1/encounters/{encounterId}/weight-history  { current, prior, history }: the last six weights, newest first
//
// A GET answers `null` before anything is recorded. The server owns every rule: the value sets, the 422 on a bad value, the 409
// IMMUTABLE_AFTER_SIGN once the note is signed (a signed note's findings never change), and the non-leaking 404 for a visit the caller
// cannot see. Nothing here re-decides them; it turns each refusal into one plain sentence the panel can show where the clinician is looking.
//
// Every call answers a `WriteResult` (reads included) instead of throwing: a failed READ matters as much as a failed write here, because a
// form that opened blank after a failed load would, on Save, replace the stored record with an empty one.
import type { ApiClient, operations } from "@chartwarden/ui";
import type { WriteResult } from "../encounters-api";
import { findingFieldLabel } from "./findings-labels";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type AdlView = NonNullable<Ok<operations["getApiV1EncountersByEncounterIdAdl"]>>;
export type AdlBody = ReqBody<operations["putApiV1EncountersByEncounterIdAdl"]>;
export type NutritionView = NonNullable<Ok<operations["getApiV1EncountersByEncounterIdNutrition"]>>;
export type NutritionBody = ReqBody<operations["putApiV1EncountersByEncounterIdNutrition"]>;
export type WeightHistoryView = Ok<operations["getApiV1EncountersByEncounterIdWeighthistory"]>;
export type WeightReading = NonNullable<WeightHistoryView["current"]>;

/** The server's code for a write to a note that is already signed, cosigned or void. */
export const IMMUTABLE_AFTER_SIGN = "IMMUTABLE_AFTER_SIGN";
/** The server's code for a write to a note that is finalized (its text is pinned) but not yet signed. */
export const NOTE_PINNED_AT_FINALIZE = "NOTE_PINNED_AT_FINALIZE";
/** The server's code for a record whose template has no section that states it. */
export const FINDING_NOT_IN_NOTE = "FINDING_NOT_IN_NOTE";
/** The server's code for a write made on a version of the record that is no longer the stored one. */
export const STALE_VERSION = "STALE_VERSION";

/** Why a signed note's findings are read-only. */
export const SIGNED_MESSAGE = "This note is signed, so these findings can no longer be changed.";
/** Why a finalized note's findings are read-only. */
export const FINALIZED_MESSAGE =
  "This note is finalized, so these findings can no longer be changed.";
/** Why a record cannot be saved on this note at all. */
export const NOT_IN_NOTE_MESSAGE =
  "This visit's note has no section for these findings, so they cannot be recorded here.";
/** What a stale save says; the panel adds the way forward. */
export const STALE_MESSAGE = "This record changed since you opened it.";

/** The sentence for each code the server answers with, whatever the status it came on. */
const CODE_MESSAGE: Readonly<Record<string, string>> = {
  [IMMUTABLE_AFTER_SIGN]: SIGNED_MESSAGE,
  [NOTE_PINNED_AT_FINALIZE]: FINALIZED_MESSAGE,
  [FINDING_NOT_IN_NOTE]: NOT_IN_NOTE_MESSAGE,
  [STALE_VERSION]: STALE_MESSAGE,
};

/** The refusals that say the note itself will not take this record: the form is read-only from then on, with the sentence that says why. */
export const LOCKING_CODES: ReadonlySet<string> = new Set([
  IMMUTABLE_AFTER_SIGN,
  NOTE_PINNED_AT_FINALIZE,
  FINDING_NOT_IN_NOTE,
]);
/** What an answer this file has no sentence for says: the server's own message is not shown (it is written for logs, not the author). */
const GENERIC_MESSAGE =
  "The action could not be completed. Try again, or reload the record if it keeps happening.";
const CONNECTION_MESSAGE =
  "The connection was interrupted. Your entries are still here; try again.";

type Failure = Extract<WriteResult<never>, { ok: false }>;

interface ErrorEnvelope {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
}

/** The sentence for a 422 detail: the field in words, and what to do. The server's "must be one of: a, b" lists stored codes, so it is not shown. */
/** A request field path in words ("items.bathing" -> "Bathing", "someFieldName" -> "Some field name") when it is not a known finding field. */
function plainFieldName(field: string): string {
  const last = field.split(".").pop() ?? field;
  const words = last
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  return words === "" ? "" : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function validationSentence(details: unknown, fallback: string): string {
  const first = Array.isArray(details) ? details[0] : details;
  if (!first || typeof first !== "object") return fallback;
  const { field, message } = first as { field?: unknown; message?: unknown };
  const label =
    typeof field === "string" ? (findingFieldLabel(field) ?? plainFieldName(field)) : null;
  const text =
    typeof message === "string" && !message.startsWith("must be one of")
      ? message
      : "Choose one of the listed options.";
  return label ? `${label}: ${text}` : text;
}

function failureOf(status: number | undefined, body: unknown): Failure {
  const httpStatus = typeof status === "number" ? status : null;
  const err: ErrorEnvelope | undefined =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: ErrorEnvelope }).error
      : undefined;
  const code = typeof err?.code === "string" ? err.code : null;
  const message =
    (code !== null ? CODE_MESSAGE[code] : undefined) ??
    (httpStatus === 404
      ? "That visit is no longer available to you."
      : httpStatus === 403
        ? "Your role is not permitted to record these findings on this visit."
        : httpStatus === 422
          ? validationSentence(err?.details, "The details entered were not accepted.")
          : GENERIC_MESSAGE);
  return { ok: false, status: httpStatus, code, message, details: err?.details };
}

const connectionFailure: Failure = {
  ok: false,
  status: null,
  code: null,
  message: CONNECTION_MESSAGE,
  details: undefined,
};

/** Run one request; a dropped connection is a failure like any other, never an exception for the screen to miss. */
async function settle<T>(
  run: () => Promise<{ data?: T | null; error?: unknown; response?: { status: number } }>,
): Promise<WriteResult<T | null>> {
  try {
    const { data, error, response } = await run();
    if (error || !response?.status || response.status >= 400)
      return failureOf(response?.status, error);
    return { ok: true, value: data ?? null };
  } catch {
    return connectionFailure;
  }
}

/** A write's 200 and the weight history always carry a body; an empty answer is not a result to act on. */
function required<T>(
  result: WriteResult<T | null>,
  emptyMessage = "The save could not be confirmed. Reload before trying again.",
): WriteResult<T> {
  if (!result.ok) return result;
  return result.value === null
    ? { ...connectionFailure, message: emptyMessage }
    : { ok: true, value: result.value };
}

export function loadAdl(
  client: ApiClient,
  encounterId: string,
): Promise<WriteResult<AdlView | null>> {
  return settle(() =>
    client.GET("/api/v1/encounters/{encounterId}/adl", { params: { path: { encounterId } } }),
  );
}

/** `version` is the one the form was loaded from (0 when nothing was stored): sent as `If-Match`, so a record that moved since is refused. */
export async function saveAdl(
  client: ApiClient,
  encounterId: string,
  body: AdlBody,
  version: number,
): Promise<WriteResult<AdlView>> {
  return required(
    await settle(() =>
      client.PUT("/api/v1/encounters/{encounterId}/adl", {
        params: { path: { encounterId }, header: { "If-Match": String(version) } },
        body,
      }),
    ),
  );
}

export function loadNutrition(
  client: ApiClient,
  encounterId: string,
): Promise<WriteResult<NutritionView | null>> {
  return settle(() =>
    client.GET("/api/v1/encounters/{encounterId}/nutrition", {
      params: { path: { encounterId } },
    }),
  );
}

export async function saveNutrition(
  client: ApiClient,
  encounterId: string,
  body: NutritionBody,
  version: number,
): Promise<WriteResult<NutritionView>> {
  return required(
    await settle(() =>
      client.PUT("/api/v1/encounters/{encounterId}/nutrition", {
        params: { path: { encounterId }, header: { "If-Match": String(version) } },
        body,
      }),
    ),
  );
}

export async function loadWeightHistory(
  client: ApiClient,
  encounterId: string,
): Promise<WriteResult<WeightHistoryView>> {
  return required(
    await settle(() =>
      client.GET("/api/v1/encounters/{encounterId}/weight-history", {
        params: { path: { encounterId } },
      }),
    ),
    "The weight history could not be read.",
  );
}
