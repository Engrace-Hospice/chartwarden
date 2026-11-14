// @chartwarden/ui web — an `OpsFailure` as the person reads it: the sentence, and the one next step its kind calls for (Re-verify for a
// stale sign-in, the earlier step to finish for a locked one, a reference to quote when it is not their doing, how long to wait when the
// server said). One alert holds the sentence AND its detail lines, so the details are announced with it. Hoisted from the admin and the
// tenant wizards, which differ only in the detail lines and the link they give for a locked step.
import type { JSX, ReactNode } from "react";
import type { OpsFailure } from "../../core/ops-write/ops-error";
import { InlineAlert } from "./inline-alert";
import { ReverifyLink } from "./step-up-link";
import { UnstyledList } from "./unstyled-list";

export interface WriteFailureNoticeProps {
  failure: OpsFailure;
  /** Called just before leaving for Re-verify: stash what was typed (never a credential). */
  onReverify?: () => void;
  /**
   * The lines under the sentence. Absent, a coded conflict lists the server's details; a lane passes its own (the go-live checks, in its
   * words) or `null` for none.
   */
  detailLines?: readonly string[] | null;
  /** The link for a `locked` refusal that names the earlier step (`failure.blockedBy`): the lane knows its own routes and titles. */
  blockedStepLink?: (stepKey: string) => ReactNode;
}

function defaultLines(failure: OpsFailure): readonly string[] | null {
  return failure.kind === "conflict" && failure.details.length > 0
    ? failure.details.map((d) => d.message)
    : null;
}

export function WriteFailureNotice({
  failure,
  onReverify,
  detailLines,
  blockedStepLink,
}: WriteFailureNoticeProps): JSX.Element {
  const fieldsShown = failure.kind === "validation" && Object.keys(failure.fieldErrors).length > 0;
  const quoteReference =
    (failure.kind === "unavailable" || failure.kind === "unknown") &&
    failure.correlationId !== null;
  const lines = detailLines === undefined ? defaultLines(failure) : detailLines;
  return (
    <div className="wx-form-stack">
      {/* The alert text is a <p>, which cannot hold the detail list: one live region wraps both so the details are announced with it. */}
      <div role="alert">
        <InlineAlert tone="error" live={false}>
          {fieldsShown ? "Some details need attention." : failure.message}
          {quoteReference ? ` Reference: ${failure.correlationId}.` : ""}
          {failure.retryAfterSeconds != null
            ? ` Try again in about ${failure.retryAfterSeconds} seconds.`
            : ""}
        </InlineAlert>
        {lines !== null && lines.length > 0 ? (
          <UnstyledList>
            {[...new Set(lines)].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </UnstyledList>
        ) : null}
      </div>
      {failure.kind === "step-up" ? (
        <div>
          <ReverifyLink {...(onReverify ? { onNavigate: onReverify } : {})}>Re-verify</ReverifyLink>
        </div>
      ) : null}
      {failure.kind === "locked" && failure.blockedBy && blockedStepLink
        ? blockedStepLink(failure.blockedBy)
        : null}
    </div>
  );
}
