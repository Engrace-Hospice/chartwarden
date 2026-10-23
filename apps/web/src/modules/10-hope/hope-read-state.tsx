// apps/web/src/modules/10-hope — shared read-state for the three unfiltered HOPE list reads (#591).
// hope.scope answers an unfiltered schedules/submissions/compliance read from a caller who is not org-wide
// scoped with 404 (deny-as-not-found, system design), and a plain 403 can come from the permission gate.
// Callers read with `settleRead(request, "denied")`: both mean "this view is not yours", so both classify
// as `denied`; any other failure (including a rejected request) is `failed` and retryable.
// A denied or failed read must never fall through to an empty list or a zero count.
import { DeniedState, ErrorState, type ReadStatus } from "@chartwarden/ui";
import type { JSX } from "react";

export function HopeListReadState({
  status,
  subject,
  failedTitle,
  onRetry,
}: {
  status: Exclude<ReadStatus, "ok">;
  /** Plain-language noun for the denied copy, e.g. "the agency-wide HOPE schedules". */
  subject: string;
  failedTitle: string;
  onRetry: () => void;
}): JSX.Element {
  if (status === "denied") {
    return (
      <DeniedState
        subject={`${subject}. Your access is limited to your own caseload or provider entity`}
      />
    );
  }
  return <ErrorState title={failedTitle} description="Try again in a moment." onRetry={onRetry} />;
}
