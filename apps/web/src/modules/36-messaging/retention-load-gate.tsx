// M36 WP 5.6 - the load states the retention governance tabs share: loading, error with Retry, denied (401 / 403), and ready. A reload that fails
// while data is on screen keeps the data and raises an inline Retry instead.
import { Button, LoadingSpinner } from "@chartwarden/ui";
import type { JSX } from "react";
import * as W from "./retention-wording";
import type { LoadView } from "./use-retention";

export const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

function RetryAlert({ retry }: { readonly retry: () => void }): JSX.Element {
  return (
    <div className="wx-retention-error" role="alert">
      <p>{W.LOAD_FAILED}</p>
      <Button type="button" tone="secondary" size="sm" onClick={retry}>
        {W.RETRY_LABEL}
      </Button>
    </div>
  );
}

export function LoadGate<T>({
  view,
  retry,
  refreshFailed = false,
  children,
}: {
  readonly view: LoadView<T>;
  readonly retry: () => void;
  /** A reload failed but the last good data is still shown: say so inline, never replace the data. */
  readonly refreshFailed?: boolean;
  readonly children: (data: T) => JSX.Element;
}): JSX.Element {
  switch (view.status) {
    case "loading":
      return <LoadingSpinner />;
    case "error":
      return <RetryAlert retry={retry} />;
    case "denied":
      return (
        <p className="wx-retention-error" role="alert">
          {view.code === 401 ? W.SIGN_IN : W.DENIED}
        </p>
      );
    case "ready":
      return (
        <>
          {refreshFailed ? <RetryAlert retry={retry} /> : null}
          {children(view.data)}
        </>
      );
  }
}
