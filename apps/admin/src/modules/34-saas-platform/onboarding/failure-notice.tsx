// apps/admin/src/modules/34-saas-platform/onboarding — an `OpsFailure` as the operator reads it: the sentence, and the one next step its
// kind calls for (Re-verify, go to the step to finish first, a reference to quote when it is not their doing). The notice itself is
// @chartwarden/ui's `WriteFailureNotice`; this gives it the operator's go-live check wording and the console's step route.
import { type OpsFailure, WriteFailureNotice } from "@chartwarden/ui";
import { createContext, useContext } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { guardFailureLines } from "./wizard-errors";

/** The go-live approval's refusal that lists what still fails: a coded 409 the kit classes "refused", whose details are the point. */
const GUARDS_FAILED_CODE = "ACTIVATION_GUARDS_FAILED";

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
  return (
    <WriteFailureNotice
      failure={failure}
      {...(onReverify ? { onReverify } : {})}
      {...(failure.code === GUARDS_FAILED_CODE && failure.details.length > 0
        ? { detailLines: guardFailureLines(failure.details) }
        : {})}
      blockedStepLink={(key) => (
        <Link to={`/tenants/${encodeURIComponent(orgSlug)}/onboarding/${encodeURIComponent(key)}`}>
          Go to {titleOf(key)}
        </Link>
      )}
    />
  );
}
