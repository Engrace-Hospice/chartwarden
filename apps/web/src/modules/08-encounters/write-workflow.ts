// apps/web/src/modules/08-encounters — shared write-ceremony plumbing for the M8 sign/cosign ceremonies
// (TASK-031). Same concern M23's write-workflow.ts (TASK-021/FLOW-008) solved for the claim editor: a 401
// means the session itself is gone (→ /login); a 403 whose envelope carries `STEP_UP_REQUIRED` means the
// session is valid but not FRESH enough for this action — the real fix is the existing `/step-up` screen
// (apps/web/src/modules/02-identity/step-up.tsx), never a dead-end error string. Every other 403 stays a
// plain inline "you lack permission" message — redirecting on those would send a permanently-unauthorized
// caller into a loop step-up can't resolve.
//
// M8's sign/cosign routes gate on a real M2 step-up now (requireStepUp, PARAM-004/CoP-418.104(c)
// follow-up), but packages/auth's requireAbac/requireStepUp still don't emit a distinguishable
// STEP_UP_REQUIRED error code on denial (a pre-existing, cross-module gap — every requireStepUp caller,
// not just M8; not this ceremony's to fix). So a stale step-up here still falls through to the generic
// 403 message rather than this redirect; see encounter-read.tsx. This helper stays generic and
// future-proof rather than dropping the branch, matching the copy this file mirrors in
// apps/web/src/modules/23-billing-medicare.
//
// Cross-module imports are architecture-fitness-enforced (each module owns its own web codePaths), so
// this is a local copy, not a shared import — see encounter-status.ts for the same per-module-helper
// convention.

/** 401 → the session is gone, only re-signing in helps. A step-up-shaped 403 → the real `/step-up` screen. */
export function authFailureRedirect(
  status: number | undefined,
  code: string | undefined,
  currentPath: string,
): string | null {
  if (status === 401) return "/login";
  if (code === "STEP_UP_REQUIRED") return `/step-up?returnTo=${encodeURIComponent(currentPath)}`;
  return null;
}
