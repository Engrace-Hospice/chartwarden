// apps/admin/src/modules/34-saas-platform/onboarding — an `OpsFailure` as the operator reads it: the sentence, and the one next step
// its kind calls for (Re-verify, go to the step to finish first, a reference to quote when it is not their doing).
import { InlineAlert, type OpsFailure, ReverifyLink } from "@chartwarden/ui";
import { createContext, useContext } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";

/** The wizard's step titles, so a message can name "Organisation" rather than `account_created`. */
export const StepTitlesContext = createContext<(key: string) => string>((key) => key);

export function FailureNotice({
  failure,
  orgSlug,
  onReverify,
}: {
  failure: OpsFailure;
  orgSlug: string;
  /** Called just before leaving for Re-verify: stash what was typed. */
  onReverify?: () => void;
}): JSX.Element {
  const titleOf = useContext(StepTitlesContext);
  const fieldsShown = failure.kind === "validation" && Object.keys(failure.fieldErrors).length > 0;
  const quoteReference =
    (failure.kind === "unavailable" || failure.kind === "unknown") &&
    failure.correlationId !== null;
  return (
    <div className="wx-form-stack" role="alert">
      <InlineAlert tone="error">
        {fieldsShown ? "Some details need attention." : failure.message}
        {quoteReference ? ` Reference: ${failure.correlationId}.` : ""}
      </InlineAlert>
      {failure.kind === "conflict" && failure.details.length > 0 ? (
        <ul>
          {failure.details.map((d) => (
            <li key={`${d.field}:${d.message}`}>{d.message}</li>
          ))}
        </ul>
      ) : null}
      {failure.kind === "step-up" ? (
        <div>
          <ReverifyLink {...(onReverify ? { onNavigate: onReverify } : {})}>Re-verify</ReverifyLink>
        </div>
      ) : null}
      {failure.kind === "locked" && failure.blockedBy ? (
        <Link
          to={`/tenants/${encodeURIComponent(orgSlug)}/onboarding/${encodeURIComponent(failure.blockedBy)}`}
        >
          Go to {titleOf(failure.blockedBy)}
        </Link>
      ) : null}
    </div>
  );
}
