// apps/web/src/modules/23-billing-medicare — shared write-ceremony plumbing for the M23 claim workflow
// (TASK-021 / FLOW-008). Two concerns every write surface (submit/replace/void/override) needs and none of
// them had:
//
//  1. `authFailureRedirect` — a 401 means the session itself is gone (→ /login); a 403 whose envelope carries
//     `STEP_UP_REQUIRED` (the `claim-state-service.ts` service-layer re-check, distinct from the generic
//     `FORBIDDEN` an ordinary permission denial throws) means the session is valid but not FRESH enough for
//     this action — the real fix is the existing `/step-up` screen (apps/web/src/modules/02-identity/step-up.tsx),
//     never a dead-end error string. Every other 403 stays a plain inline "you lack permission" message —
//     redirecting on those would send a permanently-unauthorized caller into a loop step-up can't resolve.
//  2. an in-progress ceremony/wizard draft cache so a step-up round trip (this page → /step-up → back) does not
//     discard what the caller already typed. This is intentionally NOT sessionStorage/localStorage: a reason
//     or void rationale can carry PHI, and PHI must never be persisted to browser storage (2026-06-27 audit
//     remediation). A plain module-scoped Map survives an in-SPA route change (react-router unmounts/remounts
//     the page component, but the JS module — and this Map — stays alive for the tab's lifetime) while still
//     being wiped on an actual reload, which is the correct, safe behavior for PHI-bearing draft text. Mirrors
//     the `recentTerms` precedent in apps/web/src/modules/05-patient/global-search.tsx.

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

// The store itself lives in the shell (`shell/ceremony-drafts.ts`) so sign-out and the screen lock can wipe it.
export { clearAllDrafts, clearDraft, loadDraft, saveDraft } from "../../shell/ceremony-drafts";
