// apps/web/src/shell — WP 4.8 (ADR-0075): remembers WHICH notification link a signed-out visitor opened, across the sign-in
// chain (/login -> /login/2fa -> /login/organization -> a full page load), so the visit can finish after sign-in.
//
// What is kept is only the opaque id from `/n/<id>` (letters, digits, `-`, `_`; at most 64), in sessionStorage with a short TTL:
// not in the URL, not a token, no patient/channel/message id. The way back is REBUILT from that id (`/n/<id>`), never replayed
// from a stored or supplied string, so there is no open redirect by construction (no scheme, host, `//`, query or fragment).
const KEY = "wx.pending-notification-link";
const TTL_MS = 15 * 60_000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LINK_PATH = /^\/n\/([A-Za-z0-9_-]{1,64})\/?$/;

/** The opaque id when `pathname` is exactly `/n/<id>`, else null. */
export function notificationIdFromPath(pathname: string): string | null {
  return LINK_PATH.exec(pathname)?.[1] ?? null;
}

/** The in-app path for a notification id, or "/" when the id is not opaque. */
export function notificationPath(id: string): string {
  return OPAQUE_ID.test(id) ? `/n/${id}` : "/";
}

/** Remember the id of `pathname` if it is a notification link; anything else is ignored. Storage failure is non-fatal. */
export function rememberPendingNotificationLink(pathname: string): void {
  const id = notificationIdFromPath(pathname);
  if (id === null) return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // Private mode / blocked storage: the user opens the link again after signing in.
  }
}

/** Read and clear the remembered link: its rebuilt path, or null when none, expired or unreadable. */
export function takePendingNotificationLink(): string | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    if (raw === null) return null;
    const saved = JSON.parse(raw) as { id?: unknown; at?: unknown };
    if (typeof saved.id !== "string" || !OPAQUE_ID.test(saved.id)) return null;
    if (typeof saved.at !== "number" || Date.now() - saved.at > TTL_MS) return null;
    return notificationPath(saved.id);
  } catch {
    return null;
  }
}

/** Forget any remembered link (sign-out): the next person on this browser must not be sent to the previous visitor's link. */
export function clearPendingNotificationLink(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Blocked storage: nothing was stored.
  }
}
