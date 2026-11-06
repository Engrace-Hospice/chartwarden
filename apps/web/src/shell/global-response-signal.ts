// apps/web/src/shell — global HTTP-status signal (TASK-033). The API client (`@chartwarden/ui`,
// leaf-safe, no router access) reports every response's status via `onResponseStatus`; this module
// turns that into a tiny external store a router-connected component can subscribe to and act on
// (401 → /expired, 503 → /maintenance). Kept outside React so it can be fed from `main.tsx` before
// the router exists, and read with `useSyncExternalStore` from anywhere inside it.

import { noteClaimsBillingRefusal } from "@chartwarden/ui";
import { clearAllDrafts } from "./ceremony-drafts";

/** Why a tenant address cannot be used (ADR-0049): the organization left, is suspended, or never existed. */
export type TenantUnavailableReason = "closed" | "suspended" | "unknown";

export type GlobalResponseSignal =
  | { kind: "session-expired" | "service-unavailable" }
  | { kind: "tenant-unavailable"; reason: TenantUnavailableReason }
  | { kind: "org-not-selected" }
  | null;

type Listener = () => void;

let current: GlobalResponseSignal = null;
// The watcher consumes `current`; the session's "outage" status can land after that, so the reason is kept for RequireChrome.
let lastTenantReason: TenantUnavailableReason | null = null;
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
const NOT_SESSION_DEATH_ON_401 = [
  "/api/v1/sessions/step-up",
  "/api/v1/portal/sessions/step-up",
  // #589 - a wrong screen-lock password is 401 INVALID_CREDENTIALS on a perfectly live session.
  "/api/v1/auth/unlock",
];

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

const TENANT_ERROR_CODES: Readonly<Record<string, TenantUnavailableReason>> = {
  TENANT_CLOSED: "closed",
  TENANT_SUSPENDED: "suspended",
  TENANT_HOST_UNKNOWN: "unknown",
};
const TENANT_REFUSAL_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);
/** `/api/v1/public/*` answers 404 TENANT_HOST_UNKNOWN on the demo host and on `app.<base>`; that is not a dead tenant. */
const PUBLIC_API_PREFIX = "/api/v1/public/";

/** Only these responses are worth reading the body of; an ordinary 403/404 elsewhere is never cloned. */
export function mayCarryTenantRefusal(status: number, url?: string): boolean {
  if (!TENANT_REFUSAL_STATUSES.has(status)) return false;
  const path = pathOf(url);
  return path?.startsWith("/api/") === true && !path.startsWith(PUBLIC_API_PREFIX);
}

/** The tenant-unavailable signal for a refusal body `{ error: { code } }`, or null for any other body. Reads a clone. */
export async function tenantSignalFromResponse(response: Response): Promise<GlobalResponseSignal> {
  try {
    if (!response.headers.get("content-type")?.includes("json")) return null;
    const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    const reason = typeof code === "string" ? TENANT_ERROR_CODES[code] : undefined;
    return reason ? { kind: "tenant-unavailable", reason } : null;
  } catch {
    return null;
  }
}

/**
 * True for a 401 whose body is `{ error: { code: "ORGANIZATION_NOT_SELECTED" } }`: a live session that has not bound an
 * organization (#589). Not session death - the user goes to the org picker and keeps their drafts. Reads a clone; any
 * unreadable or different body is false, so the caller keeps treating the 401 as a dead session (fail safe).
 */
export async function isOrgNotSelectedResponse(response: Response): Promise<boolean> {
  return (await errorCodeOf(response)) === "ORGANIZATION_NOT_SELECTED";
}

/**
 * ADR-0108 — the claims-billing gate's fail-closed 503 (`BILLING_ENTITLEMENT_UNAVAILABLE`) refuses one action; the rest
 * of the app works. It is not an outage, so it must not navigate to /maintenance and lose the form the user is on.
 */
const NOT_AN_OUTAGE_ON_503 = ["BILLING_ENTITLEMENT_UNAVAILABLE"];

/** The envelope's `error.code`, read from a clone; undefined for a non-JSON or unreadable body. */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    if (!response.headers.get("content-type")?.includes("json")) return undefined;
    const body = (await response.clone().json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
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

/**
 * The client's `onResponseStatus` hook (wired in main.tsx): feeds every observed response to the global signal. A 401/503
 * notifies directly; a tenant-host refusal (410/403/404) is told apart from an ordinary one by its body `error.code`.
 */
export function handleObservedResponse(
  status: number,
  url: string | undefined,
  response: Response,
): void {
  const signal = signalForStatus(status, url);
  if (signal?.kind === "session-expired") {
    // A 401 is only session death once its body says so: an org-less session gets the same status (#589).
    void isOrgNotSelectedResponse(response).then((orgLess) => {
      // Two 401s can be in flight; a genuine session death must never be overwritten by the milder org-less signal.
      if (orgLess && getGlobalResponseSignal()?.kind !== "session-expired") {
        setGlobalResponseSignal({ kind: "org-not-selected" });
      } else {
        setGlobalResponseSignal(signal);
      }
    });
  } else if (signal?.kind === "service-unavailable") {
    void errorCodeOf(response).then((code) => {
      if (code === undefined || !NOT_AN_OUTAGE_ON_503.includes(code))
        setGlobalResponseSignal(signal);
    });
  } else if (signal) {
    setGlobalResponseSignal(signal); // only 401/503 notify - don't re-render on every 2xx
  } else if (status === 402) {
    // ADR-0108 — a claims-billing add-on refusal flips every ClaimsBillingNotice / gated action at once.
    void response
      .clone()
      .json()
      .then((body: unknown) => noteClaimsBillingRefusal(body))
      .catch(() => undefined);
  } else if (mayCarryTenantRefusal(status, url)) {
    void tenantSignalFromResponse(response).then((tenantSignal) => {
      if (tenantSignal) setGlobalResponseSignal(tenantSignal);
    });
  }
}

export function setGlobalResponseSignal(signal: GlobalResponseSignal): void {
  // A dead session must not leave PHI-bearing ceremony drafts in memory for whoever signs in next on this tab (the
  // /expired route is an SPA navigation, not a reload). An idle LOCK is different and keeps them.
  if (signal?.kind === "session-expired") clearAllDrafts();
  if (signal?.kind === "tenant-unavailable") lastTenantReason = signal.reason;
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

/** The tenant-unavailable reason most recently observed, or null: a dead tenant host makes the context load fail, which is not an outage. */
export function getLastTenantUnavailableReason(): TenantUnavailableReason | null {
  return lastTenantReason;
}
