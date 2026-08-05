// apps/web/src/modules/39-consent — shared write-ceremony plumbing for the M39 consent capture and
// lifecycle screens (WX-PR-010). A 401 means the session itself is gone (→ /login). A 403 means
// SOMETHING was denied, but M39's sign/revoke/author routes gate on `requireStepUp(...)`
// (packages/auth/src/abac/require-abac.ts), which is a thin `requireAbac(op, "step_up_recent")` —
// on denial that throws a plain `ForbiddenError`, so the wire envelope's `error.code` is always the
// generic `FORBIDDEN`, never a distinguishable step-up code. (M6's write-workflow.ts checks for a
// `STEP_UP_REQUIRED` *code* — that pattern is for state-machine-level step-up checks like M14's
// meeting adjourn, which is a different mechanism; M6's own routes don't emit it either, by its own
// comment.) The actual signal `requireAbac` leaves is in `error.message`:
// `abac predicate 'step_up_recent' denied for '<op>'` — confirmed against a live 403 from
// POST /consents/:id/recipients. Route on that instead of a code that never arrives.
export function authFailureRedirect(
  status: number | undefined,
  message: string | undefined,
  currentPath: string,
): string | null {
  if (status === 401) return "/login";
  if (status === 403 && message?.includes("step_up_recent"))
    return `/step-up?returnTo=${encodeURIComponent(currentPath)}`;
  return null;
}
