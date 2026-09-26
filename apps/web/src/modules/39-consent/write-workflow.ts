// apps/web/src/modules/39-consent — shared write-ceremony plumbing for the M39 consent capture and
// lifecycle screens (WX-PR-010). A 401 means the session itself is gone (→ /login). A 403 carrying
// `STEP_UP_REQUIRED` means the session is valid but not FRESH enough for this action, and the remedy is
// the `/step-up` screen; every other 403 stays an inline "you lack permission", because redirecting a
// permanently-unauthorized caller into a ceremony would be a loop they cannot leave.
//
// THIS USED TO MATCH ON THE ERROR MESSAGE. `requireStepUp` denied with a plain `ForbiddenError`, so the
// envelope's `code` was the generic `FORBIDDEN` and the only thing distinguishing a step-up refusal was
// the diagnostic text `abac predicate 'step_up_recent' denied for '<op>'` — which this file matched on
// a substring of, and said so: "Route on that instead of a code that never arrives." That was the right
// call at the time and it was load-bearing on an internal string nobody was obliged to keep. F-084 gives
// the refusal its own code (`StepUpRequiredError`), which is what the other four modules' copies of this
// helper have branched on since before it could be emitted; matching the code is now both correct and
// the same rule everywhere.
export function authFailureRedirect(
  status: number | undefined,
  code: string | undefined,
  currentPath: string,
): string | null {
  if (status === 401) return "/login";
  if (code === "STEP_UP_REQUIRED") return `/step-up?returnTo=${encodeURIComponent(currentPath)}`;
  return null;
}
