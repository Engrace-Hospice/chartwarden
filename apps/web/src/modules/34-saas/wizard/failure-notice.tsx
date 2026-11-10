// apps/web/src/modules/34-saas/wizard — an `OpsFailure` as the tenant reads it: the sentence, and the one next step its kind calls for
// (Re-verify, go to the step to finish first, a reference to quote when it is not their doing). A server error (5xx) without a sentence
// of our own is never shown as the server wrote it (it can name internals): the tenant gets a plain line and the reference to quote.
import { InlineAlert, type OpsFailure, ReverifyLink, UnstyledList } from "@chartwarden/ui";
import { createContext, useContext } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { WIZARD_ERROR_COPY, guardLabel } from "./wizard-errors";

/** The go-live refusal that lists what still fails: a coded 409 the kit classes "refused", whose details are the point. */
const GUARDS_FAILED_CODE = "ACTIVATION_GUARDS_FAILED";

/** What a server error with no sentence of ours says. */
const UNAVAILABLE_TEXT =
  "ChartWarden could not do that right now. Nothing was changed. Try again in a moment.";

/** The wizard's step titles, so a message can name "Organisation" rather than `account_created`. */
export const StepTitlesContext = createContext<(key: string) => string>((key) => key);

export const stepHref = (key: string): string => `/admin/onboarding/${encodeURIComponent(key)}`;

export function FailureNotice({
  failure,
  inputFields = [],
  onReverify,
}: {
  failure: OpsFailure;
  /** The fields that have an input beside this notice: their errors are read there. Any other field's error is listed here. */
  inputFields?: readonly string[];
  /** Called just before leaving for Re-verify: stash what was typed. */
  onReverify?: () => void;
}): JSX.Element {
  const titleOf = useContext(StepTitlesContext);
  const fieldsShown = failure.kind === "validation" && Object.keys(failure.fieldErrors).length > 0;
  const unattached =
    failure.kind === "validation"
      ? failure.details.filter((d) => !inputFields.includes(d.field))
      : [];
  const ownSentence = failure.code !== null && failure.code in WIZARD_ERROR_COPY;
  const quoteReference =
    (failure.kind === "unavailable" || failure.kind === "unknown") &&
    failure.correlationId !== null;
  const headline =
    failure.kind === "unavailable" && !ownSentence
      ? UNAVAILABLE_TEXT
      : fieldsShown
        ? "Some details need attention."
        : failure.message;
  return (
    <div className="wx-form-stack">
      {/* The alert text is a <p>, which cannot hold the detail list: one live region wraps both so the details are announced with it. */}
      <div role="alert">
        <InlineAlert tone="error" live={false}>
          {headline}
          {quoteReference ? ` Reference: ${failure.correlationId}.` : ""}
        </InlineAlert>
        {failure.code === GUARDS_FAILED_CODE && failure.details.length > 0 ? (
          <UnstyledList>
            {failure.details.map((d) => (
              <li key={`${d.code}:${d.message}`}>
                {d.field === "guard" ? guardLabel(d.code, d.message) : d.message}
              </li>
            ))}
          </UnstyledList>
        ) : failure.kind === "conflict" && failure.details.length > 0 ? (
          <UnstyledList>
            {failure.details.map((d) => (
              <li key={`${d.field}:${d.message}`}>{d.message}</li>
            ))}
          </UnstyledList>
        ) : unattached.length > 0 ? (
          <UnstyledList>
            {unattached.map((d) => (
              <li key={`${d.field}:${d.message}`}>{d.message}</li>
            ))}
          </UnstyledList>
        ) : null}
      </div>
      {failure.kind === "step-up" ? (
        <div>
          <ReverifyLink {...(onReverify ? { onNavigate: onReverify } : {})}>Re-verify</ReverifyLink>
        </div>
      ) : null}
      {failure.kind === "locked" && failure.blockedBy ? (
        <Link to={stepHref(failure.blockedBy)}>Go to {titleOf(failure.blockedBy)}</Link>
      ) : null}
    </div>
  );
}
