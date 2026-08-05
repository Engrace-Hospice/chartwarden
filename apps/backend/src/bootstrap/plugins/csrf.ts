// apps/backend/src/bootstrap/plugins/csrf.ts — double-submit-cookie CSRF protection (WX-PR-017).
//
// WHY THIS EXISTS: M2's session is a Better Auth httpOnly cookie (`better-auth.session_token`,
// `SameSite=Lax`) — an AMBIENT credential the browser attaches automatically, including to a
// cross-site request an attacker page triggers. `SameSite=Lax` already blocks the classic
// cross-site `<form>` POST case in spec-compliant browsers, but is not a complete answer (older
// browsers, related-subdomain attacks, and Chrome's temporary "Lax+POST" grace window for a
// freshly-set cookie). Bearer-token/machine-credential requests (`x-internal-service-token`,
// authenticate.ts) are NOT ambient — an attacker page cannot read or replay a header the victim's
// JS never exposes to it — so they need no CSRF defense and are left alone here.
//
// PATTERN: double-submit cookie. A random token is minted into a non-httpOnly cookie the first
// time a request arrives without one (onRequest, every route, so it's in place before the first
// mutation). A mutating (`POST`/`PUT`/`PATCH`/`DELETE`) request is only checked when the Better
// Auth session cookie is ALSO present (i.e. the request would otherwise ride on the ambient
// credential) — it must echo the cookie's value back in `X-CSRF-Token`, which only same-origin JS
// (the real frontend, via packages/ui/src/core/api/client.ts's `csrfToken` middleware) can read.
// An attacker's cross-site page can trigger the request and have the session cookie attached, but
// cannot read the CSRF cookie value (blocked by the browser's same-origin cookie read policy) to
// put it in the header.
//
// No new dependency: cookies are read/written by hand off the raw `cookie`/`set-cookie` headers,
// matching the existing precedent in packages/auth/src/identity/mount.ts (no @fastify/cookie
// anywhere in this codebase).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { CsrfValidationError } from "@wardenx/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const CSRF_COOKIE_NAME = "wardenx_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Routes with no ambient-cookie CSRF exposure, so the check is skipped entirely:
 *  - `/api/auth/` — Better Auth's own mount; it runs its own `trustedOrigins` check
 *    (packages/auth/src/identity/auth.ts) for its state-changing routes (sign-in/up/out, etc.), and
 *    a fresh/pre-login browser has no CSRF cookie exchange with it yet.
 *  - `/webhooks/`, `/api/v1/webhooks/`, `/api/v1/telehealth/webhooks/` — server-to-server calls
 *    authenticated by a provider HMAC/signature header (Stripe, Twilio, Postmark, Daily.co), never
 *    by the browser's session cookie.
 *  - `/health`, `/ready`, `/healthz` — unauthenticated infra probes.
 */
const DEFAULT_EXEMPT_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/webhooks/",
  "/api/v1/webhooks/",
  "/api/v1/telehealth/webhooks/",
  "/health",
  "/ready",
  "/healthz",
];

export interface CsrfOptions {
  /** Set false to disable (e.g. a test host that never exercises browser-cookie auth). Default true. */
  readonly enabled?: boolean;
  /** Path prefixes exempt from the check. Defaults to {@link DEFAULT_EXEMPT_PREFIXES}. */
  readonly exemptPrefixes?: readonly string[];
  /** Force the cookie's `Secure` attribute; defaults to `NODE_ENV === "production"`. */
  readonly secure?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Internal: the CSRF cookie value in play for this request (existing or freshly minted). */
    __csrfCookieToken?: string;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** Better Auth's default cookie is `better-auth.session_token`, `__Secure-`-prefixed in production. */
function hasSessionCookie(cookies: Record<string, string>): boolean {
  return Object.keys(cookies).some((name) => name.includes("session_token"));
}

function isExempt(url: string, prefixes: readonly string[]): boolean {
  const path = url.split("?")[0] ?? url;
  return prefixes.some((p) => path === p || path.startsWith(p));
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Merge a new Set-Cookie value onto any Set-Cookie header already staged on the reply. */
function appendSetCookie(reply: FastifyReply, cookie: string): void {
  const existing = reply.getHeader("set-cookie");
  const existingList = existing === undefined ? [] : Array.isArray(existing) ? existing.map(String) : [String(existing)];
  reply.header("set-cookie", [...existingList, cookie]);
}

export function applyCsrfProtection(app: FastifyInstance, opts: CsrfOptions = {}): void {
  if (opts.enabled === false) return;
  const exemptPrefixes = opts.exemptPrefixes ?? DEFAULT_EXEMPT_PREFIXES;
  const secure = opts.secure ?? process.env.NODE_ENV === "production";

  // Mint the double-submit cookie on any request that doesn't already carry one, so it is in
  // place before the browser's first mutating call. Runs on every route (not just exempt-filtered
  // ones) — an early GET to an exempt path (e.g. a session check under /api/auth) still primes the
  // cookie for the very next, non-exempt mutation.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const cookies = parseCookies(request.headers.cookie);
    let token = cookies[CSRF_COOKIE_NAME];
    if (!token) {
      token = randomBytes(32).toString("hex");
      const attrs = [`${CSRF_COOKIE_NAME}=${token}`, "Path=/", "SameSite=Lax", ...(secure ? ["Secure"] : [])];
      appendSetCookie(reply, attrs.join("; "));
    }
    request.__csrfCookieToken = token;
  });

  // Verify: only for mutating methods, only on non-exempt routes, and only when the request also
  // carries the Better Auth session cookie (the ambient credential this defends). A request
  // authenticated purely by a header credential (machine token, or none at all) has nothing here
  // for an attacker to ride, so it is left untouched.
  //
  // Deliberately FAIL CLOSED (unlike the rate limiter's fail-open — that is an availability
  // control, this is a security control): a request whose CSRF cookie was only just minted this
  // same request is rejected rather than waved through, because the client cannot possibly have
  // echoed a value it hasn't seen yet. In practice this never bites a real browser session — every
  // SPA issues at least one prior (often CSRF-exempt, e.g. the Better Auth session check) request
  // before its first mutation, which is what primes the cookie — and it closes the alternative,
  // where "cookie absent" would double as a free pass around the whole check.
  app.addHook("preHandler", async (request: FastifyRequest) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (isExempt(request.url, exemptPrefixes)) return;
    const cookies = parseCookies(request.headers.cookie);
    if (!hasSessionCookie(cookies)) return;

    const cookieToken = request.__csrfCookieToken;
    const headerToken = request.headers[CSRF_HEADER_NAME];
    if (
      typeof cookieToken !== "string" ||
      typeof headerToken !== "string" ||
      !timingSafeStringEqual(cookieToken, headerToken)
    ) {
      throw new CsrfValidationError();
    }
  });
}
