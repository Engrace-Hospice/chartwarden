// apps/admin/src/modules/36-messaging — shared state bits (loading / error+retry / empty / no-access) and the
// load hook for the M36 platform-ops screens. Chrome is the shared `wx-*` list classes (packages/ui); no inline styles.
import {
  Button,
  Glyph,
  type GlyphName,
  InlineAlert,
  LoadingSpinner,
  useRequestGuard,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";

/** The outcome of one read: data, a 403 (no access), or any other failure. */
export type ReadResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error" };

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

/** Run `read` on mount and whenever it changes; `reload` re-runs it. Only the newest response lands. */
export function useLoad<T>(read: () => Promise<ReadResult<T>>): {
  state: LoadState<T>;
  reload: () => void;
} {
  const guard = useRequestGuard();
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const reload = useCallback(() => {
    const isCurrent = guard();
    setState({ kind: "loading" });
    read().then(
      (result) => {
        if (isCurrent()) setState(result);
      },
      () => {
        if (isCurrent()) setState({ kind: "error" });
      },
    );
  }, [read, guard]);
  useEffect(() => reload(), [reload]);
  return { state, reload };
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
    <div className="wx-list-state" role="alert">
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
  if (state.kind === "error") return <StateError message={opts.error} onRetry={opts.retry} />;
  return null;
}
