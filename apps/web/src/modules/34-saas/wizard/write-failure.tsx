// apps/web/src/modules/34-saas/wizard — an `OpsFailure` as the tenant member reads it: the sentence, and the one next step its kind calls
// for (Re-verify for a stale sign-in, a reference to quote when it is not their doing). A refusal about an input is read beside that input
// instead, so it is not repeated here.
import { InlineAlert, type OpsFailure, ReverifyLink } from "@chartwarden/ui";
import type { JSX } from "react";

export function WriteFailureNotice({
  failure,
  onReverify,
}: {
  failure: OpsFailure;
  /** Called just before leaving for Re-verify: stash what was typed (never a credential). */
  onReverify?: () => void;
}): JSX.Element {
  const quoteReference =
    (failure.kind === "unavailable" || failure.kind === "unknown") &&
    failure.correlationId !== null;
  return (
    <div className="wx-form-stack">
      <InlineAlert tone="error">
        {failure.message}
        {quoteReference ? ` Reference: ${failure.correlationId}.` : ""}
      </InlineAlert>
      {failure.kind === "step-up" ? (
        <div>
          <ReverifyLink {...(onReverify ? { onNavigate: onReverify } : {})}>Re-verify</ReverifyLink>
        </div>
      ) : null}
    </div>
  );
}
