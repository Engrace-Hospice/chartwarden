// #593 — expired-session guard: redirect rules and strict `next` validation.
import { describe, expect, it, vi } from "vitest";
import { PORTAL_BASE_PATH } from "../src/base-path";
import { createSessionGuard, signInPathFor, validateNext } from "../src/session-guard";
import type { GuardRouter } from "../src/session-guard";

const PID = "11111111-1111-4111-8111-111111111111";

function fakeRouter(pathname: string, search = "") {
  const listeners = new Set<() => void>();
  const router = {
    state: { location: { pathname: `${PORTAL_BASE_PATH}${pathname}`, search, hash: "" } },
    navigate: vi.fn((to: string) => {
      router.state = {
        location: { pathname: `${PORTAL_BASE_PATH}/`, search: to.slice(1), hash: "" },
      };
      for (const l of listeners) l();
    }),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  return router satisfies GuardRouter;
}

const json = (status: number, code?: string) =>
  new Response(code ? JSON.stringify({ error: { code } }) : "", {
    status,
    headers: { "content-type": "application/json" },
  });
const flush = () => new Promise((r) => setTimeout(r, 0));

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

  it("keeps a signed-in portal route with query", () => {
    expect(validateNext(`/p/${PID}/care-plan?tab=a`)).toBe(`/p/${PID}/care-plan?tab=a`);
    expect(validateNext("/account")).toBe("/account");
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
    expect(router.navigate).toHaveBeenCalledWith(signInPathFor(`/p/${PID}/care-plan`), {
      replace: true,
    });
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
