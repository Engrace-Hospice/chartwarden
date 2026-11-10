// apps/admin/src/modules/36-messaging — shared state bits (loading / error+retry / empty / no-access) and the
// load hook for the M36 platform-ops screens. Chrome is the shared `wx-*` list classes (packages/ui); no inline styles.
import {
  Button,
  Glyph,
  type GlyphName,
  InlineAlert,
  LoadingSpinner,
  useRequestGuard,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

/** What the operator is told when a request got no answer at all (offline, reset): openapi-fetch rethrows rather than resolving an error. */
export const UNREACHABLE_MESSAGE =
  "Could not reach the server. Check your connection and try again.";

/** The outcome of one read: data, a 403 (no access), or any other failure (optionally with a server message). */
export type ReadResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error"; readonly message?: string };

export type LoadState<T> = { readonly kind: "loading" } | ReadResult<T>;

/** Map an openapi-fetch response to a ReadResult (403 is its own state, never a generic error). */
export function toReadResult<T>(
  status: number,
  data: T | undefined,
  hasError: boolean,
): ReadResult<T> {
  if (status === 403) return { kind: "forbidden" };
  if (hasError || data === undefined) return { kind: "error" };
  return { kind: "ok", data };
}

/** A failed in-place refresh keeps the data already on screen instead of replacing it with the error state. */
function keepOnSilentError<T>(
  silent: boolean,
  prev: LoadState<T>,
  next: LoadState<T>,
): LoadState<T> {
  return silent && next.kind === "error" && prev.kind === "ok" ? prev : next;
}

/**
 * Run `read` on mount and whenever it changes. `reload` goes back to the loading state; `refresh` refetches in
 * place (the current view stays mounted, so focus is not lost); `setData` applies a functional update to ready
 * data (optimistic edits). Only the newest response lands.
 */
export function useLoad<T>(read: () => Promise<ReadResult<T>>): {
  state: LoadState<T>;
  reload: () => void;
  refresh: () => void;
  setData: (update: (current: T) => T) => void;
} {
  const guard = useRequestGuard();
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const run = useCallback(
    (silent: boolean) => {
      const isCurrent = guard();
      if (!silent) setState({ kind: "loading" });
      read().then(
        (result) => {
          if (isCurrent()) setState((prev) => keepOnSilentError(silent, prev, result));
        },
        () => {
          if (isCurrent()) setState((prev) => keepOnSilentError(silent, prev, { kind: "error" }));
        },
      );
    },
    [read, guard],
  );
  const reload = useCallback(() => run(false), [run]);
  const refresh = useCallback(() => run(true), [run]);
  const setData = useCallback((update: (current: T) => T) => {
    setState((s) => (s.kind === "ok" ? { kind: "ok", data: update(s.data) } : s));
  }, []);
  useEffect(() => reload(), [reload]);
  return { state, reload, refresh, setData };
}

export function StateLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="wx-list-state">
      <LoadingSpinner label={label} />
    </div>
  );
}

export function StateError({
  message,
  onRetry,
}: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="wx-list-state">
      <InlineAlert tone="error">{message}</InlineAlert>
      <Button tone="secondary" size="lg" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function StateEmpty({
  icon = "check-circle",
  children,
}: { icon?: GlyphName; children: ReactNode }): JSX.Element {
  return (
    <div className="wx-list-state">
      <Glyph name={icon} size={24} />
      <span>{children}</span>
    </div>
  );
}

export function StateForbidden({ what }: { what: string }): JSX.Element {
  return (
    <div className="wx-list-state" role="alert">
      <Glyph name="lock" size={24} />
      <span>You do not have access to {what}.</span>
    </div>
  );
}

/** Render the non-ok states of a LoadState; returns null when the caller should render its data. */
export function renderLoadFallback<T>(
  state: LoadState<T>,
  opts: { loading: string; error: string; noAccess: string; retry: () => void },
): JSX.Element | null {
  if (state.kind === "loading") return <StateLoading label={opts.loading} />;
  if (state.kind === "forbidden") return <StateForbidden what={opts.noAccess} />;
  if (state.kind === "error")
    return <StateError message={state.message ?? opts.error} onRetry={opts.retry} />;
  return null;
}
