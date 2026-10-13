// apps/admin/src/modules/36-messaging/settings — shared request plumbing for the three M36 settings screens.
// openapi-fetch resolves (never throws) with { data, error, response }; this folds that into one result the
// screens switch on, naming 403 (no access) separately from every other failure so it renders its own state.
import type { ReadResult } from "../ui";

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly forbidden: boolean; readonly message: string };

interface FetchLike<T> {
  data?: T;
  error?: unknown;
  response: { status: number };
}

/** The `error.message` of the standard envelope when present, else `fallback`. */
function envelopeMessage(error: unknown, fallback: string): string {
  const message = (error as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message === "string" && message !== "" ? message : fallback;
}

export function toResult<T>(res: FetchLike<T>, fallback: string): ApiResult<T> {
  if (res.error !== undefined || res.response.status >= 400) {
    return {
      ok: false,
      forbidden: res.response.status === 403,
      message: envelopeMessage(res.error, fallback),
    };
  }
  return { ok: true, data: res.data as T };
}

/** Fold a write/read ApiResult into the module-level ReadResult that `useLoad` consumes. */
export function asRead<T>(result: ApiResult<T>): ReadResult<T> {
  if (result.ok) return { kind: "ok", data: result.data };
  return result.forbidden ? { kind: "forbidden" } : { kind: "error", message: result.message };
}
