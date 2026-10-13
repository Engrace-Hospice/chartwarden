// apps/admin/src/modules/36-messaging/settings — shared request plumbing for the three M36 settings screens.
// openapi-fetch resolves (never throws) with { data, error, response }; this folds that into one result the
// screens switch on, naming 403 (no access) separately from every other failure so it renders its own state.
import { useRequestGuard } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";

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

export type LoadState<T> =
  | { readonly status: "loading" }
  | { readonly status: "forbidden" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly data: T };

/** Loads once on mount; `reload` retries (back to the loading skeleton); `setData` replaces the ready data. */
export function useLoad<T>(load: () => Promise<ApiResult<T>>): {
  state: LoadState<T>;
  reload: () => void;
  setData: (next: T) => void;
} {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const guard = useRequestGuard();
  const reload = useCallback(() => {
    const isCurrent = guard();
    setState({ status: "loading" });
    void load().then((result) => {
      if (!isCurrent()) return;
      if (result.ok) setState({ status: "ready", data: result.data });
      else if (result.forbidden) setState({ status: "forbidden" });
      else setState({ status: "error", message: result.message });
    });
  }, [guard, load]);
  useEffect(reload, []);
  const setData = useCallback((data: T) => setState({ status: "ready", data }), []);
  return { state, reload, setData };
}
