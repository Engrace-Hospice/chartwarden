// @chartwarden/portal — expired-session guard (#593). The API client reports every response status; a 401 from a
// protected `/api/v1/portal/*` call means the session is gone, so the whole screen redirects to the sign-in with a
// validated return path (`?next=`) instead of painting the shell with a "session ended" error in every card.
//
// Scope, deliberately narrow:
//  - only `/api/v1/portal/*`: `/api/auth/*` 401s are a wrong password; the funeral-home API (the case
//    page) is a separate token-based access whose own screen already shows a standalone "access ended" state.
//  - not on a chromeless route (sign-in, invitation, signed-in, funeral/collaborator redeem + case): those flows are
//    anonymous or own their 401 handling, and redirecting from the sign-in screen would loop.
//  - not the step-up route (a wrong factor is 401 on a live session) nor a 401 whose body is ORGANIZATION_NOT_SELECTED
//    (a live, org-less session, #589). Any unreadable body is treated as a dead session (fail safe).
import { matchPath } from "react-router-dom";
import { PORTAL_BASE_PATH } from "./base-path";
import { PORTAL_SCREEN_MANIFEST } from "./screens/manifest";

const PORTAL_API_PREFIX = "/api/v1/portal/";
const NOT_SESSION_DEATH_ON_401 = ["/api/v1/portal/sessions/step-up"];
const MAX_NEXT_LENGTH = 2000;
const NEXT_BASE = "http://portal.invalid";

const CHROMELESS_PATHS = PORTAL_SCREEN_MANIFEST.filter((s) => s.chrome === false).map(
  (s) => s.path,
);
const CHROMED_PATHS = PORTAL_SCREEN_MANIFEST.filter((s) => s.chrome !== false).map((s) => s.path);

/** router.state.location carries the basename; routes and `next` are app-relative. */
const appPath = (pathname: string): string =>
  PORTAL_BASE_PATH && pathname.startsWith(PORTAL_BASE_PATH)
    ? pathname.slice(PORTAL_BASE_PATH.length) || "/"
    : pathname;

const matchesAny = (paths: readonly string[], pathname: string): boolean =>
  paths.some((path) => matchPath({ path, end: true }, pathname) !== null);

/**
 * An app-relative return path (basename already stripped) that is safe to navigate to, or null. Strict allow-list:
 * it must resolve to one of the signed-in (chromed) portal routes, which excludes "/", other origins, `//host`,
 * schemes, backslashes, control characters and traversal (also when percent-encoded). Invalid input is dropped.
 */
export function validateNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_NEXT_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\") || decoded.split("/").includes("..")) {
    return null;
  }
  const url = new URL(raw, NEXT_BASE);
  if (url.origin !== NEXT_BASE || !matchesAny(CHROMED_PATHS, url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in screen URL (app-relative) that returns to `target` after sign-in. */
export function signInPathFor(target: string): string {
  const next = validateNext(target);
  return next ? `/?next=${encodeURIComponent(next)}` : "/";
}

/** The minimal slice of a react-router data router the guard needs. */
export interface GuardRouter {
  state: { location: { pathname: string; search: string; hash: string } };
  navigate(to: string, opts: { replace: boolean }): unknown;
  subscribe(listener: () => void): () => void;
}

export interface SessionGuard {
  /** Pass as `createApiClient({ onResponseStatus })`. */
  onResponseStatus(status: number, url: string | undefined, response: Response): void;
  /** Bind the router once it exists (the client is created before it). Returns a detach function. */
  attach(router: GuardRouter): () => void;
}

function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, NEXT_BASE).pathname;
  } catch {
    return undefined;
  }
}

async function isLiveOrgLessSession(response: Response): Promise<boolean> {
  try {
    if (!response.headers.get("content-type")?.includes("json")) return false;
    const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
    return body?.error?.code === "ORGANIZATION_NOT_SELECTED";
  } catch {
    return false;
  }
}

export function createSessionGuard(): SessionGuard {
  let router: GuardRouter | null = null;
  let redirecting = false;

  function redirect(): void {
    if (!router || redirecting) return;
    const { search, hash } = router.state.location;
    const pathname = appPath(router.state.location.pathname);
    if (matchesAny(CHROMELESS_PATHS, pathname)) return;
    redirecting = true; // N parallel 401s navigate once; cleared when the router settles on a chromeless route
    void router.navigate(signInPathFor(`${pathname}${search}${hash}`), { replace: true });
  }

  return {
    onResponseStatus(status, url, response) {
      if (status !== 401) return;
      const path = pathOf(url);
      if (!path?.startsWith(PORTAL_API_PREFIX) || NOT_SESSION_DEATH_ON_401.includes(path)) return;
      void isLiveOrgLessSession(response).then((orgLess) => {
        if (!orgLess) redirect();
      });
    },
    attach(next) {
      router = next;
      const unsubscribe = next.subscribe(() => {
        if (matchesAny(CHROMELESS_PATHS, appPath(next.state.location.pathname)))
          redirecting = false;
      });
      return () => {
        unsubscribe();
        if (router === next) router = null;
      };
    },
  };
}
