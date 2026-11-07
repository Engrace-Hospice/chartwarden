// apps/web/src/modules/16-bereavement — the two rules every short-lived minted link on these screens follows (a mailing batch PDF, a
// grief-library preview): only a secure link is ever put on the page, and it is dropped when it expires.

/** The longest delay `setTimeout` honours (a larger one fires at once). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** The shortest time a freshly minted link stays on the page: the client clock may be skewed, and the server enforces the real expiry. */
export const LINK_FLOOR_MS = 60_000;

/** How long to keep a just-minted batch link, clamped to what a timer can wait. A link the client clock already calls expired (or an
 * unparseable expiry) still gets LINK_FLOOR_MS: the server just minted it, so a skewed clock must not drop it before it can be clicked. */
export function linkLifetimeMs(expiresAt: string, now: number): number {
  const left = Date.parse(expiresAt) - now;
  return Number.isFinite(left)
    ? Math.min(Math.max(LINK_FLOOR_MS, left), MAX_TIMEOUT_MS)
    : LINK_FLOOR_MS;
}

/** A minted link is only ever https (loopback http is the local dev object store). */
export function isSafeBatchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}
