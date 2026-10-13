// apps/admin/src/modules/36-messaging/settings — shared state chrome for the three M36 settings screens:
// loading skeleton, error + retry, empty, no-access (403) and the success/error banner. Shared `wx-*` classes
// + Tailwind utilities only; no inline styles.
import { Button, Glyph, InlineAlert } from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import type { LoadState } from "./api";

export function PageHead({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <header className="wx-page-head">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
    </header>
  );
}

const SKELETON_ROWS = [0, 1, 2, 3];

export function Skeleton({ label }: { label: string }): JSX.Element {
  return (
    <output className="wx-list-state w-full" aria-busy="true" aria-label={label}>
      {SKELETON_ROWS.map((row) => (
        <div
          key={row}
          className="h-10 w-full animate-pulse rounded-lg bg-[var(--color-surface-low)]"
        />
      ))}
    </output>
  );
}

export function StateError({
  message,
  onRetry,
}: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="wx-list-state">
      <InlineAlert tone="error">{message}</InlineAlert>
      <Button tone="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function StateEmpty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="wx-list-state">
      <Glyph name="check-circle" size={24} />
      <span>{children}</span>
    </div>
  );
}

export function StateNoAccess({ what }: { what: string }): JSX.Element {
  return (
    <div className="wx-list-state" role="alert">
      <Glyph name="lock" size={24} />
      <span>You do not have access to {what}. Ask an administrator to grant the permission.</span>
    </div>
  );
}

export interface Banner {
  readonly ok: boolean;
  readonly message: string;
}

export function BannerView({ banner }: { banner: Banner | null }): JSX.Element | null {
  if (!banner) return null;
  return (
    <div role={banner.ok ? "status" : "alert"}>
      <InlineAlert tone={banner.ok ? "success" : "error"}>{banner.message}</InlineAlert>
    </div>
  );
}

/** Renders the non-ready LoadState branches; null when the data is ready. */
export function renderLoadFallback<T>(
  state: LoadState<T>,
  opts: { loadingLabel: string; what: string; onRetry: () => void },
): JSX.Element | null {
  if (state.status === "loading") return <Skeleton label={opts.loadingLabel} />;
  if (state.status === "forbidden") return <StateNoAccess what={opts.what} />;
  if (state.status === "error")
    return <StateError message={state.message} onRetry={opts.onRetry} />;
  return null;
}
