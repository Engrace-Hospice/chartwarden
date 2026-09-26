// apps/web/src/modules/08-encounters — shared write-ceremony plumbing for the M8 sign/cosign ceremonies
// (TASK-031). Same concern M23's write-workflow.ts (TASK-021/FLOW-008) solved for the claim editor: a 401
// means the session itself is gone (→ /login); a 403 whose envelope carries `STEP_UP_REQUIRED` means the
// session is valid but not FRESH enough for this action — the real fix is the existing `/step-up` screen
// (apps/web/src/modules/02-identity/step-up.tsx), never a dead-end error string. Every other 403 stays a
// plain inline "you lack permission" message — redirecting on those would send a permanently-unauthorized
// caller into a loop step-up can't resolve.
//
// THE BRANCH BELOW NOW FIRES (F-084). This header used to record that it could not: "packages/auth's
// requireAbac/requireStepUp still don't emit a distinguishable STEP_UP_REQUIRED error code on denial (a
// pre-existing, cross-module gap — every requireStepUp caller, not just M8; not this ceremony's to
// fix)". It was accurate, and it meant a nurse refused at the sign ceremony for a STALE re-authentication
// read "You do not have permission for this action" — a statement about their ROLE, which is false, and
// which no amount of retrying fixes. Five modules (M6, M8, M23, M24, M39) had written this same helper
// waiting on that code. `requireStepUp` now denies with `403 STEP_UP_REQUIRED`, and the redirect
// resolves to a ceremony that can actually be COMPLETED — which it could not before F-081, and which is
// the honest reason this waited rather than being fixed at either end alone.
//
// Belt and braces: packages/auth's requireAbac (as opposed to requireStepUp) can still surface that denial as a plain
// FORBIDDEN envelope whose message names `step_up_recent`. Treat that as the same user-recoverable
// ceremony gap as STEP_UP_REQUIRED so the user lands on the existing `/step-up` screen instead of a
// dead-end permission error.
//
// Cross-module imports are architecture-fitness-enforced (each module owns its own web codePaths), so
// this is a local copy, not a shared import — see encounter-status.ts for the same per-module-helper
// convention.

/** 401 → the session is gone, only re-signing in helps. A step-up-shaped 403 → the real `/step-up` screen. */
export function authFailureRedirect(
  status: number | undefined,
  code: string | undefined,
  currentPath: string,
  message?: string,
): string | null {
  if (status === 401) return "/login";
  if (code === "STEP_UP_REQUIRED" || (status === 403 && message?.includes("step_up_recent")))
    return `/step-up?returnTo=${encodeURIComponent(currentPath)}`;
  return null;
}
