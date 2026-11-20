// apps/web/src/modules/08-encounters — the retry beside a failed read. While the read is out the button is `aria-disabled` and does nothing,
// never `disabled`: a button that turns disabled under the pointer or the Enter key drops keyboard focus to the page, and the person who
// pressed it is left nowhere. The status region is always on the page and filled while the read is out, because a region mounted with its
// text is not announced.
import { Button } from "@chartwarden/ui";
import type { JSX } from "react";

const WORKING_STYLE = { opacity: 0.6, cursor: "not-allowed" } as const;

export interface RetryButtonProps {
  /** The read this retries is out: the button says so and sends no second one. */
  readonly retrying: boolean;
  readonly onRetry: () => void;
}

export function RetryButton({ retrying, onRetry }: RetryButtonProps): JSX.Element {
  return (
    <>
      <Button
        tone="secondary"
        size="sm"
        aria-disabled={retrying || undefined}
        aria-busy={retrying || undefined}
        style={retrying ? WORKING_STYLE : undefined}
        onClick={() => {
          if (!retrying) onRetry();
        }}
      >
        Try again
      </Button>
      <output className="wx-row-sub">{retrying ? " Reading again…" : ""}</output>
    </>
  );
}
