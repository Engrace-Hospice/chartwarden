// apps/web/src/shell — global HTTP-status signal (TASK-033). The API client (`@chartwarden/ui`,
// leaf-safe, no router access) reports every response's status via `onResponseStatus`; this module
// turns that into a tiny external store a router-connected component can subscribe to and act on
// (401 → /expired, 503 → /maintenance). Kept outside React so it can be fed from `main.tsx` before
// the router exists, and read with `useSyncExternalStore` from anywhere inside it.

import { clearAllDrafts } from "./ceremony-drafts";

export type GlobalResponseSignal = { kind: "session-expired" | "service-unavailable" } | null;

type Listener = () => void;

let current: GlobalResponseSignal = null;
const listeners = new Set<Listener>();

/**
 * Routes whose 401 does NOT mean the session is gone (F-081).
 *
 * `POST /api/v1/sessions/step-up` answers 401 `step_up_failed` for a factor that did not verify — a
 * wrong TOTP code, a cancelled passkey. The session behind it is fine; that route has its OWN terminal
 * answer for the case where it is not (423 `session_locked`, after `STEP_UP_POLICY.lockoutThreshold`
 * consecutive failures). Treating the 401 as session death bounced the user to `/expired` on their
 * FIRST mistake, which made the lockout counter unreachable — attempts 2 and 3 could never happen —
 * and made the screen's own "That code didn't verify. Try again" branch dead code.
 */
const NOT_SESSION_DEATH_ON_401 = ["/api/v1/sessions/step-up", "/api/v1/portal/sessions/step-up"];

/** Map an observed HTTP status (and the URL it came from) to a shell-level signal, or null. */
export function signalForStatus(status: number, url?: string): GlobalResponseSignal {
  if (status === 401) {
    // Exact path match, not a prefix: `/step-up/initiate` is a different route and its 401 — which
    // only a genuinely dead session produces — must still sign the user out.
    const path = pathOf(url);
    if (path !== undefined && NOT_SESSION_DEATH_ON_401.includes(path)) return null;
    return { kind: "session-expired" };
  }
  if (status === 503) return { kind: "service-unavailable" };
  return null;
}

/** The pathname of an observed response URL, or undefined when there is nothing parseable. */
function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

export function setGlobalResponseSignal(signal: GlobalResponseSignal): void {
  // A dead session must not leave PHI-bearing ceremony drafts in memory for whoever signs in next on this tab (the
  // /expired route is an SPA navigation, not a reload). An idle LOCK is different and keeps them.
  if (signal?.kind === "session-expired") clearAllDrafts();
  current = signal;
  for (const listener of listeners) listener();
}

export function getGlobalResponseSignal(): GlobalResponseSignal {
  return current;
}

export function subscribeGlobalResponseSignal(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
