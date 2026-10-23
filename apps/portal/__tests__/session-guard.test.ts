// #593 — expired-session guard: redirect rules and strict `next` validation.
import { describe, expect, it, vi } from "vitest";
import { PORTAL_BASE_PATH } from "../src/base-path";
import {
  appPath,
  createSessionGuard,
  patientIdOf,
  signInPathFor,
  validateNext,
} from "../src/session-guard";
import type { GuardRouter } from "../src/session-guard";

const PID = "11111111-1111-4111-8111-111111111111";

/**
 * Navigation is asynchronous like react-router's: it settles on a later tick. `supersede` leaves the location
 * unchanged (another navigation won), so the router never reaches the sign-in route.
 */
function fakeRouter(pathname: string, search = "", opts: { supersede?: boolean } = {}) {
  const listeners = new Set<() => void>();
  const router = {
    state: { location: { pathname: `${PORTAL_BASE_PATH}${pathname}`, search, hash: "" } },
    navigate: vi.fn(async (to: string) => {
      await new Promise((r) => setTimeout(r, 5));
      if (opts.supersede) return;
      router.state = {
        location: { pathname: `${PORTAL_BASE_PATH}/`, search: to.slice(1), hash: "" },
      };
      for (const l of listeners) l();
    }),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    goTo(pathname: string) {
      router.state = {
        location: { pathname: `${PORTAL_BASE_PATH}${pathname}`, search: "", hash: "" },
      };
      for (const l of listeners) l();
    },
  };
  return router satisfies GuardRouter & { goTo(p: string): void };
}

const json = (status: number, code?: string) =>
  new Response(code ? JSON.stringify({ error: { code } }) : "", {
    status,
    headers: { "content-type": "application/json" },
  });
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("validateNext", () => {
  it.each([
    ["//evil.com"],
    ["https://evil.com"],
    ["/portal/../"],
    ["/p/x/../../etc"],
    ["%2f%2fevil.com"],
    ["/%2f%2fevil.com"],
    ["/\\evil.com"],
    ["\\\\evil.com"],
    ["/"],
    ["/signed-in"],
    ["/funeral/case"],
    ["javascript:alert(1)"],
    ["/account\n"],
    [""],
    [null],
  ])("drops %s", (raw) => {
    expect(validateNext(raw as string | null)).toBeNull();
  });

  it("keeps a signed-in portal route path-only: search and hash never round-trip", () => {
    expect(validateNext(`/p/${PID}/care-plan?tab=a&b=2`)).toBe(`/p/${PID}/care-plan`);
    expect(validateNext(`/p/${PID}/care-plan?x=100%25#frag`)).toBe(`/p/${PID}/care-plan`);
    expect(validateNext("/account#top")).toBe("/account");
    expect(validateNext("/account")).toBe("/account");
  });

  it("signInPathFor emits a bare-path next and an optional reason", () => {
    expect(signInPathFor(`/account?a=1&b=2#h`)).toBe(`/?next=${encodeURIComponent("/account")}`);
    expect(signInPathFor("/account", { expired: true })).toBe(
      `/?next=${encodeURIComponent("/account")}&reason=expired`,
    );
    expect(signInPathFor("//evil.com", { expired: true })).toBe("/?reason=expired");
    expect(signInPathFor("//evil.com")).toBe("/");
  });
});

describe("patientIdOf", () => {
  it("reads the patient from a /p/:patientId route, else null", () => {
    expect(patientIdOf(`/p/${PID}/care-plan`)).toBe(PID);
    expect(patientIdOf(`/p/${PID}`)).toBe(PID);
    expect(patientIdOf("/account")).toBeNull();
    expect(patientIdOf("/patient-picker")).toBeNull();
  });
});

describe("appPath", () => {
  it("strips the basename case-insensitively on a segment boundary only", () => {
    expect(appPath(`${PORTAL_BASE_PATH}/account`)).toBe("/account");
    expect(appPath(PORTAL_BASE_PATH)).toBe("/");
    expect(appPath(`${PORTAL_BASE_PATH.toUpperCase()}/account`)).toBe("/account");
    expect(appPath(`${PORTAL_BASE_PATH}x/account`)).toBe(`${PORTAL_BASE_PATH}x/account`);
  });
});

describe("session guard", () => {
  it("redirects to sign-in with next on a portal 401", async () => {
    const router = fakeRouter(`/p/${PID}/care-plan`);
    const guard = createSessionGuard();
    guard.attach(router);
    guard.onResponseStatus(
      401,
      "http://x/api/v1/portal/care-summary",
      json(401, "UNAUTHENTICATED"),
    );
    await flush();
    expect(router.navigate).toHaveBeenCalledWith(
      signInPathFor(`/p/${PID}/care-plan`, { expired: true }),
      { replace: true },
    );
  });

  it("navigates once for parallel 401s", async () => {
    const router = fakeRouter("/account");
    const guard = createSessionGuard();
    guard.attach(router);
    for (let i = 0; i < 5; i++) {
      guard.onResponseStatus(401, "http://x/api/v1/portal/a", json(401));
    }
    await flush();
    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it("redirects again on a second expiry once the router settled on sign-in", async () => {
    const router = fakeRouter("/account");
    const guard = createSessionGuard();
    guard.attach(router);
    guard.onResponseStatus(401, "http://x/api/v1/portal/a", json(401));
    await flush();
    expect(router.navigate).toHaveBeenCalledTimes(1);
    router.goTo("/account"); // signed in again, then the session dies again
    guard.onResponseStatus(401, "http://x/api/v1/portal/a", json(401));
    await flush();
    expect(router.navigate).toHaveBeenCalledTimes(2);
  });

  it("is not stuck when a navigation is superseded: a later 401 redirects again", async () => {
    const router = fakeRouter("/account", "", { supersede: true });
    const guard = createSessionGuard();
    guard.attach(router);
    guard.onResponseStatus(401, "http://x/api/v1/portal/a", json(401));
    await flush();
    expect(router.navigate).toHaveBeenCalledTimes(1);
    guard.onResponseStatus(401, "http://x/api/v1/portal/a", json(401));
    await flush();
    expect(router.navigate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["auth route", "http://x/api/auth/sign-in/email", 401, "/account"],
    ["funeral api", "http://x/api/v1/funeral/case", 401, "/account"],
    ["step-up", "http://x/api/v1/portal/sessions/step-up", 401, "/account"],
    ["non-401", "http://x/api/v1/portal/a", 403, "/account"],
    ["chromeless route", "http://x/api/v1/portal/a", 401, "/signed-in"],
    ["sign-in route", "http://x/api/v1/portal/a", 401, "/"],
    ["funeral case route", "http://x/api/v1/portal/a", 401, "/funeral/case"],
  ])("ignores %s", async (_n, url, status, at) => {
    const router = fakeRouter(at);
    const guard = createSessionGuard();
    guard.attach(router);
    guard.onResponseStatus(status, url, json(status));
    await flush();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("treats ORGANIZATION_NOT_SELECTED as a live session", async () => {
    const router = fakeRouter("/account");
    const guard = createSessionGuard();
    guard.attach(router);
    guard.onResponseStatus(401, "http://x/api/v1/portal/a", json(401, "ORGANIZATION_NOT_SELECTED"));
    await flush();
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
