// apps/web/src/modules/06-admission — shared write-ceremony plumbing for the M6 referral→admission
// ceremonies (TASK-031). Same concern M23's write-workflow.ts (TASK-021/FLOW-008) solved for the claim
// editor: a 401 means the session itself is gone (→ /login); a 403 whose envelope carries
// `STEP_UP_REQUIRED` means the session is valid but not FRESH enough for this action — the real fix is
// the existing `/step-up` screen (apps/web/src/modules/02-identity/step-up.tsx), never a dead-end error
// string. Every other 403 stays a plain inline "you lack permission" message.
//
// None of M6's write routes (triage/accept/create/activate) carry a step-up field today — they gate on
// permission + `ifVersion` only — so in practice only the 401 branch fires. The helper stays generic
// rather than dropping the branch, matching the copy this file mirrors in apps/web/src/modules/
// 23-billing-medicare and apps/web/src/modules/08-encounters (each module owns a local copy — cross-
// module imports are architecture-fitness-enforced per module `codePaths`, including web).

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
